// Lazy loader for the browser adapters. Vite-only.
//
// import.meta.glob is resolved at build time, so Vite emits one chunk per
// protocol and the entry bundle carries none of the privacy SDKs or their wasm.
// That is the same reason the old code wrote `await import('./cloak-client.js')`
// by hand at the call site; this keeps the behaviour and drops the hardcoding.
//
// Being compile-time is also why this is safe where protocols/load.js would not
// be: nothing here depends on reading the filesystem at runtime.
const adapters = import.meta.glob('./*/browser.js')

export function hasBrowserAdapter(protocolId) {
  return Boolean(adapters[`./${protocolId}/browser.js`])
}

export async function loadBrowserAdapter(protocolId) {
  const load = adapters[`./${protocolId}/browser.js`]
  if (!load) throw new Error(`${protocolId} has no browser adapter`)
  return load()
}
