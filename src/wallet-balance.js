import { Connection, PublicKey } from '@solana/web3.js'

const MINTS = Object.freeze({
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
})

// PrivacyCash requires SOL for its deposit transaction. Keep a conservative
// reserve so MAX never attempts to spend the wallet's fee balance.
export const SOL_FEE_RESERVE = 2_000_000n

export function spendableSolBalance(rawBalance) {
  const raw = BigInt(rawBalance)
  return raw > SOL_FEE_RESERVE ? raw - SOL_FEE_RESERVE : 0n
}

function connection() {
  const url = import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString()
  return new Connection(url, 'confirmed')
}

export async function getWalletAssetBalance(address, asset) {
  const publicKey = new PublicKey(address)
  const rpc = connection()
  if (asset === 'SOL') {
    const raw = BigInt(await rpc.getBalance(publicKey, 'confirmed'))
    return { raw, spendableRaw: spendableSolBalance(raw), reservedRaw: SOL_FEE_RESERVE }
  }
  const mint = MINTS[asset]
  if (!mint) throw new Error('Unsupported asset')
  const accounts = await rpc.getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(mint) }, 'confirmed')
  const raw = accounts.value.reduce((sum, account) => {
    const amount = account.account.data.parsed?.info?.tokenAmount?.amount
    return sum + (typeof amount === 'string' ? BigInt(amount) : 0n)
  }, 0n)
  return { raw, spendableRaw: raw, reservedRaw: 0n }
}
