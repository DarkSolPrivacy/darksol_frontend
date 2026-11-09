// The user's NEAR Confidential Intents account (darksol-backend docs/NEAR_CI.md),
// new for the NEAR Hackathon (November 2026). Pure: no wallet, no network.
//
// The account is a fresh ed25519 key, not the wallet's: the wallet signs
// KEY_MESSAGE once, and the key is derived from that signature (HKDF-SHA-256).
// Solana wallets sign ed25519 deterministically, so signing the same message
// with the same wallet gives the same key again: that is how the account is
// recovered on another device, and why the key itself is never stored outside
// this tab. Its id on NEAR (an implicit account) is the public key in hex; it
// never appears on chain, where only 1Click's one-off accounts move funds.
import { ed25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import bs58 from 'bs58'

export const KEY_MESSAGE_TEXT = [
  'DarkSol: NEAR Confidential Intents key',
  '',
  'Signing this message creates the key of your private balance in NEAR Confidential Intents.',
  'Sign it only on https://darksol.app. Anyone who has this signature can spend that balance.',
  '',
  'Version: 1',
].join('\n')
export const KEY_MESSAGE = new TextEncoder().encode(KEY_MESSAGE_TEXT)
const SALT = new TextEncoder().encode('darksol/nearci')
const INFO = new TextEncoder().encode('ed25519 account v1')
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** The 32-byte seed for a wallet's signature of KEY_MESSAGE. */
export function seedFromSignature(signature) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('The wallet returned an invalid signature')
  return hkdf(sha256, signature, SALT, INFO, 32)
}

/** The account of a seed: its id (hex), its public key as NEAR writes it, and a signer. */
export function accountFromSeed(seed) {
  const publicKey = ed25519.getPublicKey(seed)
  return {
    id: hex(publicKey),
    publicKey: `ed25519:${bs58.encode(publicKey)}`,
    /** A raw_ed25519 signedData of `payload` (a string), as 1Click takes it. */
    signedData(payload) {
      const signature = ed25519.sign(new TextEncoder().encode(payload), seed)
      return { standard: 'raw_ed25519', payload, public_key: `ed25519:${bs58.encode(publicKey)}`, signature: `ed25519:${bs58.encode(signature)}` }
    },
  }
}

/**
 * A versioned nonce for intents.near, as @defuse-protocol/intents-sdk's
 * VersionedNonceBuilder writes it: magic 5628f6c6, version 0, the contract's
 * current salt (4 bytes), the deadline in nanoseconds (u64 LE), then 15 bytes
 * that start with the time in nanoseconds and end random. Base64.
 */
export function versionedNonce({ salt, deadlineMs, nowMs, random }) {
  if (!/^[0-9a-f]{8}$/.test(salt)) throw new Error('salt must be 4 bytes of hex')
  const bytes = new Uint8Array(32)
  const view = new DataView(bytes.buffer)
  bytes.set([0x56, 0x28, 0xf6, 0xc6, 0], 0)
  bytes.set(salt.match(/../g).map((pair) => parseInt(pair, 16)), 5)
  view.setBigUint64(9, BigInt(deadlineMs) * 1_000_000n, true)
  view.setBigInt64(17, BigInt(nowMs) * 1_000_000n, true)
  bytes.set(random.slice(0, 7), 25)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

/** The login payload 1Click's /v0/auth/authenticate takes: an empty intent list, signed by the account. */
export function loginPayload({ id, salt, nowMs, random, ttlMs = 60_000 }) {
  const deadline = new Date(nowMs + ttlMs)
  return JSON.stringify({ signer_id: id, verifying_contract: 'intents.near', deadline: deadline.toISOString(), nonce: versionedNonce({ salt, deadlineMs: deadline.getTime(), nowMs, random }), intents: [] })
}
