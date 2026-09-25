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

  // deadline: the browser proves the withdrawal and the backend relays it later.
  // One recipient only: each later withdrawal spends the change note the
  // previous one creates when it lands, so it cannot be proved ahead.
  // keepShielded: a withdrawal returns its change to the wallet's own shielded
  // balance, so a send can deposit more than it pays out. fromShielded: a send
  // can pay from that balance with no deposit. Both notes are found again from
  // the wallet signature on any device.
  send: Object.freeze({ execution: 'sdk', deadline: true, keepShielded: true, fromShielded: true }),
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
  // shieldedBalance: browser.js exports shieldedBalances for the wallet panel.
  modules: Object.freeze({ cli: true, browser: true, indexer: true, quote: false, bridge: true, shieldedBalance: true }),
})
