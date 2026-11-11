// Privacy Cash's proving files, fetched once per page and served from memory.
//
// snarkjs fetches the witness program and the proving key by URL inside every
// proof: 19.7 MB for the deposit and again for each withdrawal, and on a first
// visit 8 to 20 s of the send (docs/PRIVATE_SEND_PERFORMANCE.md). Held here, a
// preload before the click can fetch them ahead, and a later proof on the same
// page never asks the network again.
//
// Each file is checked against its size and SHA-256 before it is kept. The
// values are those of privacycash 1.2.2's circuit2 directory, which
// public/circuit2 copies; test/privacycash-circuit-files.test.js checks both.
export const CIRCUIT_FILES = Object.freeze({
  '/circuit2/transaction2.wasm': Object.freeze({ bytes: 3_208_099, sha256: 'a277631b7616c2c0bfd78a1648b069972ac6020e5509ae8f9bfc8772bdc70ec1', type: 'application/wasm' }),
  '/circuit2/transaction2.zkey': Object.freeze({ bytes: 16_461_496, sha256: '4aa7aa5c1c28ed1f00fee84f49c1686f53210fd999ef7c8db6cfcd298af4e693', type: 'application/octet-stream' }),
})

const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

// `fetch` is the page's own, unwrapped; `base` the page's URL, which says which
// origin's /circuit2/ these are; `subtle` WebCrypto's digest; `files` the pins.
export function createCircuitFiles({ fetch, base, subtle = globalThis.crypto?.subtle, files = CIRCUIT_FILES }) {
  const held = new Map()

  // The file's bytes, downloaded and checked once. A failed download or a file
  // that does not match is not kept, so the next call tries again.
  function load(path) {
    const expected = files[path]
    if (!expected) return Promise.reject(new Error(`${path} is not a Privacy Cash proving file`))
    if (!held.has(path)) {
      const loading = (async () => {
        const response = await fetch(new URL(path, base).href)
        if (!response.ok) throw new Error(`${path} answered ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength !== expected.bytes || hex(await subtle.digest('SHA-256', bytes)) !== expected.sha256) {
          console.warn(`[privacycash] ${path} does not match its pinned SHA-256; not kept`)
          throw new Error(`${path} does not match its pinned SHA-256`)
        }
        return bytes
      })()
      held.set(path, loading)
      loading.catch(() => { if (held.get(path) === loading) held.delete(path) })
    }
    return held.get(path)
  }

  // Which proving file a request asks for, if any: a GET to this origin's path.
  function pathOf(input, init) {
    if (!base || !subtle) return null
    if (String(init?.method ?? input?.method ?? 'GET').toUpperCase() !== 'GET') return null
    let url
    try { url = new URL(String(input?.url ?? input), base) } catch { return null }
    return url.origin === new URL(base).origin && files[url.pathname] ? url.pathname : null
  }

  // The response for a proving file's request, from memory, waiting for a
  // download already under way. Null for any other request, and when the file
  // could not be loaded and checked: the caller then asks the network as before.
  async function respond(input, init) {
    const path = pathOf(input, init)
    if (!path) return null
    try {
      return new Response(await load(path), { status: 200, headers: { 'content-type': files[path].type } })
    } catch { return null }
  }

  return { load, respond, paths: Object.keys(files) }
}
