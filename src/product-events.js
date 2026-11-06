// Product counters: a fixed event name and a few fixed categories, added to a
// per-day counter. Never an amount, address, signature, invoice, wallet key,
// visitor ID or error text, and nothing that links one event to another.
const SAFE = /^[a-z0-9][a-z0-9_]{0,31}$/
const sent = new Set()

// `once` counts an interest step at most once per page load (held in memory only).
export function track(event, props = {}, { once = false } = {}) {
  if (globalThis.location?.hostname !== 'darksol.app'
    || globalThis.navigator?.doNotTrack === '1' || globalThis.navigator?.globalPrivacyControl) return
  if (once) {
    if (sent.has(event)) return
    sent.add(event)
  }
  const params = new URLSearchParams({ e: event })
  for (const [key, value] of Object.entries(props)) {
    const text = String(value ?? '').toLowerCase()
    if (SAFE.test(text)) params.set(key, text)
  }
  // Counting failures must never interrupt navigation or wallet operations.
  try {
    void fetch(`/api/event?${params}`, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', keepalive: true,
    }).catch(() => {})
  } catch { /* Collection is best effort. */ }
}

// Why something failed, as one bounded category; the message itself never leaves.
export function failureReason(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/install a solana wallet/i.test(message)) return 'no_wallet'
  // An RPC refusing access reads "denied" too; it is not the user saying no.
  if (/\b403\b|forbidden|rpc access/i.test(message)) return 'network'
  if (/reject|denied|declined|cancel+ed|user abort/i.test(message)) return 'rejected'
  if (/insufficient|not enough|no record of a prior credit|exceeds (?:the )?balance/i.test(message)) return 'insufficient_funds'
  if (/slippage|0x1771|price (?:moved|impact)/i.test(message)) return 'slippage'
  if (/failed to fetch|networkerror|load failed|no answer|timed? ?out|timeout|not confirmed|block ?height exceeded|blockhash|429|50[234]|rpc|network/i.test(message)) return 'network'
  return 'other'
}

// A wallet's name as one of a few categories, e.g. "Coinbase Wallet" -> coinbase_wallet.
export const walletKind = (name) => String(name ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'unknown'
