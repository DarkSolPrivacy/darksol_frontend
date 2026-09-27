import assert from 'node:assert/strict'
import test from 'node:test'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { bytesToBase64 } from '../protocols/privacycash/browser.js'
import { finishSwap, swapEstimate, swapWallet } from '../protocols/privacycash/swap.js'

// privacycash.org derives its swap wallet with noble's hkdf; ours must land on the
// same address, or a swap cut short in one app is invisible to the other.
test('the swap wallet is the one privacycash.org derives from the same signature', async () => {
  const signature = Uint8Array.from({ length: 64 }, (_, index) => index * 7)
  const wallet = new PublicKey('9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD')
  const text = (value) => new TextEncoder().encode(value)
  const site = Keypair.fromSeed(hkdf(sha256, signature, sha256(text(`privacycash:v1:${wallet.toBase58()}`)), text('privacycash:solana:wallet:v1:0'), 32))
  assert.equal((await swapWallet(signature, wallet)).publicKey.toBase58(), site.publicKey.toBase58())
})

// The relayer's live terms: 0.35% plus a fixed rent fee per withdrawal.
const terms = {
  SOL: { rate: 0.0035, fixed: 6_000_000n, minimum: 10_000_000n },
  USDC: { rate: 0.0035, fixed: 742_167n, minimum: 2_000_000n },
}
const prices = { sol: 123.68, usdc: 0.9999 }

test('a swap too small to reach 0.05 SOL of output after fees is refused before any deposit', () => {
  const shielded = swapEstimate({ inputAsset: 'USDC', outputAsset: 'SOL', units: 10_000_000n, terms, prices })
  // 10 USDC less 0.777 in fees, 1% margin, then 0.0043 SOL kept for the deposit.
  assert.ok(shielded > 60_000_000n && shielded < 75_000_000n, String(shielded))
  assert.equal(swapEstimate({ inputAsset: 'USDC', outputAsset: 'SOL', units: 5_000_000n, terms, prices }), null)
  assert.ok(swapEstimate({ inputAsset: 'SOL', outputAsset: 'USDC', units: 100_000_000n, terms, prices }) > 10_000_000n)
  // 0.05 SOL keeps only 0.034 after the fee and the 0.01 the swap wallet holds back.
  assert.equal(swapEstimate({ inputAsset: 'SOL', outputAsset: 'USDC', units: 50_000_000n, terms, prices }), null)
  assert.throws(() => swapEstimate({ inputAsset: 'USDC', outputAsset: 'SOL', units: 10_000_000n, terms, prices: { usdc: 1 } }), /no current price/)
})

// A swap cut short after its withdrawal: the swap wallet holds the USDC. Finishing
// it swaps that USDC, shields the SOL it gets (less the deposit's fee reserve)
// into the wallet's own balance, and forgets the task; an empty wallet only forgets.
test('an interrupted swap is finished from what the swap wallet holds', async () => {
  const wallet = Keypair.generate().publicKey
  const burner = Keypair.generate()
  const key = `privacycash-swap-${wallet.toBase58()}`
  const store = new Map([[key, '{}']])
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  const held = { SOL: 0n, USDC: 9_000_000n }
  const connection = { getBalance: async () => Number(held.SOL), getTokenAccountBalance: async () => ({ value: { amount: String(held.USDC) } }) }
  const order = new VersionedTransaction(new TransactionMessage({ payerKey: burner.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message())
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.step === 'build_tx') return Response.json({ success: true, orderResponse: { transaction: bytesToBase64(order.serialize()), requestId: 'r' } })
    Object.assign(held, { SOL: 80_000_000n, USDC: 0n })
    return Response.json({ success: true, exeRes: { status: 'Success', signature: 'swap-sig' } })
  }
  const deposits = []
  const privacyCash = { deposit: async (params) => { deposits.push(params); return { tx: 'deposit-sig' } } }
  const session = { privacyCash, common: { publicKey: wallet }, connection }
  const task = { inputAsset: 'USDC', outputAsset: 'SOL' }

  const shielded = await finishSwap({ session, burner, task, onStatus: () => {} })
  assert.deepEqual(shielded, { units: 75_700_000n, swapSignature: 'swap-sig', depositSignature: 'deposit-sig' })
  assert.equal(calls[0].baseUnites, 9_000_000)
  assert.equal(deposits[0].amount_in_lamports, 75_700_000)
  assert.equal(deposits[0].signer.toBase58(), burner.publicKey.toBase58())
  assert.equal(deposits[0].publicKey, wallet)
  assert.ok(!store.has(key))

  store.set(key, '{}')
  Object.assign(held, { SOL: 1_000_000n })
  assert.equal(await finishSwap({ session, burner, task, onStatus: () => {} }), null)
  assert.equal(deposits.length, 1)
  assert.ok(!store.has(key))
})
