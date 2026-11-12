import assert from 'node:assert/strict'
import test from 'node:test'
import { TransactionExpiredBlockheightExceededError } from '@solana/web3.js'
import { confirmByPolling, pollingConnection } from '../protocols/shared/http-confirm.js'

// An RPC that answers each status read from `statuses` in turn (the last repeats)
// and a block height that rises by `step` per read.
function fakeRpc({ statuses, height = 100, step = 0, failFirst = 0 }) {
  const calls = []
  let reads = 0
  return {
    calls,
    getSignatureStatuses: async (signatures, config) => {
      calls.push(['status', signatures, config])
      if (reads < failFirst) { reads++; throw new TypeError('Failed to fetch') }
      const status = statuses[Math.min(reads++ - failFirst, statuses.length - 1)]
      return { context: { slot: 7 }, value: [status] }
    },
    getBlockHeight: async () => { calls.push(['height']); height += step; return height },
  }
}
const quick = { sleep: async () => {} }
const strategy = { signature: 'Sig', blockhash: 'B', lastValidBlockHeight: 150 }

test('resolves as soon as the signature reaches the commitment, as web3.js would', async () => {
  const rpc = fakeRpc({ statuses: [null, { confirmationStatus: 'processed' }, { confirmationStatus: 'confirmed' }] })
  assert.deepEqual(await confirmByPolling(rpc, strategy, 'confirmed', quick), { context: { slot: 7 }, value: { err: null } })
  assert.equal(rpc.calls.filter(([name]) => name === 'status').length, 3)
  // Processed is not confirmed; finalized waits for finalized.
  const final = fakeRpc({ statuses: [{ confirmationStatus: 'confirmed' }, { confirmationStatus: 'finalized' }] })
  await confirmByPolling(final, strategy, 'finalized', quick)
  assert.equal(final.calls.filter(([name]) => name === 'status').length, 2)
})

test('a failed transaction resolves with its error, which the caller checks', async () => {
  const err = { InstructionError: [0, { Custom: 4128 }] }
  const result = await confirmByPolling(fakeRpc({ statuses: [{ confirmationStatus: 'confirmed', err }] }), strategy, 'confirmed', quick)
  assert.deepEqual(result.value, { err })
})

test('an expired blockhash throws web3.js\'s own error, unless the transaction landed meanwhile', async () => {
  const lost = fakeRpc({ statuses: [null], height: 140, step: 5 })
  await assert.rejects(confirmByPolling(lost, strategy, 'confirmed', quick), (error) => error instanceof TransactionExpiredBlockheightExceededError && /block height exceeded/i.test(error.message))
  // The last look searches the history, as the transaction may have landed late.
  assert.deepEqual(lost.calls.at(-1), ['status', ['Sig'], { searchTransactionHistory: true }])
  const late = fakeRpc({ statuses: [null, { confirmationStatus: 'confirmed' }], height: 151 })
  assert.equal((await confirmByPolling(late, strategy, 'confirmed', quick)).value.err, null)
})

test('a read that fails is asked again, and an aborted confirmation stops', async () => {
  const flaky = fakeRpc({ statuses: [{ confirmationStatus: 'confirmed' }], failFirst: 2 })
  assert.equal((await confirmByPolling(flaky, strategy, 'confirmed', quick)).value.err, null)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(confirmByPolling(fakeRpc({ statuses: [null] }), { ...strategy, abortSignal: controller.signal }, 'confirmed', quick), { name: 'AbortError' })
})

test('the connection polls for a blockhash strategy and leaves every other form to web3.js', async () => {
  const connection = pollingConnection('https://rpc.invalid/', 'confirmed')
  connection.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed' }] })
  connection.getBlockHeight = async () => 10
  assert.deepEqual((await connection.confirmTransaction(strategy)).value, { err: null })
  // A durable nonce, or the deprecated bare signature, takes web3.js's path (here: its own errors).
  await assert.rejects(connection.confirmTransaction({ signature: 'Sig', nonceValue: 'n', nonceAccountPubkey: 'x', minContextSlot: 1 }))
})
