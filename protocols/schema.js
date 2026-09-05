// Manifest validation. Runs in a test, not at import time, so a malformed
// manifest fails CI rather than a request.

export const EXECUTION_MODES = Object.freeze(['sdk', 'documented-only', 'unsupported'])
export const CHAINS = Object.freeze(['solana', 'arbitrum'])
export const LANES = Object.freeze(['solana', 'evm', 'none'])
export const STATUSES = Object.freeze(['live', 'planned', 'disabled'])
export const CAPABILITIES = Object.freeze(['send', 'swap', 'bridge'])

// The live `asset` CHECK constraint in supabase/migrations/0001_initial.sql, on
// pool_flows, pool_snapshots, token_prices and flow_baselines. A protocol that
// trades outside this set needs a migration touching all four tables, so the
// requirement surfaces here as a failing test instead of a rejected INSERT.
export const SUPPORTED_ASSETS = Object.freeze(['USDC', 'SOL', 'USDT'])

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM = /^0x[0-9a-f]{40}$/

const isPlainString = (value) => typeof value === 'string' && value.length > 0

export function validateManifest(manifest) {
  const errors = []
  const fail = (message) => errors.push(message)
  const id = manifest?.id

  if (!isPlainString(id) || !/^[a-z][a-z0-9]*$/.test(id)) fail('id must be a lowercase alphanumeric string')
  if (!isPlainString(manifest?.name)) fail('name is required')
  if (!isPlainString(manifest?.docs)) fail('docs URL is required')
  if (!STATUSES.includes(manifest?.status)) fail(`status must be one of ${STATUSES.join(', ')}`)
  if (!CHAINS.includes(manifest?.chain)) fail(`chain must be one of ${CHAINS.join(', ')}`)
  if (!isPlainString(manifest?.network)) fail('network label is required')

  if (!Array.isArray(manifest?.aliases) || !manifest.aliases.includes(id)) {
    fail('aliases must be an array containing the id itself')
  }

  if (!isPlainString(manifest?.logo?.src) || !manifest.logo.src.startsWith('/logos/')) {
    fail('logo.src must be a /logos/ path')
  }

  const addresses = manifest?.addresses
  if (!addresses || typeof addresses !== 'object' || !Object.keys(addresses).length) {
    fail('addresses must hold at least one entry')
  } else {
    for (const [key, value] of Object.entries(addresses)) {
      if (!isPlainString(value)) { fail(`addresses.${key} must be a string`); continue }
      const pattern = value.startsWith('0x') ? EVM : BASE58
      if (!pattern.test(value)) fail(`addresses.${key} is not a well-formed address: ${value}`)
    }
    if (!isPlainString(manifest?.primaryAddress) || !(manifest.primaryAddress in addresses)) {
      fail('primaryAddress must name a key of addresses')
    }
  }

  if (!Array.isArray(manifest?.assets) || !manifest.assets.length) fail('assets must be a non-empty array')
  else {
    const unsupported = manifest.assets.filter((asset) => !SUPPORTED_ASSETS.includes(asset))
    if (unsupported.length) {
      fail(`assets ${unsupported.join(', ')} are outside the database CHECK constraint (${SUPPORTED_ASSETS.join(', ')}); add a migration first`)
    }
  }

  for (const capability of CAPABILITIES) {
    const entry = manifest?.[capability]
    if (!entry || typeof entry !== 'object') { fail(`${capability} block is required`); continue }
    if (!EXECUTION_MODES.includes(entry.execution)) {
      fail(`${capability}.execution must be one of ${EXECUTION_MODES.join(', ')}`)
    }
    // A capability the app cannot run must explain itself: the UI renders this
    // note, and "unavailable" with no reason is the thing users complain about.
    if (entry.execution !== 'sdk' && !isPlainString(entry.note)) {
      fail(`${capability}.note is required when execution is ${entry.execution}`)
    }
  }

  const swap = manifest?.swap
  if (swap?.execution === 'sdk') {
    for (const key of ['inputAssets', 'outputAssets']) {
      if (!Array.isArray(swap[key]) || !swap[key].length) fail(`swap.${key} is required when swap.execution is sdk`)
    }
  }

  const fees = manifest?.fees
  if (!fees || typeof fees !== 'object') fail('fees block is required')
  else {
    if (!Number.isFinite(fees.variableRate) || fees.variableRate < 0) fail('fees.variableRate must be a non-negative number')
    if (fees.fixedAmount !== null && !(Number.isFinite(fees.fixedAmount) && fees.fixedAmount >= 0)) {
      fail('fees.fixedAmount must be a non-negative number or null')
    }
    if (!['transaction', 'recipient'].includes(fees.fixedBasis)) fail("fees.fixedBasis must be 'transaction' or 'recipient'")
    if (!isPlainString(fees.label)) fail('fees.label is required')
  }

  const recipients = manifest?.recipients
  if (!recipients || typeof recipients.multi !== 'boolean') fail('recipients.multi must be a boolean')
  else if (recipients.multi === false && recipients.max !== 1) fail('a single-recipient protocol must set recipients.max to 1')

  if (!LANES.includes(manifest?.indexer?.lane)) fail(`indexer.lane must be one of ${LANES.join(', ')}`)

  const modules = manifest?.modules
  if (!modules || typeof modules !== 'object') fail('modules block is required')

  for (const [command, help] of Object.entries(manifest?.extensionCommands || {})) {
    if (!command.startsWith(`${id}:`)) fail(`extension command ${command} must be namespaced ${id}:`)
    if (!isPlainString(help)) fail(`extension command ${command} needs a usage string`)
  }

  return { valid: errors.length === 0, errors }
}

// Cross-manifest checks the per-manifest validator cannot see.
export function validateRegistry(manifests) {
  const errors = []
  const seen = new Map()

  for (const manifest of manifests) {
    for (const alias of manifest.aliases || []) {
      const owner = seen.get(alias)
      if (owner && owner !== manifest.id) errors.push(`alias "${alias}" is claimed by both ${owner} and ${manifest.id}`)
      seen.set(alias, manifest.id)
    }
  }

  const ids = manifests.map((manifest) => manifest.id)
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicateIds.length) errors.push(`duplicate protocol ids: ${[...new Set(duplicateIds)].join(', ')}`)

  const primaries = manifests.map((manifest) => manifest.addresses[manifest.primaryAddress])
  const duplicateAddresses = primaries.filter((address, index) => primaries.indexOf(address) !== index)
  if (duplicateAddresses.length) errors.push(`two protocols share a primary address: ${[...new Set(duplicateAddresses)].join(', ')}`)

  return { valid: errors.length === 0, errors }
}
