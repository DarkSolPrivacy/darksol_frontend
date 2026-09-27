import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { ENDPOINTS, MINTS } from '../addresses.js'
import { TOKEN_DECIMALS } from '../shared/units.js'
import { swapEligibility } from '../../src/swap-routes.js'
import {
  awaitCapacity, base64ToBytes, bytesToBase64, depositTo, openPrivacyCashSession,
  unitsText, withdrawTo, withdrawalFee, withdrawalTerms,
} from './browser.js'

// A private swap the way privacycash.org runs one, since the SDK has none:
// 1. withdraw the input privately to a swap wallet derived from the sign-in
//    signature, 2. swap it there through Jupiter via the relayer's /swap,
// 3. deposit the output back into the wallet's shielded balance, signed and paid
//    by the swap wallet. The shielded output then pays the recipient.
// The swap wallet and its SOL reserves are the site's own, so these swaps look
// like every other PrivacyCash swap on chain.

// SOL the swap wallet keeps: for a SOL deposit's fees, and, out of a SOL input,
// for the swap and the token deposit after it. Above SOL_PRESENT its SOL is a
// swap in flight, below it only that reserve.
const SOL_DEPOSIT_RESERVE = 4_300_000n
const SOL_SWAP_RESERVE = 10_000_000n
const SOL_PRESENT = 30_000_000n
// privacycash.org refuses a swap whose output is worth under 0.05 SOL.
const MINIMUM_OUTPUT_SOL = 0.05
// Headroom under the relayer's prices for Jupiter's slippage and fees.
const PRICE_MARGIN = 0.99

// HKDF-SHA256(signature, sha256('privacycash:v1:' + wallet), 'privacycash:solana:wallet:v1:0'):
// the same swap wallet privacycash.org derives, so either app can find its funds.
export async function swapWallet(signature, publicKey) {
  const text = (value) => new TextEncoder().encode(value)
  const salt = await crypto.subtle.digest('SHA-256', text(`privacycash:v1:${publicKey.toBase58()}`))
  const key = await crypto.subtle.importKey('raw', signature, 'HKDF', false, ['deriveBits'])
  const seed = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: text('privacycash:solana:wallet:v1:0') }, key, 256)
  return Keypair.fromSeed(new Uint8Array(seed))
}

// The output `units` of input should shield, from the relayer's prices and
// `terms` per asset (withdrawalTerms): the withdrawal into the swap wallet, the
// SOL it keeps, and the swap. Null when the swap is too small to run, or its
// output could not be sent on in a withdrawal.
export function swapEstimate({ inputAsset, outputAsset, units, terms, prices }) {
  const price = (asset) => prices[asset.toLowerCase()]
  if (!(price(inputAsset) > 0 && price(outputAsset) > 0 && price('SOL') > 0)) throw new Error('PrivacyCash has no current price to size this swap')
  if (units < terms[inputAsset].minimum) return null
  const swapped = units - withdrawalFee(terms[inputAsset], units) - (inputAsset === 'SOL' ? SOL_SWAP_RESERVE : 0n)
  if (swapped <= 0n) return null
  const worth = Number(swapped) / 10 ** TOKEN_DECIMALS[inputAsset] * price(inputAsset) * PRICE_MARGIN
  if (worth < MINIMUM_OUTPUT_SOL * price('SOL')) return null
  const output = BigInt(Math.floor(worth / price(outputAsset) * 10 ** TOKEN_DECIMALS[outputAsset]))
  const shielded = output - (outputAsset === 'SOL' ? SOL_DEPOSIT_RESERVE : 0n)
  return shielded >= terms[outputAsset].minimum ? shielded : null
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

const present = (asset, units) => units > (asset === 'SOL' ? SOL_PRESENT : 0n)

// The holding once it rises above `before`, polled for up to two minutes.
async function arrival(connection, owner, asset, before, onWait) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const units = await holdings(connection, owner, asset)
    if (units > before) return units
    onWait()
    await new Promise((resolve) => setTimeout(resolve, 3000))
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

const taskKey = (publicKey) => `privacycash-swap-${publicKey.toBase58()}`

// Carries a swap back into the wallet's shielded balance from wherever it
// stopped: swaps the input if the swap wallet still holds it, then shields the
// output. `waitFor` is the input held before a withdrawal on its way in.
// Returns what was shielded, or null when the swap wallet held none of it.
export async function finishSwap({ session, burner, task: { inputAsset, outputAsset }, waitFor, onStatus }) {
  const { privacyCash, common, connection } = session
  const owner = burner.publicKey
  const input = waitFor === undefined ? await holdings(connection, owner, inputAsset)
    : await arrival(connection, owner, inputAsset, waitFor, () => onStatus(`Waiting for the ${inputAsset} to reach the swap wallet…`))
  let swapSignature = null
  if (present(inputAsset, input)) {
    const before = await holdings(connection, owner, outputAsset)
    onStatus(`Swapping ${inputAsset} to ${outputAsset}…`)
    swapSignature = await jupiterSwap(burner, inputAsset, outputAsset, input - (inputAsset === 'SOL' ? SOL_SWAP_RESERVE : 0n))
    await arrival(connection, owner, outputAsset, before, () => onStatus('Waiting for the swap to settle…'))
  }
  const output = await holdings(connection, owner, outputAsset)
  if (!present(outputAsset, output)) {
    localStorage.removeItem(taskKey(common.publicKey))
    return null
  }
  const units = output - (outputAsset === 'SOL' ? SOL_DEPOSIT_RESERVE : 0n)
  onStatus(`Shielding the ${outputAsset}…`)
  const deposit = await depositTo(privacyCash, common, outputAsset, units, async (transaction) => { transaction.sign([burner]); return transaction }, owner)
  localStorage.removeItem(taskKey(common.publicKey))
  return { units, swapSignature, depositSignature: deposit.tx }
}

// Deposits `totalBaseUnits` of the input, swaps it privately and pays the whole
// output, less the pool's withdrawal fee, to the recipient. `gasBaseUnits` of a
// SOL input ride the same deposit and stay shielded through the swap, then go to
// the recipient as SOL for network fees in a withdrawal of their own.
// ponytail: an interrupted swap is only finished when the next PrivacyCash swap
// starts; add a resume action to the page if interrupted swaps turn up.
export async function executePrivacyCashSwap({ provider, inputAsset, outputAsset, totalBaseUnits, gasBaseUnits = 0n, recipient, onStatus = () => {} }) {
  const route = swapEligibility('privacycash', inputAsset, outputAsset)
  if (!route.available || route.kind !== 'swap') throw new Error(route.reason || `PrivacyCash cannot swap ${inputAsset} to ${outputAsset}`)
  const units = BigInt(totalBaseUnits)
  const gas = BigInt(gasBaseUnits)
  if (gas && inputAsset !== 'SOL') throw new Error('SOL for fees can only ride a swap paid in SOL')
  const recipientKey = new PublicKey(String(recipient))
  const session = await openPrivacyCashSession({ provider, asset: inputAsset, totalBaseUnits: units + gas, onStatus })
  const { privacyCash, common, publicKey, connection, transactionSigner } = session
  const burner = await swapWallet(session.signature, publicKey)

  // Finished alone, never followed by this new deposit: the user retrying a
  // swap that stopped means that swap, not a second one.
  let pending = null
  try { pending = JSON.parse(localStorage.getItem(taskKey(publicKey))) } catch {}
  if (pending) {
    onStatus('Finishing your earlier swap…')
    const shielded = await finishSwap({ session, burner, task: pending, onStatus })
    if (shielded) throw new Error(`Finished your earlier interrupted swap: ${unitsText(shielded.units, pending.outputAsset)} is back in your shielded balance. Nothing new was deposited; send it with Use shielded funds, or swap again.`)
  }

  onStatus('Checking the swap size…')
  const terms = { [inputAsset]: await withdrawalTerms(privacyCash, inputAsset), [outputAsset]: await withdrawalTerms(privacyCash, outputAsset) }
  if (!swapEstimate({ inputAsset, outputAsset, units, terms, prices: await privacyCash.getConfig('prices') })) {
    throw new Error(`${unitsText(units, inputAsset)} is too small to swap privately: after PrivacyCash's withdrawal fee it must still be worth about ${MINIMUM_OUTPUT_SOL} SOL`)
  }

  onStatus('Approve deposit in your wallet…')
  const deposit = await depositTo(privacyCash, common, inputAsset, units + gas, transactionSigner)
  const receipt = { provider: 'privacycash', inputAsset, outputAsset, depositSignature: deposit.tx, withdrawals: [] }
  let stage = 'shielded'
  try {
    await awaitCapacity(privacyCash, common, inputAsset, units, onStatus)
    const waitFor = await holdings(connection, burner.publicKey, inputAsset)
    // Saved before the withdrawal, so a swap cut short anywhere after it is found again.
    localStorage.setItem(taskKey(publicKey), JSON.stringify({ inputAsset, outputAsset }))
    onStatus(`Moving the ${inputAsset} to the swap wallet…`)
    await withdrawTo(privacyCash, common, inputAsset, { publicKey: burner.publicKey, baseUnits: units })
    stage = 'swap'
    const shielded = await finishSwap({ session, burner, task: { inputAsset, outputAsset }, waitFor, onStatus })
    if (!shielded) throw new Error('the swap wallet received nothing to swap')
    receipt.swapSignature = shielded.swapSignature
    stage = 'send'
    await awaitCapacity(privacyCash, common, outputAsset, shielded.units, onStatus)
    onStatus('Sending to the recipient…')
    receipt.withdrawals.push(await withdrawTo(privacyCash, common, outputAsset, { publicKey: recipientKey, baseUnits: shielded.units }))
  } catch (error) {
    const where = stage === 'shielded' ? `the ${inputAsset} is in your shielded balance`
      : stage === 'swap' ? 'the funds wait in a swap wallet only your PrivacyCash signature controls, and your next PrivacyCash swap moves them back into your shielded balance'
        : `the ${outputAsset} is in your shielded balance; send it with Use shielded funds`
    throw Object.assign(new Error(`Deposit succeeded, but the swap stopped: ${error instanceof Error ? error.message : String(error)}. Nothing is lost: ${where}.`), { receipt })
  }
  // After the payment, so this SOL failing never undoes it.
  if (gas) {
    try {
      await awaitCapacity(privacyCash, common, 'SOL', gas, onStatus)
      onStatus('Sending SOL for fees…')
      receipt.gas = await withdrawTo(privacyCash, common, 'SOL', { publicKey: recipientKey, baseUnits: gas })
    } catch (error) { receipt.gasError = `${error instanceof Error ? error.message : String(error)}. The SOL stays in your shielded balance` }
  }
  return receipt
}
