import { CONTRACTS, ENDPOINTS, EXPLORERS, PROGRAMS } from '../addresses.js'

export default Object.freeze({
  id: 'curvy',
  name: 'Curvy',
  aliases: Object.freeze(['curvy']),
  status: 'live',
  chain: 'arbitrum',
  chainId: 42161,
  network: 'Arbitrum One',
  docs: 'https://docs.curvy.box/',
  logo: Object.freeze({ src: '/logos/curvy.svg', source: 'https://www.curvy.box/' }),

  addresses: Object.freeze({
    vault: CONTRACTS.curvyVault,
    aggregator: CONTRACTS.curvyAggregator,
    solanaPortal: PROGRAMS.curvyPortal,
  }),
  primaryAddress: 'vault',
  explorer: EXPLORERS.arbitrum,
  services: Object.freeze({ api: ENDPOINTS.curvyApi }),

  assets: Object.freeze(['USDC', 'SOL', 'USDT']),

  fees: Object.freeze({
    // 0.1% aggregation + 0.2% unshielding is the exit path this rate models.
    variableRate: 0.003,
    fixedAmount: 0,
    fixedToken: null,
    fixedBasis: 'transaction',
    label: '0.1% aggregation + 0.2% unshielding; shielding separately costs 0.1%',
    policyLabel: '0.3% private exit path',
    policyDetail: '0.1% aggregation + 0.2% unshielding; shielding separately costs 0.1%',
  }),
  recipients: Object.freeze({ multi: false, max: 1 }),
  capabilityNote: 'The current integration treats each public unshield as a single-recipient exit.',

  send: Object.freeze({ execution: 'sdk' }),
  swap: Object.freeze({
    execution: 'sdk',
    aggregator: 'LiFi',
    inputAssets: Object.freeze(['USDC', 'SOL', 'USDT']),
    outputAssets: Object.freeze(['USDC', 'SOL', 'USDT']),
    note: 'Curvy swaps supported private Vault currencies through a LiFi-backed intent.',
    routeBanner: null,
  }),
  bridge: Object.freeze({
    execution: 'documented-only',
    note: 'Curvy bridges through LI.FI entry/exit Portals, but this app has no Curvy browser path.',
  }),

  indexer: Object.freeze({
    lane: 'evm',
    indexedVia: 'alchemy',
    poolSource: 'on-chain Arbitrum Vault balance',
    flowMethod: 'Vault deposits and withdrawals verified from Curvy events on Arbitrum; portal swaps are not inferred without a defensible link.',
    deploymentBlock: 396728892,
    confirmations: 64,
    overlapBlocks: 2400,
  }),

  signerKind: 'injected',
  modules: Object.freeze({ cli: true, browser: false, indexer: true, quote: false, bridge: false }),
  // Commands only Curvy has. Keeping their usage here means the CLI help is
  // generated rather than maintained alongside the code that runs them.
  extensionCommands: Object.freeze({
    'curvy:register': 'curvy:register -- <handle.curvy.name> --execute',
    'curvy:auth-diagnostic': 'curvy:auth-diagnostic',
    'curvy:portal-status': 'curvy:portal-status -- <address>',
    'curvy:recover': 'curvy:recover -- <portal-address> <token-symbol> --execute',
  }),
})
