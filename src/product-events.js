// Product counters: a fixed event name and a few fixed categories, added to a
// per-day counter (the onboarding tour also to a per-hour one). Never an amount,
// address, signature, invoice, wallet key, visitor ID or error text, and
// nothing that links one event to another.
const SAFE = /^[a-z0-9][a-z0-9_]{0,31}$/
const sent = new Set()

// `once` counts an interest step at most once per page load (held in memory only):
// true for the event, or a name for one of its categories (e.g. a single failure cause).
export function track(event, props = {}, { once = false } = {}) {
  if (globalThis.location?.hostname !== 'darksol.app'
    || globalThis.navigator?.doNotTrack === '1' || globalThis.navigator?.globalPrivacyControl) return
  if (once) {
    const key = once === true ? event : `${event}:${once}`
    if (sent.has(key)) return
    sent.add(key)
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
// The backend keeps only the causes it lists (REASONS in darksol-backend
// server/product-events.js): list a new one there first, or it counts as other.
// Order matters: the first match wins.
export function failureReason(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  // An RPC refusing access reads "denied" too; it is not the user saying no.
  if (/\b403\b|forbidden|rpc access/i.test(message)) return 'network'
  // Before "rejected": a relayer refusing a withdrawal is not the user saying no.
  if (/relayer|the withdrawal (?:failed|expired|was rejected|timed out)/i.test(message)) return 'relayer'
  if (/reject|denied|declined|cancel+ed|user abort/i.test(message)) return 'rejected'
  if (/insufficient|not enough|no record of a prior credit|exceeds (?:the )?balance|AccountNotFound|\d+ lamports|no SOL|private balance/i.test(message)) return 'insufficient_funds'
  if (/slippage|0x1771|price (?:moved|impact)/i.test(message)) return 'slippage'
  // Umbra v2's prover needs the page cross-origin isolated, which a reload restores.
  if (/page reloaded|reload darksol/i.test(message)) return 'page_reload'
  // The wallet on another account, not connected, or failing inside itself.
  if (/not been authorized|switch the wallet|account changed|did not provide an address|wallet-standard account|did not connect|^unexpected error\.?$/i.test(message)) return 'wallet'
  if (/\bproofs?\b|prover|proving|witness|circuit|zkey|out of memory|memory access out of bounds/i.test(message)) return 'proof'
  if (/did not see .+ within|timed? ?out|timeout|not confirmed|block ?height exceeded|expired/i.test(message)) return 'timeout'
  if (/did not land|simulation failed|custom program error|instruction error|transaction failed|failed to send transaction/i.test(message)) return 'tx_failed'
  if (/failed to fetch|networkerror|load failed|no answer|could not finish reading|blockhash|429|50[234]|rpc|network/i.test(message)) return 'network'
  return 'other'
}

// A wallet's name as one of a few categories, e.g. "Coinbase Wallet" -> coinbase_wallet.
export const walletKind = (name) => String(name ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'unknown'
