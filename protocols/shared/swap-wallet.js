// A private swap through a one-time swap wallet, for a pool whose SDK has none:
// 1. the pool withdraws the input privately to the wallet, 2. the wallet swaps
// it through Jupiter, 3. it pays the recipient everything it holds and is left
// empty. The pool withdrawal is what hides the payer. Privacy Cash (swap.js)
// reaches Jupiter through its relayer; Umbra v2 and Cloak call Jupiter Ultra
// themselves (ultraSwap below).
//
// The wallet holds no SOL when the input is a token, so Jupiter must pay the
// swap's network fee (a gasless order; measured 2026-11-06: 4 USDC to USDT in a
// wallet with no SOL was filled gasless, Jupiter keeping about 0.13 USDT for it).
// Between two tokens the output goes straight to the recipient (Ultra's
// `receiver`), so the wallet never needs SOL for a payout either.
import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
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
// Jupiter sends it. `receiver` takes the output instead of the wallet. With
// `gasless` (a wallet holding no SOL) only an order whose network fee Jupiter
// pays is sent; any other would fail on chain, so it is refused here first.
export async function ultraSwap(burner, inputAsset, outputAsset, units, { receiver, gasless = false } = {}) {
  const query = new URLSearchParams({ inputMint: MINTS[inputAsset], outputMint: MINTS[outputAsset], amount: String(units), taker: burner.publicKey.toBase58(), ...(receiver ? { receiver: String(receiver) } : {}) })
  const order = await fetch(`${ENDPOINTS.jupiterUltra}/order?${query}`).then((response) => response.json())
  if (!order?.transaction) throw new Error(`Jupiter returned no swap transaction${order?.errorMessage || order?.error ? `: ${order.errorMessage || order.error}` : ''}`)
  if (gasless && !order.gasless) throw new Error('Jupiter would not pay this swap\'s network fee')
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
// output, units, { gasless })`, then pays out. Between two tokens it swaps
// straight to the recipient through Jupiter Ultra, whatever `swap` is, and
// there is nothing to pay out. `task.keep` is the SOL of a SOL input not to
// swap. With `wait`, the input is still on its way in. `forget` drops the
// saved task once nothing is left to do. Returns the payout, or null when the
// wallet was already empty.
export async function finishSwap({ connection, burner, task, wait = false, swap, forget, onStatus }) {
  const { inputAsset, outputAsset } = task
  const wallet = burner.publicKey
  const input = wait ? await arrival(connection, wallet, inputAsset, 0n, () => onStatus(`Waiting for the ${inputAsset} to reach the swap wallet…`))
    : await holdings(connection, wallet, inputAsset)
  const swappable = input - (inputAsset === 'SOL' ? BigInt(task.keep) : 0n)
  let swapSignature = null
  if (swappable > (inputAsset === 'SOL' ? SWAP_MINIMUM : 0n)) {
    // A token input arrives with no SOL beside it: only a gasless order can run.
    const gasless = inputAsset !== 'SOL' && !await holdings(connection, wallet, 'SOL')
    if (inputAsset !== 'SOL' && outputAsset !== 'SOL') {
      onStatus(`Swapping ${inputAsset} to ${outputAsset} for the recipient…`)
      swapSignature = await ultraSwap(burner, inputAsset, outputAsset, swappable, { receiver: task.recipient, gasless })
      forget()
      return { swapSignature, signature: swapSignature, tokens: null, lamports: 0n }
    }
    const before = await holdings(connection, wallet, outputAsset)
    onStatus(`Swapping ${inputAsset} to ${outputAsset}…`)
    swapSignature = await swap(burner, inputAsset, outputAsset, swappable, { gasless })
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

// The one-time wallet a swap runs in, saved in this browser under `key` before
// any input moves to it, so a swap cut short anywhere after is found again.
export function startSwapTask(key, { inputAsset, outputAsset, recipient, keep = 0n }) {
  const burner = Keypair.generate()
  const task = { secret: toBase64(burner.secretKey), inputAsset, outputAsset, recipient: String(recipient), keep: String(keep) }
  localStorage.setItem(key, JSON.stringify(task))
  return { burner, task }
}

// Finishes the swap an earlier run left under `key`: the payout with its task,
// or null when there was none or its wallet was already empty.
export async function finishSavedSwap({ key, connection, swap, onStatus }) {
  let task = null
  try { task = JSON.parse(localStorage.getItem(key)) } catch { task = null }
  if (!task?.secret) return null
  onStatus('Finishing your earlier swap…')
  const paid = await finishSwap({ connection, burner: Keypair.fromSecretKey(fromBase64(task.secret)), task, swap, forget: () => localStorage.removeItem(key), onStatus })
  return paid && { ...paid, task }
}
