import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountKeysFor } from '../protocols/shared/solana-flows.js'
import { loadIndexer } from '../protocols/load.js'
import { listProtocols } from '../protocols/registry.js'

// Real mainnet transactions, plus the flows the decoders produced for them
// before the decode logic moved out of server/index.js into the protocol
// folders. Nothing here is a test identity: these are third-party public
// transactions captured from the Cloak and PrivacyCash programs.
const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => JSON.parse(readFileSync(resolve(here, 'fixtures', name), 'utf8'))
const transactions = read('solana-transactions.json')
const expected = read('solana-flows.json')

// The same instruction walk server/index.js performs.
async function decodeTransaction(protocol, tx) {
  if (!tx?.blockTime || tx.meta?.err) return []
  const keys = accountKeysFor(tx)
  const { decode } = await loadIndexer(protocol)
  const outer = tx.transaction?.message?.instructions || []
  const flows = outer.map((ix, index) => decode(tx, ix, keys, `o${index}`)).filter(Boolean)
  for (const group of tx.meta?.innerInstructions || []) {
    group.instructions?.forEach((ix, index) => {
      const flow = decode(tx, ix, keys, `i${group.index}-${index}`)
      if (flow) flows.push(flow)
    })
  }
  return flows
}

for (const protocol of Object.keys(transactions)) {
  test(`${protocol} decodes its recorded mainnet transactions unchanged`, async () => {
    const decoded = []
    for (const tx of transactions[protocol]) decoded.push(...await decodeTransaction(protocol, tx))
    assert.deepEqual(decoded, expected[protocol])
  })
}

test('the fixtures cover every flow type the decoders can emit', () => {
  const kinds = new Set(Object.values(expected).flat().map((flow) => flow.flowType))
  // swap_out exercises the branch that reads the output mint out of the proof
  // payload, which is the easiest one to break in a refactor.
  for (const kind of ['deposit', 'withdraw', 'swap_out']) {
    assert.ok(kinds.has(kind), `no ${kind} flow in the fixtures`)
  }
  const swap = expected.cloakc.find((flow) => flow.flowType === 'swap_out')
  assert.equal(swap.counterAsset, 'USDC')
  assert.equal(swap.direction, 'withdraw')
})

test('a foreign instruction is ignored by every decoder', async () => {
  const [tx] = transactions.cloakc
  const keys = accountKeysFor(tx)
  for (const { id } of listProtocols({ lane: 'solana' })) {
    const { decode } = await loadIndexer(id)
    // System program, never one of ours.
    const foreign = { programId: '11111111111111111111111111111111', data: '3Bxs4h24hBtQy9rw', accounts: [] }
    assert.equal(decode(tx, foreign, keys, 'o0'), null)
  }
})

test('every Solana-lane protocol exposes a decoder', async () => {
  for (const { id } of listProtocols({ lane: 'solana' })) {
    const indexer = await loadIndexer(id)
    assert.equal(indexer.lane, 'solana')
    assert.equal(typeof indexer.decode, 'function', `${id} has no decode()`)
  }
})
