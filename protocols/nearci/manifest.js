// NEAR Confidential Intents as a DarkSol send (darksol-backend docs/NEAR_CI.md),
// new for the NEAR Hackathon (November 2026). The wallet shields into a private
// balance on intents.near through 1Click, and 1Click pays the recipient on
// Solana out of it; protocols/nearci/browser.js runs both.
import { TREASURY } from './intent.js'

export default Object.freeze({
  id: 'nearci',
  name: 'NEAR Confidential Intents',
  aliases: Object.freeze(['nearci', 'nearconfidentialintents', 'confidentialintents']),
  // Planned, not live (2026-11-09): 1Click and the private chain's validators
  // see every transfer, so the send page shows CI greyed out as "Soon" and never
  // ranks it; the analytics page still shows its measured privacy.
  status: 'planned',
  chain: 'near',
  chainId: null,
  network: 'NEAR (intents.near), from and to Solana through 1Click',
  docs: 'https://docs.near-intents.org/integration/market-makers/confidential-intents',
  logo: Object.freeze({ src: '/logos/nearci.svg', source: 'DarkSol' }),

  // Every confidential balance enters and leaves through this account.
  addresses: Object.freeze({ treasury: TREASURY }),
  primaryAddress: 'treasury',
  explorer: Object.freeze({ account: 'https://nearblocks.io/address/', transaction: 'https://nearblocks.io/txns/' }),

  assets: Object.freeze(['SOL', 'USDC', 'USDT']),

  // Dry 1Click quotes of 2026-11-08: shielding is free; a withdrawal to Solana
  // costs a fixed amount of about $0.01 whatever the size. A USDC or USDT
  // shield also pays rent for 1Click's one-time deposit token account
  // (1,493,440 lamports with the network fee in the 2026-11-08 test); a SOL
  // shield pays only the network fee (25,000 lamports through Solflare on 2026-11-09).
  fees: Object.freeze({
    variableRate: 0,
    fixedByToken: Object.freeze({ SOL: 0.000112297, USDC: 0.010005, USDT: 0.01001 }),
    fixedAmount: null,
    fixedToken: null,
    fixedBasis: 'transaction',
    depositCostSol: 0.0014934,
    depositCostSolByToken: Object.freeze({ SOL: 0.000025, USDC: 0.0014934, USDT: 0.0014934 }),
    label: 'About $0.01 per withdrawal',
    policyLabel: '1Click fee on withdrawal',
    policyDetail: 'Shielding into a private balance is free; each withdrawal pays 1Click about $0.01',
  }),
  recipients: Object.freeze({ multi: false, max: 1 }),

  send: Object.freeze({ execution: 'sdk', keepShielded: true, fromShielded: true }),
  swap: Object.freeze({ execution: 'unsupported', note: 'DarkSol sends through NEAR Confidential Intents in the same token only.' }),
  bridge: Object.freeze({ execution: 'unsupported', note: 'DarkSol pays Solana recipients through NEAR Confidential Intents.' }),

  // Not indexed by the dashboard lanes: darksol-backend's `nearci` service
  // collects the Treasury's flows, and its simulation measures each send.
  indexer: Object.freeze({
    lane: 'none',
    indexedVia: 'fastnear',
    poolSource: 'CI Treasury on intents.near',
    flowMethod: 'Transfers into and out of the CI Treasury, from FastNEAR; entries and exits are paired by the linker in darksol-backend docs/NEAR_CI.md.',
  }),

  signerKind: 'wallet-standard',
  modules: Object.freeze({ indexer: false, browser: true, cli: false, quote: false, bridge: false, shieldedBalance: true }),
})
