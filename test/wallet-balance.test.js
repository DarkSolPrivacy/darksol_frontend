import test from 'node:test'
import assert from 'node:assert/strict'
import { SOL_FEE_RESERVE, spendableSolBalance } from '../src/wallet-balance.js'

test('SOL maximum keeps the network-fee reserve in the wallet', () => {
  assert.equal(SOL_FEE_RESERVE, 2_000_000n)
  assert.equal(spendableSolBalance(1_000_000n), 0n)
  assert.equal(spendableSolBalance(2_000_000n), 0n)
  assert.equal(spendableSolBalance(1_000_000_000n), 998_000_000n)
})
