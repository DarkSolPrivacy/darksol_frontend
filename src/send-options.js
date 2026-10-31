// The ways to send this amount privately, and the one we suggest. Each option's
// privacy is measured, not scored: the share of DarkSol sends like it that our
// tracer linked to the sender, from GET /api/privacy-quote (darksol-backend
// docs/PRIVACY_QUOTE.md). Pure: the page passes in the quote, prices, shielded
// balances and settings.
//
// Ranking. value = privacy − k × fee as a % of the payment, so a fee that is a
// big share of a small payment counts for more. Privacy shows as a 5-step meter
// (the quote is good to about ±10 points), and options on the same step of
// value are a tie: the cheaper one wins, then the sooner one.
import { PROTOCOLS } from '../protocols/registry.js'
import { TOKEN_DECIMALS } from '../protocols/shared/units.js'
import { PAYMENT_ASSETS } from './payment-assets.js'

export const QUOTE_POOLS = Object.freeze(['privacycash', 'cloakc', 'umbrav2'])
// A cell with fewer sends says too little to offer the option.
export const MIN_SENDS = 10
export const WAITS = Object.freeze({ now: 0, '6h': 21_600, '24h': 86_400 })
const KEEP_WAITS = ['6h', '24h']
// k per priority. Fees ranks on the fee alone, privacy breaking ties.
const WEIGHT = { auto: 1.5, privacy: 0.5, time: 1.5 }

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'auto', priority: 'privacy', maxWait: '24h', keepNothing: false, remind: true,
  pools: Object.freeze({ privacycash: true, cloakc: true, umbrav2: true }),
})

/** What the ranking uses: Auto is privacy first, a day's wait and every pool; the two switches always apply. */
export function effectiveSettings(settings = DEFAULT_SETTINGS) {
  const base = { ...DEFAULT_SETTINGS, ...settings, pools: { ...DEFAULT_SETTINGS.pools, ...settings?.pools } }
  return base.mode === 'custom' ? base : { ...base, priority: 'auto', maxWait: '24h', pools: { ...DEFAULT_SETTINGS.pools } }
}

export const meterLevel = (score) => Math.max(0, Math.min(5, Math.round(score / 20)))

const units = (value, asset) => BigInt(Math.round(value * 10 ** TOKEN_DECIMALS[asset]))
const toNumber = (raw, asset) => Number(raw) / 10 ** TOKEN_DECIMALS[asset]

/**
 * The pool's fee on a withdrawal of `raw` (base units), from its manifest: the
 * variable rate plus the fixed part, which Privacy Cash prices in SOL. Null
 * when a price it needs is missing.
 */
export function poolFee(protocol, asset, raw, prices) {
  const fees = PROTOCOLS[protocol].fees
  const variable = BigInt(Math.ceil(Number(raw) * fees.variableRate))
  let fixed = 0n
  if (fees.fixedByToken?.[asset] !== undefined) fixed = units(fees.fixedByToken[asset], asset)
  else if (fees.fixedAmount) {
    if (!(prices[fees.fixedToken] > 0) || !(prices[asset] > 0)) return null
    fixed = units(fees.fixedAmount * prices[fees.fixedToken] / prices[asset], asset)
  }
  return variable + fixed
}

/** The deposit a keep option copies: the most frequent recent amount in [raw, 1.5 raw], or null. */
export function popularDeposit(popular = [], raw) {
  const most = (raw * 3n) / 2n
  const hit = popular.find(({ amount }) => BigInt(amount) >= raw && BigInt(amount) <= most)
  return hit ? BigInt(hit.amount) : null
}

export function bucketFor(usd, buckets) {
  const ranges = buckets.map((name) => name.split('-').map(Number))
  const index = ranges.findIndex(([from, to]) => usd >= from && usd < to)
  if (index >= 0) return buckets[index]
  return usd < ranges[0][0] ? buckets[0] : buckets.at(-1)
}

function privacyOf(pool, strategy, wait, bucket) {
  const cell = pool?.cells?.find((item) => item.strategy === strategy && item.wait === wait && item.bucket === bucket)
  if (!cell || cell.sends < MIN_SENDS) return null
  return { score: Math.round(100 * (1 - cell.traced / cell.sends)), sends: cell.sends }
}

/**
 * Every option for sending `raw` base units of `asset` to one recipient, ranked
 * best first, plus the suggested one and the plain send ("as typed").
 * @param {{ quote: object, asset: string, raw: bigint, prices: Record<string, number>, shielded?: Record<string, bigint>,
 *   settings?: object, canRun?: (protocol: string) => boolean }} input
 */
export function sendOptions({ quote, asset, raw, prices, shielded = {}, settings, canRun = () => true }) {
  if (!quote?.pools || !(raw > 0n) || !(prices[asset] > 0)) return null
  const chosen = effectiveSettings(settings)
  const amount = toNumber(raw, asset)
  const usd = amount * prices[asset]
  const bucket = bucketFor(usd, quote.buckets)
  const options = []
  for (const protocol of QUOTE_POOLS) {
    const pool = quote.pools[protocol]
    const send = PROTOCOLS[protocol]?.send
    if (!pool || !send || !PROTOCOLS[protocol].assets.includes(asset)) continue
    const fee = poolFee(protocol, asset, raw, prices)
    if (fee === null) continue
    const feeUsd = toNumber(fee, asset) * prices[asset]
    // A fresh deposit also pays its network fee and rent.
    const depositUsd = (PROTOCOLS[protocol].fees.depositCostSol ?? 0) * (prices.SOL ?? 0)
    const runs = canRun(protocol) && (protocol !== 'cloakc' || raw >= PAYMENT_ASSETS[asset].cloakMin)
    const add = (kind, strategy, wait, extra) => {
      const privacy = privacyOf(pool, strategy, wait, bucket)
      if (!privacy) return
      const cost = feeUsd + (kind === 'balance' ? 0 : depositUsd)
      options.push({
        id: `${protocol}:${kind}:${wait}`, protocol, kind, wait, waitSeconds: WAITS[wait],
        score: privacy.score, sends: privacy.sends, level: meterLevel(privacy.score),
        fee, feeUsd: cost, feePct: 100 * cost / usd, receives: raw > fee ? raw - fee : 0n,
        deposit: kind === 'balance' ? 0n : raw, kept: 0n, executable: runs, ...extra,
      })
    }
    add('now', 'exact', 'now')
    if (send.keepShielded && send.fromShielded && !chosen.keepNothing) {
      const deposit = popularDeposit(pool.popular, raw)
      if (deposit !== null) for (const wait of KEEP_WAITS) add('keep', 'keep', wait, { deposit, kept: deposit - raw })
    }
    if (send.fromShielded && shielded[protocol] !== undefined && shielded[protocol] >= raw) {
      add('balance', 'balance', 'now', { balanceBefore: shielded[protocol], balanceAfter: shielded[protocol] - raw })
    }
  }
  const allowed = options.filter((option) => option.executable && chosen.pools[option.protocol] && option.waitSeconds <= WAITS[chosen.maxWait === 'now' ? 'now' : chosen.maxWait])
  const pool = chosen.priority === 'time' && allowed.some((option) => option.waitSeconds === 0) ? allowed.filter((option) => option.waitSeconds === 0) : allowed
  const ranked = [...pool].sort(compare(chosen.priority))
  const suggested = ranked[0] ?? null
  const asTyped = options.filter((option) => option.kind === 'now' && option.executable).sort((a, b) => a.feeUsd - b.feeUsd)[0] ?? null
  // Everything else after the ranked ones, so the list can still show it, marked unavailable.
  const rest = options.filter((option) => !pool.includes(option)).sort(compare(chosen.priority))
  return { bucket, usd, suggested, asTyped, options: [...ranked, ...rest], settings: chosen }
}

function compare(priority) {
  if (priority === 'fees') return (a, b) => a.feeUsd - b.feeUsd || b.score - a.score || a.waitSeconds - b.waitSeconds
  const k = WEIGHT[priority] ?? WEIGHT.auto
  const step = (option) => meterLevel(option.score - k * option.feePct)
  return (a, b) => step(b) - step(a) || a.feeUsd - b.feeUsd || a.waitSeconds - b.waitSeconds || b.score - a.score
}
