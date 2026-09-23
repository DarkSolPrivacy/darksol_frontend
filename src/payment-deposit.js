import { AddressLookupTableProgram, Connection, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { getPaymentLink } from './payment-api.js'
import { PAYMENT_ASSETS, cloakMinimum, paymentMint, validateCheckout } from './payment-assets.js'

export { validateCheckout }

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

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

// A signed deposit can land only while its blockhash is valid. Check expiry first,
// then history: unseen after expiry means it can never land and a retry is safe.
export async function depositExpired(id, blockhash, connection = new Connection(paymentRpcUrl(), 'confirmed')) {
  if (!blockhash || (await connection.isBlockhashValid(blockhash)).value) return false
  const { value: [status] } = await connection.getSignatureStatuses([id], { searchTransactionHistory: true })
  return !status
}

export async function payPaymentInvoice({ invoice, provider, address, signal, onStatus = () => {}, onSigned, connection = new Connection(paymentRpcUrl(), 'confirmed') }) {
  validateCheckout(invoice)
  session(provider, address, signal)
  if (typeof provider.signTransaction !== 'function') throw new Error('This wallet does not support transaction signing')
  if (invoice.status === 'paid') throw new Error('This invoice is already paid')
  if (invoice.protocol === 'cloakc' && BigInt(invoice.amount) < PAYMENT_ASSETS[invoice.asset].cloakMin) throw new Error(`Cloak requires a minimum payment of ${cloakMinimum(invoice.asset)}`)
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error('Connect to Solana mainnet to pay this invoice')
  const publicKey = new PublicKey(address)
  const mint = new PublicKey(paymentMint(invoice.protocol, invoice.asset))
  const lamports = BigInt(await connection.getBalance(publicKey))
  if (invoice.asset === 'SOL') {
    if (lamports < BigInt(invoice.amount) + 1000000n) throw new Error('Not enough SOL for this payment and network fees')
  } else {
    const account = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, publicKey)).catch(() => null)
    if (!account || BigInt(account.value.amount) < BigInt(invoice.amount)) throw new Error(`Not enough ${invoice.asset} for this payment`)
    // Cloak SPL deposits also pay rent for a supplemental lookup table (about 0.0056 SOL).
    if (lamports < (invoice.protocol === 'cloakc' ? 8000000n : 2000000n)) throw new Error('Not enough SOL for network fees')
  }
  let signedId = null
  const signTransaction = async (transaction) => {
    session(provider, address, signal)
    // Cloak's SPL deposit first creates a lookup table in a legacy transaction.
    // It moves no funds and is not the deposit, so it takes no invoice guard.
    if (transaction.version === undefined) {
      if (invoice.protocol !== 'cloakc' || invoice.asset === 'SOL' || !transaction.instructions?.length
        || !transaction.instructions.every((instruction) => instruction.programId.equals(AddressLookupTableProgram.programId))) throw new Error('Unexpected transaction to sign')
      onStatus('Approve lookup table setup in your wallet...')
      const signed = await provider.signTransaction(transaction)
      session(provider, address, signal)
      return signed
    }
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
    await onSigned(signedId, signed.message.recentBlockhash)
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
      inputUtxos: [await sdk.createZeroUtxo(mint)], outputUtxos: [note],
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
