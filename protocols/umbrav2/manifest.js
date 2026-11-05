import { ENDPOINTS, EXPLORERS, PROGRAMS, UMBRAV2 } from '../addresses.js'

export default Object.freeze({
  id: 'umbrav2',
  name: 'Umbra v2',
  aliases: Object.freeze(['umbrav2', 'nimbus']),
  status: 'live',
  chain: 'solana',
  chainId: null,
  network: 'Solana',
  docs: 'https://sdk.nimbusprivacy.xyz',
  logo: Object.freeze({ src: '/logos/umbrav2.svg', source: 'https://docs.nimbusprivacy.xyz' }),

  addresses: Object.freeze({
    program: PROGRAMS.umbrav2,
    userRegistry: PROGRAMS.umbrav2UserRegistry,
    lamportVault: UMBRAV2.lamportVault,
    vaultAuthority: UMBRAV2.vaultAuthority,
  }),
  primaryAddress: 'program',
  explorer: EXPLORERS.solana,
  // The SDK's mainnet preset (@umbra-privacy/nimbus-solana-web 0.1.1). The
  // gateway fronts the relayer, guardians, screener, data endorser, fee enclave
  // and coordinator, and refuses requests without a bearer token; ./browser.js
  // reaches it through the backend's /api/umbra-gateway, which adds one.
  services: Object.freeze({
    gateway: ENDPOINTS.umbrav2Gateway,
    indexerCdn: ENDPOINTS.umbrav2IndexerCdn,
    data: ENDPOINTS.umbrav2Data,
    context: ENDPOINTS.umbrav2Context,
  }),

  // The pool holds about 45 other mints (PRVT, CASH, JUP ...). Only the three
  // the database CHECK constraint accepts are declared; adding another needs a
  // migration across pool_flows, pool_snapshots, token_prices and flow_baselines.
  assets: Object.freeze(['SOL', 'USDC', 'USDT']),

  // From the pool's fee policy account UMBRAV2.feePolicy (decoded as the SDK's
  // decodeFeePolicy does), read 2026-11-05 at slot 465782823: deposit 0 bps,
  // private transfer 5 bps, withdraw 10 bps, pass-through 10 bps, same-owner
  // exemption on deposits and transfers, and a zero fee-tree root (no per-user
  // overrides). It was 0 / 35 / 50 / 50 bps on 2026-10-23. A DarkSol send is a
  // deposit then a withdraw: 0 + 10 bps. Two withdrawals that day paid exactly
  // that (10,000,000 lamports arrived as 9,990,009).
  // The fee stays in the pool as a fee note; it never leaves custody on chain.
  fees: Object.freeze({
    variableRate: 0.001,
    // The relayer's own fee is published behind the gateway token, and is zero
    // when the relayer sponsors the spend, so it is not modelled here.
    fixedAmount: 0,
    fixedToken: null,
    fixedBasis: 'transaction',
    label: '0.1% plus any relayer fee',
    policyLabel: '0.1% protocol fee',
    policyDetail: 'Deposits are free; withdrawals pay 0.1% and private transfers 0.05%',
  }),
  recipients: Object.freeze({ multi: false, max: 1 }),

  // keepShielded: a send deposits into the wallet's own private balance and then
  // withdraws, so it can withdraw less than it deposited, or nothing (shield
  // only). fromShielded: a send can withdraw from that balance with no deposit;
  // the SDK merges notes first when the largest three fall short. The balance is
  // found again from the wallet's unlock signature on any device.
  send: Object.freeze({ execution: 'sdk', keepShielded: true, fromShielded: true }),
  // The SDK publishes no swap (@umbra-privacy/nimbus-solana-web 0.1.1), so
  // browser.js runs one: a private withdrawal of SOL to a one-time swap wallet,
  // a Jupiter Ultra swap there, and a payout of everything it holds to the
  // recipient (shared/swap-wallet.js). SOL input only: the swap wallet's network
  // fees come out of it (swapWallet, the same measured figures as Privacy
  // Cash's), and a wallet holding only a token could be left unable to move it.
  // keepShielded / fromShielded: as for a send, the swap can deposit more than it
  // swaps, or take its SOL from the private balance with no deposit.
  swap: Object.freeze({
    execution: 'sdk',
    aggregator: 'Jupiter',
    inputAssets: Object.freeze(['SOL']),
    outputAssets: Object.freeze(['USDC', 'USDT']),
    keepShielded: true,
    fromShielded: true,
    swapWallet: Object.freeze({ inputReserveSol: 0.006, swapFeeSol: 0.0000062, payoutFeeSol: 0.000013, tokenAccountRentSol: 0.00148844 }),
    // browser.js swaps only more than this: the reserve plus the swap wallet's
    // 0.01 SOL minimum (shared/swap-wallet.js), so the page offers no smaller swap.
    minimumInput: 0.016,
    // Jupiter Ultra charged 0.02% on SOL-stable fills in dry orders of 2026-11-05;
    // the figure Privacy Cash's swaps measured through Ultra is kept as the bound.
    routingFee: 0.0004,
    note: 'Umbra v2 swaps SOL to USDC or USDT in a one-time wallet through Jupiter, after a private withdrawal.',
  }),
  bridge: Object.freeze({
    execution: 'unsupported',
    note: 'Umbra v2 is Solana-only and exposes no bridge.',
  }),

  // Measured on mainnet, 2026-10-23. A deposit shows the funding wallet, the
  // token and the amount; a withdrawal the destination, the token and the
  // amount. A private transfer inside the pool shows none of them, only
  // Umbra's relayer submitting it. Withdrawals and transfers are relayed, and
  // every value transaction is co-signed by Umbra's attesters.
  indexer: Object.freeze({
    lane: 'solana',
    indexedVia: 'helius',
    poolSource: 'vault accounts',
    flowMethod: 'Deposits and withdrawals read from the vault balance deltas; transfers inside the pool move no custody and are not recorded. Deposits and withdrawals are not linked.',
  }),

  signerKind: 'wallet-standard',
  // The SDK is browser-only, so there is no CLI module. The backend indexes the
  // pool (darksol-backend's protocols/umbrav2/indexer.js); this repo ships no copy.
  // shieldedBalance: browser.js exports shieldedBalances for the wallet panel.
  modules: Object.freeze({ indexer: false, browser: true, cli: false, quote: false, bridge: false, shieldedBalance: true }),
})
