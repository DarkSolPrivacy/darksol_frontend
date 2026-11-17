// Public prepared measurements. Matching is in base units; a nearby amount
// never inherits an exact score, and gross manual deposits never use net keep
// cells. No amount or wallet is sent to this endpoint.
import { TOKEN_DECIMALS } from '../protocols/shared/units.js'

const WAITS = { now: 60, '6h': 21600, '12h': 43200, '24h': 86400 }
function units(text, asset) {
  if (!/^\d+(?:\.\d+)?$/.test(String(text))) return null
  const [whole, fraction = ''] = String(text).split('.')
  if (fraction.length > TOKEN_DECIMALS[asset]) return null
  return String(BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS[asset]) + BigInt(fraction.padEnd(TOKEN_DECIMALS[asset], '0')))
}

export function preparedSimulation(table, request, now = Date.now()) {
  if (table?.model !== 'privacy-analysis/1' || table.asset !== request?.asset || !Object.hasOwn(TOKEN_DECIMALS, request.asset)) return null
  const amount = units(request.amount, request.asset)
  const deposit = request.deposit == null ? null : units(request.deposit, request.asset)
  const maxWait = request.maxWait ?? '24h'
  if (!amount || !(BigInt(amount) > 0n) || !WAITS[maxWait] || (request.deposit != null && (deposit === null || BigInt(deposit) < BigInt(amount)))
    || (request.recipients !== undefined && (!Number.isInteger(request.recipients) || request.recipients < 1 || request.recipients > 50))) return null
  const pools = {}
  for (const [protocol, snapshot] of Object.entries(table.pools ?? {})) {
    if (snapshot.model !== table.model || snapshot.asset !== request.asset || snapshot.protocol !== protocol
      || !(snapshot.validUntil > now) || snapshot.simulationModel !== 'privacy-sim/2') continue
    const entry = snapshot.entries?.[amount]
    if (!Array.isArray(entry?.cells)) continue
    const manual = deposit !== null && BigInt(deposit) > BigInt(amount)
    if (manual && !entry.manual?.some((cell) => cell.deposit === deposit)) continue
    const sourceCells = manual ? [...entry.cells.filter((cell) => cell.strategy !== 'keep'), ...entry.manual.filter((cell) => cell.deposit === deposit)] : entry.cells
    const cells = sourceCells.filter((cell) => WAITS[cell.wait] <= WAITS[maxWait]
      && (request.recipients > 1 ? ['split', 'balance'].includes(cell.strategy) : ['exact', 'keep', 'balance'].includes(cell.strategy)))
    pools[protocol] = { amountMode: 'gross', cells, asOf: snapshot.historyThrough,
      prepared: { computedAt: snapshot.computedAt, checkedAt: snapshot.checkedAt, validUntil: snapshot.validUntil, source: snapshot.source } }
  }
  return Object.keys(pools).length ? { asset: request.asset, model: 'privacy-sim/2', days: 90, samples: 300, pools } : null
}

export function createAnalysisResource({ fetcher = (...args) => fetch(...args), now = Date.now, ttl = 60_000 } = {}) {
  const assets = new Map()
  const entry = (asset) => {
    if (!assets.has(asset)) assets.set(asset, { value: { loading: true, data: null, checkedAt: 0 }, listeners: new Set(), inflight: null, loaded: false })
    return assets.get(asset)
  }
  return {
    get: (asset) => entry(asset).value,
    subscribe(asset, listener) { const listeners = entry(asset).listeners; listeners.add(listener); return () => listeners.delete(listener) },
    load(asset) {
      const held = entry(asset)
      if (held.inflight) return held.inflight
      if (held.loaded && now() - held.value.checkedAt < ttl) return Promise.resolve()
      // The ttl counts from the request, not its answer: the page's one-minute
      // timer starts with the request, so a ttl counted from the answer made
      // every other tick a few milliseconds early and the table refreshed only
      // every two minutes.
      const requestedAt = now()
      held.inflight = (async () => {
        let data = held.value.data
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetcher(`/api/privacy-analysis?asset=${encodeURIComponent(asset)}`, { signal: controller.signal })
          if (!response.ok) throw new Error('Analysis unavailable')
          const value = await response.json()
          if (value.asset !== asset || value.model !== 'privacy-analysis/1') throw new Error('Invalid analysis response')
          data = value
        } catch { /* Existing snapshots expire in preparedSimulation, even offline. */ }
        finally { clearTimeout(timeout) }
        held.loaded = true
        held.value = { loading: false, data, checkedAt: requestedAt }
        for (const listener of held.listeners) listener()
      })().finally(() => { held.inflight = null })
      return held.inflight
    },
  }
}
