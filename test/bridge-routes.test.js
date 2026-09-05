import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_CHAINS, bridgeEligibility, bridgeMinimumBaseUnits,
  bridgeNetBaseUnits, bridgeTokensFor, validateBridgeAddress,
} from '../src/bridge-routes.js'

// Shape mirrors https://api3.privacycash.org/config so the fee arithmetic is
// exercised against the field names the relayer actually returns.
const CONFIG = {
  withdraw_fee_rate: 0.0035,
  rent_fees: { sol: 0.006, usdc: 0.6251424713639534, usdt: 0.6250790777270377 },
  minimum_withdrawal: { sol: 0.01, usdc: 2, usdt: 2 },
  prices: { sol: 104.17296, usdc: 0.9998325, usdt: 0.9999339 },
}

test('only PrivacyCash exposes an executable bridge', () => {
  assert.equal(bridgeEligibility('privacycash', 'USDC', 'ethereum', 'USDC').available, true)
  // Cloak is Solana-only: its SDK and Shield Pool program have no bridge surface.
  assert.equal(bridgeEligibility('cloakc', 'USDC', 'ethereum', 'USDC').available, false)
  assert.match(bridgeEligibility('cloakc', 'USDC', 'ethereum', 'USDC').reason, /Solana-only/)
  // Curvy bridges through LI.FI but has no browser path in this app.
  assert.equal(bridgeEligibility('curvy', 'USDC', 'ethereum', 'USDC').reason, 'SOON')
})

test('destination tokens are constrained per chain', () => {
  assert.equal(bridgeEligibility('privacycash', 'USDC', 'base', 'USDC').available, true)
  // Base receives ETH and USDC only.
  const blocked = bridgeEligibility('privacycash', 'USDC', 'base', 'USDT')
  assert.equal(blocked.available, false)
  assert.match(blocked.reason, /Base does not receive USDT/)
  assert.deepEqual(bridgeTokensFor('bitcoin'), ['BTC'])
  assert.equal(bridgeEligibility('privacycash', 'SOL', 'nope', 'USDC').available, false)
})

test('bridge input is limited to the pool assets that can leave Solana', () => {
  assert.equal(bridgeEligibility('privacycash', 'DAI', 'ethereum', 'DAI').available, false)
  assert.match(bridgeEligibility('privacycash', 'DAI', 'ethereum', 'DAI').reason, /SOL, USDC, USDT/)
})

test('recipient addresses are validated against the destination chain', () => {
  const evm = '0x' + 'a'.repeat(40)
  assert.equal(validateBridgeAddress(evm, 'ethereum').valid, true)
  assert.equal(validateBridgeAddress(evm, 'pol').valid, true)
  // A Solana address must not pass as an EVM recipient.
  assert.equal(validateBridgeAddress('So11111111111111111111111111111111111111112', 'ethereum').valid, false)
  // Nor an EVM address as a Bitcoin recipient.
  assert.equal(validateBridgeAddress(evm, 'bitcoin').valid, false)
  assert.equal(validateBridgeAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'bitcoin').valid, true)
  assert.equal(validateBridgeAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'bitcoin').valid, true)
  assert.equal(validateBridgeAddress('', 'ethereum').error, 'Enter an address')
  assert.match(validateBridgeAddress(evm, 'unknown-chain').error, /destination chain/)
})

test('the relayer is quoted the net amount, not the gross withdrawal', () => {
  // 100 USDC gross: 0.35% rate fee plus the published USDC rent fee.
  const { netBaseUnits, rateFeeBaseUnits, rentFeeBaseUnits } = bridgeNetBaseUnits(100_000_000n, 'USDC', CONFIG)
  assert.equal(rateFeeBaseUnits, 350_000n)
  assert.equal(rentFeeBaseUnits, 625_142n)
  assert.equal(netBaseUnits, 100_000_000n - 350_000n - 625_142n)
  assert.ok(netBaseUnits < 100_000_000n)
})

test('an amount that cannot cover the withdrawal fee is rejected', () => {
  assert.throws(() => bridgeNetBaseUnits(1000n, 'USDC', CONFIG), /does not cover/)
  assert.throws(() => bridgeNetBaseUnits(100_000_000n, 'DAI', CONFIG), /Unsupported bridge asset/)
  assert.throws(() => bridgeNetBaseUnits(100_000_000n, 'USDC', {}), /withdrawal fee rate/)
})

test('the minimum is the larger of the withdrawal floor and 0.05 SOL of value', () => {
  // 0.05 SOL is the bridge floor and exceeds the 0.01 SOL withdrawal minimum.
  assert.equal(bridgeMinimumBaseUnits('SOL', CONFIG), 50_000_000n)
  // 0.05 SOL of USDC (~5.21) exceeds the flat 2 USDC withdrawal minimum.
  const usdc = bridgeMinimumBaseUnits('USDC', CONFIG)
  assert.ok(usdc > 2_000_000n, `expected the SOL-equivalent floor to win, got ${usdc}`)
  // Without prices the per-token withdrawal minimum is the fallback.
  assert.equal(bridgeMinimumBaseUnits('USDC', { minimum_withdrawal: { usdc: 2 } }), 2_000_000n)
})

test('every chain row is usable by the picker', () => {
  for (const chain of BRIDGE_CHAINS) {
    assert.ok(chain.tokens.length > 0, `${chain.id} has no destination tokens`)
    assert.ok(chain.label && chain.name, `${chain.id} is missing display text`)
    assert.ok(['evm', 'bitcoin'].includes(chain.addressKind), `${chain.id} has no address validator`)
    // The first token is what the picker falls back to when switching chains.
    assert.equal(bridgeEligibility('privacycash', 'USDC', chain.id, chain.tokens[0]).available, true)
  }
})
