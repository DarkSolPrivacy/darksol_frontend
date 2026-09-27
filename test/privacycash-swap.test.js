import assert from 'node:assert/strict'
import test from 'node:test'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { bytesToBase64 } from '../protocols/privacycash/browser.js'
import { finishSwap, swapEstimate, swapWallet } from '../protocols/privacycash/swap.js'

// privacycash.org derives its swap wallet with noble's hkdf at index 0; each swap
// here takes another index of the same derivation, so it stays recoverable from
// the signature and the saved index.
test('swap wallets are privacycash.org’s derivation at any index', async () => {
  const signature = Uint8Array.from({ length: 64 }, (_, index) => index * 7)
  const wallet = new PublicKey('9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD')
  const text = (value) => new TextEncoder().encode(value)
  const site = (index) => Keypair.fromSeed(hkdf(sha256, signature, sha256(text(`privacycash:v1:${wallet.toBase58()}`)), text(`privacycash:solana:wallet:v1:${index}`), 32)).publicKey.toBase58()
  assert.equal((await swapWallet(signature, wallet)).publicKey.toBase58(), site(0))
  assert.equal((await swapWallet(signature, wallet, 1234567)).publicKey.toBase58(), site(1234567))
  assert.notEqual(site(0), site(1234567))
})

// The relayer's live terms: 0.35% plus a fixed rent fee per withdrawal.
const usdc = { rate: 0.0035, fixed: 742_167n, minimum: 2_000_000n }
const sol = { rate: 0.0035, fixed: 6_000_000n, minimum: 10_000_000n }
const prices = { sol: 123.68, usdc: 0.9999 }

test('a swap too small to reach 0.05 SOL of output after the fee is refused before any deposit', () => {
  // 10 USDC less 0.777 in fees and a 1% margin: about 0.0738 SOL.
  const delivered = swapEstimate({ inputAsset: 'USDC', outputAsset: 'SOL', units: 10_000_000n, terms: usdc, prices })
  assert.ok(delivered > 70_000_000n && delivered < 76_000_000n, String(delivered))
  assert.equal(swapEstimate({ inputAsset: 'USDC', outputAsset: 'SOL', units: 5_000_000n, terms: usdc, prices }), null)
  assert.ok(swapEstimate({ inputAsset: 'SOL', outputAsset: 'USDC', units: 100_000_000n, terms: sol, prices }) > 10_000_000n)
  // 0.06 SOL keeps only 0.0478 after the fee and the 0.006 held back.
  assert.equal(swapEstimate({ inputAsset: 'SOL', outputAsset: 'USDC', units: 60_000_000n, terms: sol, prices }), null)
  assert.throws(() => swapEstimate({ inputAsset: 'USDC', outputAsset: 'SOL', units: 10_000_000n, terms: usdc, prices: { usdc: 1 } }), /no current price/)
})

// A swap cut short after its withdrawal: the one-time swap wallet holds the USDC
// and the USDC account the relayer opened for it. Finishing swaps the USDC and
// pays the recipient every lamport, that account's rent included, less the fee.
test('an interrupted swap is finished by paying the recipient straight from the swap wallet', async () => {
  const owner = Keypair.generate().publicKey
  const recipient = Keypair.generate().publicKey
  const burner = Keypair.generate()
  const usdcAccount = getAssociatedTokenAddressSync(new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), burner.publicKey)
  const key = `privacycash-swap-${owner.toBase58()}`
  const store = new Map([[key, '{}']])
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  const held = { SOL: 0n, USDC: 9_000_000n, usdcAccount: 1_488_440 }
  let sent = null
  const connection = {
    getBalance: async () => Number(held.SOL),
    getTokenAccountBalance: async () => ({ value: { amount: String(held.USDC) } }),
    // Only the swap wallet's USDC account exists; no wrapped-SOL account was left open.
    getAccountInfo: async (account) => held.usdcAccount && account.equals(usdcAccount) ? { lamports: held.usdcAccount } : null,
    getMinimumBalanceForRentExemption: async () => 1_488_440,
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
    sendRawTransaction: async (bytes) => { sent = VersionedTransaction.deserialize(bytes); Object.assign(held, { SOL: 0n, usdcAccount: 0 }); return 'payout-sig' },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
  }
  const order = new VersionedTransaction(new TransactionMessage({ payerKey: burner.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message())
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.step === 'build_tx') return Response.json({ success: true, orderResponse: { transaction: bytesToBase64(order.serialize()), requestId: 'r' } })
    Object.assign(held, { SOL: 80_000_000n, USDC: 0n })
    return Response.json({ success: true, exeRes: { status: 'Success', signature: 'swap-sig' } })
  }
  const task = { index: 42, inputAsset: 'USDC', outputAsset: 'SOL', recipient: recipient.toBase58(), keep: '0' }

  const paid = await finishSwap({ connection, burner, owner, task, onStatus: () => {} })
  // 80,000,000 swapped in + 1,488,440 rent back − 13,000 fee.
  assert.deepEqual(paid, { swapSignature: 'swap-sig', signature: 'payout-sig', tokens: 0n, lamports: 81_475_440n })
  assert.equal(calls[0].baseUnites, 9_000_000)
  const keys = sent.message.staticAccountKeys.map((account) => account.toBase58())
  assert.equal(keys[0], burner.publicKey.toBase58())
  const transfer = sent.message.compiledInstructions.find((instruction) => keys[instruction.programIdIndex] === SystemProgram.programId.toBase58())
  assert.equal(keys[transfer.accountKeyIndexes[1]], recipient.toBase58())
  assert.equal(Buffer.from(transfer.data).readBigUInt64LE(4), 81_475_440n)
  assert.ok(!store.has(key))

  // Already paid: an empty wallet only forgets the task.
  store.set(key, '{}')
  assert.equal(await finishSwap({ connection, burner, owner, task, onStatus: () => {} }), null)
  assert.equal(calls.length, 2)
  assert.ok(!store.has(key))
})
