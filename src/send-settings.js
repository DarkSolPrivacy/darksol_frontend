// The send settings and the payments waiting to go out. Both live only in this
// browser: no address, amount or setting reaches our server.
import { DEFAULT_SETTINGS } from './send-options.js'

const SETTINGS_KEY = 'darksol:send-settings:v1'
const PENDING_KEY = 'darksol:pending-payments:v1'

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: nothing kept */ }
}

export function loadSettings() {
  const stored = read(SETTINGS_KEY, {})
  return { ...DEFAULT_SETTINGS, ...stored, pools: { ...DEFAULT_SETTINGS.pools, ...stored?.pools } }
}
export const saveSettings = (settings) => write(SETTINGS_KEY, settings)

/**
 * Payments whose deposit is in and whose send waits: { id, protocol, asset,
 * recipient, baseUnits, deposit, depositSignature, owner, createdAt, readyAt }.
 * Amounts are base-unit strings.
 */
export const loadPending = () => read(PENDING_KEY, []).filter((item) => item && typeof item.id === 'string')
export const savePending = (items) => write(PENDING_KEY, items)
