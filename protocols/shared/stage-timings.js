// How long each stage of a send takes, to find what to speed up and to check
// that a change did. One recorder per send: the adapter says which stage is
// running, the recorder adds up milliseconds per leg and stage, and prints one
// table when the send ends. It holds stage names and durations only (never an
// address, signature, note or amount), keeps them in memory, and sends nothing.
//
// The stages are the same for every pool, so the tables compare:
//   queued            waiting for an earlier read or send in the pool's queue
//   sdk load          importing the pool's SDK and its WebAssembly
//   sign-in           the pool's sign-in or unlock message (instant when kept)
//   registration      Umbra v2 only: a wallet's one-time registration
//   note scan         reading the pool for the wallet's notes, or its tree
//   circuit download  fetching the proving files, wherever in the send it falls
//   proof             building the proof, downloads taken out
//   wallet approval   waiting for the wallet to sign a transaction or a request
//   relay request     handing the transaction to the relayer or the network
//   settlement wait   waiting until it is confirmed and spendable
//   other             everything else: balance checks, fee and state reads
export const STAGES = Object.freeze(['queued', 'sdk load', 'sign-in', 'registration', 'note scan', 'circuit download', 'proof', 'wallet approval', 'relay request', 'settlement wait', 'other'])

// The last sends' tables, newest last. In the console: darksolSendTimings.
const KEPT = 10
export const history = []

// Overlapping intervals as one: two files downloading at once count once.
function union(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  const merged = []
  for (const { start, end } of sorted) {
    const last = merged.at(-1)
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  return merged
}

// Milliseconds per leg and stage, in the order they first ran, then the total.
// A carved interval (a download) is taken out of whichever stages it ran under
// and counted as its own stage, so the rows add up to the total.
export function tableRows(pool, spans, carved) {
  const rows = new Map()
  const add = (leg, stage, ms) => {
    const key = `${leg}\n${stage}`
    if (!rows.has(key)) rows.set(key, { pool, leg, stage, ms: 0 })
    rows.get(key).ms += ms
  }
  const byStage = new Map()
  for (const interval of carved) byStage.set(interval.stage, [...(byStage.get(interval.stage) ?? []), interval])
  for (const span of spans) {
    let own = span.end - span.start
    add(span.leg, span.stage, 0)
    for (const [stage, intervals] of byStage) {
      if (stage === span.stage) continue
      const taken = union(intervals).reduce((sum, { start, end }) => sum + Math.max(0, Math.min(span.end, end) - Math.max(span.start, start)), 0)
      if (!taken) continue
      add(span.leg, stage, taken)
      own -= taken
    }
    add(span.leg, span.stage, Math.max(0, own))
  }
  const list = [...rows.values()].filter((row) => row.ms >= 0.5).map((row) => ({ ...row, ms: Math.round(row.ms) }))
  const total = spans.length ? spans.at(-1).end - spans[0].start : 0
  return [...list, { pool, leg: 'total', stage: '', ms: Math.round(total) }]
}

// Reports finished downloads: `stageOf(url)` names the stage a URL belongs to,
// or nothing. Browser only; elsewhere nothing is watched.
function watchResources(stageOf, carve) {
  if (typeof PerformanceObserver !== 'function') return () => {}
  const take = (entries) => {
    for (const entry of entries) {
      const stage = stageOf(entry.name)
      if (stage) carve(stage, entry.startTime, entry.responseEnd || entry.startTime + entry.duration)
    }
  }
  try {
    const observer = new PerformanceObserver((list) => take(list.getEntries()))
    observer.observe({ type: 'resource' })
    return () => { take(observer.takeRecords()); observer.disconnect() }
  } catch { return () => {} }
}

function printTable(run) {
  console.log(`[send timings] ${run.pool} ${run.kind} ${run.outcome} in ${(run.rows.at(-1).ms / 1000).toFixed(1)} s`)
  console.table(run.rows)
}

// `downloads(url)` names the stage a finished download counts as, for the files
// a prover fetches inside its own call.
export function createTimings(pool, { kind = 'send', downloads, now = () => performance.now(), watch = watchResources, print = printTable } = {}) {
  const spans = []
  const carved = []
  let leg = kind
  let open = { leg, stage: 'queued', start: now() }
  let finished = null
  const carve = (stage, start, end) => { if (!finished && end > start) carved.push({ stage, start, end }) }
  const stop = downloads ? watch(downloads, carve) : () => {}
  const enter = (stage) => {
    if (finished || (open.stage === stage && open.leg === leg)) return
    const at = now()
    spans.push({ ...open, end: at })
    open = { leg, stage, start: at }
  }
  return {
    // Names what follows: 'deposit', 'withdrawal'. The stage goes on under the new name.
    leg(name) { leg = name; enter(open.stage) },
    enter,
    get stage() { return open.stage },
    // Runs `task` as `stage`, then goes back to the stage it interrupted.
    async during(stage, task) {
      const before = open.stage
      enter(stage)
      try { return await task() } finally { enter(before) }
    },
    carve,
    finish(outcome = 'sent') {
      if (finished) return finished
      stop()
      spans.push({ ...open, end: now() })
      finished = { pool, kind, outcome, rows: tableRows(pool, spans, carved) }
      history.push(finished)
      if (history.length > KEPT) history.shift()
      try { print(finished) } catch { /* A console that cannot print must not fail the send. */ }
      return finished
    },
  }
}

// For the flows that are not timed (a bridge, a swap, a balance read).
export const NO_TIMINGS = Object.freeze({ leg() {}, enter() {}, stage: null, during: (stage, task) => task(), carve() {}, finish: () => null })

// Times `task(timings)` as one send: the table prints whether it resolves or throws.
export async function withTimings(pool, options, task) {
  const timings = createTimings(pool, options)
  try {
    const result = await task(timings)
    timings.finish('sent')
    return result
  } catch (error) {
    timings.finish('failed')
    throw error
  }
}

if (typeof globalThis.window === 'object') globalThis.darksolSendTimings = history
