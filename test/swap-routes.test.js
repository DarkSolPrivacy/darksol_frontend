import test from 'node:test'
import assert from 'node:assert/strict'
import { swapEligibility } from '../src/swap-routes.js'

test('Cloak supports only SOL to stablecoin swaps', () => {
  assert.equal(swapEligibility('cloakc', 'SOL', 'USDC').available, true)
  assert.equal(swapEligibility('cloakc', 'SOL', 'USDT').available, true)
  assert.match(swapEligibility('cloakc', 'USDC', 'SOL').reason, /only from SOL/)
})

// Its swap wallet pays the re-deposit's fee from SOL, so SOL is on one side.
test('PrivacyCash swaps between SOL and a stablecoin in both directions', () => {
  for (const [input, output] of [['USDC', 'SOL'], ['USDT', 'SOL'], ['SOL', 'USDC'], ['SOL', 'USDT']]) {
    assert.equal(swapEligibility('privacycash', input, output).available, true, `${input} -> ${output}`)
  }
  assert.match(swapEligibility('privacycash', 'USDC', 'USDT').reason, /to or from SOL/)
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
