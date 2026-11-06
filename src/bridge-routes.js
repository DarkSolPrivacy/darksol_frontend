// Private bridging route table and eligibility.
//
// PrivacyCash bridging is NOT a distinct SDK primitive the way a swap would be.
// The relayer hands out a one-time Solana deposit address and the bridge is then
// an ordinary private withdrawal whose recipient is that address:
//
//   1. POST {step:'quote'}   -> quote.depositAddress
//   2. withdraw/withdrawSPL  -> recipient = depositAddress   (the SDK call we already ship)
//   3. POST {step:'send_tx'} -> relayer releases on the destination chain
//
// Cross-chain settlement is executed by a NEAR Intents market maker, not Jupiter,
// so this path is independent of the swap route table in `swap-routes.js`.
// Source: https://privacycash.mintlify.app/sdk/bridge

import { BRIDGE_CAPABILITIES, PROTOCOLS } from '../protocols/registry.js'
import { decimalsFor } from '../protocols/shared/units.js'

export { BRIDGE_CAPABILITIES }

// The relayer is PrivacyCash infrastructure, so its URLs come from that
// protocol's manifest rather than being retyped here.
export const BRIDGE_RELAYER_URL = PROTOCOLS.privacycash.services.bridgeRelayer
export const BRIDGE_CONFIG_URL = PROTOCOLS.privacycash.services.bridgeConfig

// Assets that can leave the PrivacyCash Solana pool as bridge input.
export const BRIDGE_INPUT_ASSETS = Object.freeze(['SOL', 'USDC', 'USDT'])

// The relayer rejects any pair outside this table, so the picker is built from it
// rather than from a free-form chain list. `id` values are the literal API
// identifiers -- note Polygon is `pol`, not `polygon`.
//
// The live PrivacyCash app additionally shows Robinhood, Arbitrum, Tron, Zcash and
// Hyperliquid chips. Those are absent from the documented route map, so they are
// left out here rather than offered as pairs the relayer would refuse. Add a row
// once a route is confirmed against the relayer.
export const BRIDGE_CHAINS = Object.freeze([
  Object.freeze({ id: 'ethereum', label: 'eth', name: 'Ethereum', addressKind: 'evm', tokens: Object.freeze(['ETH', 'USDC', 'USDT', 'DAI']) }),
  Object.freeze({ id: 'bnb', label: 'bnb', name: 'BNB Chain', addressKind: 'evm', tokens: Object.freeze(['BNB', 'USDC', 'USDT']) }),
  Object.freeze({ id: 'base', label: 'base', name: 'Base', addressKind: 'evm', tokens: Object.freeze(['ETH', 'USDC']) }),
  Object.freeze({ id: 'pol', label: 'poly', name: 'Polygon', addressKind: 'evm', tokens: Object.freeze(['POL', 'USDC', 'USDT']) }),
  Object.freeze({ id: 'bitcoin', label: 'btc', name: 'Bitcoin', addressKind: 'bitcoin', tokens: Object.freeze(['BTC']) }),
])

// A token DarkSol knows is not automatically a token this relayer accepts as
// bridge input, so the asset is checked against the bridge list rather than
// just the decimals table.
function bridgeDecimals(asset) {
  if (!BRIDGE_INPUT_ASSETS.includes(String(asset).toUpperCase())) throw new Error('Unsupported bridge asset')
  return decimalsFor(asset)
}

export function bridgeChain(chainId) {
  return BRIDGE_CHAINS.find((chain) => chain.id === chainId) || null
}

export function bridgeTokensFor(chainId) {
  return bridgeChain(chainId)?.tokens || []
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
// Bech32 (bc1...) plus legacy P2PKH/P2SH, matching the relayer's documented rules.
const BTC_BECH32 = /^bc1[02-9ac-hj-np-z]{11,71}$/
const BTC_LEGACY = /^[13][1-9A-HJ-NP-Za-km-z]{25,39}$/

export function sanitizeBridgeAddress(value) {
  return String(value ?? '').normalize('NFKC').trim()
}

// The relayer validates the recipient against the destination chain and only
// reports the mismatch after a quote round-trip, so the same rules are enforced
// locally before the user is asked to sign anything.
export function validateBridgeAddress(value, chainId) {
  const sanitized = sanitizeBridgeAddress(value)
  const chain = bridgeChain(chainId)
  if (!chain) return { valid: false, sanitized, error: 'Choose a destination chain' }
  if (!sanitized) return { valid: false, sanitized, error: 'Enter an address' }
  if (/\s/.test(sanitized)) return { valid: false, sanitized, error: 'Address contains spaces' }
  if (chain.addressKind === 'evm') {
    return EVM_ADDRESS.test(sanitized)
      ? { valid: true, sanitized }
      : { valid: false, sanitized, error: `Enter a ${chain.name} address (0x followed by 40 hex characters)` }
  }
  if (chain.addressKind === 'bitcoin') {
    return BTC_BECH32.test(sanitized) || BTC_LEGACY.test(sanitized)
      ? { valid: true, sanitized }
      : { valid: false, sanitized, error: 'Enter a Bitcoin address (bc1..., or a legacy 1.../3... address)' }
  }
  return { valid: false, sanitized, error: 'Unsupported destination chain' }
}

export function bridgeEligibility(protocol, inputAsset, chainId, outputToken) {
  const input = String(inputAsset || '').toUpperCase()
  const capability = BRIDGE_CAPABILITIES[protocol]
  if (!capability) return { available: false, reason: 'This provider has no configured bridge integration.' }
  if (capability.execution === 'unsupported') return { available: false, kind: 'bridge', capability, reason: capability.note }
  if (capability.execution === 'documented-only') return { available: false, kind: 'bridge', capability, reason: `${PROTOCOLS[protocol]?.name ?? protocol} documents bridging, but DarkSol cannot run it.` }
  if (!BRIDGE_INPUT_ASSETS.includes(input)) {
    return { available: false, kind: 'bridge', capability, reason: `Bridging is supported from ${BRIDGE_INPUT_ASSETS.join(', ')} only.` }
  }
  const chain = bridgeChain(chainId)
  if (!chain) return { available: false, kind: 'bridge', capability, reason: 'Choose a destination chain.' }
  const token = String(outputToken || '').toUpperCase()
  if (!chain.tokens.includes(token)) {
    return { available: false, kind: 'bridge', capability, reason: `${chain.name} does not receive ${token || 'that token'}.` }
  }
  return { available: true, kind: 'bridge', capability, chain, outputToken: token }
}

// Relayer fee model, mirroring the arithmetic in PrivacyCash's own bridge guide:
// a rate fee on the amount plus a flat per-recipient rent fee. The relayer must be
// quoted the NET amount it will actually receive, while the SDK withdrawal is
// still called with the GROSS amount.
export function bridgeNetBaseUnits(grossBaseUnits, asset, config) {
  const decimals = bridgeDecimals(asset)
  const unitsPerToken = 10 ** decimals
  const feeRate = Number(config?.withdraw_fee_rate)
  if (!Number.isFinite(feeRate) || feeRate < 0) throw new Error('Relayer did not report a withdrawal fee rate')
  const rentFee = Number(config?.rent_fees?.[String(asset).toLowerCase()] ?? 0)
  const rateFeeBaseUnits = BigInt(Math.floor(Number(grossBaseUnits) * feeRate))
  const rentFeeBaseUnits = BigInt(Math.floor(unitsPerToken * (Number.isFinite(rentFee) ? rentFee : 0)))
  const netBaseUnits = BigInt(grossBaseUnits) - rateFeeBaseUnits - rentFeeBaseUnits
  if (netBaseUnits <= 0n) throw new Error('Amount does not cover the PrivacyCash withdrawal fee')
  return { netBaseUnits, rateFeeBaseUnits, rentFeeBaseUnits, decimals, unitsPerToken }
}

// The bridge needs roughly 0.05 SOL of value to cover cross-chain execution. The
// relayer publishes live prices, so the floor is derived rather than hardcoded per
// asset, and falls back to the plain per-token withdrawal minimum when a price is
// missing.
export const BRIDGE_MINIMUM_SOL_EQUIVALENT = 0.05

export function bridgeMinimumBaseUnits(asset, config) {
  const key = String(asset).toLowerCase()
  const decimals = bridgeDecimals(asset)
  const unitsPerToken = 10 ** decimals
  const withdrawalMinimum = Number(config?.minimum_withdrawal?.[key] ?? 0)
  const solPrice = Number(config?.prices?.sol)
  const assetPrice = Number(config?.prices?.[key])
  const bridgeFloor = Number.isFinite(solPrice) && Number.isFinite(assetPrice) && assetPrice > 0
    ? (BRIDGE_MINIMUM_SOL_EQUIVALENT * solPrice) / assetPrice
    : 0
  const minimum = Math.max(Number.isFinite(withdrawalMinimum) ? withdrawalMinimum : 0, bridgeFloor)
  return BigInt(Math.ceil(minimum * unitsPerToken))
}
