// The ways to send this amount privately, and the one we suggest. Each option's
// privacy is measured, not scored: the share of DarkSol sends like it that our
// tracer linked to the sender. For this exact amount it comes from POST
// /api/privacy-sim (darksol-backend docs/PRIVACY_SIM.md), good to ±6 points at
// most (95% interval). Until that answers, or without it, it comes from the
// amount's size bucket in GET /api/privacy-quote (docs/PRIVACY_QUOTE.md), good
// to about ±10. Pure: the page passes in the quote (merged by withSimulation),
// prices, shielded balances and settings.
//
// Ranking. value = privacy − k × fee as a % of the payment, so a fee that is a
// big share of a small payment counts for more. Privacy shows as a 5-step
// meter, and options on the same step of value are a tie: the cheaper one wins,
// then the sooner one.
import { PROTOCOLS } from '../protocols/registry.js'
import { TOKEN_DECIMALS, withdrawalFor } from '../protocols/shared/units.js'
import { PAYMENT_ASSETS } from './payment-assets.js'

export const QUOTE_POOLS = Object.freeze(['privacycash', 'cloakc', 'umbrav2'])
// Shown under the options, greyed out as "Soon", never ranked: NEAR Confidential
// Intents hides a payment from the public but not from 1Click or the validators
// of NEAR's private chain (protocols/nearci/manifest.js).
export const SOON_POOLS = Object.freeze(['nearci'])
// A cell with fewer sends says too little to offer the option.
export const MIN_SENDS = 10
export const WAITS = Object.freeze({ now: 0, '6h': 21_600, '12h': 43_200, '24h': 86_400 })
// A wait shows once the quote measures it: 12h is offered from the first quote that has its cells.
// The simulation also measures 30m, which is not offered.
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

// Include every setting that changes the simulation in its request identity.
// A late response for another wait limit or manual deposit must never be used.
export function simulationRequest({ asset, raw, settings, deposit = null }) {
  const decimal = (value) => {
    const scale = 10n ** BigInt(TOKEN_DECIMALS[asset])
    return `${value / scale}.${String(value % scale).padStart(TOKEN_DECIMALS[asset], '0')}`
  }
  if (!(raw > 0n)) return null
  return { asset, amount: decimal(raw), maxWait: effectiveSettings(settings).maxWait,
    ...(deposit !== null && { deposit: decimal(deposit) }) }
}

// Never below 1: even a send the red team traced every time leaves no proof that
// the money is the same, which the pool alone provides. 0 is kept for the one
// case with no cover at all (overwhelmed below).
export const meterLevel = (score) => Math.max(1, Math.min(5, Math.round(score / 20)))
// Withdrawn at once and larger than all the pool holds of the token: most of it
// can only be the sender's own deposit. `balance` is the quote's, in token units.
const overwhelmed = (pool, amount, wait) => wait === 'now' && Number.isFinite(pool?.balance) && amount > pool.balance

const units = (value, asset) => BigInt(Math.round(value * 10 ** TOKEN_DECIMALS[asset]))
const toNumber = (raw, asset) => Number(raw) / 10 ** TOKEN_DECIMALS[asset]

/**
 * The pool's fee on a withdrawal of `raw` (base units), from its manifest: the
 * variable rate (per token where the pool sets one, as Cloak does) plus the
 * fixed part, which Privacy Cash prices in SOL. Null when a price it needs is
 * missing.
 */
export function poolFee(protocol, asset, raw, prices) {
  const fees = PROTOCOLS[protocol].fees
  const variable = BigInt(Math.ceil(Number(raw) * (fees.variableByToken?.[asset] ?? fees.variableRate)))
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

/**
 * The quote for this exact amount: each pool the simulation (POST
 * /api/privacy-sim) measured has its cells in `bucket`, the amount's bucket,
 * replaced by the simulated ones, marked `simulated: { days, samples }`. Other
 * buckets, `popular` and the pools it lacks (Umbra v2, pools still loading)
 * stay as quoted. Without a quote, the simulation alone, with buckets [bucket].
 */
export function withSimulation(quote, sim, bucket) {
  if (!sim?.pools || !bucket) return quote
  const pools = { ...quote?.pools }
  const simulated = { days: sim.days, samples: sim.samples }
  for (const [protocol, measured] of Object.entries(sim.pools)) {
    if (!Array.isArray(measured?.cells)) continue
    const quoted = pools[protocol]
    pools[protocol] = { ...quoted, amountMode: measured.amountMode, cells: [...(quoted?.cells ?? []).filter((cell) => cell.bucket !== bucket), ...measured.cells.map((cell) => ({ ...cell, bucket, simulated }))] }
  }
  return quote ? { ...quote, pools } : { asset: sim.asset, buckets: [bucket], pools }
}

// The first of `strategies` the quote measured with enough sends; `simulated`
// when it was measured for this exact amount.
function privacyOf(pool, strategies, wait, bucket, deposit = null) {
  for (const strategy of [strategies].flat()) {
    const cell = pool?.cells?.find((item) => item.strategy === strategy && item.wait === wait && item.bucket === bucket
      && (pool.amountMode !== 'gross' || strategy !== 'keep' || item.deposit === String(deposit)))
    if (cell && cell.sends >= MIN_SENDS) return { score: Math.round(100 * (1 - cell.traced / cell.sends)), sends: cell.sends, ...cell.simulated && { simulated: cell.simulated } }
  }
  return null
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
  const strategy = pool.amountMode === 'gross' && kind === 'keep' ? (deposit > raw ? 'keep' : 'exact')
    : kind !== 'keep' ? kind : common ? ['keep', 'exact'] : 'exact'
  const privacy = privacyOf(pool, strategy, 'now', bucket, deposit)
  return privacy && { ...privacy, bucket, level: overwhelmed(pool, toNumber(raw, asset), 'now') ? 0 : meterLevel(privacy.score) }
}

// Which cells measure a send: from the balance, to several recipients, a
// deposit others make too (keep), or any other deposit, read as an exact one. A
// common deposit falls back to exact where the pool has too few keep sends: an
// exact send's deposit is an amount no one else makes, so it is the worse case.
function strategyOf(pool, kind, recipients, deposit, raw) {
  if (kind === 'balance') return 'balance'
  if (recipients > 1) return 'split'
  if (pool.amountMode === 'gross') return deposit > raw ? 'keep' : 'exact'
  return deposit >= raw && (pool.popular ?? []).some(({ amount }) => BigInt(amount) === deposit) ? ['keep', 'exact'] : 'exact'
}

/**
 * Every option for sending `raw` base units of `asset`, ranked best first, plus
 * the suggested one and why it leads (reason: privacy, fees or time), the plain
 * send ("as typed") and the fastest one that is really private (PRIVATE_LEVEL or more). Now, later (deposit now, send from
 * the shielded balance in 6, 12 or 24 hours) and from the balance. `recipients`
 * splits the payment; `deposit` is a deposit the user set (keeping part
 * shielded), else later copies a common amount when there is one.
 * @param {{ quote: object, asset: string, raw: bigint, prices: Record<string, number>, shielded?: Record<string, bigint>,
 *   settings?: object, canRun?: (protocol: string) => boolean, recipients?: number, deposit?: bigint|null,
 *   paused?: Record<string, string>, topUp?: boolean, balanceOnly?: boolean }} input  topUp: deposit a common amount above the payment and keep the rest
 *   shielded (more privacy); false deposits only what is sent.  paused: pools that stopped deposits, with why; they can still pay from a balance.
 *   balanceOnly: only payments from a shielded balance (Use shielded funds), one per pool that holds enough.
 */
export function sendOptions({ quote, asset, raw, prices, shielded = {}, settings, canRun = () => true, recipients = 1, deposit: fixed = null, paused: stopped = {}, topUp = true, balanceOnly = false }) {
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
    // A fresh deposit also pays its network fee and rent (per token where it differs, as for NEAR Confidential Intents).
    const depositUsd = (manifest.fees.depositCostSolByToken?.[asset] ?? manifest.fees.depositCostSol ?? 0) * (prices.SOL ?? 0)
    const runs = canRun(protocol) && (protocol !== 'cloakc' || raw >= PAYMENT_ASSETS[asset].cloakMin)
    // A suggested top-up pays the recipient exactly what was typed: it withdraws
    // that plus the pool's fee, and only the rest of the deposit stays shielded.
    // The send recomputes the fee from the pool's live terms (`exact`).
    const payout = withdrawalFor(raw, (units) => poolFee(protocol, asset, units, prices))
    const add = (kind, wait, deposit, extra) => {
      const privacy = privacyOf(pool, strategyOf(pool, kind, recipients, deposit, raw), wait, bucket, deposit)
      if (!privacy) return
      const exact = fixed === null && kind !== 'balance' && deposit > raw && recipients === 1
      const optionFee = exact ? payout - raw : fee
      const cost = toNumber(optionFee, asset) * prices[asset] + (kind === 'balance' ? 0 : depositUsd)
      // A pool that paused deposits can still pay from its shielded balance.
      const paused = kind !== 'balance' && stopped[protocol] ? stopped[protocol] : null
      options.push({
        id: `${protocol}:${kind}:${wait}`, protocol, kind, wait, waitSeconds: WAITS[wait],
        score: privacy.score, sends: privacy.sends, simulated: privacy.simulated, level: overwhelmed(pool, amount, wait) ? 0 : meterLevel(privacy.score),
        fee: optionFee, feeUsd: cost, feePct: 100 * cost / usd, receives: exact ? raw : raw > fee ? raw - fee : 0n,
        deposit, kept: deposit - (exact ? payout : raw), exact, executable: runs && !paused, paused, ...extra,
      })
    }
    const depositFor = (wait) => {
      if (fixed !== null) return fixed
      if (!topUp || chosen.keepNothing || !send.keepShielded) return raw
      // A top-up must cover the payout and its fee, and leave something shielded.
      if (pool.amountMode !== 'gross') {
        const common = popularDeposit(pool.popular, raw)
        return common !== null && common > payout ? common : raw
      }
      // Each candidate was tested with this withdrawal and this deposit. Pick
      // separately for each permitted wait; a 24 h winner need not win at 6 h.
      if (recipients > 1) return raw
      const level = (cell) => meterLevel(Math.round(100 * (1 - cell.traced / cell.sends)))
      const candidates = pool.cells.filter((cell) => cell.bucket === bucket && cell.strategy === 'keep' && cell.wait === wait
        && cell.sends >= MIN_SENDS && cell.deposit && BigInt(cell.deposit) > payout && BigInt(cell.deposit) <= raw * 3n / 2n)
        .sort((a, b) => level(b) - level(a) || Number(BigInt(a.deposit) - BigInt(b.deposit)))
      return candidates.length ? BigInt(candidates[0].deposit) : raw
    }
    if (!balanceOnly) add('now', 'now', depositFor('now'))
    // A wait longer than the settings' longest is never offered, not even greyed
    // out: neither in the list nor as the shield-more offer.
    if (!balanceOnly && send.keepShielded && send.fromShielded) {
      for (const wait of LATER_WAITS) if (WAITS[wait] <= WAITS[chosen.maxWait]) add('later', wait, depositFor(wait))
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
  const allowed = options.filter((option) => option.executable && chosen.pools[option.protocol])
  const pool = chosen.priority === 'time' && allowed.some((option) => option.waitSeconds === 0) ? allowed.filter((option) => option.waitSeconds === 0) : allowed
  const sorted = [...pool].sort(compare(chosen.priority))
  // An option on the same meter step or higher, at no higher fee, leads when it
  // is sooner: two 5 of 5 waits send in 6 h, not 24 h, even when the longer one
  // scored a few points more.
  const lead = sorted[0]
  const suggested = (lead && sorted.filter((option) => option.level >= lead.level && option.feeUsd <= lead.feeUsd)
    .sort((a, b) => a.waitSeconds - b.waitSeconds || a.feeUsd - b.feeUsd)[0]) ?? null
  const ranked = suggested ? [suggested, ...sorted.filter((option) => option !== suggested)] : sorted
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
  return { bucket, usd, suggested, reason, asTyped, fastest, balanceHint: fastest?.kind === 'balance' ? null : balanceHint, balanceOnly, options: [...ranked, ...rest], settings: chosen }
}

/** An optional privacy improvement, even when the fee/time priority leads elsewhere. */
export function shieldMoreOffer(plain, more) {
  const base = plain?.suggested
  if (!base || !more || more.settings.keepNothing) return null
  return more.options.filter((option) => option.executable && more.settings.pools[option.protocol]
    && option.waitSeconds <= WAITS[more.settings.maxWait] && option.kept > 0n && option.level > base.level)
    .sort((a, b) => b.level - a.level || a.waitSeconds - b.waitSeconds || a.feeUsd - b.feeUsd
      || Number(a.kept - b.kept) || b.score - a.score)[0] ?? null
}

function compare(priority) {
  if (priority === 'fees') return (a, b) => a.feeUsd - b.feeUsd || b.score - a.score || a.waitSeconds - b.waitSeconds
  const k = WEIGHT[priority] ?? WEIGHT.auto
  // Not meterLevel: its floor of 1 would hide how far a fee drags a weak option down.
  const step = (option) => Math.max(0, Math.min(5, Math.round((option.score - k * option.feePct) / 20)))
  return (a, b) => step(b) - step(a) || a.feeUsd - b.feeUsd || a.waitSeconds - b.waitSeconds || b.score - a.score
}
