import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { ENDPOINTS, MINTS } from '../addresses.js'
import { TOKEN_DECIMALS } from '../shared/units.js'
import { finishSwap as finishInSwapWallet } from '../shared/swap-wallet.js'
import { swapEligibility } from '../../src/swap-routes.js'
import manifest from './manifest.js'
import {
  awaitCapacity, base64ToBytes, bytesToBase64, depositTo, noteAmounts, openPrivacyCashSession,
  planWithdrawals, unitsText, withdrawTo, withdrawalFee, withdrawalTerms,
} from './browser.js'

// A private swap, since the SDK has none: 1. withdraw the input privately to a
// one-time swap wallet derived from the sign-in signature, 2. swap it there
// through Jupiter via the PrivacyCash relayer's /swap, 3. pay the recipient
// straight from that wallet and leave it empty (shared/swap-wallet.js). The pool
// withdrawal is what hides the payer; re-shielding the output and withdrawing
// again (what privacycash.org does) cost a second pool fee and hid nothing,
// since the two legs matched to the lamport seconds apart.

// SOL held back from a SOL input for the swap's fees and the recipient's token
// account; whatever is left reaches the recipient as SOL for fees.
const INPUT_RESERVE = BigInt(Math.round(manifest.swap.swapWallet.inputReserveSol * 1e9))
// privacycash.org refuses a swap whose output is worth under 0.05 SOL, and
// Jupiter's gasless fills need a qualifying size too.
const MINIMUM_OUTPUT_SOL = 0.05
// Headroom under the relayer's prices for Jupiter's slippage and fees.
const PRICE_MARGIN = 0.99

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

const taskKey = (publicKey) => `privacycash-swap-${publicKey.toBase58()}`

// Carries a swap to the recipient from wherever it stopped (shared/swap-wallet.js),
// swapping through the relayer and forgetting this browser's task when done.
export function finishSwap({ connection, burner, owner, task, wait = false, onStatus }) {
  return finishInSwapWallet({ connection, burner, task, wait, onStatus, swap: jupiterSwap, forget: () => localStorage.removeItem(taskKey(owner)) })
}

// Swaps what the recipient is paid for (`recipients`' total, else all of
// `totalBaseUnits`) and pays the whole output to the recipient. From the wallet
// it first deposits `totalBaseUnits`, and what is not swapped stays shielded.
// `source: 'shielded'` takes the input from the shielded balance instead, in as
// many withdrawals into the swap wallet as the notes need (planWithdrawals). A
// SOL input also leaves the recipient the reserve's remainder as SOL for fees.
// ponytail: the swap wallet's index lives only in this browser's task, so a swap
// cut short can be finished only here, by the next PrivacyCash swap; carry the
// index in an encrypted note if cross-device recovery turns out to matter.
export async function executePrivacyCashSwap({ provider, inputAsset, outputAsset, totalBaseUnits, recipient, recipients, source = 'wallet', onStatus = () => {} }) {
  const route = swapEligibility('privacycash', inputAsset, outputAsset)
  if (!route.available || route.kind !== 'swap') throw new Error(route.reason || `PrivacyCash cannot swap ${inputAsset} to ${outputAsset}`)
  const fromShielded = source === 'shielded'
  const deposited = BigInt(totalBaseUnits)
  const units = recipients ? recipients.reduce((sum, item) => sum + BigInt(item.baseUnits), 0n) : deposited
  if (!fromShielded && units > deposited) throw new Error('The swap takes more than the deposit')
  const recipientKey = new PublicKey(String(recipient))
  const session = await openPrivacyCashSession({ provider, asset: inputAsset, totalBaseUnits: deposited, fund: !fromShielded, onStatus })
  const { privacyCash, common, publicKey, connection, transactionSigner } = session

  // Finished alone, never followed by this new deposit: the user retrying a
  // swap that stopped means that swap, not a second one.
  let pending = null
  try { pending = JSON.parse(localStorage.getItem(taskKey(publicKey))) } catch {}
  if (pending?.index) {
    onStatus('Finishing your earlier swap…')
    const burner = await swapWallet(session.signature, publicKey, pending.index)
    const paid = await finishSwap({ connection, burner, owner: publicKey, task: pending, onStatus })
    if (paid) throw new Error(`Finished your earlier interrupted swap: ${paid.tokens ? unitsText(paid.tokens, pending.outputAsset) : unitsText(paid.lamports, 'SOL')} went to ${pending.recipient}. Nothing new was ${fromShielded ? 'sent' : 'deposited'}; swap again to start this one.`)
  }

  onStatus('Checking the swap size…')
  const terms = await withdrawalTerms(privacyCash, inputAsset)
  if (!swapEstimate({ inputAsset, outputAsset, units, terms, prices: await privacyCash.getConfig('prices') })) {
    throw new Error(`${unitsText(units, inputAsset)} is too small to swap privately: after PrivacyCash's withdrawal fee it must still be worth about ${MINIMUM_OUTPUT_SOL} SOL`)
  }

  // From the balance, the withdrawals into the swap wallet are planned before anything moves.
  let pieces = [units]
  if (fromShielded) {
    onStatus('Reading your shielded balance…')
    const plan = planWithdrawals(await noteAmounts(privacyCash, common, inputAsset), [units], terms.minimum)
    if (!plan) throw new Error(`Your shielded ${inputAsset} cannot pay ${unitsText(units, inputAsset)} in withdrawals of at least ${unitsText(terms.minimum, inputAsset)}`)
    pieces = plan[0]
  }
  const receipt = { provider: 'privacycash', inputAsset, outputAsset, depositSignature: null, withdrawals: [] }
  if (!fromShielded) {
    onStatus('Approve deposit in your wallet…')
    receipt.depositSignature = (await depositTo(privacyCash, common, inputAsset, deposited, transactionSigner)).tx
  }
  let stage = 'shielded'
  try {
    const task = {
      index: 1 + crypto.getRandomValues(new Uint32Array(1))[0] % 2_000_000_000,
      inputAsset, outputAsset, recipient: recipientKey.toBase58(), keep: String(inputAsset === 'SOL' ? INPUT_RESERVE : 0n),
    }
    const burner = await swapWallet(session.signature, publicKey, task.index)
    // Saved before the withdrawal, so a swap cut short anywhere after it is found again.
    localStorage.setItem(taskKey(publicKey), JSON.stringify(task))
    for (const [index, piece] of pieces.entries()) {
      await awaitCapacity(privacyCash, common, inputAsset, piece, onStatus)
      onStatus(`Moving the ${inputAsset} to a one-time swap wallet${pieces.length > 1 ? ` (${index + 1} of ${pieces.length})` : ''}…`)
      await withdrawTo(privacyCash, common, inputAsset, { publicKey: burner.publicKey, baseUnits: piece })
      stage = 'swap'
    }
    const paid = await finishSwap({ connection, burner, owner: publicKey, task, wait: true, onStatus })
    if (!paid) throw new Error('the swap wallet received nothing to swap')
    receipt.swapSignature = paid.swapSignature
    receipt.withdrawals.push({ tx: paid.signature })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (fromShielded && stage === 'shielded') throw error
    const where = stage === 'shielded' ? `the ${inputAsset} is in your shielded balance`
      : `what reached it waits in a one-time swap wallet only your PrivacyCash signature controls, and your next PrivacyCash swap in this browser pays it to the recipient${pieces.length > 1 ? '; the rest stays in your shielded balance' : ''}`
    throw Object.assign(new Error(`${fromShielded ? 'The swap stopped' : 'Deposit succeeded, but the swap stopped'}: ${reason}. Nothing is lost: ${where}.`), { receipt })
  }
  return receipt
}
