// NEAR Confidential Intents in the frontend: the derived account key, the
// versioned nonce and login, what an unshield may sign, and CI as a ranked
// send option. node --test test/nearci.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'
import { KEY_MESSAGE_TEXT, accountFromSeed, loginPayload, seedFromSignature, versionedNonce } from '../protocols/nearci/account.js'
import { TOKENS, TREASURY, checkUnshieldIntent } from '../protocols/nearci/intent.js'
import { PROTOCOLS, listProtocols } from '../protocols/registry.js'
import { validateManifest } from '../protocols/schema.js'
import { QUOTE_POOLS, SOON_POOLS, poolFee, sendOptions } from '../src/send-options.js'

const signature = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256)

test('the account key is derived from the wallet signature, the same every time', () => {
  const one = accountFromSeed(seedFromSignature(signature))
  const two = accountFromSeed(seedFromSignature(Uint8Array.from(signature)))
  assert.equal(one.id, two.id)
  assert.match(one.id, /^[0-9a-f]{64}$/)
  assert.equal(one.publicKey, `ed25519:${bs58.encode(Buffer.from(one.id, 'hex'))}`)
  const other = accountFromSeed(seedFromSignature(signature.map((byte, i) => i === 0 ? byte ^ 1 : byte)))
  assert.notEqual(other.id, one.id)
  assert.throws(() => seedFromSignature(new Uint8Array(10)), /invalid signature/)
  assert.match(KEY_MESSAGE_TEXT, /Sign it only on https:\/\/darksol\.app/)
})

test('signedData is a raw_ed25519 signature of the payload, verifiable with the account key', () => {
  const account = accountFromSeed(seedFromSignature(signature))
  const signed = account.signedData('{"hello":1}')
  assert.equal(signed.standard, 'raw_ed25519')
  assert.equal(signed.public_key, account.publicKey)
  const raw = bs58.decode(signed.signature.slice('ed25519:'.length))
  assert.ok(ed25519.verify(raw, new TextEncoder().encode('{"hello":1}'), Buffer.from(account.id, 'hex')))
})

test('the versioned nonce carries the magic, the salt, the deadline and the time, as the intents SDK writes it', () => {
  const nonce = Buffer.from(versionedNonce({ salt: '252812b3', deadlineMs: 1_794_157_800_000, nowMs: 1_794_157_740_000, random: Uint8Array.from([1, 2, 3, 4, 5, 6, 7]) }), 'base64')
  assert.equal(nonce.length, 32)
  assert.deepEqual([...nonce.subarray(0, 9)], [0x56, 0x28, 0xf6, 0xc6, 0, 0x25, 0x28, 0x12, 0xb3])
  assert.equal(nonce.readBigUInt64LE(9), 1_794_157_800_000n * 1_000_000n)
  assert.equal(nonce.readBigInt64LE(17), 1_794_157_740_000n * 1_000_000n)
  assert.deepEqual([...nonce.subarray(25)], [1, 2, 3, 4, 5, 6, 7])
  const login = JSON.parse(loginPayload({ id: 'ab'.repeat(32), salt: '252812b3', nowMs: 1_794_157_740_000, random: new Uint8Array(7) }))
  assert.deepEqual(Object.keys(login), ['signer_id', 'verifying_contract', 'deadline', 'nonce', 'intents'])
  assert.deepEqual([login.signer_id, login.verifying_contract, login.deadline, login.intents], ['ab'.repeat(32), 'intents.near', '2026-11-08T17:10:00.000Z', []])
})

test('an unshield signs only the transfer its quote described', () => {
  const signer = 'c9bd56f3e11c2ca77036119870ee21b9feea231953f4bfddd7b12f1928c8be4a'
  const receiver = 'cfd629a064e4591fff8ea6b37067a64d8aaa91bed81aa6436d39a10d9415e21f'
  const now = Date.parse('2026-11-08T18:10:00Z')
  // The intent 1Click generated for the 2026-11-08 unshield of 1 USDT.
  const real = { verifying_contract: 'intents.far', signer_id: signer, deadline: '2026-11-11T18:09:55.770Z', nonce: 'Vij2xgDhEPMXgAKETAYQ5xgYE/6QYAlx9DjfVBc/19o=',
    intents: [{ intent: 'transfer', receiver_id: receiver, tokens: { [`imt:${TREASURY}:${TOKENS.USDT}`]: '1000000' } }] }
  const expect = { signer, receiver, asset: 'USDT', units: 1_000_000n, now }
  assert.equal(checkUnshieldIntent(JSON.stringify(real), expect).signer_id, signer)
  const altered = (patch) => JSON.stringify({ ...real, ...patch })
  const transfer = (patch) => altered({ intents: [{ ...real.intents[0], ...patch }] })
  for (const [why, payload] of [
    ['another receiver', transfer({ receiver_id: 'f'.repeat(64) })],
    ['another amount', transfer({ tokens: { [`imt:${TREASURY}:${TOKENS.USDT}`]: '9000000' } })],
    ['another token', transfer({ tokens: { [`imt:${TREASURY}:${TOKENS.USDC}`]: '1000000' } })],
    ['not one token', transfer({ tokens: { [`imt:${TREASURY}:${TOKENS.USDT}`]: '1000000', [`imt:${TREASURY}:${TOKENS.SOL}`]: '1' } })],
    ['not one transfer', altered({ intents: [real.intents[0], real.intents[0]] })],
    ['another signer', altered({ signer_id: 'e'.repeat(64) })],
    ['unknown contract', altered({ verifying_contract: 'evil.near' })],
    ['deadline', altered({ deadline: '2027-01-01T00:00:00Z' })],
    ['another receiver', transfer({ intent: 'ft_withdraw' })],
  ]) assert.throws(() => checkUnshieldIntent(payload, expect), new RegExp(why), why)
  assert.throws(() => checkUnshieldIntent('not json', expect), /not JSON/)
})

test('CI is registered but planned: shown as Soon, never ranked, even when the quote measures it', () => {
  assert.deepEqual(validateManifest(PROTOCOLS.nearci), { valid: true, errors: [] })
  assert.equal(PROTOCOLS.nearci.status, 'planned')
  assert.ok(!listProtocols().some(({ id }) => id === 'nearci'), 'not a live pool: no balance read, no pool lists')
  assert.deepEqual(SOON_POOLS, ['nearci'])
  assert.ok(!QUOTE_POOLS.includes('nearci'))
  const prices = { USDC: 1, USDT: 1, SOL: 100 }
  assert.equal(poolFee('nearci', 'USDC', 25_000_000n, prices), 10_005n)
  assert.equal(poolFee('nearci', 'SOL', 10n ** 9n, prices), 112_297n)
  const cell = (strategy, wait, sends, traced) => ({ strategy, wait, bucket: '10-100', planned: sends, sends, traced })
  const quote = {
    asset: 'USDC', buckets: ['1-10', '10-100', '100-1000', '1000-10000'],
    pools: {
      nearci: { cells: [cell('exact', 'now', 300, 300), cell('keep', '6h', 270, 90), cell('keep', '24h', 270, 3), cell('balance', 'now', 300, 0)], popular: [{ amount: '30000000', deposits: 9 }] },
    },
  }
  // The backend still returns a nearci pool; the page ignores it.
  assert.deepEqual(sendOptions({ quote, asset: 'USDC', raw: 25_000_000n, prices, shielded: { nearci: 100_000_000n } }).options, [])
})
