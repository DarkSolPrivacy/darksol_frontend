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
  // The SDK has no swap; swap.js withdraws privately to a one-time swap wallet
  // derived from the wallet signature, swaps there through Jupiter via the
  // relayer, and pays the recipient from that wallet; between two stablecoins
  // Jupiter Ultra pays the recipient directly (see minimumInput below).
  swap: Object.freeze({
    execution: 'sdk',
    aggregator: 'Jupiter',
    inputAssets: Object.freeze(['USDC', 'SOL', 'USDT']),
    outputAssets: Object.freeze(['USDC', 'SOL', 'USDT']),
    // Between two tokens the swap wallet would hold no SOL for its payout, so
    // the output goes straight to the recipient from a gasless Jupiter Ultra
    // order instead (shared/swap-wallet.js); hence no SOL needed on either side.
    // A token input must still be large enough for Jupiter to pay its fee.
    minimumInput: Object.freeze({ USDC: 5, USDT: 5 }),
    // Only the swapped part is withdrawn into the swap wallet: the rest of a
    // deposit stays shielded, or the input comes from the shielded balance.
    keepShielded: true,
    fromShielded: true,
    // A one-time swap wallet pays the recipient directly (swap.js). inputReserveSol:
    // SOL held back from a SOL input for the swap's fees and the recipient's token
    // account; the rest reaches the recipient as SOL for fees. The other figures
    // feed the backend's settlement estimate, as measured on the live swaps of
    // 2026-09-27: the swap's network fee when the swap wallet holds SOL, the
    // payout's, and rent for one token account (1,488,440 lamports).
    swapWallet: Object.freeze({ inputReserveSol: 0.006, swapFeeSol: 0.0000062, payoutFeeSol: 0.000013, tokenAccountRentSol: 0.00148844 }),
    // Jupiter Ultra's fee on the relayer's orders, the highest of three live swaps
    // (0.04%, 0.02%, 0% for an RFQ fill); Jupiter documents 0.02% for SOL-stable
    // pairs and up to 0.1% elsewhere.
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
