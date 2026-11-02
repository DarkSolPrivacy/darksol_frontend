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
export const WAITS = Object.freeze({ now: 0, '6h': 21_600, '12h': 43_200, '24h': 86_400 })
// A wait shows once the quote measures it: 12h is offered from the first quote that has its cells.
const LATER_WAITS = ['6h', '12h', '24h']
// "Really private": the step a send must reach to be offered as the fastest private one.
export const PRIVATE_LEVEL = 4
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
 * The measured privacy of a send set up by hand, sent now in `protocol`: keep
 * part shielded (`deposit` is what the user deposits), pay from the shielded
 * balance, or pay several recipients from one deposit (split). A kept deposit
 * hides only when others deposit that amount too; any other reads as an exact
 * one. Null without a measurement.
 * @param {{ quote: object, protocol: string, asset: string, raw: bigint, prices: Record<string, number>, kind: 'keep'|'balance'|'split', deposit?: bigint|null }} input
 */
export function measuredPrivacy({ quote, protocol, asset, raw, prices, kind, deposit = null }) {
  const pool = quote?.pools?.[protocol]
  if (!pool || !(raw > 0n) || !(prices[asset] > 0)) return null
  const bucket = bucketFor(toNumber(raw, asset) * prices[asset], quote.buckets)
  const common = deposit !== null && (pool.popular ?? []).some(({ amount }) => BigInt(amount) === deposit)
  const privacy = privacyOf(pool, kind === 'keep' && !common ? 'exact' : kind, 'now', bucket)
  return privacy && { ...privacy, level: meterLevel(privacy.score) }
}

// Which cell measures a send: from the balance, to several recipients, a
// deposit others make too that keeps part (keep), or any other deposit, read as
// an exact one. Sending all of a common deposit keeps nothing, so it is exact.
function strategyOf(pool, kind, recipients, deposit, raw) {
  if (kind === 'balance') return 'balance'
  if (recipients > 1) return 'split'
  return deposit > raw && (pool.popular ?? []).some(({ amount }) => BigInt(amount) === deposit) ? 'keep' : 'exact'
}

/**
 * Every option for sending `raw` base units of `asset`, ranked best first, plus
 * the suggested one and why it leads (reason: privacy, fees or time), the plain
 * send ("as typed") and the fastest one that is really private (PRIVATE_LEVEL or more). Now, later (deposit now, send from
 * the shielded balance in 6, 12 or 24 hours) and from the balance. `recipients`
 * splits the payment; `deposit` is a deposit the user set (keeping part
 * shielded), else later copies a common amount when there is one.
 * @param {{ quote: object, asset: string, raw: bigint, prices: Record<string, number>, shielded?: Record<string, bigint>,
 *   settings?: object, canRun?: (protocol: string) => boolean, recipients?: number, deposit?: bigint|null }} input
 */
export function sendOptions({ quote, asset, raw, prices, shielded = {}, settings, canRun = () => true, recipients = 1, deposit: fixed = null }) {
  if (!quote?.pools || !(raw > 0n) || !(prices[asset] > 0)) return null
  const chosen = effectiveSettings(settings)
  const amount = toNumber(raw, asset)
  const usd = amount * prices[asset]
  const bucket = bucketFor(usd, quote.buckets)
  const options = []
  let balanceHint = null
  for (const protocol of QUOTE_POOLS) {
    const pool = quote.pools[protocol]
    const manifest = PROTOCOLS[protocol]
    const send = manifest?.send
    if (!pool || !send || !manifest.assets.includes(asset)) continue
    if (recipients > 1 && !manifest.recipients.multi) continue
    if (fixed !== null && fixed > raw && !send.keepShielded) continue
    let fee = poolFee(protocol, asset, raw, prices)
    if (fee === null) continue
    // Privacy Cash charges its fixed part per recipient.
    if (recipients > 1 && manifest.fees.fixedBasis === 'recipient') fee += poolFee(protocol, asset, 0n, prices) * BigInt(recipients - 1)
    const feeUsd = toNumber(fee, asset) * prices[asset]
    // A fresh deposit also pays its network fee and rent.
    const depositUsd = (manifest.fees.depositCostSol ?? 0) * (prices.SOL ?? 0)
    const runs = canRun(protocol) && (protocol !== 'cloakc' || raw >= PAYMENT_ASSETS[asset].cloakMin)
    const add = (kind, wait, deposit, extra) => {
      const privacy = privacyOf(pool, strategyOf(pool, kind, recipients, deposit, raw), wait, bucket)
      if (!privacy) return
      const cost = feeUsd + (kind === 'balance' ? 0 : depositUsd)
      options.push({
        id: `${protocol}:${kind}:${wait}`, protocol, kind, wait, waitSeconds: WAITS[wait],
        score: privacy.score, sends: privacy.sends, level: meterLevel(privacy.score),
        fee, feeUsd: cost, feePct: 100 * cost / usd, receives: raw > fee ? raw - fee : 0n,
        deposit, kept: deposit - raw, executable: runs, ...extra,
      })
    }
    add('now', 'now', fixed ?? raw)
    if (send.keepShielded && send.fromShielded) {
      const deposit = fixed ?? (chosen.keepNothing ? null : popularDeposit(pool.popular, raw)) ?? raw
      for (const wait of LATER_WAITS) add('later', wait, deposit)
    }
    if (send.fromShielded) {
      const balance = shielded[protocol]
      if (balance !== undefined && balance >= raw) add('balance', 'now', 0n, { kept: 0n, balanceBefore: balance, balanceAfter: balance - raw })
      else {
        // Not read yet, or too small: say what paying from a balance would score.
        const privacy = privacyOf(pool, 'balance', 'now', bucket)
        if (privacy && meterLevel(privacy.score) >= PRIVATE_LEVEL && !balanceHint) balanceHint = { protocol, ...privacy, level: meterLevel(privacy.score), known: balance !== undefined }
      }
    }
  }
  const allowed = options.filter((option) => option.executable && chosen.pools[option.protocol] && option.waitSeconds <= WAITS[chosen.maxWait])
  const pool = chosen.priority === 'time' && allowed.some((option) => option.waitSeconds === 0) ? allowed.filter((option) => option.waitSeconds === 0) : allowed
  const ranked = [...pool].sort(compare(chosen.priority))
  const suggested = ranked[0] ?? null
  const asTyped = options.filter((option) => option.kind === 'now' && option.executable).sort((a, b) => a.feeUsd - b.feeUsd)[0] ?? null
  // The soonest really private one; same wait, the cheaper.
  const fastest = allowed.filter((option) => option.level >= PRIVATE_LEVEL).sort((a, b) => a.waitSeconds - b.waitSeconds || a.feeUsd - b.feeUsd)[0] ?? null
  // Everything else after the ranked ones, so the list can still show it, marked unavailable.
  const rest = options.filter((option) => !pool.includes(option)).sort(compare(chosen.priority))
  // Why the suggestion leads: it hides you better than the rest, it is the most
  // private that sends now, or its fee won (a lower fee outweighed a step of
  // privacy, or every option is as private).
  const levels = allowed.map((option) => option.level)
  const top = Math.max(...levels)
  const reason = !suggested ? null : chosen.priority === 'fees' ? 'fees'
    : suggested.level < top ? (chosen.priority === 'time' ? 'time' : 'fees')
      : levels.some((level) => level < top) || allowed.length === 1 ? 'privacy' : 'fees'
  return { bucket, usd, suggested, reason, asTyped, fastest, balanceHint: fastest?.kind === 'balance' ? null : balanceHint, options: [...ranked, ...rest], settings: chosen }
}

function compare(priority) {
  if (priority === 'fees') return (a, b) => a.feeUsd - b.feeUsd || b.score - a.score || a.waitSeconds - b.waitSeconds
  const k = WEIGHT[priority] ?? WEIGHT.auto
  const step = (option) => meterLevel(option.score - k * option.feePct)
  return (a, b) => step(b) - step(a) || a.feeUsd - b.feeUsd || a.waitSeconds - b.waitSeconds || b.score - a.score
}
