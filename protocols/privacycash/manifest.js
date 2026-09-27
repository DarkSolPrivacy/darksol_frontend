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
    swapRelayer: ENDPOINTS.privacycashSwap,
  }),

  assets: Object.freeze(['SOL', 'USDC', 'USDT']),

  fees: Object.freeze({
    variableRate: 0.0035,
    fixedAmount: 0.006,
    fixedToken: 'SOL',
    fixedBasis: 'recipient',
    // Network fee and rent for two accounts, paid by whoever signs a deposit
    // (the wallet, or the swap wallet re-depositing); measured on chain 2026-09-27.
    depositCostSol: 0.00159692,
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
  // The SDK has no swap; this runs the one privacycash.org runs (swap.js): a
  // private withdrawal to a swap wallet derived from the wallet signature, a
  // Jupiter swap there through the relayer, and a deposit back into the shielded
  // balance, which then pays the recipient. oneSideSol: that swap wallet pays the
  // deposit's network fee from SOL it swapped for or kept, so SOL is on one side.
  swap: Object.freeze({
    execution: 'sdk',
    aggregator: 'Jupiter',
    inputAssets: Object.freeze(['USDC', 'SOL', 'USDT']),
    outputAssets: Object.freeze(['USDC', 'SOL', 'USDT']),
    oneSideSol: true,
    // SOL the swap wallet keeps for fees (swap.js holds the same numbers): out of
    // a SOL input for the swap and the token re-deposit, and out of a SOL output
    // for its re-deposit. The backend's settlement estimate reads these.
    reshield: Object.freeze({ inputSol: 0.01, outputSol: 0.0043 }),
    // Jupiter Ultra's fee on the relayer's order: 0.04% on the live USDC -> SOL
    // swap; Jupiter documents 0.02% for SOL-stable pairs and up to 0.1% elsewhere.
    routingFee: 0.0004,
    note: 'PrivacyCash swaps through Jupiter in a signature-derived swap wallet and re-shields the output before paying the recipient.',
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
