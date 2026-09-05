import { PublicKey } from '@solana/web3.js'
import { MINTS, openPrivacyCashSession } from './privacycash-client.js'
import {
  BRIDGE_CONFIG_URL, BRIDGE_RELAYER_URL,
  bridgeEligibility, bridgeMinimumBaseUnits, bridgeNetBaseUnits,
} from './bridge-routes.js'

// Renders base units as the plain decimal token string the relayer expects in
// `inputTokenAmount`. Kept exact (no float round-trip) so the quoted amount and
// the amount the relayer actually receives cannot drift apart.
function decimalAmount(baseUnits, decimals) {
  const text = String(baseUnits).padStart(decimals + 1, '0')
  const whole = text.slice(0, text.length - decimals)
  const fraction = text.slice(text.length - decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

// The relayer answers 200 with `{success:false, error}` for rejected input, so the
// HTTP status alone is not a success signal.
async function relayerCall(body) {
  const response = await fetch(BRIDGE_RELAYER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let payload
  try { payload = await response.json() } catch { throw new Error(`Bridge relayer returned a malformed response (HTTP ${response.status})`) }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || `Bridge relayer rejected the request (HTTP ${response.status})`)
  }
  return payload
}

async function relayerConfig() {
  const response = await fetch(BRIDGE_CONFIG_URL)
  if (!response.ok) throw new Error(`Unable to read PrivacyCash relayer config (HTTP ${response.status})`)
  return response.json()
}

/**
 * Bridge out of the PrivacyCash Solana pool to another chain.
 *
 * There is no bridge-specific SDK call: step 2 is the same `withdraw` /
 * `withdrawSPL` used for an ordinary private transfer, with the relayer's
 * one-time deposit address as the recipient. Deposit runs before the quote is
 * requested because proof generation and wallet approval are slow and the
 * relayer's quote is short-lived -- this keeps the quote-to-withdrawal gap small.
 */
export async function executePrivacyCashBridge({
  provider, asset, chainId, outputToken, recipient, totalBaseUnits, onStatus = () => {},
}) {
  const route = bridgeEligibility('privacycash', asset, chainId, outputToken)
  if (!route.available) throw new Error(route.reason)
  const { chain, outputToken: token } = route

  onStatus('Reading relayer fees…')
  const config = await relayerConfig()
  const minimumBaseUnits = bridgeMinimumBaseUnits(asset, config)
  if (BigInt(totalBaseUnits) < minimumBaseUnits) {
    const decimals = { SOL: 9, USDC: 6, USDT: 6 }[String(asset).toUpperCase()]
    throw new Error(`Bridging ${asset} requires at least ${decimalAmount(minimumBaseUnits, decimals)} ${asset} to cover cross-chain fees`)
  }
  // The relayer must be quoted the amount it will actually receive, while the SDK
  // withdrawal is still called with the gross amount.
  const { netBaseUnits, decimals } = bridgeNetBaseUnits(totalBaseUnits, asset, config)
  const netAmount = decimalAmount(netBaseUnits, decimals)

  const session = await openPrivacyCashSession({ provider, asset, totalBaseUnits, onStatus })
  const { privacyCash, common, publicKey, transactionSigner } = session

  onStatus('Approve deposit in your wallet…')
  const deposit = asset === 'SOL'
    ? await privacyCash.deposit({ ...common, amount_in_lamports: Number(totalBaseUnits), transactionSigner })
    : await privacyCash.depositSPL({ ...common, mintAddress: new PublicKey(MINTS[asset]), base_units: Number(totalBaseUnits), transactionSigner })

  const receipt = {
    provider: 'privacycash', kind: 'bridge', asset,
    outputChain: chain.id, outputChainName: chain.name, outputToken: token,
    recipient, depositSignature: deposit.tx, withdrawals: [],
  }

  try {
    onStatus('Requesting bridge quote…')
    const quote = await relayerCall({
      step: 'quote',
      inputChain: 'solana',
      outputChain: chain.id,
      inputTokenName: String(asset).toLowerCase(),
      outputTokenName: token.toLowerCase(),
      inputTokenAmount: netAmount,
      refundAddress: publicKey.toBase58(),
      recipientAddress: recipient,
      quoteWaitingTimeMs: 3000,
    })
    const depositAddress = quote?.quote?.depositAddress
    if (!depositAddress) throw new Error('Bridge relayer did not return a deposit address')
    receipt.depositAddress = depositAddress
    receipt.quote = quote.quote

    onStatus(`Sending privately to the ${chain.name} route…`)
    const withdrawal = asset === 'SOL'
      ? await privacyCash.withdraw({ ...common, recipient: new PublicKey(depositAddress), amount_in_lamports: Number(totalBaseUnits) })
      : await privacyCash.withdrawSPL({ ...common, recipient: new PublicKey(depositAddress), mintAddress: new PublicKey(MINTS[asset]), base_units: Number(totalBaseUnits) })
    receipt.withdrawals.push(withdrawal)
    // A partial withdrawal delivers less than the relayer was quoted, so the
    // market maker would settle against the wrong amount. Surface it instead of
    // reporting success.
    if (withdrawal.isPartial) {
      throw new Error('The private withdrawal only partially filled, so the bridge amount no longer matches the quote')
    }

    onStatus('Confirming with the relayer…')
    await relayerCall({ step: 'send_tx', txHash: withdrawal.tx, depositAddress })
    return { ...receipt, withdrawSignature: withdrawal.tx, status: 'submitted' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const stage = receipt.withdrawals.length
      ? `The private withdrawal landed (${receipt.withdrawals[0].tx}) but the relayer was not confirmed. Contact PrivacyCash with that signature and the deposit address before retrying.`
      : 'Your funds are still in the PrivacyCash private pool and can be withdrawn normally.'
    const wrapped = new Error(`Deposit succeeded, but the bridge failed: ${detail}. ${stage}`)
    wrapped.receipt = receipt
    throw wrapped
  }
}
