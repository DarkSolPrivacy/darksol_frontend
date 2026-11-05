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

  // Each pool's PoolConfig charges an exit (withdrawal or swap) 0.3% plus a fixed
  // fee in its own token (docs.cloak.ag/guide/fees, confirmed on chain 2026-09-27:
  // a 0.03 SOL swap paid 0.00509 SOL). Deposits are free; the wallet pays the
  // network fee and rent for three accounts (depositCostSol, measured on a SOL deposit).
  fees: Object.freeze({
    variableRate: 0.003,
    fixedAmount: 0.005,
    fixedToken: 'SOL',
    fixedBasis: 'transaction',
    fixedByToken: Object.freeze({ SOL: 0.005, USDC: 0.45, USDT: 0.45 }),
    depositCostSol: 0.00197088,
    label: '0.3% + 0.005 SOL or 0.45 USDC/USDT per exit',
    policyLabel: '0.3% protocol fee',
    policyDetail: 'Exits add 0.005 SOL or 0.45 USDC/USDT',
  }),
  recipients: Object.freeze({ multi: false, max: 1 }),
  capabilityNote: 'Current mainnet 0.2.x integration is treated as single-recipient.',

  // keepShielded: a send deposits, then withdraws only what the recipient is
  // paid (partialWithdraw); the rest stays as a change note. fromShielded: a send
  // can pay from those notes with no deposit, merging more than two first.
  // localNotes: Cloak has no scan by wallet, so those notes are saved in this
  // browser only, and Shield only goes through a payment link paid to yourself,
  // which the wallet signature recovers on any device.
  send: Object.freeze({ execution: 'sdk', keepShielded: true, fromShielded: true, localNotes: true }),
  swap: Object.freeze({
    execution: 'sdk',
    aggregator: 'Jupiter',
    inputAssets: Object.freeze(['SOL']),
    outputAssets: Object.freeze(['USDC', 'USDT']),
    // Cloak's relay routes through Jupiter's swap API, which added no fee on chain.
    routingFee: 0,
    // The swap leaves its change as a note: a deposit can be larger than the
    // swap (the rest stays shielded), or the swap can spend saved notes.
    keepShielded: true,
    fromShielded: true,
    note: 'Cloak swaps private SOL to a public SPL-token recipient through Jupiter.',
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
