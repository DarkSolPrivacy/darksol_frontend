// Every on-chain identifier the app knows, in one place.
//
// Before this file the same values were retyped across the codebase: the three
// SPL mints appeared in six modules, the Cloak and PrivacyCash program ids in
// four, and the Curvy vault in three -- where one copy had already drifted to a
// wrong address. Nothing outside this file should hardcode an address again.
//
// Pure data, zero imports, so the Vite bundle, the Express server and the tsx
// CLI can all read it without pulling in each other's SDKs.
//
// Everything here is public protocol infrastructure. Test identities, portals
// and signatures stay out of version control.

export const PROGRAMS = Object.freeze({
  cloakc: 'zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW',
  privacycash: '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD',
  // Curvy's Solana entry Portal program. Its private balances live on Arbitrum.
  curvyPortal: '6cHtg7sPLL9NQQuuyepnkud6PskMWV5yxvU2vXfag4qX',
  umbra: 'UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh',
  umbraDevnet: 'DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ',
})

export const CONTRACTS = Object.freeze({
  curvyVault: '0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00',
  curvyAggregator: '0xe51924cef003a654ec9735c4d97f5d4862cbcbb1',
})

export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112'

export const MINTS = Object.freeze({
  SOL: NATIVE_SOL_MINT,
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
})

export const MINT_SYMBOLS = Object.freeze(
  Object.fromEntries(Object.entries(MINTS).map(([symbol, mint]) => [mint, symbol])),
)

// Curvy's Arbitrum vault addresses its assets by an internal token id as well as
// by contract address, and the indexer needs both directions.
export const ARBITRUM_TOKENS = Object.freeze({
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': Object.freeze({ symbol: 'USDC', decimals: 6, tokenId: 2 }),
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': Object.freeze({ symbol: 'USDT', decimals: 6, tokenId: 3 }),
  '0x2bcc6d6cdbbdc0a4071e48bb3b969b06b3330c07': Object.freeze({ symbol: 'SOL', decimals: 9, tokenId: 4 }),
})

export const ENDPOINTS = Object.freeze({
  umbraIndexer: 'https://utxo-indexer.api.umbraprivacy.com',
  umbraRelayer: 'https://relayer.api.umbraprivacy.com',
  umbraIndexerDevnet: 'https://utxo-indexer.api-devnet.umbraprivacy.com',
  umbraRelayerDevnet: 'https://relayer.api-devnet.umbraprivacy.com',
  jupiterQuote: 'https://lite-api.jup.ag/swap/v1/quote',
  curvyApi: 'https://api.curvy.box',
  privacycashBridge: 'https://api3.privacycash.org/bridge',
  privacycashConfig: 'https://api3.privacycash.org/config',
})

export const EXPLORERS = Object.freeze({
  solana: Object.freeze({ account: 'https://solscan.io/account/', transaction: 'https://solscan.io/tx/' }),
  arbitrum: Object.freeze({ account: 'https://arbiscan.io/address/', transaction: 'https://arbiscan.io/tx/' }),
})
