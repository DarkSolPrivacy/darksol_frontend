import test from 'node:test'
import assert from 'node:assert/strict'
import { swapEligibility } from '../src/swap-routes.js'

// Privacy Cash and Umbra v2 swap in a one-time wallet, and between two tokens
// Jupiter pays the recipient directly, so they swap every pair of SOL, USDC
// and USDT. Cloak swaps from SOL only.
test('Privacy Cash and Umbra v2 swap every pair of SOL, USDC and USDT; Cloak from SOL', () => {
  assert.equal(swapEligibility('cloakc', 'SOL', 'USDC').available, true)
  assert.equal(swapEligibility('cloakc', 'SOL', 'USDT').available, true)
  assert.match(swapEligibility('cloakc', 'USDC', 'SOL').reason, /only from SOL/)
  const pairs = [['SOL', 'USDC'], ['SOL', 'USDT'], ['USDC', 'SOL'], ['USDT', 'SOL'], ['USDC', 'USDT'], ['USDT', 'USDC']]
  for (const protocol of ['privacycash', 'umbrav2']) {
    for (const [input, output] of pairs) {
      const route = swapEligibility(protocol, input, output)
      assert.equal(route.available, true, `${protocol} ${input} -> ${output}: ${route.reason}`)
      assert.equal(route.kind, 'swap')
    }
  }
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
