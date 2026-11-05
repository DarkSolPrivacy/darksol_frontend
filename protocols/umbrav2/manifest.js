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

  // From the pool's fee policy account UMBRAV2.feePolicy, read 2026-10-23:
  // deposit 0 bps, private transfer 35 bps, withdraw 50 bps, pass-through 50
  // bps, a same-owner exemption on transfers only, and a zero fee-tree root (no
  // per-user overrides). A DarkSol send is a deposit then a withdraw: 0 + 50 bps.
  // The fee stays in the pool as a fee note; it never leaves custody on chain.
  fees: Object.freeze({
    variableRate: 0.005,
    // The relayer's own fee is published behind the gateway token, and is zero
    // when the relayer sponsors the spend, so it is not modelled here.
    fixedAmount: 0,
    fixedToken: null,
    fixedBasis: 'transaction',
    label: '0.5% plus any relayer fee',
    policyLabel: '0.5% protocol fee',
    policyDetail: 'Deposits are free; withdrawals pay 0.5% and private transfers 0.35%',
  }),
  recipients: Object.freeze({ multi: false, max: 1 }),

  // keepShielded: a send deposits into the wallet's own private balance and then
  // withdraws, so it can withdraw less than it deposited, or nothing (shield
  // only). fromShielded: a send can withdraw from that balance with no deposit;
  // the SDK merges notes first when the largest three fall short. The balance is
  // found again from the wallet's unlock signature on any device.
  send: Object.freeze({ execution: 'sdk', keepShielded: true, fromShielded: true }),
  swap: Object.freeze({
    execution: 'unsupported',
    aggregator: null,
    inputAssets: Object.freeze([]),
    outputAssets: Object.freeze([]),
    note: 'Umbra v2 publishes no swap in @umbra-privacy/nimbus-solana-web 0.1.1.',
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
