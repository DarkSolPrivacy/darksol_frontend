export const SWAP_ASSETS = Object.freeze(['USDC', 'SOL', 'USDT'])

export const SWAP_CAPABILITIES = Object.freeze({
  cloakc: Object.freeze({
    inputAssets: Object.freeze(['SOL']),
    outputAssets: Object.freeze(['USDC', 'USDT']),
    execution: 'sdk',
    note: 'Cloak swaps private SOL to a public SPL-token recipient through Jupiter.',
  }),
  privacycash: Object.freeze({
    inputAssets: SWAP_ASSETS,
    outputAssets: SWAP_ASSETS,
    execution: 'documented-only',
    note: 'PrivacyCash documents private swaps, but its published SDK has no supported swap or recovery method.',
  }),
  curvy: Object.freeze({
    inputAssets: SWAP_ASSETS,
    outputAssets: SWAP_ASSETS,
    execution: 'sdk',
    note: 'Curvy swaps supported private Vault currencies through a LiFi-backed intent.',
  }),
})

export function swapEligibility(protocol, inputAsset, outputAsset) {
  const input = String(inputAsset || '').toUpperCase()
  const output = String(outputAsset || '').toUpperCase()
  const capability = SWAP_CAPABILITIES[protocol]
  if (!capability) return { available: false, reason: 'This provider has no configured private-swap integration.' }
  if (!SWAP_ASSETS.includes(input) || !SWAP_ASSETS.includes(output)) {
    return { available: false, reason: 'The selected swap asset is not supported by this planner.' }
  }
  if (input === output) return { available: true, kind: 'transfer', capability }
  if (!capability.inputAssets.includes(input)) {
    const supported = capability.inputAssets.join(' or ')
    return { available: false, kind: 'swap', capability, reason: `${protocol === 'cloakc' ? 'CLOAKC' : protocol} swaps only from ${supported}; ${input} -> ${output} is not supported.` }
  }
  if (!capability.outputAssets.includes(output)) {
    return { available: false, kind: 'swap', capability, reason: `${protocol === 'cloakc' ? 'CLOAKC' : protocol} cannot swap to ${output}.` }
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
