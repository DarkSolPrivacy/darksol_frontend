// A private swap through a one-time swap wallet, for a pool whose SDK has none:
// 1. the pool withdraws the input privately to the wallet, 2. the wallet swaps
// it through Jupiter, 3. it pays the recipient everything it holds and is left
// empty. The pool withdrawal is what hides the payer. Privacy Cash (swap.js)
// reaches Jupiter through its relayer; Umbra v2 calls Jupiter Ultra itself
// (ultraSwap below).
import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { ENDPOINTS, MINTS } from '../addresses.js'
import { TOKEN_DECIMALS } from './units.js'

// A SOL input above the reserve by this much is still waiting to be swapped.
export const SWAP_MINIMUM = 10_000_000n
// The payout pays its own fee: one signature plus this priority fee.
const PAYOUT_UNITS = 80_000
const PAYOUT_MICRO_LAMPORTS = 100_000
const PAYOUT_FEE = 5_000n + BigInt(Math.ceil(PAYOUT_UNITS * PAYOUT_MICRO_LAMPORTS / 1e6))

const toBase64 = (bytes) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary) }
const fromBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

// What the swap wallet holds of `asset`, in base units.
export async function holdings(connection, owner, asset) {
  if (asset === 'SOL') return BigInt(await connection.getBalance(owner, 'confirmed'))
  try {
    const { value } = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(MINTS[asset]), owner), 'confirmed')
    return BigInt(value.amount)
  } catch (error) {
    if (/could not find account/i.test(error?.message)) return 0n
    throw error
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The holding once it rises above `before`, polled for up to two minutes.
async function arrival(connection, owner, asset, before, onWait) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const units = await holdings(connection, owner, asset)
    if (units > before) return units
    onWait()
    await sleep(3000)
  }
  throw new Error(`the ${asset} did not reach the swap wallet in time`)
}

async function confirmed(connection, signature) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const { value: [status] } = await connection.getSignatureStatuses([signature])
    if (status?.err) throw new Error(`the payout failed on chain: ${JSON.stringify(status.err)}`)
    if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) return
    await sleep(1500)
  }
  throw new Error('the payout was not confirmed in time')
}

// Jupiter Ultra builds the order for the swap wallet, which signs it, and
// Jupiter sends it. A fill by Jupiter's market makers pays its own network fee;
// any other is paid from the wallet's SOL, which is why a pool that calls this
// swaps only from SOL and holds part of it back.
export async function ultraSwap(burner, inputAsset, outputAsset, units) {
  const query = new URLSearchParams({ inputMint: MINTS[inputAsset], outputMint: MINTS[outputAsset], amount: String(units), taker: burner.publicKey.toBase58() })
  const order = await fetch(`${ENDPOINTS.jupiterUltra}/order?${query}`).then((response) => response.json())
  if (!order?.transaction) throw new Error(`Jupiter returned no swap transaction${order?.errorMessage || order?.error ? `: ${order.errorMessage || order.error}` : ''}`)
  const transaction = VersionedTransaction.deserialize(fromBase64(order.transaction))
  transaction.sign([burner])
  const result = await fetch(`${ENDPOINTS.jupiterUltra}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTransaction: toBase64(transaction.serialize()), requestId: order.requestId }),
  }).then((response) => response.json())
  if (result?.status !== 'Success' || !result.signature) throw new Error(`Jupiter swap failed${result?.error ? `: ${result.error}` : ''}`)
  return result.signature
}

// Empties the swap wallet into the recipient in one transaction it signs and
// pays for: the output token (opening the recipient's token account if it has
// none), its own token accounts closed (a wrapped-SOL one a swap left open
// included), and every lamport left, rent included.
async function payout({ connection, burner, recipient, inputAsset, outputAsset }) {
  const owner = burner.publicKey
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: PAYOUT_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PAYOUT_MICRO_LAMPORTS }),
  ]
  let lamports = BigInt(await connection.getBalance(owner, 'confirmed')) - PAYOUT_FEE
  let tokens = 0n
  for (const asset of new Set([inputAsset, outputAsset])) {
    const mint = new PublicKey(MINTS[asset])
    const account = getAssociatedTokenAddressSync(mint, owner)
    const info = await connection.getAccountInfo(account, 'confirmed')
    if (!info) continue
    if (asset === outputAsset && asset !== 'SOL') {
      tokens = await holdings(connection, owner, asset)
      const target = getAssociatedTokenAddressSync(mint, recipient)
      if (!await connection.getAccountInfo(target, 'confirmed')) lamports -= BigInt(await connection.getMinimumBalanceForRentExemption(165))
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(owner, target, recipient, mint),
        createTransferCheckedInstruction(account, mint, target, owner, tokens, TOKEN_DECIMALS[asset]),
      )
    }
    instructions.push(createCloseAccountInstruction(account, owner, owner))
    lamports += BigInt(info.lamports)
  }
  if (lamports < 0n) throw new Error('the swap wallet cannot cover the payout fee')
  if (lamports > 0n) instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: recipient, lamports }))
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message())
  transaction.sign([burner])
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 5 })
  await confirmed(connection, signature)
  return { signature, tokens, lamports }
}

// Carries a swap to the recipient from wherever it stopped, reading only what
// the swap wallet holds: swaps the input still there with `swap(burner, input,
// output, units)`, then pays out. `task.keep` is the SOL of a SOL input not to
// swap. With `wait`, the input is still on its way in. `forget` drops the saved
// task once nothing is left to do. Returns the payout, or null when the wallet
// was already empty.
export async function finishSwap({ connection, burner, task, wait = false, swap, forget, onStatus }) {
  const { inputAsset, outputAsset } = task
  const wallet = burner.publicKey
  const input = wait ? await arrival(connection, wallet, inputAsset, 0n, () => onStatus(`Waiting for the ${inputAsset} to reach the swap wallet…`))
    : await holdings(connection, wallet, inputAsset)
  const swappable = input - (inputAsset === 'SOL' ? BigInt(task.keep) : 0n)
  let swapSignature = null
  if (swappable > (inputAsset === 'SOL' ? SWAP_MINIMUM : 0n)) {
    const before = await holdings(connection, wallet, outputAsset)
    onStatus(`Swapping ${inputAsset} to ${outputAsset}…`)
    swapSignature = await swap(burner, inputAsset, outputAsset, swappable)
    await arrival(connection, wallet, outputAsset, before, () => onStatus('Waiting for the swap to settle…'))
  }
  if (!await holdings(connection, wallet, outputAsset) && !await holdings(connection, wallet, 'SOL')) {
    forget()
    return null
  }
  onStatus('Paying the recipient…')
  const paid = await payout({ connection, burner, recipient: new PublicKey(task.recipient), inputAsset, outputAsset })
  forget()
  return { swapSignature, ...paid }
}
