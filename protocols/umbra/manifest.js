import { ENDPOINTS, EXPLORERS, PROGRAMS } from '../addresses.js'

export default Object.freeze({
  id: 'umbra',
  name: 'Umbra v1',
  aliases: Object.freeze(['umbra', 'umbraprivacy']),
  status: 'live',
  // Still indexed and still sendable; the planner ranks it after current pools.
  legacy: true,
  supersededBy: 'umbrav2',
  chain: 'solana',
  chainId: null,
  network: 'Solana',
  docs: 'https://sdk.umbraprivacy.com',
  logo: Object.freeze({ src: '/logos/umbra.svg', source: 'https://umbraprivacy.com' }),

  addresses: Object.freeze({ program: PROGRAMS.umbra }),
  primaryAddress: 'program',
  explorer: EXPLORERS.solana,
  services: Object.freeze({
    indexerApi: ENDPOINTS.umbraIndexer,
    relayerApi: ENDPOINTS.umbraRelayer,
  }),

  // Umbra's mainnet allowlist also carries UMBRA, CASH and ZINC. Only the three
  // the database CHECK constraint accepts are declared; adding another needs a
  // migration across pool_flows, pool_snapshots, token_prices and flow_baselines.
  assets: Object.freeze(['SOL', 'USDC', 'USDT']),

  fees: Object.freeze({
    // floor(amount * 35 / 16384). A power-of-two divisor, not basis points --
    // 0.21362...%, so the decimal here is the protocol's rate, not a rounding.
    variableRate: 35 / 16384,
    // Note creation also charges a fixed SOL amount for nullifier rent plus
    // worst-case burn compute. It is quoted by the SDK per note rather than
    // published as a constant, so it is not modelled as a fixed fee here.
    fixedAmount: 0,
    fixedToken: null,
    fixedBasis: 'transaction',
    label: '0.2136% plus a fixed SOL note-creation fee',
    policyLabel: '0.2136% protocol fee',
    policyDetail: 'Self-deposits are free; note creation adds a fixed SOL rent and compute fee',
  }),
  recipients: Object.freeze({ multi: false, max: 1 }),
  capabilityNote: 'A Stealth Pool note is written per recipient, so each send is treated as single-recipient.',

  send: Object.freeze({ execution: 'sdk' }),
  swap: Object.freeze({
    execution: 'documented-only',
    aggregator: null,
    inputAssets: Object.freeze(['SOL', 'USDC', 'USDT']),
    outputAssets: Object.freeze(['SOL', 'USDC', 'USDT']),
    note: 'Umbra documents encrypted swaps, but @umbra-privacy/sdk 5.0.0-rc.6 publishes no swap, quote or route module.',
    integrationNote: 'Absent from all 43 subpath exports of @umbra-privacy/sdk 5.0.0-rc.6',
  }),
  bridge: Object.freeze({
    execution: 'unsupported',
    note: 'Umbra is Solana-only and exposes no bridge.',
  }),

  // Everything below was measured against mainnet, not inferred from docs.
  //
  // Encrypted: per-user ETA balances and Stealth Pool note amounts. Not
  // encrypted: the public boundary. Custody is plainly readable -- derive the
  // token pool with findTokenPoolPda({ mintAddress, umbraProgram }) from
  // @umbra-privacy/sdk/pda, then read the SPL account that PDA owns. Observed
  // holdings: 656 SOL, 61.4k USDC, 51.7k USDT. That is a directly readable TVL,
  // the way privacycash reads its pool, with no decoding at all.
  //
  // THE TRAP that ./indexer.js exists to avoid: Umbra runs on Arcium MPC, so a
  // withdrawal is two transactions. The user's request only queues a
  // computation; the tokens actually move later, in a separate transaction
  // carrying ONLY the ...Callback instruction
  // (WithdrawFromSharedBalanceIntoPublicBalanceV18Callback,
  // ClaimIntoPublicBalanceToMxeV18Callback). Deposits are not symmetric -- their
  // tokens move in the initiating instruction. Filtering callbacks out, as is
  // natural when they look like noise, silently drops every withdrawal and
  // reports a pool that only ever grows.
  //
  // What stays unknowable is the part that should be: who holds what inside,
  // and which deposit a given withdrawal came from.
  indexer: Object.freeze({
    lane: 'solana',
    indexedVia: 'helius',
    poolSource: 'on-chain pool accounts',
    flowMethod: 'Shielding decoded from the initiating instruction; unshielding from the Arcium callback that moves the tokens. Deposits and withdrawals are not linked.',
  }),

  // The SDK signs through a wallet-standard account, not the injected provider
  // the other Solana protocols use.
  signerKind: 'wallet-standard',
  modules: Object.freeze({ cli: true, browser: true, indexer: true, quote: false, bridge: false }),
  extensionCommands: Object.freeze({
    'umbra:register': 'umbra:register -- --execute',
  }),
})
