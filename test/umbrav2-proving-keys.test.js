import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import test from 'node:test'
import { PROVING_KEY_CACHE, createProvingKeyFetch, heldFromKeys, wantedFiles, warmProvingKeys } from '../protocols/umbrav2/proving-keys.js'

const BASE = 'https://assets.example/zk/'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (text) => new TextEncoder().encode(text)

// A manifest shaped like the SDK's (presets.js), with small files.
const contents = { 'registration.zkey': 'reg-key', 'registration.wcd': 'reg-calc', 'transaction.zkey': 'tx-key', 'transaction.wcd': 'tx-calc', 'absence.zkey': 'abs-key', 'absence.wcd': 'abs-calc' }
const plain = (path) => ({ plain: { path, byteLength: bytesOf(contents[path]).byteLength, sha256: sha256(bytesOf(contents[path])) } })
const circuit = (name, file, r1csHash) => ({ circuit: name, r1csHash, artifacts: { 'proving-key': plain(`${file}.zkey`), 'verifying-key': {}, 'witness-calculator': plain(`${file}.wcd`) } })
const provingKeys = { baseUrl: BASE, manifest: { circuits: [
  circuit('registration', 'registration', '29290b0c28534719174e5b52f64dba96108fc6abc434cb8ee8d949b1e851ed3b'),
  circuit('transaction', 'transaction', 'ff73b9fe751bbdb44ab5ef5729843a90d15c8420e38d4012b3729daa479569f9'),
  circuit('nullifier_non_membership', 'absence', 'f54fdbeb0e86ad61d273f02b037b204d05130f3e761faf52be56a5d331544668'),
] } }

// Cache Storage, as far as the module uses it.
function fakeCaches() {
  const entries = new Map()
  const cache = {
    match: async (url) => entries.get(String(url))?.clone(),
    put: async (url, response) => { entries.set(String(url), response) },
    delete: async (request) => entries.delete(String(request?.url ?? request)),
    keys: async () => [...entries.keys()].map((url) => ({ url })),
  }
  return { entries, open: async (name) => { assert.equal(name, PROVING_KEY_CACHE); return cache } }
}
const server = (overrides = {}) => {
  const asked = []
  const fetch = async (url) => {
    asked.push(String(url))
    const name = String(url).slice(BASE.length)
    const body = overrides[name] ?? contents[name]
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(bytesOf(body))
  }
  return { asked, fetch }
}

test('what the SDK already holds is read from its blob keys', () => {
  const held = heldFromKeys([
    'umbra/circuit-artifacts/proving-key/transaction/ff73b9fe751bbdb4/plain sha256:6e43245f',
    new TextEncoder().encode('umbra/circuit-artifacts/witness-calculator/transaction/ff73b9fe751bbdb4/plain sha256:c0d70003'),
    'umbra/circuit-artifacts/runtime/prover/0123456789abcdef/plain', 'something-else',
  ])
  assert.deepEqual([...held].sort(), ['proving-key/transaction/ff73b9fe751bbdb4', 'witness-calculator/transaction/ff73b9fe751bbdb4'])
})

test('only files the SDK lacks are wanted, the registration\'s only for an unregistered wallet', () => {
  const names = (files) => files.map((file) => file.url.slice(BASE.length))
  assert.deepEqual(names(wantedFiles(provingKeys, new Set())), ['registration.wcd', 'registration.zkey', 'transaction.wcd', 'transaction.zkey', 'absence.wcd', 'absence.zkey'])
  assert.deepEqual(names(wantedFiles(provingKeys, new Set(), { registered: true })), ['transaction.wcd', 'transaction.zkey', 'absence.wcd', 'absence.zkey'])
  const held = new Set(['proving-key/transaction/ff73b9fe751bbdb4', 'witness-calculator/transaction/ff73b9fe751bbdb4', 'proving-key/nullifier_non_membership/f54fdbeb0e86ad61'])
  assert.deepEqual(names(wantedFiles(provingKeys, held, { registered: true })), ['absence.wcd'])
  // Another build of a circuit is another file.
  assert.deepEqual(names(wantedFiles(provingKeys, new Set(['proving-key/transaction/0000000000000000']), { registered: true })).includes('transaction.zkey'), true)
  assert.deepEqual(wantedFiles(undefined, new Set()), [])
  const [file] = wantedFiles(provingKeys, new Set(), { registered: true })
  assert.deepEqual(file, { url: `${BASE}transaction.wcd`, byteLength: 7, sha256: sha256(bytesOf('tx-calc')) })
})

test('a preload keeps each checked file until the SDK asks for it, then hands it over once', async () => {
  const caches = fakeCaches()
  const { asked, fetch } = server()
  const files = wantedFiles(provingKeys, new Set(), { registered: true })
  const bytes = await warmProvingKeys(files, { fetch, caches, subtle: webcrypto.subtle })
  assert.equal(bytes, files.reduce((sum, file) => sum + file.byteLength, 0))
  assert.equal(caches.entries.size, 4)
  // A second preload downloads nothing again.
  assert.equal(await warmProvingKeys(files, { fetch, caches, subtle: webcrypto.subtle }), 0)
  assert.equal(asked.length, 4)

  const drops = []
  const sdkFetch = createProvingKeyFetch({ fetch, caches, later: (drop) => drops.push(drop) })
  const key = await sdkFetch(`${BASE}transaction.zkey`)
  assert.equal(await key.text(), 'tx-key')
  assert.equal(asked.length, 4)
  // Everything else is the SDK's own traffic.
  assert.equal(await (await sdkFetch(`${BASE}registration.zkey`)).text(), 'reg-key')
  assert.equal(asked.at(-1), `${BASE}registration.zkey`)
  await sdkFetch('https://darksol.app/api/solana-rpc', { method: 'POST', body: '{}' }).catch(() => {})
  assert.equal(asked.at(-1), 'https://darksol.app/api/solana-rpc')
  // Once the SDK has stored its own copy, the one here goes.
  for (const drop of drops) drop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(caches.entries.has(`${BASE}transaction.zkey`), false)
})

test('a file that is not the manifest\'s is not kept, and the preload stops there', async (t) => {
  for (const wrong of ['tx-kex', 'tx-key-longer']) {
    const caches = fakeCaches()
    const { asked, fetch } = server({ 'transaction.zkey': wrong })
    await warmProvingKeys(wantedFiles(provingKeys, new Set(), { registered: true }), { fetch, caches, subtle: webcrypto.subtle })
    assert.deepEqual([...caches.entries.keys()], [`${BASE}transaction.wcd`])
    assert.equal(asked.length, 2)
    // The SDK then downloads it itself, and applies its own check.
    const sdkFetch = createProvingKeyFetch({ fetch, caches, later: () => {} })
    assert.equal(await (await sdkFetch(`${BASE}transaction.zkey`)).text(), wrong)
  }
  const caches = fakeCaches()
  assert.equal(await warmProvingKeys(wantedFiles(provingKeys, new Set()), { fetch: async () => { throw new TypeError('Failed to fetch') }, caches, subtle: webcrypto.subtle }), 0)
  assert.equal(caches.entries.size, 0)
  // No Cache Storage (a private window): nothing is downloaded ahead.
  assert.equal(await warmProvingKeys(wantedFiles(provingKeys, new Set()), { fetch: async () => assert.fail('no download'), caches: undefined, subtle: webcrypto.subtle }), 0)
})

test('files left from an earlier preload that are no longer wanted are dropped', async () => {
  const caches = fakeCaches()
  const { fetch } = server()
  await warmProvingKeys(wantedFiles(provingKeys, new Set()), { fetch, caches, subtle: webcrypto.subtle })
  assert.equal(caches.entries.size, 6)
  // The wallet registered and the SDK took the transaction files meanwhile.
  const held = new Set(['proving-key/transaction/ff73b9fe751bbdb4', 'witness-calculator/transaction/ff73b9fe751bbdb4'])
  await warmProvingKeys(wantedFiles(provingKeys, held, { registered: true }), { fetch, caches, subtle: webcrypto.subtle })
  assert.deepEqual([...caches.entries.keys()].sort(), [`${BASE}absence.wcd`, `${BASE}absence.zkey`])
})

test('a proof that starts during the download waits for it instead of downloading again', async () => {
  const caches = fakeCaches()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const asked = []
  const slow = async (url) => { asked.push(String(url)); await gate; return new Response(bytesOf(contents[String(url).slice(BASE.length)])) }
  const files = wantedFiles(provingKeys, new Set(['witness-calculator/transaction/ff73b9fe751bbdb4']), { registered: true }).slice(0, 1)
  const warming = warmProvingKeys(files, { fetch: slow, caches, subtle: webcrypto.subtle })
  await new Promise((resolve) => setImmediate(resolve))
  const sdkFetch = createProvingKeyFetch({ fetch: slow, caches, later: () => {} })
  const asking = sdkFetch(`${BASE}transaction.zkey`)
  release()
  assert.equal(await (await asking).text(), 'tx-key')
  await warming
  assert.deepEqual(asked, [`${BASE}transaction.zkey`])
})
