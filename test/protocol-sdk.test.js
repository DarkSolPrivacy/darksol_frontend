import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { PROGRAMS, parseLamports, parseRecipient, requireExecute } from '../scripts/runtime.ts'

test('production program addresses remain pinned', () => {
  assert.equal(new PublicKey(PROGRAMS.cloakc).toBase58(), PROGRAMS.cloakc)
  assert.equal(new PublicKey(PROGRAMS.privacycash).toBase58(), PROGRAMS.privacycash)
  assert.equal(PROGRAMS.curvyVault.toLowerCase(), '0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00')
  assert.equal(PROGRAMS.curvyAggregator.toLowerCase(), '0xe51924cef003a654ec9735c4d97f5d4862cbcbb1')
})

test('lamports parser accepts integers and refuses floats or zero', () => {
  assert.equal(parseLamports('50000000'), 50_000_000n)
  assert.throws(() => parseLamports('0'))
  assert.throws(() => parseLamports('0.1'))
  assert.throws(() => parseLamports('-1'))
})

test('recipient parser validates and canonicalizes Solana addresses', () => {
  const address = '11111111111111111111111111111111'
  assert.equal(parseRecipient(address).toBase58(), address)
  assert.throws(() => parseRecipient('not-an-address'))
})

test('broadcasting requires an explicit execute flag', () => {
  assert.throws(() => requireExecute([]), /Refusing to broadcast/)
  assert.doesNotThrow(() => requireExecute(['--execute']))
})
