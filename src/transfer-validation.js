import { PublicKey } from '@solana/web3.js'
import { TOKEN_DECIMALS } from '../protocols/shared/units.js'

export { TOKEN_DECIMALS }

export function sanitizeAmount(value) {
  return String(value ?? '').normalize('NFKC').trim()
}

export function parseAmount(value, asset) {
  const text = sanitizeAmount(value)
  const decimals = TOKEN_DECIMALS[asset]
  if (decimals === undefined) return { valid: false, error: 'Unsupported asset' }
  if (!text) return { valid: false, error: 'Enter an amount' }
  // A trailing dot ("5.") is a whole amount still being typed.
  if (!/^\d+(?:\.\d*)?$/.test(text)) return { valid: false, error: 'Use numbers only' }
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) return { valid: false, error: `${asset} supports ${decimals} decimals` }
  const baseUnits = BigInt(whole) * (10n ** BigInt(decimals))
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  if (baseUnits <= 0n) return { valid: false, error: 'Amount must be greater than zero' }
  if (baseUnits > BigInt(Number.MAX_SAFE_INTEGER)) return { valid: false, error: 'Amount is too large' }
  const normalizedFraction = fraction.replace(/0+$/, '')
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0'
  return {
    valid: true,
    baseUnits,
    normalized: normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole,
  }
}

export function sanitizeSolanaAddress(value) {
  return String(value ?? '').normalize('NFKC').trim()
}

export function validateSolanaAddress(value) {
  const sanitized = sanitizeSolanaAddress(value)
  if (!sanitized) return { valid: false, sanitized, error: 'Enter an address' }
  if (/\s/.test(sanitized)) return { valid: false, sanitized, error: 'Address contains spaces' }
  try {
    const publicKey = new PublicKey(sanitized)
    const normalized = publicKey.toBase58()
    if (normalized !== sanitized) return { valid: false, sanitized, error: 'Invalid Solana address' }
    return { valid: true, sanitized: normalized, publicKey }
  } catch {
    return { valid: false, sanitized, error: 'Invalid Solana address' }
  }
}

export function validateTransfer({ asset, amount, recipients, senderAddress }) {
  const total = parseAmount(amount, asset)
  const rows = recipients.map((recipient) => ({
    address: validateSolanaAddress(recipient.address),
    amount: parseAmount(recipient.amount, asset),
  }))
  if (!total.valid) return { valid: false, error: total.error, total, rows }
  const invalidRow = rows.find((row) => !row.address.valid || !row.amount.valid)
  if (invalidRow) return { valid: false, error: invalidRow.address.error || invalidRow.amount.error, total, rows }
  const addresses = rows.map((row) => row.address.sanitized)
  if (new Set(addresses).size !== addresses.length) return { valid: false, error: 'Recipient addresses must be different', total, rows }
  if (senderAddress && addresses.includes(senderAddress)) return { valid: false, error: 'Use a different receiving address', total, rows }
  const allocated = rows.reduce((sum, row) => sum + row.amount.baseUnits, 0n)
  if (allocated !== total.baseUnits) return { valid: false, error: 'Recipient amounts must equal the total', total, rows, allocated }
  return { valid: true, total, rows, allocated }
}
