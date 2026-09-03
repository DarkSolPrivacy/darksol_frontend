import test from 'node:test'
import assert from 'node:assert/strict'
import { swapEligibility } from '../src/swap-routes.js'

test('Cloak supports only SOL to stablecoin swaps', () => {
  assert.equal(swapEligibility('cloakc', 'SOL', 'USDC').available, true)
  assert.equal(swapEligibility('cloakc', 'SOL', 'USDT').available, true)
  assert.match(swapEligibility('cloakc', 'USDC', 'SOL').reason, /only from SOL/)
})

test('PrivacyCash documented swaps remain visible but unavailable without a public SDK method', () => {
  const route = swapEligibility('privacycash', 'USDC', 'SOL')
  assert.equal(route.available, false)
  assert.equal(route.reason, 'SOON')
})

test('Curvy supports both directions for configured vault assets', () => {
  assert.equal(swapEligibility('curvy', 'SOL', 'USDC').available, true)
  assert.equal(swapEligibility('curvy', 'USDC', 'SOL').available, true)
  assert.equal(swapEligibility('curvy', 'USDC', 'USDT').available, true)
})

test('same-asset routes remain transfers for every provider', () => {
  for (const protocol of ['cloakc', 'privacycash', 'curvy']) {
    assert.deepEqual(swapEligibility(protocol, 'SOL', 'SOL').available, true)
    assert.equal(swapEligibility(protocol, 'SOL', 'SOL').kind, 'transfer')
  }
})
