// The single source every protocol table is now derived from.
//
// Before this, the same metadata was maintained by hand in scripts/runtime.ts,
// server/index.js, server/app.js, src/main.jsx and server/privacy-engine.js.
// Values that were retyped are computed here instead -- shortProgram and the
// explorer URLs especially, since a hand-written copy of Curvy's address had
// already drifted to a different contract.
//
// Pure data in, pure data out: no I/O, no SDK imports, safe in the browser
// bundle, the Express app and the tsx CLI alike.
import { manifests } from './manifests.js'

export { manifests }

export const PROTOCOL_IDS = Object.freeze(manifests.map((manifest) => manifest.id))

const shorten = (address) => address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address

function decorate(manifest) {
  const primary = manifest.addresses[manifest.primaryAddress]
  return Object.freeze({
    ...manifest,
    // Consumers still call this programId; on an EVM protocol it is the vault.
    programId: primary,
    shortProgram: shorten(primary),
    explorerAccount: `${manifest.explorer.account}${primary}`,
    explorerTransaction: manifest.explorer.transaction,
    feePolicy: Object.freeze({ label: manifest.fees.policyLabel, detail: manifest.fees.policyDetail }),
    legacy: Boolean(manifest.legacy),
    supersededBy: manifest.supersededBy ?? null,
  })
}

export const PROTOCOLS = Object.freeze(
  Object.fromEntries(manifests.map((manifest) => [manifest.id, decorate(manifest)])),
)

export function getProtocol(id) {
  return PROTOCOLS[String(id || '').toLowerCase()] || null
}

// Replaces main.jsx's providerKey(), which sniffed substrings and would have
// mapped any future id containing "cloak" onto cloakc.
const ALIASES = Object.freeze(Object.fromEntries(
  manifests.flatMap((manifest) => manifest.aliases.map((alias) => [alias, manifest.id])),
))

export function resolveProtocolId(value) {
  const key = String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return ALIASES[key] || (PROTOCOLS[key] ? key : key)
}

export function listProtocols({ chain, lane, capability, status = 'live' } = {}) {
  return manifests.filter((manifest) => {
    if (status && manifest.status !== status) return false
    if (chain && manifest.chain !== chain) return false
    if (lane && manifest.indexer.lane !== lane) return false
    if (capability && manifest[capability]?.execution !== 'sdk') return false
    return true
  }).map((manifest) => PROTOCOLS[manifest.id])
}

// --- derived tables -------------------------------------------------------
// Each of these replaces a hand-maintained literal. The shapes are reproduced
// exactly; test/protocol-registry.test.js pins them against the originals.

export const PROGRAMS = Object.freeze({
  cloakc: PROTOCOLS.cloakc.addresses.program,
  privacycash: PROTOCOLS.privacycash.addresses.program,
  curvyVault: PROTOCOLS.curvy.addresses.vault,
  curvyAggregator: PROTOCOLS.curvy.addresses.aggregator,
})

export const PROVIDER_CAPABILITIES = Object.freeze(Object.fromEntries(manifests.map((manifest) => {
  const capability = {
    id: manifest.id,
    name: manifest.name,
    network: manifest.network,
    supportsMultiRecipient: manifest.recipients.multi,
    maxRecipients: manifest.recipients.max,
    supportsDeadline: manifest.send.deadline === true,
    supportsPrivateSwap: manifest.swap.execution === 'sdk',
    swapAggregator: manifest.swap.aggregator,
    protocolExecution: Object.freeze({ label: 'historical p50 / p95 when available' }),
    withdrawalFee: Object.freeze({
      variableRate: manifest.fees.variableRate,
      ...(manifest.fees.variableByToken ? { variableByToken: manifest.fees.variableByToken } : {}),
      fixedAmount: manifest.fees.fixedAmount,
      fixedToken: manifest.fees.fixedToken,
      fixedBasis: manifest.fees.fixedBasis,
      ...(manifest.fees.fixedAppliesToTokens ? { fixedAppliesToTokens: manifest.fees.fixedAppliesToTokens } : {}),
      ...(manifest.fees.fixedByToken ? { fixedByToken: manifest.fees.fixedByToken } : {}),
      label: manifest.fees.label,
    }),
  }
  // Only PrivacyCash carries these today; adding them unconditionally would
  // change the shape the planner already returns.
  if (manifest.swap.execution === 'documented-only') {
    capability.documentsPrivateSwap = true
    capability.privateSwapIntegration = manifest.swap.integrationNote
  }
  if (manifest.chainId) capability.chainId = manifest.chainId
  if (manifest.assets && manifest.id === 'curvy') capability.supportedTokens = manifest.assets
  if (manifest.capabilityNote) capability.capabilityNote = manifest.capabilityNote
  if (manifest.legacy) Object.assign(capability, { legacy: true, supersededBy: manifest.supersededBy })
  return [manifest.id, Object.freeze(capability)]
})))

export const SWAP_CAPABILITIES = Object.freeze(Object.fromEntries(manifests.map((manifest) => [
  manifest.id,
  Object.freeze({
    inputAssets: manifest.swap.inputAssets,
    outputAssets: manifest.swap.outputAssets,
    execution: manifest.swap.execution,
    note: manifest.swap.note,
  }),
])))

export const BRIDGE_CAPABILITIES = Object.freeze(Object.fromEntries(manifests.map((manifest) => [
  manifest.id,
  Object.freeze({ execution: manifest.bridge.execution, note: manifest.bridge.note }),
])))

export const LOGOS = Object.freeze(Object.fromEntries(
  manifests.map((manifest) => [manifest.id, manifest.logo]),
))

// Every extension command, mapped to the protocol that owns it, so the CLI
// stops hardcoding a `curvy:` prefix.
export const EXTENSION_COMMANDS = Object.freeze(Object.fromEntries(manifests.flatMap((manifest) =>
  Object.entries(manifest.extensionCommands || {}).map(([command, usage]) =>
    [command, Object.freeze({ protocol: manifest.id, usage })]),
)))
