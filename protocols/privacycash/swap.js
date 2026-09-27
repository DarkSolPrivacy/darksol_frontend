import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { ENDPOINTS, MINTS } from '../addresses.js'
import { TOKEN_DECIMALS } from '../shared/units.js'
import { swapEligibility } from '../../src/swap-routes.js'
import manifest from './manifest.js'
import {
  awaitCapacity, base64ToBytes, bytesToBase64, depositTo, openPrivacyCashSession,
  unitsText, withdrawTo, withdrawalFee, withdrawalTerms,
} from './browser.js'

// A private swap, since the SDK has none: 1. withdraw the input privately to a
// one-time swap wallet derived from the sign-in signature, 2. swap it there
// through Jupiter via the PrivacyCash relayer's /swap, 3. pay the recipient
// straight from that wallet and leave it empty. The pool withdrawal is what
// hides the payer; re-shielding the output and withdrawing again (what
// privacycash.org does) cost a second pool fee and hid nothing, since the two
// legs matched to the lamport seconds apart.

// SOL held back from a SOL input for the swap's own fees and the recipient's
// token account; whatever is left reaches the recipient as SOL for fees.
const INPUT_RESERVE = BigInt(Math.round(manifest.swap.swapWallet.inputReserveSol * 1e9))
// A SOL input above the reserve by this much is still waiting to be swapped.
const SWAP_MINIMUM = 10_000_000n
// privacycash.org refuses a swap whose output is worth under 0.05 SOL, and
// Jupiter's gasless fills need a qualifying size too.
const MINIMUM_OUTPUT_SOL = 0.05
// Headroom under the relayer's prices for Jupiter's slippage and fees.
const PRICE_MARGIN = 0.99
// The payout pays its own fee: one signature plus this priority fee.
const PAYOUT_UNITS = 80_000
const PAYOUT_MICRO_LAMPORTS = 100_000
const PAYOUT_FEE = 5_000n + BigInt(Math.ceil(PAYOUT_UNITS * PAYOUT_MICRO_LAMPORTS / 1e6))

// HKDF-SHA256(signature, sha256('privacycash:v1:' + wallet), 'privacycash:solana:wallet:v1:' + index).
// Index 0 is the one swap wallet privacycash.org uses; each swap here takes a
// fresh random index, so no two swaps (or their recipients) share a wallet.
export async function swapWallet(signature, publicKey, index = 0) {
  const text = (value) => new TextEncoder().encode(value)
  const salt = await crypto.subtle.digest('SHA-256', text(`privacycash:v1:${publicKey.toBase58()}`))
  const key = await crypto.subtle.importKey('raw', signature, 'HKDF', false, ['deriveBits'])
  const seed = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: text(`privacycash:solana:wallet:v1:${index}`) }, key, 256)
  return Keypair.fromSeed(new Uint8Array(seed))
}

// The output `units` of input should deliver, from the relayer's prices and its
// `terms` for the input (withdrawalTerms): one withdrawal into the swap wallet
// and, for a SOL input, the reserve. Null when the swap is too small to run.
export function swapEstimate({ inputAsset, outputAsset, units, terms, prices }) {
  const price = (asset) => prices[asset.toLowerCase()]
  if (!(price(inputAsset) > 0 && price(outputAsset) > 0 && price('SOL') > 0)) throw new Error('PrivacyCash has no current price to size this swap')
  if (units < terms.minimum) return null
  const swapped = units - withdrawalFee(terms, units) - (inputAsset === 'SOL' ? INPUT_RESERVE : 0n)
  if (swapped <= 0n) return null
  const worth = Number(swapped) / 10 ** TOKEN_DECIMALS[inputAsset] * price(inputAsset) * PRICE_MARGIN
  if (worth < MINIMUM_OUTPUT_SOL * price('SOL')) return null
  return BigInt(Math.floor(worth / price(outputAsset) * 10 ** TOKEN_DECIMALS[outputAsset]))
}

// What the swap wallet holds of `asset`, in base units.
async function holdings(connection, owner, asset) {
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

async function relayerSwap(body) {
  const response = await fetch(ENDPOINTS.privacycashSwap, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  let payload
  try { payload = await response.json() } catch { throw new Error(`PrivacyCash swap relayer returned a malformed response (HTTP ${response.status})`) }
  if (!response.ok || !payload?.success) throw new Error(payload?.error || `PrivacyCash swap relayer rejected the request (HTTP ${response.status})`)
  return payload
}

// Jupiter builds the order for the swap wallet, which signs it, and the relayer
// submits it; Jupiter covers the fee when that wallet holds no SOL.
async function jupiterSwap(burner, inputAsset, outputAsset, units) {
  const taker = burner.publicKey.toBase58()
  const { orderResponse: order } = await relayerSwap({ step: 'build_tx', baseUnites: Number(units), inputMint: MINTS[inputAsset], outputMint: MINTS[outputAsset], taker })
  if (!order?.transaction) throw new Error('Jupiter returned no swap transaction')
  const transaction = VersionedTransaction.deserialize(base64ToBytes(order.transaction))
  transaction.sign([burner])
  const { exeRes: result } = await relayerSwap({ step: 'send_tx', requestId: order.requestId, signedTransaction: bytesToBase64(transaction.serialize()), taker })
  if (result?.status === 'Failed' || !result?.signature) throw new Error(`Jupiter swap failed${result?.error ? `: ${result.error}` : ''}`)
  return result.signature
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

const taskKey = (publicKey) => `privacycash-swap-${publicKey.toBase58()}`

// Carries a swap to the recipient from wherever it stopped, reading only what
// the swap wallet holds: swaps the input still there, then pays out. `task.keep`
// is the SOL of a SOL input not to swap. With `wait`, the input is still on its
// way in. Returns the payout, or null when the wallet was already empty.
export async function finishSwap({ connection, burner, owner, task, wait = false, onStatus }) {
  const { inputAsset, outputAsset } = task
  const wallet = burner.publicKey
  const input = wait ? await arrival(connection, wallet, inputAsset, 0n, () => onStatus(`Waiting for the ${inputAsset} to reach the swap wallet…`))
    : await holdings(connection, wallet, inputAsset)
  const swappable = input - (inputAsset === 'SOL' ? BigInt(task.keep) : 0n)
  let swapSignature = null
  if (swappable > (inputAsset === 'SOL' ? SWAP_MINIMUM : 0n)) {
    const before = await holdings(connection, wallet, outputAsset)
    onStatus(`Swapping ${inputAsset} to ${outputAsset}…`)
    swapSignature = await jupiterSwap(burner, inputAsset, outputAsset, swappable)
    await arrival(connection, wallet, outputAsset, before, () => onStatus('Waiting for the swap to settle…'))
  }
  if (!await holdings(connection, wallet, outputAsset) && !await holdings(connection, wallet, 'SOL')) {
    localStorage.removeItem(taskKey(owner))
    return null
  }
  onStatus('Paying the recipient…')
  const paid = await payout({ connection, burner, recipient: new PublicKey(task.recipient), inputAsset, outputAsset })
  localStorage.removeItem(taskKey(owner))
  return { swapSignature, ...paid }
}

// Deposits `totalBaseUnits` of the input, swaps it privately and pays the whole
// output to the recipient. A SOL input also leaves the recipient the reserve's
// remainder as SOL for network fees.
// ponytail: the swap wallet's index lives only in this browser's task, so a swap
// cut short can be finished only here, by the next PrivacyCash swap; carry the
// index in an encrypted note if cross-device recovery turns out to matter.
export async function executePrivacyCashSwap({ provider, inputAsset, outputAsset, totalBaseUnits, recipient, onStatus = () => {} }) {
  const route = swapEligibility('privacycash', inputAsset, outputAsset)
  if (!route.available || route.kind !== 'swap') throw new Error(route.reason || `PrivacyCash cannot swap ${inputAsset} to ${outputAsset}`)
  const units = BigInt(totalBaseUnits)
  const recipientKey = new PublicKey(String(recipient))
  const session = await openPrivacyCashSession({ provider, asset: inputAsset, totalBaseUnits: units, onStatus })
  const { privacyCash, common, publicKey, connection, transactionSigner } = session

  // Finished alone, never followed by this new deposit: the user retrying a
  // swap that stopped means that swap, not a second one.
  let pending = null
  try { pending = JSON.parse(localStorage.getItem(taskKey(publicKey))) } catch {}
  if (pending?.index) {
    onStatus('Finishing your earlier swap…')
    const burner = await swapWallet(session.signature, publicKey, pending.index)
    const paid = await finishSwap({ connection, burner, owner: publicKey, task: pending, onStatus })
    if (paid) throw new Error(`Finished your earlier interrupted swap: ${paid.tokens ? unitsText(paid.tokens, pending.outputAsset) : unitsText(paid.lamports, 'SOL')} went to ${pending.recipient}. Nothing new was deposited; swap again to start this one.`)
  }

  onStatus('Checking the swap size…')
  const terms = await withdrawalTerms(privacyCash, inputAsset)
  if (!swapEstimate({ inputAsset, outputAsset, units, terms, prices: await privacyCash.getConfig('prices') })) {
    throw new Error(`${unitsText(units, inputAsset)} is too small to swap privately: after PrivacyCash's withdrawal fee it must still be worth about ${MINIMUM_OUTPUT_SOL} SOL`)
  }

  onStatus('Approve deposit in your wallet…')
  const deposit = await depositTo(privacyCash, common, inputAsset, units, transactionSigner)
  const receipt = { provider: 'privacycash', inputAsset, outputAsset, depositSignature: deposit.tx, withdrawals: [] }
  let stage = 'shielded'
  try {
    await awaitCapacity(privacyCash, common, inputAsset, units, onStatus)
    const task = {
      index: 1 + crypto.getRandomValues(new Uint32Array(1))[0] % 2_000_000_000,
      inputAsset, outputAsset, recipient: recipientKey.toBase58(), keep: String(inputAsset === 'SOL' ? INPUT_RESERVE : 0n),
    }
    const burner = await swapWallet(session.signature, publicKey, task.index)
    // Saved before the withdrawal, so a swap cut short anywhere after it is found again.
    localStorage.setItem(taskKey(publicKey), JSON.stringify(task))
    onStatus(`Moving the ${inputAsset} to a one-time swap wallet…`)
    await withdrawTo(privacyCash, common, inputAsset, { publicKey: burner.publicKey, baseUnits: units })
    stage = 'swap'
    const paid = await finishSwap({ connection, burner, owner: publicKey, task, wait: true, onStatus })
    if (!paid) throw new Error('the swap wallet received nothing to swap')
    receipt.swapSignature = paid.swapSignature
    receipt.withdrawals.push({ tx: paid.signature })
  } catch (error) {
    const where = stage === 'shielded' ? `the ${inputAsset} is in your shielded balance`
      : 'the funds wait in a one-time swap wallet only your PrivacyCash signature controls, and your next PrivacyCash swap in this browser pays them to the recipient'
    throw Object.assign(new Error(`Deposit succeeded, but the swap stopped: ${error instanceof Error ? error.message : String(error)}. Nothing is lost: ${where}.`), { receipt })
  }
  return receipt
}
