import { PublicKey } from '@solana/web3.js'
import { parseAmount } from './transfer-validation.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const STORAGE_PREFIX = 'darksol:payment-note:v1:'
const PROTOCOLS = ['privacycash', 'cloakc']
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const unhex = (value) => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Invalid recovery data')
  return Uint8Array.from(value.match(/../g), (byte) => parseInt(byte, 16))
}

function signingMessage(invoice) {
  if (invoice.version !== 1 || invoice.network !== 'solana-mainnet' || invoice.asset !== 'SOL'
    || !PROTOCOLS.includes(invoice.protocol) || !/^[0-9a-f]{64}$/.test(invoice.id)
    || !/^[1-9][0-9]*$/.test(invoice.amount) || BigInt(invoice.amount) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Unsupported payment invoice')
  }
  return [
    'DarkSol private payment link',
    'Version: 1',
    'App: darksol.app',
    'Network: solana-mainnet',
    `Protocol: ${invoice.protocol}`,
    `Invoice: ${invoice.id}`,
    `Amount: ${invoice.amount} lamports`,
    'Sign to prepare and recover this private payment note. Keep this signature private.',
  ].join('\n')
}

function assertSession(provider, address, signal) {
  signal?.throwIfAborted()
  if (!provider?.publicKey || String(provider.publicKey) !== address || provider.isConnected === false) {
    throw new Error('Wallet account changed. Reconnect the original wallet and try again.')
  }
}

async function sign(provider, address, message, signal) {
  assertSession(provider, address, signal)
  if (typeof provider.signMessage !== 'function') throw new Error('This wallet does not support message signing')
  const result = await provider.signMessage(encoder.encode(message), 'utf8')
  assertSession(provider, address, signal)
  const bytes = result?.signature ?? result
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) throw new Error('Wallet returned an invalid signature')
  const signature = new Uint8Array(bytes)
  const publicKey = await crypto.subtle.importKey('raw', new PublicKey(address).toBytes(), 'Ed25519', false, ['verify'])
  if (!await crypto.subtle.verify('Ed25519', publicKey, signature, encoder.encode(message))) {
    signature.fill(0)
    throw new Error('Wallet signature could not be verified')
  }
  return signature
}

async function recoveryKey(signature, protocol) {
  const material = await crypto.subtle.importKey('raw', signature, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('DarkSol private payment link v1'),
    info: encoder.encode(`encrypted-recovery:${protocol}`),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

function authenticatedData(record) {
  return encoder.encode(JSON.stringify({
    version: record.version, signingMessage: record.signingMessage,
    invoice: record.invoice, reference: record.reference, createdAt: record.createdAt,
  }))
}

// These two model imports intentionally match the tested privacycash@1.2.2
// internals. EncryptionService's SDK-derived note key must match decryptUtxo().
async function privacyCashTools(signature) {
  const [{ WasmFactory }, { EncryptionService }, { Utxo }, { Keypair }] = await Promise.all([
    import('@lightprotocol/hasher.rs'),
    import('privacycash/utils'),
    import('../node_modules/privacycash/dist/models/utxo.js'),
    import('../node_modules/privacycash/dist/models/keypair.js'),
  ])
  const wasm = await WasmFactory.getInstance()
  const encryption = new EncryptionService()
  encryption.deriveEncryptionKeyFromSignature(signature)
  const keypair = new Keypair(encryption.getUtxoPrivateKeyV2(), wasm)
  return { wasm, encryption, keypair, Utxo }
}

async function buildNote(protocol, amount, signature) {
  if (protocol === 'privacycash') {
    const { wasm, encryption, keypair, Utxo } = await privacyCashTools(signature)
    // The SDK's default blinding uses Math.random(); supply secure randomness.
    const notes = [amount, 0n].map((value) => new Utxo({
      lightWasm: wasm, keypair, amount: value,
      blinding: BigInt('0x' + hex(crypto.getRandomValues(new Uint8Array(31)))).toString(),
    }))
    const outputs = notes.map((note) => ({
      amount: note.amount.toString(), mint: note.mintAddress,
      publicKey: note.keypair.pubkey.toString(), blinding: note.blinding.toString(),
      commitment: note.getCommitment().toString(),
      encryptedNote: encryption.encryptUtxo(note).toString('hex'),
    }))
    return { outputs, privateNotes: outputs.map((note) => note.encryptedNote) }
  }
  const sdk = await import('@cloak.dev/sdk')
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', signature))
  const owner = await sdk.deriveUtxoKeypairFromSpendKey(sdk.deriveSpendKey(seed).sk_spend)
  seed.fill(0)
  const note = await sdk.createUtxo(amount, owner, sdk.NATIVE_SOL_MINT)
  return {
    outputs: [{
      amount: note.amount.toString(), mint: note.mintAddress.toBase58(),
      publicKey: owner.publicKey.toString(), blinding: note.blinding.toString(),
      commitment: note.commitment.toString(),
    }],
    privateNotes: [hex(sdk.serializeUtxo(note))],
  }
}

export function readPaymentDrafts(storage, address) {
  const prefix = `${STORAGE_PREFIX}${address}:`
  const records = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(prefix)) {
      const record = JSON.parse(storage.getItem(key))
      if (record.version !== 1 || record.signingMessage !== signingMessage(record.invoice)
        || key !== prefix + record.invoice.id) throw new Error('Saved payment recovery data is invalid')
      records.push(record)
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function preparePaymentNote({ provider, address, protocol, amount, reference = '', storage = localStorage, signal, onStatus = () => {} }) {
  if (!crypto?.subtle) throw new Error('Payment links require HTTPS or localhost')
  if (!PROTOCOLS.includes(protocol)) throw new Error('Unsupported payment pool')
  const parsed = parseAmount(amount, 'SOL')
  if (!parsed.valid) throw new Error(parsed.error)
  if (typeof reference !== 'string' || reference.length > 80) throw new Error('Reference must be 80 characters or fewer')
  const invoice = {
    version: 1, id: hex(crypto.getRandomValues(new Uint8Array(32))),
    network: 'solana-mainnet', protocol, asset: 'SOL', amount: parsed.baseUnits.toString(),
  }
  const message = signingMessage(invoice)
  onStatus('Approve the message in your wallet…')
  const signature = await sign(provider, address, message, signal)
  try {
    onStatus('Preparing your private note…')
    const { outputs, privateNotes } = await buildNote(protocol, parsed.baseUnits, signature)
    assertSession(provider, address, signal)
    const record = {
      version: 1, invoice: { ...invoice, outputs }, signingMessage: message,
      reference: reference.trim(), createdAt: new Date().toISOString(),
    }
    const key = await recoveryKey(signature, protocol)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: authenticatedData(record) }, key,
      encoder.encode(JSON.stringify({ notes: privateNotes, fundedIndex: null })),
    )
    record.recovery = { algorithm: 'AES-256-GCM', iv: hex(iv), ciphertext: hex(new Uint8Array(ciphertext)) }
    assertSession(provider, address, signal)
    // Each draft has its own key so concurrent tabs cannot overwrite other notes.
    // Only the local storage namespace contains the wallet address.
    const storageKey = `${STORAGE_PREFIX}${address}:${invoice.id}`
    const serialized = JSON.stringify(record)
    storage.setItem(storageKey, serialized)
    if (storage.getItem(storageKey) !== serialized) throw new Error('Could not save payment recovery data')
    return record
  } finally {
    signature.fill(0)
  }
}

// Recovering signs the exact saved message; no signature or plaintext spending
// key is cached. The confirmed tree index must be supplied after actual funding.
export async function recoverPaymentNote({ provider, address, record, signal }) {
  if (record.version !== 1 || record.signingMessage !== signingMessage(record.invoice)
    || record.recovery?.algorithm !== 'AES-256-GCM') throw new Error('Invalid payment recovery data')
  const signature = await sign(provider, address, record.signingMessage, signal)
  try {
    const key = await recoveryKey(signature, record.invoice.protocol)
    const decrypted = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: unhex(record.recovery.iv), additionalData: authenticatedData(record),
    }, key, unhex(record.recovery.ciphertext))
    const saved = JSON.parse(decoder.decode(decrypted))
    let notes
    if (record.invoice.protocol === 'privacycash') {
      const { wasm, encryption } = await privacyCashTools(signature)
      notes = await Promise.all(saved.notes.map((ciphertext) => encryption.decryptUtxo(ciphertext, wasm)))
    } else {
      const sdk = await import('@cloak.dev/sdk')
      notes = await Promise.all(saved.notes.map((serialized) => sdk.deserializeUtxo(unhex(serialized))))
    }
    if (notes.length !== record.invoice.outputs.length || notes.some((note, index) =>
      String(note.getCommitment ? note.getCommitment() : note.commitment) !== record.invoice.outputs[index].commitment)) {
      throw new Error('Recovered note does not match the invoice')
    }
    assertSession(provider, address, signal)
    return { notes, fundedIndex: saved.fundedIndex }
  } finally {
    signature.fill(0)
  }
}
