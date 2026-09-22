import bs58 from 'bs58'

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
  const result = await request(endpoint, { method: 'POST', body: record, access, signal })
  paymentLinkUrl(result.payment_url)
  return result
}

export const listPaymentLinks = ({ access, signal, offset = 0 }) => request(`/api/payment-links?limit=50&offset=${offset}`, { access, signal })
export const getPaymentLink = (id, signal) => request(`/api/payment-links/${id}`, { signal })

export function validDepositId(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false
  try { return bs58.decode(value).length === 64 } catch { return false }
}

export function reportPaymentDeposit(id, transactionId, signal) {
  if (!validDepositId(transactionId)) throw new Error('Enter a valid Solana transaction ID')
  return request(`/api/payment-links/${id}/deposit`, { method: 'POST', body: { transaction_id: transactionId }, signal })
}
