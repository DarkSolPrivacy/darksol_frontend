import bs58 from 'bs58'
import { validateCheckout } from './payment-assets.js'

// The backend validates and parameterizes everything; these checks stop a
// malformed value in the browser, before it reaches a URL path or request body.
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

function paymentId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid payment ID')
  return id
}

// Mirrors the backend's record shape: nothing beyond these fields leaves the browser.
export function validatePaymentRecord(record) {
  const derived = record?.version === 2
  const { invoice, recovery } = record ?? {}
  if (!exactKeys(record, derived ? ['version', 'index', 'invoice', 'reference', 'createdAt']
    : ['version', 'invoice', 'signingMessage', 'reference', 'createdAt', 'recovery'])
    || (derived ? !Number.isSafeInteger(record.index) || record.index < 0 || record.index >= 2 ** 31
      : record.version !== 1 || typeof record.signingMessage !== 'string' || record.signingMessage.length > 1000
        || !exactKeys(recovery, ['algorithm', 'iv', 'ciphertext']) || recovery.algorithm !== 'AES-256-GCM'
        || !/^[0-9a-f]{24}$/.test(recovery.iv) || !/^(?:[0-9a-f]{2}){17,8192}$/.test(recovery.ciphertext))
    || typeof record.reference !== 'string' || record.reference.length > 80
    || typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))
    || new Date(record.createdAt).toISOString() !== record.createdAt
    || !exactKeys(invoice, ['version', 'id', 'network', 'protocol', 'asset', 'amount', 'outputs'])
    || !Array.isArray(invoice.outputs) || !invoice.outputs.every((output) => exactKeys(output,
      ['amount', 'mint', 'publicKey', 'blinding', 'commitment', ...(invoice.protocol === 'privacycash' ? ['encryptedNote'] : [])]))) {
    throw new Error('Saved payment record is invalid')
  }
  const { id, ...terms } = invoice
  validateCheckout({ ...terms, payment_id: id, status: 'pending' })
  return record
}

async function request(path, { access, signal, method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method, cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(access ? { Authorization: `Bearer ${access.credential}`, 'X-Merchant-Id': access.merchant_id } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw Object.assign(new Error(result?.error || 'Payment service unavailable. Please try again.'), { status: response.status })
  return result
}

export function paymentLinkUrl(value) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid payment URL')
  return url.href
}

export async function createPaymentLink({ record, access, signal, endpoint = '/api/payment-links' }) {
  const result = await request(endpoint, { method: 'POST', body: validatePaymentRecord(record), access, signal })
  paymentLinkUrl(result.payment_url)
  return result
}

export const deletePaymentLink = (id, access, signal) =>
  request(`/api/payment-links/${paymentId(id)}`, { method: 'DELETE', access, signal })

export function listPaymentLinks({ access, signal, offset = 0 }) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid page offset')
  return request(`/api/payment-links?limit=50&offset=${offset}`, { access, signal })
}
export const getPaymentLink = (id, signal) => request(`/api/payment-links/${paymentId(id)}`, { signal })

export function validDepositId(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false
  try { return bs58.decode(value).length === 64 } catch { return false }
}

export function reportPaymentDeposit(id, transactionId, signal) {
  if (!validDepositId(transactionId)) throw new Error('Enter a valid Solana transaction ID')
  return request(`/api/payment-links/${paymentId(id)}/deposit`, { method: 'POST', body: { transaction_id: transactionId }, signal })
}
