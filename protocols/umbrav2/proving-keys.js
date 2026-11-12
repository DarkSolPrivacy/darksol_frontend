// Umbra v2's proving files, downloaded before the click.
//
// The SDK downloads a circuit's proving key and witness calculator inside the
// first proof that needs them (transaction: 97.6 MB and 7.9 MB; absence:
// 26.8 MB and 2 MB; registration: 11.8 MB and 1.1 MB), checks each against the
// digest its manifest pins, and keeps it in IndexedDB from then on. Umbra's own
// app downloads them as soon as a wallet connects, so its first proof only proves.
//
// The SDK (@umbra-privacy/nimbus-solana-web 0.5.0) has no call that loads them
// ahead. What it does take is the `fetch` it downloads with, so the files are
// fetched here, checked against the same pinned size and digest, and kept in
// Cache Storage until the SDK asks for them through that fetch. It checks them
// again itself and stores its own copy, after which the copy here is dropped.
// A file the SDK already holds is not fetched.
export const PROVING_KEY_CACHE = 'darksol-umbrav2-proving-keys'
// The files of one circuit the SDK caches, by the manifest's names.
const ARTIFACTS = ['witness-calculator', 'proving-key']
// How long a handed-over file stays in Cache Storage: the SDK has stored its own by then.
const DROP_AFTER_MS = 120_000

const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
const isProvingFile = (url) => /\.(zkey|wcd)$/.test(url.split('?')[0])

// Downloads under way, by URL: a proof that starts meanwhile waits for the
// same download instead of starting another.
const underWay = new Map()

// The `fetch` given to the SDK. A proving file waiting in Cache Storage is
// answered from there; every other request, and a file that is not there, goes
// to the network as before.
export function createProvingKeyFetch({ fetch = (input, init) => globalThis.fetch(input, init), caches = globalThis.caches, later = setTimeout } = {}) {
  return async (input, init) => {
    const url = String(input?.url ?? input)
    if (caches && isProvingFile(url)) {
      try {
        await underWay.get(url)
        const cache = await caches.open(PROVING_KEY_CACHE)
        const kept = await cache.match(url)
        if (kept) {
          later(() => { cache.delete(url).catch(() => {}) }, DROP_AFTER_MS)
          return kept
        }
      } catch { /* The network, as before. */ }
    }
    return fetch(input, init)
  }
}

// The files the SDK has cached in this browser, as `artifact/circuit/r1cs-hash-prefix`
// (its blob keys read "…proving-key/transaction/ff73b9fe751bbdb4/plain sha256:…").
// Null when the browser cannot say.
export async function heldArtifacts(name, indexedDB = globalThis.indexedDB) {
  try {
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return new Set()
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name)
      // The SDK has not created it yet: leave it uncreated.
      request.onupgradeneeded = () => request.transaction.abort()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (!database.objectStoreNames.contains('blobs')) return new Set()
      const keys = await new Promise((resolve, reject) => {
        const request = database.transaction('blobs').objectStore('blobs').getAllKeys()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      return heldFromKeys(keys)
    } finally { database.close() }
  } catch { return null }
}

export function heldFromKeys(keys) {
  const held = new Set()
  for (const key of keys) {
    const text = typeof key === 'string' ? key : new TextDecoder().decode(key instanceof ArrayBuffer ? new Uint8Array(key) : key)
    const found = /(proving-key|witness-calculator)\/([^/\s]+)\/([0-9a-f]{16})/.exec(text)
    if (found) held.add(`${found[1]}/${found[2]}/${found[3]}`)
  }
  return held
}

// The files a payment will need that the SDK does not hold: every circuit's,
// the registration's only for a wallet not known to be registered.
export function wantedFiles(provingKeys, held, { registered = false } = {}) {
  const files = []
  for (const entry of provingKeys?.manifest?.circuits ?? []) {
    if (entry.circuit === 'registration' && registered) continue
    for (const artifact of ARTIFACTS) {
      const plain = entry.artifacts?.[artifact]?.plain
      if (!plain?.path || held.has(`${artifact}/${entry.circuit}/${String(entry.r1csHash).slice(0, 16)}`)) continue
      files.push({ url: new URL(plain.path, provingKeys.baseUrl).href, byteLength: plain.byteLength, sha256: plain.sha256 })
    }
  }
  return files
}

// Downloads the wanted files into Cache Storage, one after another, each kept
// only when its size and SHA-256 are the manifest's. Files left from an earlier
// preload that are no longer wanted are dropped. Resolves to the bytes
// downloaded; stops quietly at the first file that fails.
export async function warmProvingKeys(files, { fetch = (input, init) => globalThis.fetch(input, init), caches = globalThis.caches, subtle = globalThis.crypto?.subtle, signal } = {}) {
  if (!caches || !subtle) return 0
  const cache = await caches.open(PROVING_KEY_CACHE)
  const wanted = new Set(files.map((file) => file.url))
  for (const request of await cache.keys()) if (!wanted.has(request.url)) await cache.delete(request)
  let bytes = 0
  for (const file of files) {
    if (signal?.aborted) break
    if (underWay.has(file.url) || await cache.match(file.url)) continue
    const download = (async () => {
      const response = await fetch(file.url, { signal, priority: 'low' })
      if (!response.ok) return false
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.byteLength !== file.byteLength || hex(await subtle.digest('SHA-256', body)) !== file.sha256) return false
      await cache.put(file.url, new Response(body, { headers: { 'content-type': 'application/octet-stream' } }))
      bytes += body.byteLength
      return true
    })().catch(() => false)
    underWay.set(file.url, download)
    const kept = await download
    underWay.delete(file.url)
    if (!kept) break
  }
  return bytes
}
