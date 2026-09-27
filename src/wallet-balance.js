import { Connection, PublicKey } from '@solana/web3.js'
import { MINTS } from '../protocols/addresses.js'

// PrivacyCash requires SOL for its deposit transaction. Keep a conservative
// reserve so MAX never attempts to spend the wallet's fee balance.
export const SOL_FEE_RESERVE = 2_000_000n

export function spendableSolBalance(rawBalance) {
  const raw = BigInt(rawBalance)
  return raw > SOL_FEE_RESERVE ? raw - SOL_FEE_RESERVE : 0n
}

// A wallet below this cannot open a token account (0.00204 SOL of rent), which
// a Jupiter swap and a send to a fresh wallet both need, so it is offered SOL.
export const RECIPIENT_SOL_FLOOR = 3_000_000n

function connection() {
  const url = import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString()
  return new Connection(url, 'confirmed')
}

// The lamports each address holds, in order, from one RPC call.
export async function solBalances(addresses) {
  const accounts = await connection().getMultipleAccountsInfo(addresses.map((address) => new PublicKey(address)), 'confirmed')
  return accounts.map((account) => BigInt(account?.lamports ?? 0))
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
