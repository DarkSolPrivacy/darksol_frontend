import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountKeysFor } from '../protocols/shared/solana-flows.js'
import { custodyOwners, decode } from '../protocols/umbra/indexer.js'

// Real mainnet transactions that moved Umbra custody, in both directions, plus
// the flows the decoder produced for them. Third-party public transactions --
// none of these are our test identities.
const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => JSON.parse(readFileSync(resolve(here, 'fixtures', name), 'utf8'))
const transactions = read('umbra-transactions.json')
const expected = read('umbra-flows.json')

function decodeTransaction(tx) {
  const keys = accountKeysFor(tx)
  const flows = []
  for (const [index, ix] of (tx.transaction?.message?.instructions || []).entries()) {
    const flow = decode(tx, ix, keys, `o${index}`)
    if (flow) flows.push(flow)
  }
  for (const group of tx.meta?.innerInstructions || []) {
    for (const [index, ix] of (group.instructions || []).entries()) {
      const flow = decode(tx, ix, keys, `i${group.index}-${index}`)
      if (flow) flows.push(flow)
    }
  }
  return flows
}

test('umbra decodes its recorded mainnet transactions unchanged', () => {
  const decoded = transactions.flatMap(decodeTransaction)
  assert.deepEqual(decoded, expected)
})

test('withdrawals are decoded even though they settle in a callback', () => {
  // The regression this guards: Umbra settles through Arcium MPC, so the tokens
  // leave in a later transaction carrying only the ...Callback instruction. An
  // earlier probe filtered callbacks out as noise and reported zero withdrawals
  // over 90 days, which was wrong. If this ever returns 0 again, that filter has
  // come back.
  const withdrawals = expected.filter((flow) => flow.direction === 'withdraw')
  assert.ok(withdrawals.length > 0, 'no withdrawals decoded: the callback path has regressed')
  for (const flow of withdrawals) {
    assert.ok(Number(flow.amount) > 0, 'a withdrawal must carry a positive amount')
    assert.equal(flow.flowType, 'withdraw')
  }
})

test('both directions and more than one asset are covered', () => {
  const directions = new Set(expected.map((flow) => flow.direction))
  assert.deepEqual([...directions].sort(), ['deposit', 'withdraw'])
  assert.ok(new Set(expected.map((flow) => flow.asset)).size > 1, 'fixtures cover only one asset')
})

test('each settling transaction yields exactly one flow', () => {
  // Deposits carry the initiating instruction and withdrawals the callback, and
  // the two never share a transaction -- so a transaction that produced two
  // flows would mean the pool is being double counted.
  for (const tx of transactions) {
    const flows = decodeTransaction(tx)
    assert.ok(flows.length <= 1, `${tx.transaction.signatures[0]} decoded to ${flows.length} flows`)
  }
  assert.equal(new Set(expected.map((flow) => flow.id)).size, expected.length, 'duplicate flow ids')
})

test('custody pools are derived from the SDK, not hardcoded', () => {
  const owners = custodyOwners()
  assert.deepEqual(Object.keys(owners).sort(), ['SOL', 'USDC', 'USDT'])
  // Pinned so a change in derivation or program id is caught rather than
  // silently reading a different pool.
  assert.equal(owners.SOL, 'G4UZ3uHsYJWXgr4D1VhD3k9nNWtUGNih7SbfSbAErPMp')
  assert.equal(owners.USDC, '8yQJpcpmK6EMfCh4Gj28Xp785a6cHYyrvXX1FAh1zdKT')
  assert.equal(owners.USDT, 'A3HLhp1EsmjqFVix7jdbgXZVjMJkGxoincZUz6C93Xrn')
})

test('a foreign instruction is ignored', () => {
  const [tx] = transactions
  const keys = accountKeysFor(tx)
  const foreign = { programId: '11111111111111111111111111111111', data: '3Bxs4h24hBtQy9rw', accounts: [] }
  assert.equal(decode(tx, foreign, keys, 'o0'), null)
})
