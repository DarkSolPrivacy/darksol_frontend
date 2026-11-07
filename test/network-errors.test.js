import assert from 'node:assert/strict'
import test from 'node:test'
import { explainFailure, isNoAnswer } from '../protocols/shared/network.js'
import { labelRelayerFailures, relayerFailure } from '../protocols/privacycash/browser.js'

const relayer = (path) => new URL(`https://api3.privacycash.org${path}`)

test('a request with no answer says what was being reached, in every browser', () => {
  for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
    assert.equal(isNoAnswer(new TypeError(message)), true)
    assert.match(explainFailure(message), /^A request got no answer/)
  }
  assert.equal(isNoAnswer(new Error('Failed to fetch')), false, 'only the browser’s TypeError')
  assert.equal(explainFailure('failed to get balance of account 6dyG: TypeError: Failed to fetch'),
    'Could not reach the Solana network (get balance of account 6dyG). Check your connection and try again.')
  assert.equal(explainFailure('Deposit succeeded, but withdrawal 1 failed: Failed to fetch'),
    'Deposit succeeded, but withdrawal 1 failed: no answer from the network.', 'what already went through is kept')
  assert.equal(explainFailure('Not enough USDT in the connected wallet'), 'Not enough USDT in the connected wallet')
  assert.match(explainFailure('403 Forbidden'), /RPC access was denied/)
})

test('a relayer failure says whether anything may have moved', () => {
  assert.match(relayerFailure(relayer('/withdraw/spl'), 'POST'), /while it submitted the withdrawal\. It may still have gone through/)
  assert.match(relayerFailure(relayer('/deposit'), 'POST'), /submitted your deposit/)
  assert.match(relayerFailure(relayer('/utxos/check/ab12?token=usdt')), /^Privacy Cash accepted the transaction/)
  assert.equal(relayerFailure(relayer('/utxos/range?token=usdt&start=0&end=10000')),
    'Could not reach the Privacy Cash relayer (api3.privacycash.org) while reading your shielded notes, so nothing was sent at that step.')
  assert.match(relayerFailure(relayer('/utxos/indices'), 'POST'), /reading your shielded notes, so nothing was sent/, 'a POST that only reads')
  assert.match(relayerFailure(relayer('/merkle/root?token=usdt')), /reading the pool state/)
})

test('only relayer requests that got no answer are relabelled', async () => {
  const calls = []
  const target = { fetch: async (input, init) => { calls.push(String(input)); if (String(input).includes('down')) throw new TypeError('Failed to fetch'); return 'ok' } }
  labelRelayerFailures(target)
  const labelled = target.fetch
  labelRelayerFailures(target)
  assert.equal(target.fetch, labelled, 'installed once')
  assert.equal(await target.fetch('https://api3.privacycash.org/config'), 'ok')
  await assert.rejects(target.fetch('https://api3.privacycash.org/withdraw?down', { method: 'post' }), /dropped while it submitted the withdrawal/)
  await assert.rejects(target.fetch('https://api3.privacycash.org/merkle/root?down'), (error) => error.message.includes('reading the pool state') && error.cause instanceof TypeError)
  await assert.rejects(target.fetch('https://example.com/?down'), { name: 'TypeError', message: 'Failed to fetch' })
  assert.equal(calls.length, 4)
})

test('a wallet that cannot pay the network fee is told so in plain words', () => {
  // Umbra v2's SDK, before anything is signed: no account at all, and too few lamports.
  const missing = explainFailure("the connected wallet pays this flow's transaction fee and has no account on the cluster, so Solana would refuse it as AccountNotFound; it needs 900880 lamports; nothing was proved, asked of the committee, signed or sent")
  assert.match(missing, /^This wallet has no SOL for network fees: this step needs 0\.000901 SOL\./)
  const few = explainFailure("the connected wallet holds 1000000 lamports and paying for this flow's transactions requires 3039280; nothing was proved, asked of the committee, signed or sent")
  assert.match(few, /^Not enough SOL for network fees: this step needs 0\.00304 SOL/)
  assert.match(few, /the wallet has 0\.001 SOL/)
  // Solana's own refusals, from any pool.
  for (const message of ['Simulation failed: Attempt to debit an account but found no record of a prior credit.', 'insufficient lamports 5000, need 10000', 'InsufficientFundsForFee']) {
    assert.match(explainFailure(message), /^Not enough SOL to pay the network fee/, message)
  }
  // A lamport count with 403 in it is not an RPC refusal.
  assert.doesNotMatch(explainFailure('the connected wallet holds 1403000 lamports and paying for this flow\'s transactions requires 2403000; nothing was proved'), /RPC access/)
  assert.match(explainFailure('Request failed with status code 403'), /RPC access was denied/)
})

test("a wallet refusing to sign for an account that has not connected the site says what to do", () => {
  assert.match(explainFailure('the wallet failed to sign transactions: Error: The requested method and/or account has not been authorized by the user.'), /switch to the account shown at the top right/)
})
