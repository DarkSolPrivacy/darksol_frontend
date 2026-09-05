import { ENDPOINTS, EXPLORERS, PROGRAMS } from '../addresses.js'

export default Object.freeze({
  id: 'privacycash',
  name: 'PrivacyCash',
  aliases: Object.freeze(['privacycash', 'privacymoney']),
  status: 'live',
  chain: 'solana',
  chainId: null,
  network: 'Solana',
  docs: 'https://privacycash.mintlify.app/',
  logo: Object.freeze({ src: '/logos/privacycash-icon.png', source: 'https://privacycash.mintlify.app/' }),

  addresses: Object.freeze({ program: PROGRAMS.privacycash }),
  primaryAddress: 'program',
  explorer: EXPLORERS.solana,
  services: Object.freeze({
    bridgeRelayer: ENDPOINTS.privacycashBridge,
    bridgeConfig: ENDPOINTS.privacycashConfig,
  }),

  assets: Object.freeze(['SOL', 'USDC', 'USDT']),

  fees: Object.freeze({
    variableRate: 0.0035,
    fixedAmount: 0.006,
    fixedToken: 'SOL',
    fixedBasis: 'recipient',
    label: '0.35% + 0.006 SOL equivalent per recipient',
    policyLabel: '0.35% + base fee',
    policyDetail: 'Transfers: 0.006 SOL equivalent · swaps: 0.008 SOL equivalent + Jupiter fees',
  }),
  recipients: Object.freeze({ multi: true, max: null }),

  send: Object.freeze({ execution: 'sdk' }),
  swap: Object.freeze({
    execution: 'documented-only',
    aggregator: 'Jupiter',
    inputAssets: Object.freeze(['USDC', 'SOL', 'USDT']),
    outputAssets: Object.freeze(['USDC', 'SOL', 'USDT']),
    note: 'PrivacyCash documents private swaps, but its published SDK has no supported swap or recovery method.',
    integrationNote: 'Unavailable in privacycash@1.2.2 public SDK',
    routeBanner: null,
  }),
  bridge: Object.freeze({
    execution: 'sdk',
    note: 'PrivacyCash bridges by withdrawing privately to a NEAR Intents market-maker address.',
  }),

  indexer: Object.freeze({
    lane: 'solana',
    indexedVia: 'helius',
    poolSource: 'on-chain pool accounts',
    flowMethod: 'Swaps inferred by one-to-one ephemeral-wallet links within 120 seconds.',
  }),

  signerKind: 'injected',
  modules: Object.freeze({ cli: true, browser: true, indexer: true, quote: false, bridge: true }),
})
