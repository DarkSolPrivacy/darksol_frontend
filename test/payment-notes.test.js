import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { preparePaymentKeys, preparePaymentNote, recoverPaymentNote, readPaymentDrafts, PAYMENT_KEYS_MESSAGE } from '../src/payment-notes.js'
import { pairNotes, scanPrivacyCashNotes, withdrawPaymentNotes, PRIVACYCASH_FIRST_OUTPUT } from '../src/payment-withdraw.js'

function storage() {
  const entries = new Map()
  return {
    get length() { return entries.size },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  }
}

function signer(privateKey, publicKey) {
  const messages = []
  const provider = {
    publicKey, isConnected: true,
    async signMessage(message) {
      messages.push(new TextDecoder().decode(message))
      return { signature: new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, message)) }
    },
    signTransaction() { throw new Error('Note preparation must not sign transactions') },
  }
  return { provider, address: publicKey.toBase58(), messages }
}

async function wallet() {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  return signer(keys.privateKey, new PublicKey(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))))
}

// The wallet that produced test/fixtures/payment-records-v1.json with the version 1 code.
async function legacyWallet(seed) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')])
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign'])
  const { x } = await crypto.subtle.exportKey('jwk', privateKey)
  return signer(privateKey, new PublicKey(Buffer.from(x, 'base64url')))
}

for (const protocol of ['privacycash', 'cloakc']) {
  test(`${protocol}: one signature derives, and re-derives, every note with the real SDK`, async () => {
    const owner = await wallet()
    const local = storage()
    const keys = await preparePaymentKeys(owner)
    const record = await preparePaymentNote({ ...owner, keys, index: 0, protocol, amount: '0.02', reference: 'Order 1', storage: local })
    assert.deepEqual(owner.messages, [PAYMENT_KEYS_MESSAGE])
    assert.deepEqual(Object.keys(record), ['version', 'index', 'invoice', 'reference', 'createdAt'])
    assert.equal(record.invoice.amount, '20000000')
    assert.equal(record.invoice.outputs.length, protocol === 'privacycash' ? 2 : 1)
    assert.equal(JSON.stringify(record).includes(owner.address), false)
    assert.equal(/privateKey|spendingKey|signature|recovery/i.test(JSON.stringify(record)), false)

    // A payer can reconstruct the commitment from public invoice fields only.
    if (protocol === 'privacycash') {
      const [{ WasmFactory }, { Utxo }] = await Promise.all([
        import('@lightprotocol/hasher.rs'), import('../node_modules/privacycash/dist/models/utxo.js'),
      ])
      const lightWasm = await WasmFactory.getInstance()
      for (const output of record.invoice.outputs) {
        const publicNote = new Utxo({ lightWasm, amount: output.amount, blinding: output.blinding,
          mintAddress: output.mint, keypair: { pubkey: output.publicKey } })
        assert.equal(publicNote.getCommitment().toString(), output.commitment)
      }
      assert.notEqual(record.invoice.outputs[0].encryptedNote.slice(16, 40), record.invoice.outputs[1].encryptedNote.slice(16, 40))
    } else {
      const sdk = await import('@cloak.dev/sdk')
      const output = record.invoice.outputs[0]
      assert.equal((await sdk.computeUtxoCommitment({ amount: BigInt(output.amount), blinding: BigInt(output.blinding),
        mintAddress: new PublicKey(output.mint), keypair: { publicKey: BigInt(output.publicKey), privateKey: 0n } })).toString(), output.commitment)
    }
    assert.equal(readPaymentDrafts(local, owner.address).length, 1)

    // A fresh session (another device) signs the same message and reaches the note.
    const again = await preparePaymentKeys(owner)
    const { notes } = await recoverPaymentNote({ ...owner, record, keys: again })
    assert.equal(notes[0].amount.toString(), '20000000')
    assert.ok(BigInt((notes[0].keypair.privateKey ?? notes[0].keypair.privkey).toString()) > 0n)

    const second = await preparePaymentNote({ ...owner, keys, index: 1, protocol, amount: '0.02', storage: local })
    assert.notEqual(record.invoice.id, second.invoice.id)
    assert.notEqual(record.invoice.outputs[0].publicKey, second.invoice.outputs[0].publicKey)
    // Same index, same invoice id: the server's uniqueness refuses a reused key.
    assert.equal((await preparePaymentNote({ ...owner, keys, index: 0, protocol, amount: '0.03', storage: storage() })).invoice.id, record.invoice.id)

    const stranger = await wallet()
    assert.equal(readPaymentDrafts(local, stranger.address).length, 0)
    await assert.rejects(recoverPaymentNote({ ...owner, record, keys: { ...await preparePaymentKeys(stranger), address: owner.address } }))
    await assert.rejects(recoverPaymentNote({ ...owner, record: { ...record, index: 1 }, keys }))
    const modified = structuredClone(record)
    modified.invoice.outputs[0].commitment = '1'
    await assert.rejects(recoverPaymentNote({ ...owner, record: modified, keys }), /does not match/)
  })

  test(`${protocol}: version 1 records made before derived keys still recover`, async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/payment-records-v1.json', import.meta.url), 'utf8'))
    const owner = await legacyWallet(fixture.walletSeed)
    assert.equal(owner.address, fixture.address)
    const record = fixture.records[protocol]
    const { notes, encryption } = await recoverPaymentNote({ ...owner, record })
    assert.equal(owner.messages[0], record.signingMessage)
    assert.equal(notes[0].amount.toString(), '20000000')
    assert.equal(Boolean(encryption), protocol === 'privacycash')
    const local = storage()
    local.setItem(`darksol:payment-note:v1:${owner.address}:${record.invoice.id}`, JSON.stringify(record))
    assert.equal(readPaymentDrafts(local, owner.address).length, 1)
  })
}

test('reject invalid inputs, foreign keys, changed accounts, and cancelled work without saving', async () => {
  const owner = await wallet()
  const keys = await preparePaymentKeys(owner)
  const local = storage()
  const options = { ...owner, keys, index: 0, protocol: 'cloakc', amount: '0.02', storage: local }
  await assert.rejects(preparePaymentNote({ ...options, amount: '-1' }))
  await assert.rejects(preparePaymentNote({ ...options, protocol: 'unknown' }))
  await assert.rejects(preparePaymentNote({ ...options, index: -1 }), /index/)
  await assert.rejects(preparePaymentNote({ ...options, index: 1.5 }), /index/)
  const other = await wallet()
  const otherKeys = await preparePaymentKeys(other)
  await assert.rejects(preparePaymentNote({ ...options, keys: otherKeys }), /another wallet/)
  owner.provider.signMessage = async () => { throw new Error('User rejected request') }
  await assert.rejects(preparePaymentKeys(owner), /User rejected/)
  owner.provider.publicKey = PublicKey.default
  await assert.rejects(preparePaymentNote(options), /account changed/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(preparePaymentNote({ ...options, ...other, keys: otherKeys, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(local.length, 0)
})

test('invalid signatures and storage failures never report a prepared draft', async () => {
  const owner = await wallet()
  const local = storage()
  const sign = owner.provider.signMessage
  owner.provider.signMessage = async () => new Uint8Array(64)
  await assert.rejects(preparePaymentKeys(owner), /verified/)
  owner.provider.signMessage = sign
  local.setItem = () => { throw new Error('Storage quota exceeded') }
  await assert.rejects(preparePaymentNote({ ...owner, keys: await preparePaymentKeys(owner), index: 0, protocol: 'cloakc', amount: '0.02', storage: local }), /quota/)
  assert.equal(local.length, 0)
})

function stubFetch(t, routes) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    for (const [pattern, reply] of routes) {
      if (pattern.test(String(url))) return new Response(JSON.stringify(await reply(String(url), init)))
    }
    throw new Error('Unexpected request ' + url)
  })
  return calls
}

test('a cold scan finds PrivacyCash notes by their derived IVs, with nothing stored', async (t) => {
  const owner = await wallet()
  const keys = await preparePaymentKeys(owner)
  const records = []
  for (const index of [0, 3]) records.push(await preparePaymentNote({ ...owner, keys, index, protocol: 'privacycash', amount: `0.0${index + 1}`, storage: storage() }))
  const usdc = await preparePaymentNote({ ...owner, keys, index: 4, protocol: 'privacycash', asset: 'USDC', amount: '2.5', storage: storage() })
  const stranger = await wallet()
  const theirs = await preparePaymentNote({ ...stranger, keys: await preparePaymentKeys(stranger), index: 0, protocol: 'privacycash', amount: '0.5', storage: storage() })
  const pool = [...theirs.invoice.outputs, ...records[0].invoice.outputs, { encryptedNote: 'ab'.repeat(80) }, ...records[1].invoice.outputs]
    .map((output) => output.encryptedNote)
  const calls = stubFetch(t, [
    [/utxos\/range/, (url) => {
      const params = new URL(url).searchParams
      const tree = { usdc: usdc.invoice.outputs.map((output) => output.encryptedNote), usdt: [] }[params.get('token')] ?? pool
      const start = Number(params.get('start')) - PRIVACYCASH_FIRST_OUTPUT[params.get('token')?.toUpperCase() ?? 'SOL']
      return { encrypted_outputs: tree.slice(start, start + 10000), hasMore: false }
    }],
    [/utxos\/indices/, (_url, init) => ({ indices: [JSON.parse(init.body).token === 'usdc' ? 7 : 42] })],
  ])
  const connection = { getAccountInfo: async () => null }
  const found = await scanPrivacyCashNotes({ keys, connection, toIndex: 5 })
  assert.deepEqual(found.map((item) => item.record.index), [0, 3, 4])
  assert.deepEqual(found.map((item) => item.spent), [false, false, false])
  records.push(usdc)
  for (const [position, item] of found.entries()) {
    assert.equal(JSON.stringify(item.record.invoice), JSON.stringify(records[position].invoice))
    assert.equal((await recoverPaymentNote({ ...owner, record: item.record, keys })).notes[0].amount.toString(), records[position].invoice.amount)
  }
  assert.equal(calls.filter((call) => call.url.includes('range')).length, 3)
})

test('PrivacyCash withdraw spends the known note through the SDK without scanning the pool', async (t) => {
  const owner = await wallet()
  const keys = await preparePaymentKeys(owner)
  const record = await preparePaymentNote({ ...owner, keys, index: 2, protocol: 'privacycash', amount: '0.02', storage: storage() })
  const calls = stubFetch(t, [
    [/merkle\/root/, () => ({ root: '1', nextIndex: 814000 })],
    [/\/config/, () => ({ withdraw_fee_rate: 0.0035, withdraw_rent_fee: 0.006 })],
    [/utxos\/range/, () => ({ encrypted_outputs: [], hasMore: false, total: 814000 })],
    [/utxos\/indices/, (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).encrypted_outputs, [record.invoice.outputs[0].encryptedNote])
      return { indices: [813950] }
    }],
    [/merkle\/proofv2/, () => { throw new Error('stop before proving') }],
  ])
  const connection = { getMultipleAccountsInfo: async (accounts) => accounts.map(() => null) }
  await assert.rejects(withdrawPaymentNotes({ ...owner, records: [record], keys, recipient: owner.address, connection }), /stop before proving/)
  const proof = new URL(calls.find((call) => call.url.includes('proofv2')).url)
  assert.equal(proof.searchParams.get('commitments').split(',')[0], record.invoice.outputs[0].commitment)
  assert.equal(new URL(calls.find((call) => call.url.includes('range')).url).searchParams.get('start'), '814000')
  await assert.rejects(withdrawPaymentNotes({ ...owner, records: [record], keys, recipient: 'notAnAddress', connection }), /Invalid Solana address/)
})

test('PrivacyCash withdraw spends two notes with different keys in one proof', async (t) => {
  const owner = await wallet()
  const keys = await preparePaymentKeys(owner)
  const records = [
    await preparePaymentNote({ ...owner, keys, index: 2, protocol: 'privacycash', amount: '0.02', storage: storage() }),
    await preparePaymentNote({ ...owner, keys, index: 3, protocol: 'privacycash', amount: '0.03', storage: storage() }),
  ]
  const calls = stubFetch(t, [
    [/merkle\/root/, () => ({ root: '1', nextIndex: 814000 })],
    [/\/config/, () => ({ withdraw_fee_rate: 0.0035, withdraw_rent_fee: 0.006 })],
    [/utxos\/range/, () => ({ encrypted_outputs: [], hasMore: false, total: 814000 })],
    [/utxos\/indices/, (_url, init) => ({ indices: JSON.parse(init.body).encrypted_outputs.map((_, position) => 813950 + position) })],
    [/merkle\/proofv2/, () => { throw new Error('stop before proving') }],
  ])
  const connection = { getMultipleAccountsInfo: async (accounts) => accounts.map(() => null) }
  await assert.rejects(withdrawPaymentNotes({ ...owner, records, keys, recipient: owner.address, connection }), /stop before proving/)
  const proof = new URL(calls.find((call) => call.url.includes('proofv2')).url)
  assert.deepEqual(proof.searchParams.get('commitments').split(',').sort(), records.map((record) => record.invoice.outputs[0].commitment).sort())
  const usdc = await preparePaymentNote({ ...owner, keys, index: 4, protocol: 'privacycash', asset: 'USDC', amount: '5', storage: storage() })
  await assert.rejects(withdrawPaymentNotes({ ...owner, records: [records[0], usdc], keys, recipient: owner.address, connection }), /one pool and asset/)
})

test('notes pair up by pool and asset, two per withdrawal', () => {
  const note = (id, protocol, asset) => ({ invoice: { id, protocol, asset } })
  const ids = (groups) => groups.map((group) => group.map((record) => record.invoice.id))
  assert.deepEqual(ids(pairNotes([note('a', 'privacycash', 'SOL'), note('b', 'cloakc', 'SOL'), note('c', 'privacycash', 'SOL'),
    note('d', 'privacycash', 'USDC'), note('e', 'privacycash', 'SOL'), note('f', 'cloakc', 'SOL')])), [['a', 'c'], ['e'], ['b', 'f'], ['d']])
  assert.deepEqual(pairNotes([]), [])
})
