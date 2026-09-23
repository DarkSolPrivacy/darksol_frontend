import { PublicKey } from '@solana/web3.js'
import { parseAmount } from './transfer-validation.js'
import { MERCHANT_IDENTITY_MESSAGE, deriveMerchantAccess } from './merchant-identity.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const STORAGE_PREFIX = 'darksol:payment-note:v1:'
const PROTOCOLS = ['privacycash', 'cloakc']
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const unhex = (value) => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Invalid recovery data')
  return Uint8Array.from(value.match(/../g), (byte) => parseInt(byte, 16))
}

// One signature keys every version 2 note: the index picks the note, so signing
// again on any device recovers all of them without a stored record.
export const PAYMENT_KEYS_MESSAGE = [
  'DarkSol payment notes',
  'Version: 2',
  'App: darksol.app',
  'Purpose: derive the keys of your private payment notes. Signing again recovers them.',
  'This is not a merchant access message. Keep this signature private.',
].join('\n')

export async function prepareMerchantAccess({ provider, address, signal }) {
  const signature = await sign(provider, address, MERCHANT_IDENTITY_MESSAGE, signal)
  try {
    const access = await deriveMerchantAccess(signature)
    assertSession(provider, address, signal)
    return access
  } finally {
    signature.fill(0)
  }
}

// The HKDF key is non-extractable: the page can derive note keys, never read the signature.
export async function preparePaymentKeys({ provider, address, signal }) {
  const signature = await sign(provider, address, PAYMENT_KEYS_MESSAGE, signal)
  try {
    const key = await crypto.subtle.importKey('raw', signature, 'HKDF', false, ['deriveBits'])
    assertSession(provider, address, signal)
    return { address, key }
  } finally {
    signature.fill(0)
  }
}

async function derive(keys, info, bits) {
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('DarkSol payment notes v2'), info: encoder.encode(info),
  }, keys.key, bits))
}

export const derivedInvoiceId = async (keys, index) => hex(await derive(keys, `invoice-id:${index}`, 256))
// Stands in for the per-invoice signature a version 1 note was keyed from.
const privacyCashSeed = (keys, index) => derive(keys, `privacycash-note:${index}`, 512)
export const privacyCashIv = async (keys, index, output) => hex(await derive(keys, `privacycash-iv:${index}:${output}`, 96))
export const cloakNk = (keys) => derive(keys, 'cloak-nk', 256)
const cloakSalt = async (keys, index) => BigInt('0x' + hex(await derive(keys, `cloak-note-salt:${index}`, 96)))

// The SDK's V2 layout, version(8) | iv(12) | tag(16) | ciphertext, with an IV
// derived from the note index instead of drawn at random: a cold scan finds the
// note among every pool output by its IV alone. The server refuses a second
// record for an index, so each key and IV pair encrypts once.
async function sealPrivacyCashNote(encryption, note, iv) {
  const key = await crypto.subtle.importKey('raw', encryption.encryptionKeyV2, 'AES-GCM', false, ['encrypt'])
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unhex(iv) }, key,
    encoder.encode(`${note.amount}|${note.blinding}|${note.index}|${note.mintAddress}`)))
  return '0000000000000002' + iv + hex(sealed.subarray(-16)) + hex(sealed.subarray(0, -16))
}

// Version 1 message: each note was keyed from a signature over its random invoice.
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
async function privacyCashTools(seed) {
  const [{ WasmFactory }, { EncryptionService }, { Utxo }, { Keypair }] = await Promise.all([
    import('@lightprotocol/hasher.rs'),
    import('privacycash/utils'),
    import('../node_modules/privacycash/dist/models/utxo.js'),
    import('../node_modules/privacycash/dist/models/keypair.js'),
  ])
  const wasm = await WasmFactory.getInstance()
  const encryption = new EncryptionService()
  encryption.deriveEncryptionKeyFromSignature(seed)
  const keypair = new Keypair(encryption.getUtxoPrivateKeyV2(), wasm)
  return { wasm, encryption, keypair, Utxo }
}

async function buildNote(keys, index, protocol, amount) {
  if (protocol === 'privacycash') {
    const { wasm, encryption, keypair, Utxo } = await privacyCashTools(await privacyCashSeed(keys, index))
    // The SDK's default blinding uses Math.random(); supply secure randomness.
    const notes = [amount, 0n].map((value) => new Utxo({
      lightWasm: wasm, keypair, amount: value,
      blinding: BigInt('0x' + hex(crypto.getRandomValues(new Uint8Array(31)))).toString(),
    }))
    return Promise.all(notes.map(async (note, output) => ({
      amount: note.amount.toString(), mint: note.mintAddress,
      publicKey: note.keypair.pubkey.toString(), blinding: note.blinding.toString(),
      commitment: note.getCommitment().toString(),
      encryptedNote: await sealPrivacyCashNote(encryption, note, await privacyCashIv(keys, index, output)),
    })))
  }
  // Cloak's own recoverable deposit shape: key and blinding are PRF(nk, salt).
  const sdk = await import('@cloak.dev/sdk')
  const { utxo } = await sdk.createRecoverableDepositUtxo(amount, await cloakNk(keys), sdk.NATIVE_SOL_MINT, await cloakSalt(keys, index))
  return [{
    amount: utxo.amount.toString(), mint: utxo.mintAddress.toBase58(),
    publicKey: utxo.keypair.publicKey.toString(), blinding: utxo.blinding.toString(),
    commitment: utxo.commitment.toString(),
  }]
}

// Decrypts a version 2 PrivacyCash note's outputs; AES-GCM success is what
// proves an output is this index's.
export async function privacyCashNotes(keys, index, encryptedNotes) {
  const { encryption, wasm } = await privacyCashTools(await privacyCashSeed(keys, index))
  return { encryption, notes: await Promise.all(encryptedNotes.map((note) => encryption.decryptUtxo(note, wasm))) }
}

export function readPaymentDrafts(storage, address) {
  const prefix = `${STORAGE_PREFIX}${address}:`
  const records = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(prefix)) {
      const record = JSON.parse(storage.getItem(key))
      const valid = record.version === 2 ? Number.isSafeInteger(record.index) && record.index >= 0
        : record.version === 1 && record.signingMessage === signingMessage(record.invoice)
      if (!valid || key !== prefix + record.invoice?.id) throw new Error('Saved payment recovery data is invalid')
      records.push(record)
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// `index` must be unused: pass max(server next_index, highest local draft + 1).
export async function preparePaymentNote({ provider, address, keys, index, protocol, amount, reference = '', storage = localStorage, signal, onStatus = () => {} }) {
  if (!crypto?.subtle) throw new Error('Payment links require HTTPS or localhost')
  if (!PROTOCOLS.includes(protocol)) throw new Error('Unsupported payment pool')
  const parsed = parseAmount(amount, 'SOL')
  if (!parsed.valid) throw new Error(parsed.error)
  if (typeof reference !== 'string' || reference.length > 80) throw new Error('Reference must be 80 characters or fewer')
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31) throw new Error('Invalid payment note index')
  if (keys?.address !== address) throw new Error('Payment keys belong to another wallet')
  assertSession(provider, address, signal)
  onStatus('Preparing your private note…')
  const invoice = {
    version: 1, id: await derivedInvoiceId(keys, index),
    network: 'solana-mainnet', protocol, asset: 'SOL', amount: parsed.baseUnits.toString(),
    outputs: await buildNote(keys, index, protocol, parsed.baseUnits),
  }
  assertSession(provider, address, signal)
  const record = { version: 2, index, invoice, reference: reference.trim(), createdAt: new Date().toISOString() }
  // Each draft has its own key so concurrent tabs cannot overwrite other notes.
  // Only the local storage namespace contains the wallet address.
  const storageKey = `${STORAGE_PREFIX}${address}:${invoice.id}`
  const serialized = JSON.stringify(record)
  storage.setItem(storageKey, serialized)
  if (storage.getItem(storageKey) !== serialized) throw new Error('Could not save payment recovery data')
  return record
}

// Returns the invoice's notes in spendable form, plus PrivacyCash's encryption
// service, which its withdraw needs. Version 2 uses `keys` from preparePaymentKeys;
// version 1 signs its exact saved message, and no signature is cached.
export async function recoverPaymentNote({ provider, address, record, keys, signal }) {
  const protocol = record.invoice?.protocol
  let notes, encryption
  if (record.version === 2) {
    if (!Number.isSafeInteger(record.index) || keys?.address !== address) throw new Error('Invalid payment recovery data')
    assertSession(provider, address, signal)
    if (protocol === 'privacycash') {
      ({ notes, encryption } = await privacyCashNotes(keys, record.index, record.invoice.outputs.map((output) => output.encryptedNote)))
    } else {
      const sdk = await import('@cloak.dev/sdk')
      const secrets = await sdk.deriveDepositNoteSecrets(await cloakNk(keys), await cloakSalt(keys, record.index))
      const output = record.invoice.outputs[0]
      const note = { ...secrets, amount: BigInt(output.amount), mintAddress: new PublicKey(output.mint) }
      notes = [{ ...note, commitment: await sdk.computeUtxoCommitment(note) }]
    }
  } else {
    if (record.version !== 1 || record.signingMessage !== signingMessage(record.invoice)
      || record.recovery?.algorithm !== 'AES-256-GCM') throw new Error('Invalid payment recovery data')
    const signature = await sign(provider, address, record.signingMessage, signal)
    try {
      const key = await recoveryKey(signature, protocol)
      const decrypted = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: unhex(record.recovery.iv), additionalData: authenticatedData(record),
      }, key, unhex(record.recovery.ciphertext))
      const saved = JSON.parse(decoder.decode(decrypted))
      if (protocol === 'privacycash') {
        const tools = await privacyCashTools(signature)
        encryption = tools.encryption
        notes = await Promise.all(saved.notes.map((ciphertext) => encryption.decryptUtxo(ciphertext, tools.wasm)))
      } else {
        const sdk = await import('@cloak.dev/sdk')
        notes = await Promise.all(saved.notes.map((serialized) => sdk.deserializeUtxo(unhex(serialized))))
      }
    } finally {
      signature.fill(0)
    }
  }
  if (notes.length !== record.invoice.outputs.length || notes.some((note, index) =>
    String(note.getCommitment ? note.getCommitment() : note.commitment) !== record.invoice.outputs[index].commitment)) {
    throw new Error('Recovered note does not match the invoice')
  }
  assertSession(provider, address, signal)
  return { notes, encryption }
}
