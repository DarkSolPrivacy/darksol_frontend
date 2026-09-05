// Token decimals and base-unit conversion.
//
// TOKEN_DECIMALS was declared five times across the app (transfer-validation,
// main.jsx, bridge-routes twice, server/app.js, server/index.js). Amounts are
// always integer base units held as BigInt; floating point never touches them.

export const TOKEN_DECIMALS = Object.freeze({ SOL: 9, USDC: 6, USDT: 6 })

export function decimalsFor(asset) {
  const decimals = TOKEN_DECIMALS[String(asset).toUpperCase()]
  if (decimals === undefined) throw new Error(`Unsupported asset: ${asset}`)
  return decimals
}

// Parses a human decimal string into base units. Returns null rather than
// throwing, because every caller is validating user input.
export function rawTokenAmount(value, asset) {
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  const decimals = decimalsFor(asset)
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) return null
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

export function rawTokenText(raw, asset) {
  const decimals = decimalsFor(asset)
  const scale = 10n ** BigInt(decimals)
  const whole = raw / scale
  const fraction = String(raw % scale).padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}
