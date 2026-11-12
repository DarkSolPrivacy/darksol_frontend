// A wallet's first Privacy Cash scan in a browser reads recent notes only.
//
// The SDK finds a wallet's notes by downloading the pool's encrypted notes
// 20,000 at a time and trying each with the wallet's key. It saves how far it
// got, so later scans read only what is new, but a first scan started at note 0:
// about 900,000 SOL notes and 80 MB, the largest delay measured in a first send
// (docs/PRIVATE_SEND_PERFORMANCE.md). privacycash.org's own app starts a first
// scan at the tree's last 100,000 notes instead, and offers a full scan beside it.
//
// This does the same with the SDK's own `offset` parameter (getUtxos and
// getUtxosSPL in privacycash 1.2.2). `deposit`, `withdraw` and their SPL
// versions scan with no offset, from the saved position, so the windowed scan
// runs before them and leaves that position at the tip.
//
// A saved position is never moved: only a wallet and asset this browser has
// never scanned get the window. A note older than the window is not counted
// until the full rescan (scanOlderNotes) has read the notes before it.
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { ENDPOINTS, MINTS } from '../addresses.js'

export const RECENT_NOTES = 100_000
// The SDK's storage key prefixes (privacycash/src/utils/constants.ts), which it
// does not export; test/privacycash-recent-scan.test.js checks them against it.
export const LSK_FETCH_OFFSET = 'fetch_offset'
export const LSK_ENCRYPTED_OUTPUTS = 'encrypted_outputs'
// Beside the SDK's position: where the first scan started, kept while the notes
// before it are unread; and the same start, kept only while that scan runs.
const RECENT_FROM = 'darksol-pc-recent-from:'
const RECENT_PENDING = 'darksol-pc-recent-pending:'
// The full rescan's own position and findings, apart from the SDK's.
const OLDER_SCAN = 'darksol-pc-older-scan:'
const RELAYER = new URL(ENDPOINTS.privacycashConfig).origin
// The relayer's name for each tree; SOL's is the default one.
const TREE_TOKEN = { SOL: null, USDC: 'usdc', USDT: 'usdt' }

// The SDK's storage keys for one wallet's notes in one tree: SOL notes are filed
// under the wallet, token notes under its associated token account.
// `localstorageKey` is the SDK's own (exported from privacycash/utils).
export function scanKeys(localstorageKey, publicKey, asset) {
  const wallet = new PublicKey(String(publicKey))
  const owner = asset === 'SOL' ? wallet : getAssociatedTokenAddressSync(new PublicKey(MINTS[asset]), wallet)
  const id = localstorageKey(owner)
  return { offset: LSK_FETCH_OFFSET + id, outputs: LSK_ENCRYPTED_OUTPUTS + id, history: `tradeHistory${id}` }
}

// How many notes a tree holds, from the relayer the SDK scans.
export async function treeSize(asset, fetcher = globalThis.fetch) {
  const token = TREE_TOKEN[asset]
  const response = await fetcher(`${RELAYER}/merkle/root${token ? `?token=${token}` : ''}`)
  if (!response.ok) throw new Error(`Privacy Cash tree state answered ${response.status}`)
  const { nextIndex } = await response.json()
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 0) throw new Error('Privacy Cash tree state has no nextIndex')
  return nextIndex
}

// Runs the wallet's first scan of one tree from its last RECENT_NOTES notes:
// `scan(offset)` is the SDK's getUtxos or getUtxosSPL with that offset, `size()`
// the tree's note count. Returns where it started, or null when it did nothing:
// the browser already holds a position, the tree is no larger than the window,
// or its size could not be read (the SDK then scans from note 0 as before).
//
// The SDK saves its position after every page but what it found only at the
// end, so a first scan cut short (a closed tab, a dropped connection) would
// resume past notes it had found and never count them. The pending mark says
// the position is that unfinished scan's own, and the scan starts over.
export async function scanRecentFirst({ keys, storage, size, scan, recent = RECENT_NOTES }) {
  const pending = storage.getItem(RECENT_PENDING + keys.offset)
  let start
  if (pending !== null) {
    start = Number(pending)
    storage.removeItem(keys.offset)
  } else {
    if (storage.getItem(keys.offset) !== null) return null
    try { start = (await size()) - recent } catch { return null }
    // Another tab may have scanned while the size was read.
    if (!(start > 0) || storage.getItem(keys.offset) !== null) return null
  }
  if (!Number.isSafeInteger(start) || start <= 0) { storage.removeItem(RECENT_PENDING + keys.offset); return null }
  storage.setItem(RECENT_PENDING + keys.offset, String(start))
  storage.setItem(RECENT_FROM + keys.offset, String(start))
  await scan(start)
  storage.removeItem(RECENT_PENDING + keys.offset)
  return start
}

// Whether the balance read under `keys` covers recent notes only.
export const coversRecentOnly = (keys, storage) => storage.getItem(RECENT_FROM + keys.offset) !== null

// A Storage whose keys all carry `prefix`, so a second SDK scan keeps a position of its own.
export function prefixedStorage(storage, prefix) {
  return {
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: (key) => storage.removeItem(prefix + key),
  }
}

// The full rescan: reads the tree from note 0 with the SDK's own scan, under a
// position of its own, so the SDK's saved position stays where it is. The
// unspent notes it finds join the SDK's note cache, which every later scan
// re-checks, and the balance stops being recent-only. `scan(storage)` runs the
// SDK's getUtxos or getUtxosSPL with that storage. An interrupted rescan starts
// over, for the reason scanRecentFirst gives. Returns whether it found notes the
// cache did not hold; false at once when the balance already covers everything.
export async function scanOlderNotes({ keys, storage, scan }) {
  if (!coversRecentOnly(keys, storage)) return false
  const shadow = prefixedStorage(storage, OLDER_SCAN)
  const clear = () => { for (const key of [keys.offset, keys.outputs, keys.history]) shadow.removeItem(key) }
  clear()
  try {
    await scan(shadow)
    const older = JSON.parse(shadow.getItem(keys.outputs) || '[]')
    const current = JSON.parse(storage.getItem(keys.outputs) || '[]')
    storage.setItem(keys.outputs, JSON.stringify([...new Set([...current, ...older])]))
    storage.removeItem(RECENT_FROM + keys.offset)
    return older.some((note) => !current.includes(note))
  } finally { clear() }
}
