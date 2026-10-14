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
