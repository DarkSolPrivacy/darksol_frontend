import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, sanitizeAmount, validateSolanaAddress, validateTransfer } from '../src/transfer-validation.js'

const SENDER = '11111111111111111111111111111111'
const RECIPIENT_ONE = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const RECIPIENT_TWO = 'SysvarRent111111111111111111111111111111111'

test('amounts are normalized and converted without floating point math', () => {
  assert.equal(sanitizeAmount(' ００１.２３００ '), '001.2300')
  assert.deepEqual(parseAmount(' 001.2300 ', 'USDC'), {
    valid: true,
    baseUnits: 1_230_000n,
    normalized: '1.23',
  })
  assert.equal(parseAmount('0.000000001', 'SOL').baseUnits, 1n)
})

test('invalid, zero, over-precision, and unsafe amounts are rejected', () => {
  for (const value of ['', '0', '-1', '1e3', '1,000', '1.2x']) {
    assert.equal(parseAmount(value, 'USDC').valid, false, value)
  }
  assert.match(parseAmount('1.0000001', 'USDC').error, /6 decimals/)
  assert.equal(parseAmount('9007199254.740992', 'USDC').valid, false)
})

test('Solana addresses are trimmed, canonicalized, and validated', () => {
  assert.equal(validateSolanaAddress(`  ${RECIPIENT_ONE}\n`).sanitized, RECIPIENT_ONE)
  assert.equal(validateSolanaAddress(RECIPIENT_ONE).valid, true)
  assert.equal(validateSolanaAddress(`${RECIPIENT_ONE} x`).valid, false)
  assert.equal(validateSolanaAddress('not-an-address').valid, false)
})

test('transfer validation requires exact allocation and distinct non-sender recipients', () => {
  const valid = validateTransfer({
    asset: 'USDC',
    amount: '10',
    senderAddress: SENDER,
    recipients: [
      { address: RECIPIENT_ONE, amount: '4' },
      { address: RECIPIENT_TWO, amount: '6' },
    ],
  })
  assert.equal(valid.valid, true)
  assert.equal(valid.allocated, 10_000_000n)

  assert.match(validateTransfer({
    asset: 'USDC', amount: '10', senderAddress: SENDER,
    recipients: [{ address: RECIPIENT_ONE, amount: '9' }],
  }).error, /equal the total/)

  assert.match(validateTransfer({
    asset: 'USDC', amount: '10', senderAddress: SENDER,
    recipients: [{ address: RECIPIENT_ONE, amount: '5' }, { address: RECIPIENT_ONE, amount: '5' }],
  }).error, /different/)

  assert.match(validateTransfer({
    asset: 'USDC', amount: '10', senderAddress: SENDER,
    recipients: [{ address: SENDER, amount: '10' }],
  }).error, /different receiving address/)
})
