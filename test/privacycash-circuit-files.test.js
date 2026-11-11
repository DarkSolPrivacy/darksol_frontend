import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CIRCUIT_FILES, createCircuitFiles } from '../protocols/privacycash/circuit-files.js'

const BASE = 'https://darksol.app/send'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('the pinned sizes and digests are those of the files served and of the SDK package', () => {
  for (const [path, expected] of Object.entries(CIRCUIT_FILES)) {
    for (const file of [new URL(`../public${path}`, import.meta.url), new URL(`../node_modules/privacycash${path}`, import.meta.url)]) {
      const bytes = readFileSync(file)
      assert.equal(bytes.byteLength, expected.bytes, String(file))
      assert.equal(sha256(bytes), expected.sha256, String(file))
    }
  }
})

// Small stand-ins for the two files, pinned the same way.
function standIns(t) {
  const files = { '/circuit2/transaction2.wasm': new Uint8Array([0, 97, 115, 109, 1, 2, 3]), '/circuit2/transaction2.zkey': new Uint8Array(4096).fill(7) }
  const pins = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { ...CIRCUIT_FILES[path], bytes: bytes.byteLength, sha256: sha256(bytes) }]))
  const calls = []
  const fetch = t.mock.fn(async (url) => {
    calls.push(String(url))
    const { pathname } = new URL(String(url))
    return files[pathname] ? new Response(files[pathname]) : new Response('missing', { status: 404 })
  })
  return { files, pins, fetch, calls, subtle: webcrypto.subtle }
}

test('each file is downloaded once and then served from memory, to every proof', async (t) => {
  const { files, pins, fetch, calls, subtle } = standIns(t)
  const circuits = createCircuitFiles({ fetch, base: BASE, subtle, files: pins })
  // A preload and the proof's own request at once share one download.
  const [loaded, first] = await Promise.all([circuits.load('/circuit2/transaction2.zkey'), circuits.respond('/circuit2/transaction2.zkey')])
  assert.equal(loaded.byteLength, 4096)
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), files['/circuit2/transaction2.zkey'])
  // The withdrawal's proof, as snarkjs asks: by path, by full URL, as a Request.
  for (const input of ['/circuit2/transaction2.zkey', 'https://darksol.app/circuit2/transaction2.zkey', new Request('https://darksol.app/circuit2/transaction2.zkey')]) {
    const response = await circuits.respond(input)
    assert.equal(response.status, 200)
    assert.equal((await response.arrayBuffer()).byteLength, 4096)
  }
  const wasm = await circuits.respond('/circuit2/transaction2.wasm')
  assert.equal(wasm.headers.get('content-type'), 'application/wasm')
  assert.deepEqual(calls, ['https://darksol.app/circuit2/transaction2.zkey', 'https://darksol.app/circuit2/transaction2.wasm'])
  // What a reader does with its copy leaves the held bytes alone.
  new Uint8Array(await (await circuits.respond('/circuit2/transaction2.wasm')).arrayBuffer()).fill(9)
  assert.deepEqual(new Uint8Array(await (await circuits.respond('/circuit2/transaction2.wasm')).arrayBuffer()), files['/circuit2/transaction2.wasm'])
})

test('only this origin\'s proving files are answered, and only for a GET', async (t) => {
  const { pins, fetch, subtle } = standIns(t)
  const circuits = createCircuitFiles({ fetch, base: BASE, subtle, files: pins })
  for (const [input, init] of [
    ['https://api3.privacycash.org/utxos/range?start=0&end=20000'], ['/api/plan'], ['/circuit2/other.zkey'],
    ['https://evil.example/circuit2/transaction2.zkey'], ['/circuit2/transaction2.zkey', { method: 'POST' }], ['http://[bad'],
  ]) assert.equal(await circuits.respond(input, init), null)
  assert.equal(fetch.mock.callCount(), 0)
  // Outside a page there is no origin to speak for.
  assert.equal(await createCircuitFiles({ fetch, base: undefined, subtle, files: pins }).respond('/circuit2/transaction2.zkey'), null)
})

test('a file that does not match its digest is never served from memory, and is tried again', async (t) => {
  const { files, pins, fetch, subtle } = standIns(t)
  t.mock.method(console, 'warn', () => {})
  const circuits = createCircuitFiles({ fetch, base: BASE, subtle, files: pins })
  const good = files['/circuit2/transaction2.zkey']
  for (const bad of [good.slice(0, good.byteLength - 1), Uint8Array.from(good, (byte, index) => index === 100 ? byte ^ 1 : byte)]) {
    files['/circuit2/transaction2.zkey'] = bad
    await assert.rejects(circuits.load('/circuit2/transaction2.zkey'), /pinned SHA-256/)
    // The caller then asks the network as it always did.
    assert.equal(await circuits.respond('/circuit2/transaction2.zkey'), null)
  }
  files['/circuit2/transaction2.zkey'] = good
  assert.equal((await circuits.load('/circuit2/transaction2.zkey')).byteLength, good.byteLength)
})

test('a failed download is not kept either', async (t) => {
  const { pins, fetch, subtle } = standIns(t)
  let down = true
  const flaky = async (url) => { if (down) throw new TypeError('Failed to fetch'); return fetch(url) }
  const circuits = createCircuitFiles({ fetch: flaky, base: BASE, subtle, files: pins })
  await assert.rejects(circuits.load('/circuit2/transaction2.wasm'), /Failed to fetch/)
  assert.equal(await circuits.respond('/circuit2/transaction2.wasm'), null)
  down = false
  assert.equal((await circuits.respond('/circuit2/transaction2.wasm')).status, 200)
  await assert.rejects(circuits.load('/circuit2/unknown.bin'), /not a Privacy Cash proving file/)
})
