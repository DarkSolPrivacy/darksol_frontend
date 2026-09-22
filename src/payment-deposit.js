import { Connection, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { getPaymentLink } from './payment-api.js'

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const FIELD_MAX = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const integer = (value, max = FIELD_MAX) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < max

export function validateCheckout(invoice) {
  if (!invoice || invoice.version !== 1 || invoice.network !== 'solana-mainnet' || invoice.asset !== 'SOL'
    || !['cloakc', 'privacycash'].includes(invoice.protocol) || !/^[0-9a-f]{64}$/.test(invoice.payment_id)
    || !integer(invoice.amount, BigInt(Number.MAX_SAFE_INTEGER) + 1n) || BigInt(invoice.amount) <= 0n
    || !['pending', 'paid'].includes(invoice.status)) throw new Error('Unsupported payment invoice')
  const privacycash = invoice.protocol === 'privacycash'
  if (!Array.isArray(invoice.outputs) || invoice.outputs.length !== (privacycash ? 2 : 1)) throw new Error('Invalid payment outputs')
  for (const [index, output] of invoice.outputs.entries()) {
    if (output.amount !== (index ? '0' : invoice.amount)
      || output.mint !== (privacycash ? '11111111111111111111111111111112' : 'So11111111111111111111111111111111111111112')
      || !['publicKey', 'blinding', 'commitment'].every((key) => integer(output[key]))
      || BigInt(output.publicKey) === 0n || BigInt(output.commitment) === 0n
      || (privacycash && (typeof output.encryptedNote !== 'string' || !/^(?:[0-9a-f]{2}){16,4096}$/.test(output.encryptedNote)))) throw new Error('Invalid payment output')
  }
  if (new Set(invoice.outputs.map((output) => output.commitment)).size !== invoice.outputs.length) throw new Error('Duplicate payment output')
  return invoice
}

function session(provider, address, signal) {
  signal?.throwIfAborted()
  if (!provider?.isConnected || String(provider.publicKey) !== address) throw new Error('Wallet account changed. Reconnect and try again.')
}

function invoiceTerms(invoice) {
  return JSON.stringify([invoice.protocol, invoice.network, invoice.asset, invoice.amount, invoice.outputs])
}

// Payment transactions go directly to chain RPC, never to the DarkSol backend.
export function paymentRpcUrl() {
  // No default: api.mainnet-beta.solana.com answers browser origins with a raw
  // 403, so falling back to it only hides a missing deployment setting.
  // Unset and malformed are the same deployment mistake, so they read alike
  // instead of surfacing a bare "Failed to construct 'URL'".
  let url
  try { url = new URL(import.meta.env?.VITE_PAYMENT_SOLANA_RPC_URL) }
  catch { throw new Error('This checkout has no valid Solana RPC endpoint. VITE_PAYMENT_SOLANA_RPC_URL must be a full URL, for example https://mainnet.helius-rpc.com/?api-key=KEY') }
  if (url.protocol !== 'https:' || url.username || url.password
    || /(^|\.)darksol\.app$/.test(url.hostname)
    || (typeof window !== 'undefined' && url.origin === window.location.origin)) throw new Error('Payments require a direct HTTPS Solana RPC endpoint')
  return url.href
}

export async function payPaymentInvoice({ invoice, provider, address, signal, onStatus = () => {}, onSigned, connection = new Connection(paymentRpcUrl(), 'confirmed') }) {
  validateCheckout(invoice)
  session(provider, address, signal)
  if (typeof provider.signTransaction !== 'function') throw new Error('This wallet does not support transaction signing')
  if (invoice.status === 'paid') throw new Error('This invoice is already paid')
  if (invoice.protocol === 'cloakc' && BigInt(invoice.amount) < 10000000n) throw new Error('Cloak requires a minimum payment of 0.01 SOL')
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error('Connect to Solana mainnet to pay this invoice')
  const publicKey = new PublicKey(address)
  if (BigInt(await connection.getBalance(publicKey)) < BigInt(invoice.amount) + 1000000n) throw new Error('Not enough SOL for this payment and network fees')
  let signedId = null
  const signTransaction = async (transaction) => {
    session(provider, address, signal)
    if (signedId) throw new Error('A deposit is already awaiting confirmation. Check its status before paying again.')
    const latest = validateCheckout(await getPaymentLink(invoice.payment_id, signal))
    if (latest.status === 'paid') throw new Error('This invoice is already paid')
    if (invoiceTerms(latest) !== invoiceTerms(invoice)) throw new Error('Payment details changed. Reload the checkout.')
    onStatus('Approve payment in your wallet...')
    const before = transaction.message.serialize()
    const signed = await provider.signTransaction(transaction)
    session(provider, address, signal)
    const after = signed.message.serialize()
    if (before.length !== after.length || before.some((byte, index) => byte !== after[index])) throw new Error('Wallet changed the payment transaction')
    if (!signed.signatures[0]?.some((byte) => byte !== 0)) throw new Error('Wallet did not sign the payment')
    signedId = bs58.encode(signed.signatures[0])
    // The caller persists this public transaction ID before any broadcast can occur.
    await onSigned(signedId)
    return signed
  }
  try {
    if (invoice.protocol === 'privacycash') {
      const { depositPrivacyCashInvoice } = await import('./payment-privacycash.js')
      return await depositPrivacyCashInvoice({ invoice, connection, publicKey, signTransaction, signal, onStatus })
    }
    onStatus('Preparing private deposit...')
    const sdk = await import('@cloak.dev/sdk')
    const output = invoice.outputs[0]
    const note = { amount: BigInt(output.amount), mintAddress: new PublicKey(output.mint), blinding: BigInt(output.blinding),
      commitment: BigInt(output.commitment), keypair: { publicKey: BigInt(output.publicKey), privateKey: 0n }, index: 0 }
    if ((await sdk.computeUtxoCommitment(note)).toString() !== output.commitment) throw new Error('Payment note commitment does not match')
    session(provider, address, signal)
    const result = await sdk.transact({
      inputUtxos: [await sdk.createZeroUtxo(sdk.NATIVE_SOL_MINT)], outputUtxos: [note],
      externalAmount: BigInt(invoice.amount), depositor: publicKey,
    }, {
      connection, programId: sdk.CLOAK_PROGRAM_ID, relayUrl: sdk.CLOAK_PRODUCTION_RELAY_URL,
      depositorPublicKey: publicKey, walletPublicKey: publicKey, signTransaction,
      // Invoice recovery already holds the merchant's encrypted note. The payer has no note key.
      disableChainNotes: true, enforceViewingKeyRegistration: false, maxRootRetries: 0,
      onProgress: (message) => { signal?.throwIfAborted(); onStatus(message) },
    })
    return result.signature
  } catch (error) {
    if (signedId) error.transactionId = signedId
    throw error
  }
}
