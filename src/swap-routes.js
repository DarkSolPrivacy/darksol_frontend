// Private-swap eligibility.
//
// The capability table itself now lives in each protocol's manifest and is
// derived by protocols/registry.js, so a new protocol declares its swap support
// in its own folder instead of being added to a literal here.
import { PROTOCOLS, SWAP_CAPABILITIES } from '../protocols/registry.js'

export { SWAP_CAPABILITIES }

export const SWAP_ASSETS = Object.freeze(['USDC', 'SOL', 'USDT'])

export function swapEligibility(protocol, inputAsset, outputAsset) {
  const input = String(inputAsset || '').toUpperCase()
  const output = String(outputAsset || '').toUpperCase()
  const capability = SWAP_CAPABILITIES[protocol]
  if (!capability) return { available: false, reason: 'This provider has no configured private-swap integration.' }
  if (!SWAP_ASSETS.includes(input) || !SWAP_ASSETS.includes(output)) {
    return { available: false, reason: 'The selected swap asset is not supported by this planner.' }
  }
  if (input === output) return { available: true, kind: 'transfer', capability }
  if (capability.execution === 'unsupported') return { available: false, kind: 'swap', capability, reason: capability.note }
  const name = PROTOCOLS[protocol]?.name || protocol
  if (!capability.inputAssets.includes(input)) {
    const supported = capability.inputAssets.join(' or ')
    return { available: false, kind: 'swap', capability, reason: `${name} swaps only from ${supported}; ${input} -> ${output} is not supported.` }
  }
  if (!capability.outputAssets.includes(output)) {
    return { available: false, kind: 'swap', capability, reason: `${name} cannot swap to ${output}.` }
  }
  if (PROTOCOLS[protocol].swap.oneSideSol && input !== 'SOL' && output !== 'SOL') {
    return { available: false, kind: 'swap', capability, reason: `${name} swaps to or from SOL; ${input} -> ${output} is not supported.` }
  }
  if (capability.execution === 'documented-only') {
    return {
      available: false,
      kind: 'swap',
      capability,
      reason: 'SOON',
    }
  }
  return { available: true, kind: 'swap', capability }
}
