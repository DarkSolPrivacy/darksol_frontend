// Gets the selected route's send ready before the click: its SDK and the
// proving files it would otherwise download after it. Only for the pool the
// planner selected, never while a payment runs, and never on a data-saver
// connection. A preload asks the wallet for nothing and proves nothing; one
// that fails says nothing, and the send loads what it needs as before.

// A browser set to save data downloads nothing it was not asked for.
export function allowsPreload(connection = globalThis.navigator?.connection) {
  return !connection?.saveData
}

// `load` is protocols/browser.js's loadBrowserAdapter (Vite-only, so the caller
// passes it); `provider` the connected wallet, which a preload may read the
// address of and never asks to sign. Resolves to whether the pool's preload ran
// to its end. Never rejects.
export async function preloadRoute(protocolId, { load, connection, provider } = {}) {
  if (!protocolId || !allowsPreload(connection)) return false
  try {
    const adapter = await load(protocolId)
    if (typeof adapter.preload !== 'function') return false
    return Boolean(await adapter.preload({ provider }))
  } catch { return false }
}
