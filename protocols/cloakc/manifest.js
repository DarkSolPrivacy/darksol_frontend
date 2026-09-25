import { EXPLORERS, PROGRAMS } from '../addresses.js'

export default Object.freeze({
  id: 'cloakc',
  name: 'CLOAKC',
  // The API has returned 'cloakc', 'cloak' and 'CLOAKC' at different times, and
  // main.jsx resolved that with substring sniffing. Aliases replace it.
  aliases: Object.freeze(['cloakc', 'cloak']),
  status: 'live',
  chain: 'solana',
  chainId: null,
  network: 'Solana',
  docs: 'https://docs.cloak.ag/sdk/introduction',
  logo: Object.freeze({ src: '/logos/cloak.png', source: 'https://www.cloak.ag/brand' }),

  addresses: Object.freeze({ program: PROGRAMS.cloakc }),
  primaryAddress: 'program',
  explorer: EXPLORERS.solana,
  services: Object.freeze({}),

  assets: Object.freeze(['SOL', 'USDC', 'USDT']),

  fees: Object.freeze({
    variableRate: 0.003,
    fixedAmount: 0.005,
    fixedToken: 'SOL',
    fixedBasis: 'transaction',
    fixedAppliesToTokens: Object.freeze(['SOL']),
    label: '0.3%; SOL exits add 0.005 SOL',
    policyLabel: '0.3% protocol fee',
    policyDetail: 'SOL exits add 0.005 SOL',
  }),
  recipients: Object.freeze({ multi: false, max: 1 }),
  capabilityNote: 'Current mainnet 0.2.x integration is treated as single-recipient.',

  send: Object.freeze({ execution: 'sdk' }),
  swap: Object.freeze({
    execution: 'sdk',
    aggregator: 'Jupiter',
    inputAssets: Object.freeze(['SOL']),
    outputAssets: Object.freeze(['USDC', 'USDT']),
    note: 'Cloak swaps private SOL to a public SPL-token recipient through Jupiter.',
    routeBanner: Object.freeze({
      from: 'PRIVATE SOL', via: 'JUPITER', to: 'PUBLIC USDC / USDT RECIPIENT',
      note: 'Two-stage Cloak TransactSwap flow',
    }),
  }),
  bridge: Object.freeze({
    execution: 'unsupported',
    note: 'Cloak is Solana-only. Its SDK and Shield Pool program expose no bridge.',
  }),

  indexer: Object.freeze({
    lane: 'solana',
    indexedVia: 'helius',
    poolSource: 'reconstructed indexed net flows',
    flowMethod: 'Swap-outs decoded from Cloak TransactSwap instructions; output asset is read from the instruction payload.',
  }),

  signerKind: 'injected',
  // shieldedBalance: browser.js exports shieldedBalances for the wallet panel.
  modules: Object.freeze({ cli: true, browser: true, indexer: true, quote: true, bridge: false, shieldedBalance: true }),
})
