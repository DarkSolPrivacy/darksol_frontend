/**
 * Pure privacy-planning heuristics.
 *
 * All monetary values supplied to this module must use the same valuation unit
 * (normally USD). This module never reads the database and never invents pool
 * activity when an input is missing.
 */

import { PROVIDER_CAPABILITIES } from '../protocols/registry.js'

export const ESTIMATE_NOTICE = 'Estimated from recent historical activity; future anonymity is not guaranteed.'

// Derived from each protocol manifest. This module stays pure -- the registry
// is data only -- and getProviderCapabilities/estimateProviderFee keep taking
// the table as an injectable parameter, so tests can still pass their own.
export { PROVIDER_CAPABILITIES }

export const PRIVACY_TARGETS = Object.freeze({
  balanced: Object.freeze({ id: 'balanced', label: 'Balanced', score: 60 }),
  high: Object.freeze({ id: 'high', label: 'High', score: 75 }),
  maximum: Object.freeze({ id: 'maximum', label: 'Maximum', score: 90 }),
})

export const DEFAULT_PRIVACY_CONFIG = Object.freeze({
  weights: Object.freeze({
    depth: 20,
    cover: 20,
    similarity: 25,
    temporal: 15,
    activity: 10,
    uniqueness: 10,
  }),
  bands: Object.freeze([
    Object.freeze({ min: 90, band: 'VERY HIGH' }),
    Object.freeze({ min: 75, band: 'HIGH' }),
    Object.freeze({ min: 45, band: 'MEDIUM' }),
    Object.freeze({ min: 25, band: 'LOW' }),
    Object.freeze({ min: 0, band: 'VERY LOW' }),
  ]),
  // Piecewise interpolation uses log(pool share) between these calibration points.
  depth: Object.freeze({
    points: Object.freeze([
      Object.freeze({ share: 0, score: 100, label: 'negligible' }),
      Object.freeze({ share: 0.001, score: 96, label: 'excellent' }),
      Object.freeze({ share: 0.01, score: 86, label: 'very good' }),
      Object.freeze({ share: 0.05, score: 64, label: 'reasonable' }),
      Object.freeze({ share: 0.10, score: 42, label: 'weak' }),
      Object.freeze({ share: 0.25, score: 16, label: 'poor' }),
      Object.freeze({ share: 1, score: 0, label: 'very poor' }),
    ]),
  }),
  cover: Object.freeze({
    points: Object.freeze([
      Object.freeze({ ratio: 0, score: 0 }),
      Object.freeze({ ratio: 0.25, score: 12 }),
      Object.freeze({ ratio: 0.5, score: 24 }),
      Object.freeze({ ratio: 1, score: 40 }),
      Object.freeze({ ratio: 2, score: 55 }),
      Object.freeze({ ratio: 5, score: 70 }),
      Object.freeze({ ratio: 10, score: 82 }),
      Object.freeze({ ratio: 25, score: 94 }),
      Object.freeze({ ratio: 50, score: 100 }),
    ]),
  }),
  similarity: Object.freeze({
    verySimilarMinRatio: 0.8,
    verySimilarMaxRatio: 1.25,
    moderateMinRatio: 0.5,
    moderateMaxRatio: 2,
    distanceDecay: 1.6,
    countHalfSaturation: 8,
    volumeHalfSaturation: 5,
  }),
  temporal: Object.freeze({
    bucketMinutes: 15,
    separationPoints: Object.freeze([
      Object.freeze({ minutes: 0, score: 0 }),
      Object.freeze({ minutes: 1, score: 7 }),
      Object.freeze({ minutes: 5, score: 20 }),
      Object.freeze({ minutes: 15, score: 36 }),
      Object.freeze({ minutes: 60, score: 62 }),
      Object.freeze({ minutes: 180, score: 78 }),
      Object.freeze({ minutes: 360, score: 88 }),
      Object.freeze({ minutes: 1440, score: 100 }),
    ]),
    separationWeight: 0.65,
    diversityHalfSaturationBuckets: 10,
  }),
  activity: Object.freeze({ transactionHalfSaturation: 80 }),
  // A shielded pool hides a recipient among its notes, so the size of that set
  // bounds how private any exit from it can be. Only pools that publish the
  // number are affected; the rest are scored exactly as before, and this
  // deliberately carries no scoring weight, because weighting a signal that one
  // provider can supply and the others cannot would bias every comparison.
  //
  // `minimumSet` is a policy floor, not a derived constant: below it a recipient
  // is one of too few candidates for the estimate to mean anything.
  anonymitySet: Object.freeze({ minimumSet: 50 }),
  confidence: Object.freeze({ staleAfterSeconds: 600, unusableAfterSeconds: 86400, fullHistorySeconds: 7 * 86400 }),
  eta: Object.freeze({ stepMinutes: 1, maxHorizonMinutes: 7 * 24 * 60, timelineMinutes: Object.freeze([0, 30, 60, 120, 360]) }),
  multiRecipient: Object.freeze({
    maxCoordinationPenalty: 34,
    minimumReceiverWeight: 0.65,
    averageReceiverWeight: 0.35,
  }),
})

const EXTERNAL_TYPES = new Set(['DEPOSIT', 'WITHDRAW', 'SWAP_IN', 'SWAP_OUT'])
const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value))
const round = (value, digits = 2) => Number(value.toFixed(digits))
const finite = (value) => Number.isFinite(Number(value))

function mergeConfig(base, overrides = {}) {
  const merged = { ...base, ...overrides }
  for (const key of ['weights', 'depth', 'cover', 'similarity', 'temporal', 'activity', 'confidence', 'eta', 'multiRecipient', 'anonymitySet']) {
    merged[key] = { ...base[key], ...(overrides[key] || {}) }
  }
  return merged
}

export function createPrivacyConfig(overrides = {}) {
  const config = mergeConfig(DEFAULT_PRIVACY_CONFIG, overrides)
  const weightTotal = Object.values(config.weights).reduce((sum, value) => sum + Number(value), 0)
  if (!finite(weightTotal) || weightTotal <= 0) throw new TypeError('Privacy scoring weights must have a positive total')
  return config
}

export function getProviderCapabilities(provider, capabilities = PROVIDER_CAPABILITIES) {
  return capabilities[String(provider || '').toLowerCase()] || null
}

export function getPrivacyTarget(target, targets = PRIVACY_TARGETS) {
  if (finite(target)) return { id: 'custom', label: 'Custom', score: clamp(Number(target)) }
  return targets[String(target || 'high').toLowerCase()] || null
}

function readVolume(metrics, window) {
  const suffix = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '6h': '6h', '24h': '24h', '7d': '7d' }[window]
  const direct = metrics?.[`externalVolume${suffix}`]
  const nested = metrics?.externalVolumes?.[window]
  const value = direct ?? nested
  return finite(value) && Number(value) >= 0 ? Number(value) : null
}

function readTvl(metrics) {
  const value = metrics?.tvl ?? metrics?.poolTvl ?? metrics?.poolTvlUsd
  return finite(value) && Number(value) > 0 ? Number(value) : null
}

function normalizeFlows(metrics) {
  const source = metrics?.recentFlows ?? metrics?.flows
  if (!Array.isArray(source)) return null
  return source.flatMap((flow) => {
    const amount = Number(flow?.value ?? flow?.amountUsd ?? flow?.amount)
    const timestamp = Number(flow?.timestamp ?? flow?.blockTime)
    const type = String(flow?.type ?? flow?.flowType ?? flow?.direction ?? '').toUpperCase()
    if (!finite(amount) || amount <= 0 || !finite(timestamp)) return []
    return [{ ...flow, amount, timestamp, type: EXTERNAL_TYPES.has(type) ? type : type || 'UNKNOWN' }]
  })
}

function piecewise(value, points, xKey, logScale = false) {
  if (value <= points[0][xKey]) return points[0].score
  for (let index = 1; index < points.length; index += 1) {
    const lower = points[index - 1]
    const upper = points[index]
    if (value <= upper[xKey]) {
      const lowerX = logScale ? Math.log10(Math.max(lower[xKey], Number.EPSILON)) : lower[xKey]
      const upperX = logScale ? Math.log10(Math.max(upper[xKey], Number.EPSILON)) : upper[xKey]
      const valueX = logScale ? Math.log10(Math.max(value, Number.EPSILON)) : value
      const position = clamp((valueX - lowerX) / Math.max(Number.EPSILON, upperX - lowerX), 0, 1)
      return lower.score + (upper.score - lower.score) * position
    }
  }
  return points.at(-1).score
}

function privacyBand(score, config) {
  return config.bands.find(({ min }) => score >= min)?.band || 'VERY LOW'
}

function saturation(value, halfSaturation) {
  if (value <= 0) return 0
  return 100 * value / (value + halfSaturation)
}

function median(values) {
  const sorted = values.filter(finite).map(Number).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function similarityStats(amount, flows, config, now) {
  let weightedCount = 0
  let weightedVolume = 0
  let verySimilarCount = 0
  let moderateCount = 0
  const comparableFlows = []
  for (const flow of flows) {
    if (flow.independent === false || now - flow.timestamp > 7 * 86400 || flow.timestamp > now) continue
    const ratio = flow.amount / amount
    if (ratio < config.similarity.moderateMinRatio || ratio > config.similarity.moderateMaxRatio) continue
    const logDistance = Math.abs(Math.log2(ratio))
    // Observable exits are the strongest plausible alternatives to a planned
    // exit. Inbound events still add cover, but receive less weight.
    const typeWeight = flow.type === 'WITHDRAW' || flow.type === 'SWAP_OUT'
      ? 1
      : flow.type === 'DEPOSIT' || flow.type === 'SWAP_IN' ? 0.6 : 0.5
    const weight = Math.exp(-config.similarity.distanceDecay * logDistance) * typeWeight
    weightedCount += weight
    weightedVolume += flow.amount * weight
    moderateCount += 1
    if (ratio >= config.similarity.verySimilarMinRatio && ratio <= config.similarity.verySimilarMaxRatio) verySimilarCount += 1
    comparableFlows.push({ ...flow, ratio, weight, typeWeight })
  }
  return { weightedCount, weightedVolume, verySimilarCount, moderateCount, comparableFlows }
}

function temporalDiversity(flows, now, config, metrics = {}) {
  const bucketSeconds = config.temporal.bucketMinutes * 60
  const buckets = new Set(flows.filter((flow) => flow.independent !== false && flow.timestamp <= now && flow.timestamp >= now - 86400)
    .map((flow) => Math.floor(flow.timestamp / bucketSeconds)))
  const precomputedActiveBuckets = Array.isArray(metrics.hourlyCounts24h)
    ? metrics.hourlyCounts24h.filter((value) => Number(value) > 0).length
    : finite(metrics.activeHours24h) ? Number(metrics.activeHours24h) : 0
  const bucketCount = Math.max(buckets.size, precomputedActiveBuckets)
  return { bucketCount, score: saturation(bucketCount, config.temporal.diversityHalfSaturationBuckets) }
}

function flowRates(metrics, flows, amount, now, config) {
  const volumeWindows = [['1h', 60], ['6h', 360], ['24h', 1440]]
  const volumeRates = volumeWindows.map(([window, minutes]) => {
    const volume = readVolume(metrics, window)
    return volume == null ? null : volume / minutes
  })
  if (finite(metrics.volumeRatePerMinute) && Number(metrics.volumeRatePerMinute) >= 0) volumeRates.push(Number(metrics.volumeRatePerMinute))
  const similarRates = volumeWindows.map(([window, minutes]) => {
    const cutoff = now - minutes * 60
    const stats = similarityStats(amount, flows.filter((flow) => flow.timestamp >= cutoff), config, now)
    return stats.weightedCount / minutes
  })
  const similarVolumeRates = volumeWindows.map(([window, minutes]) => {
    const cutoff = now - minutes * 60
    const stats = similarityStats(amount, flows.filter((flow) => flow.timestamp >= cutoff), config, now)
    return stats.weightedVolume / minutes
  })
  const txRates = volumeWindows.map(([, minutes]) => {
    const cutoff = now - minutes * 60
    return new Set(flows.filter((flow) => flow.independent !== false && flow.timestamp >= cutoff && flow.timestamp <= now)
      .map((flow, index) => flow.signature ?? flow.id ?? `${flow.timestamp}:${index}`)).size / minutes
  })
  if (finite(metrics.flowRatePerMinute) && Number(metrics.flowRatePerMinute) >= 0) txRates.push(Number(metrics.flowRatePerMinute))
  return {
    volumePerMinute: median(volumeRates),
    similarWeightPerMinute: median(similarRates),
    similarVolumePerMinute: median(similarVolumeRates),
    transactionsPerMinute: median(txRates),
    volatility: finite(metrics.activityVolatility) ? Number(metrics.activityVolatility) : rateVolatility(volumeRates),
  }
}

function rateVolatility(rates) {
  const values = rates.filter((value) => finite(value) && value >= 0)
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (!mean) return values.every((value) => value === 0) ? 0 : 1
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

function confidenceFor(metrics, flows, similarity, rates, now, config) {
  let score = 100
  const reasons = []
  const suppliedAges = [metrics.dataStalenessSeconds, metrics.flowAgeSeconds, metrics.snapshotAgeSeconds, metrics.priceAgeSeconds]
    .filter(finite).map(Number)
  const age = suppliedAges.length
    ? Math.max(0, ...suppliedAges)
    : Math.max(0, now - Number(metrics.timestamp))
  if (age > config.confidence.unusableAfterSeconds) { score -= 55; reasons.push('Pool metrics are more than 24 hours old.') }
  else if (age > config.confidence.staleAfterSeconds) { score -= 20; reasons.push('Pool metrics are stale.') }
  const earliest = flows.length ? Math.min(...flows.map(({ timestamp }) => timestamp) ) : now
  const historySeconds = metrics.historyComplete === true || metrics.coverage7d === true
    ? Math.max(config.confidence.fullHistorySeconds, finite(metrics.historyDays) ? Number(metrics.historyDays) * 86400 : 0)
    : finite(metrics.historySeconds)
      ? Number(metrics.historySeconds)
      : finite(metrics.historyDays)
        ? Number(metrics.historyDays) * 86400
        : Math.max(0, now - Number(metrics.historyStart ?? earliest))
  if (historySeconds < 86400) { score -= 25; reasons.push('Less than 24 hours of flow history is available.') }
  else if (historySeconds < config.confidence.fullHistorySeconds) { score -= 10; reasons.push('Less than seven days of flow history is available.') }
  if (similarity.weightedCount < 1) { score -= 25; reasons.push('Comparable-size flow history is sparse.') }
  else if (similarity.weightedCount < 5) { score -= 10; reasons.push('Only a few comparable-size flows are available.') }
  if (rates.volatility != null && rates.volatility > 1) { score -= 20; reasons.push('Recent activity rates are highly volatile.') }
  else if (rates.volatility != null && rates.volatility > 0.5) { score -= 10; reasons.push('Recent activity rates are volatile.') }
  if (flows.length < 10) { score -= 15; reasons.push('The historical flow sample is small.') }
  score = clamp(score)
  return { score: Math.round(score), band: score >= 75 ? 'HIGH' : score >= 45 ? 'MEDIUM' : 'LOW', reasons }
}

function unavailableEstimate(input, missingData) {
  const unavailableReason = 'Required historical metrics are unavailable.'
  return {
    available: false,
    provider: input?.provider ?? null,
    token: input?.token ?? null,
    score: null,
    band: 'UNAVAILABLE',
    label: 'Estimated privacy unavailable',
    unavailableReason,
    missingData,
    confidence: { score: 0, band: 'LOW', reasons: ['Required historical metrics are unavailable.'] },
    notice: ESTIMATE_NOTICE,
  }
}

function inputData(input) {
  const metrics = input?.metrics
  // USD/common-unit valuation takes precedence over a native token amount.
  const amount = Number(input?.amountUsd ?? metrics?.amountUsd ?? input?.amount ?? input?.transferAmount)
  const tvl = readTvl(metrics)
  const now = Number(input?.now ?? metrics?.timestamp)
  const flows = normalizeFlows(metrics)
  const missing = []
  if (!finite(amount) || amount <= 0) missing.push('positive transfer amount')
  if (!metrics) missing.push('pool metrics')
  if (tvl == null) missing.push('pool TVL')
  if (!finite(now)) missing.push('metrics timestamp')
  if (readVolume(metrics, '1h') == null) missing.push('1h external volume')
  if (readVolume(metrics, '6h') == null) missing.push('6h external volume')
  if (readVolume(metrics, '24h') == null) missing.push('24h external volume')
  if (flows == null) missing.push('recent external flows')
  return { amount, metrics, tvl, now, flows: flows || [], missing }
}

function calculateCore(input, config, projection = {}) {
  const data = inputData(input)
  if (data.missing.length) return unavailableEstimate(input, data.missing)
  const { amount, metrics, tvl, now, flows } = data
  const waitMinutes = Math.max(0, Number(projection.waitMinutes || 0))
  const evaluationTime = now + waitMinutes * 60
  const rates = projection.rates || flowRates(metrics, flows, amount, now, config)
  const similarity = similarityStats(amount, flows, config, now)
  const projectedSimilarCount = similarity.weightedCount + Math.max(0, rates.similarWeightPerMinute || 0) * waitMinutes
  const projectedSimilarVolume = similarity.weightedVolume + Math.max(0, rates.similarVolumePerMinute || 0) * waitMinutes
  const base24hVolume = readVolume(metrics, '24h')
  const relevantVolume = base24hVolume + Math.max(0, rates.volumePerMinute || 0) * waitMinutes
  const poolShare = amount / tvl
  const coverRatio = relevantVolume / amount
  const depthScore = piecewise(poolShare, config.depth.points, 'share', true)
  const coverScore = piecewise(coverRatio, config.cover.points, 'ratio')
  const similarityCountScore = saturation(projectedSimilarCount, config.similarity.countHalfSaturation)
  const similarityVolumeScore = saturation(projectedSimilarVolume / amount, config.similarity.volumeHalfSaturation)
  const similarityScore = similarityCountScore * 0.75 + similarityVolumeScore * 0.25
  const diversity = temporalDiversity(flows, now, config, metrics)
  const projectedDiversity = saturation(
    diversity.bucketCount + Math.min(waitMinutes / config.temporal.bucketMinutes, (rates.transactionsPerMinute || 0) * waitMinutes),
    config.temporal.diversityHalfSaturationBuckets,
  )
  const depositTimestamp = finite(input.depositTimestamp) ? Number(input.depositTimestamp) : null
  const exitTimestamp = finite(input.exitTimestamp) ? Number(input.exitTimestamp) : now
  const separationMinutes = depositTimestamp == null ? null : Math.max(0, (exitTimestamp - depositTimestamp) / 60 + waitMinutes)
  const separationScore = separationMinutes == null
    ? null
    : piecewise(separationMinutes, config.temporal.separationPoints, 'minutes')
  const temporalScore = separationScore == null
    ? projectedDiversity
    : separationScore * config.temporal.separationWeight + projectedDiversity * (1 - config.temporal.separationWeight)
  const observedTransactions = finite(metrics.recentTransactionCount)
    ? Number(metrics.recentTransactionCount)
    : new Set(flows.filter((flow) => flow.timestamp >= now - 86400).map((flow, index) => flow.signature ?? flow.id ?? `${flow.timestamp}:${index}`)).size
  const projectedTransactions = observedTransactions + Math.max(0, rates.transactionsPerMinute || 0) * waitMinutes
  const activityScore = saturation(projectedTransactions, config.activity.transactionHalfSaturation)
  const uniquenessScore = saturation(projectedSimilarCount, config.similarity.countHalfSaturation / 2)
  const subscores = { depth: depthScore, cover: coverScore, similarity: similarityScore, temporal: temporalScore, activity: activityScore, uniqueness: uniquenessScore }
  const totalWeight = Object.values(config.weights).reduce((sum, value) => sum + Number(value), 0)
  const score = clamp(Object.entries(subscores).reduce((sum, [key, value]) => sum + value * config.weights[key], 0) / totalWeight)
  const noCover = waitMinutes === 0 && amount > tvl
  // A pool that publishes how many notes it holds tells us the size of the set
  // the recipient hides among. Below the floor there are too few candidates for
  // the estimate to carry meaning, whatever the value-based signals say. Pools
  // that publish nothing are unaffected.
  const anonymitySetSize = finite(metrics.anonymitySet?.size) ? Number(metrics.anonymitySet.size) : null
  const thinAnonymitySet = anonymitySetSize !== null && anonymitySetSize < config.anonymitySet.minimumSet
  const effectiveScore = noCover || thinAnonymitySet ? 0 : score
  const swapFlows = flows.filter(({ type }) => type === 'SWAP_IN' || type === 'SWAP_OUT')
  const confidence = confidenceFor(metrics, flows, similarity, rates, now, config)
  if (waitMinutes > 1440 && confidence.score > 0) {
    confidence.score = Math.max(0, confidence.score - 10)
    confidence.band = confidence.score >= 75 ? 'HIGH' : confidence.score >= 45 ? 'MEDIUM' : 'LOW'
    confidence.reasons.push('Long-horizon projections have additional uncertainty.')
  }
  const explanations = []
  if (noCover) explanations.push({ impact: 'negative', metric: 'no cover', message: 'Transfer exceeds the current same-asset pool balance; an immediate exit would be mathematically linkable.' })
  if (thinAnonymitySet) {
    explanations.push({ impact: 'negative', metric: 'anonymity set', message: `Only ${anonymitySetSize} notes exist in this pool; a recipient would be one of too few candidates.` })
  } else if (anonymitySetSize !== null) {
    explanations.push({ impact: anonymitySetSize >= 5000 ? 'positive' : 'neutral', metric: 'anonymity set', message: `${anonymitySetSize.toLocaleString('en-US')} notes make up the set a recipient hides among.` })
  }
  explanations.push({ impact: depthScore >= 75 ? 'positive' : depthScore < 45 ? 'negative' : 'neutral', metric: 'pool depth', message: `Transfer is ${round(poolShare * 100, 3)}% of pool TVL.` })
  explanations.push({ impact: coverScore >= 75 ? 'positive' : coverScore < 45 ? 'negative' : 'neutral', metric: 'relevant cover', message: `Observed cover ratio is ${round(coverRatio)}×; volume alone does not imply privacy.` })
  explanations.push({ impact: similarityScore >= 65 ? 'positive' : similarityScore < 35 ? 'negative' : 'neutral', metric: 'similar-size flows', message: `${round(projectedSimilarCount, 1)} weighted comparable flows provide amount cover.` })
  if (separationMinutes != null) explanations.push({ impact: separationScore >= 65 ? 'positive' : separationScore < 35 ? 'negative' : 'neutral', metric: 'time separation', message: `${round(separationMinutes, 1)} minutes separate the deposit and planned exit.` })
  if (swapFlows.length) explanations.push({ impact: 'neutral', metric: 'swap activity', message: `${swapFlows.length} recent swap-related external flows are included in relevant activity.` })
  return {
    available: true,
    provider: input.provider ?? metrics.provider ?? null,
    token: input.token ?? metrics.token ?? null,
    timestamp: evaluationTime,
    score: Math.round(effectiveScore),
    rawScore: effectiveScore,
    band: noCover || thinAnonymitySet ? 'NOT PRIVATE' : privacyBand(effectiveScore, config),
    label: noCover || thinAnonymitySet ? 'No cover / not private' : 'Estimated privacy',
    noCover,
    anonymitySetSize,
    anonymitySetSource: metrics.anonymitySet?.source ?? null,
    thinAnonymitySet,
    privacyConstraint: noCover
      ? { code: 'NO_COVER', message: 'Immediate transfer exceeds the current same-asset pool balance.' }
      : thinAnonymitySet
        ? { code: 'THIN_ANONYMITY_SET', message: `Pool holds ${anonymitySetSize} notes, below the ${config.anonymitySet.minimumSet} required for a meaningful estimate.` }
        : null,
    depthScore: Math.round(depthScore),
    coverScore: Math.round(coverScore),
    similarityScore: Math.round(similarityScore),
    temporalScore: Math.round(temporalScore),
    activityScore: Math.round(activityScore),
    uniquenessScore: Math.round(uniquenessScore),
    subscores: Object.fromEntries(Object.entries(subscores).map(([key, value]) => [key, Math.round(value)])),
    poolShare,
    coverRatio,
    similarFlowCount: similarity.moderateCount,
    verySimilarFlowCount: similarity.verySimilarCount,
    weightedSimilarFlowCount: round(projectedSimilarCount, 3),
    weightedSimilarFlowVolume: round(projectedSimilarVolume, 2),
    recentTransactionCount: Math.round(projectedTransactions),
    swapActivity: { count: swapFlows.length, volume: swapFlows.reduce((sum, flow) => sum + flow.amount, 0) },
    timeSeparationMinutes: separationMinutes,
    executionLatencyP50: metrics.executionLatencyP50 ?? null,
    executionLatencyP95: metrics.executionLatencyP95 ?? null,
    confidence,
    explanations,
    rateModel: {
      method: 'median of trailing 1h, 6h, and 24h rates',
      externalVolumePerMinute: rates.volumePerMinute,
      weightedSimilarFlowsPerMinute: rates.similarWeightPerMinute,
      transactionsPerMinute: rates.transactionsPerMinute,
    },
    notice: ESTIMATE_NOTICE,
  }
}

function formatMinutes(minutes) {
  if (minutes == null) return null
  if (minutes < 60) return `~${Math.max(1, Math.round(minutes))} min`
  const hours = Math.floor(minutes / 60)
  const remainder = Math.round(minutes % 60)
  if (hours < 24) return remainder ? `~${hours}h ${remainder}m` : `~${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `~${days}d ${remainingHours}h` : `~${days}d`
}

function binaryTargetSearch({ evaluate, targetScore, minimumMinute = 0, maximumMinute, stepMinutes = 1 }) {
  const step = Math.max(1, Math.floor(stepMinutes))
  const minimumStep = Math.max(0, Math.ceil(minimumMinute / step))
  const maximumStep = Math.max(minimumStep, Math.floor(maximumMinute / step))
  const first = evaluate(minimumStep * step)
  if (first.score >= targetScore) return { minute: minimumStep * step, estimate: first }
  const last = evaluate(maximumStep * step)
  if (last.score < targetScore) return null
  let low = minimumStep + 1
  let high = maximumStep
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (evaluate(middle * step).score >= targetScore) high = middle
    else low = middle + 1
  }
  return { minute: low * step, estimate: evaluate(low * step) }
}

export function simulatePrivacyEta(input, target = 'high', overrides = {}) {
  const config = createPrivacyConfig(overrides)
  const targetConfig = getPrivacyTarget(target, overrides.targets || PRIVACY_TARGETS)
  if (!targetConfig) throw new TypeError(`Unknown privacy target: ${target}`)
  const current = calculateCore(input, config)
  if (!current.available) return { ...current, target: targetConfig, status: 'unavailable', seconds: null, display: 'Not enough activity to estimate' }
  if (current.score >= targetConfig.score) {
    return { status: 'already_reached', target: targetConfig, seconds: 0, display: 'Available now', projectedScore: current.score, confidence: current.confidence, notice: ESTIMATE_NOTICE }
  }
  const data = inputData(input)
  const rates = flowRates(data.metrics, data.flows, data.amount, data.now, config)
  if (!(rates.volumePerMinute > 0 || rates.similarWeightPerMinute > 0 || rates.transactionsPerMinute > 0)) {
    return { status: 'insufficient_activity', target: targetConfig, seconds: null, display: 'Not enough activity to estimate', projectedScore: current.score, confidence: current.confidence, notice: ESTIMATE_NOTICE }
  }
  const timeline = []
  for (const minute of config.eta.timelineMinutes) {
    const estimate = calculateCore(input, config, { waitMinutes: minute, rates })
    timeline.push({ seconds: minute * 60, score: estimate.score, band: estimate.band })
  }
  const crossing = binaryTargetSearch({
    evaluate: (minute) => calculateCore(input, config, { waitMinutes: minute, rates }),
    targetScore: targetConfig.score,
    minimumMinute: config.eta.stepMinutes,
    maximumMinute: config.eta.maxHorizonMinutes,
    stepMinutes: config.eta.stepMinutes,
  })
  if (crossing) return {
    status: 'reached', target: targetConfig, seconds: crossing.minute * 60, display: formatMinutes(crossing.minute), projectedScore: crossing.estimate.score,
    confidence: crossing.estimate.confidence, timeline, method: 'Expected accumulation based on robust trailing activity rates.', notice: ESTIMATE_NOTICE,
  }
  return {
    status: 'beyond_horizon', target: targetConfig, seconds: null,
    display: `> ${formatMinutes(config.eta.maxHorizonMinutes).replace(/^~/, '')}`,
    projectedScore: calculateCore(input, config, { waitMinutes: config.eta.maxHorizonMinutes, rates }).score,
    confidence: current.confidence, timeline, notice: ESTIMATE_NOTICE,
  }
}

export function calculatePrivacyEstimate(input, overrides = {}) {
  const config = createPrivacyConfig(overrides)
  const estimate = calculateCore(input, config)
  if (!estimate.available || overrides.includeEta === false) return estimate
  const estimatedTimeToHigh = simulatePrivacyEta(input, 'high', overrides)
  const estimatedTimeToVeryHigh = simulatePrivacyEta(input, 'maximum', overrides)
  const selectedTarget = getPrivacyTarget(input?.target || 'high', overrides.targets || PRIVACY_TARGETS)
  const estimatedTimeToTarget = selectedTarget?.id === 'high'
    ? estimatedTimeToHigh
    : selectedTarget?.id === 'maximum' ? estimatedTimeToVeryHigh : simulatePrivacyEta(input, selectedTarget?.score, overrides)
  return {
    ...estimate,
    privacyTarget: selectedTarget,
    estimatedTimeToTarget,
    estimatedTimeToHigh,
    estimatedTimeToVeryHigh,
  }
}

export const estimatePrivacy = calculatePrivacyEstimate
export const estimateTimeToPrivacy = simulatePrivacyEta

export function estimateProviderFee({ provider, token, amount, recipientCount = 1, tokenPrices = {}, capabilities = PROVIDER_CAPABILITIES }) {
  const providerConfig = getProviderCapabilities(provider, capabilities)
  if (!providerConfig) return { available: false, reason: `Unknown provider: ${provider}` }
  const model = providerConfig.withdrawalFee
  if (!model || !finite(amount) || Number(amount) < 0) return { available: false, reason: 'Fee model or amount is unavailable.' }
  const normalizedToken = String(token || '').toUpperCase()
  const count = Math.max(1, Math.floor(Number(recipientCount) || 1))
  const variableFee = Number(amount) * model.variableRate
  const fixedApplies = !model.fixedAppliesToTokens || model.fixedAppliesToTokens.includes(normalizedToken)
  const fixedUnits = fixedApplies ? (model.fixedBasis === 'recipient' ? count : 1) : 0
  let fixedFee = 0
  if (fixedUnits && model.fixedAmount) {
    if (model.fixedToken === normalizedToken) fixedFee = model.fixedAmount * fixedUnits
    else {
      const fixedPrice = Number(tokenPrices[model.fixedToken])
      const outputPrice = Number(tokenPrices[normalizedToken])
      if (!(fixedPrice > 0) || !(outputPrice > 0)) {
        return {
          available: false,
          reason: `Stored ${model.fixedToken} and ${normalizedToken} prices are required to convert the fixed fee.`,
          components: { variableFee, fixedAmount: model.fixedAmount, fixedToken: model.fixedToken, fixedBasis: model.fixedBasis, fixedUnits },
        }
      }
      fixedFee = model.fixedAmount * fixedUnits * fixedPrice / outputPrice
    }
  }
  return {
    available: true,
    token: normalizedToken,
    total: variableFee + fixedFee,
    components: {
      variableFee,
      variableRate: model.variableRate,
      fixedFee,
      fixedAmount: model.fixedAmount,
      fixedToken: model.fixedToken,
      fixedBasis: model.fixedBasis,
      fixedUnits,
      recipientCount: count,
    },
    label: model.label,
  }
}

function coefficientOfVariation(values) {
  if (!values.length) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (!mean) return 0
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

function coordinationPenalty(amounts, delays, totalAmount, rates, config) {
  const span = Math.max(...delays) - Math.min(...delays)
  const timing = span <= 1 ? 12 : span <= 5 ? 10 : span <= 15 ? 7 : span <= 60 ? 4 : span <= 180 ? 2 : 0
  const variation = coefficientOfVariation(amounts)
  const regularity = variation < 0.01 ? 10 : variation < 0.05 ? 9 : variation < 0.15 ? 6 : variation < 0.3 ? 3 : 0
  const reconstructedShare = totalAmount > 0 ? amounts.reduce((sum, amount) => sum + amount, 0) / totalAmount : 1
  const reconstruction = Math.abs(1 - reconstructedShare) <= 0.01 ? 4 : Math.abs(1 - reconstructedShare) <= 0.05 ? 2 : 0
  const expectedIndependentTransactions = Math.max(0, rates.transactionsPerMinute || 0) * span
  const unrelated = expectedIndependentTransactions < 1 ? 8 : expectedIndependentTransactions < amounts.length ? 6 : expectedIndependentTransactions < amounts.length * 3 ? 3 : 0
  const total = Math.min(config.multiRecipient.maxCoordinationPenalty, timing + regularity + reconstruction + unrelated)
  const band = total >= 24 ? 'HIGH' : total >= 12 ? 'MEDIUM' : 'LOW'
  return {
    total, band,
    components: { timing, amountRegularity: regularity, sumReconstruction: reconstruction, limitedUnrelatedActivity: unrelated },
    explanation: 'Splitting does not guarantee unlinkability; tightly timed, regular legs can remain correlatable.',
  }
}

function planScore(receiverEstimates, penalty, config) {
  const scores = receiverEstimates.map(({ estimate }) => estimate.rawScore ?? estimate.score)
  const weakest = Math.min(...scores)
  const harmonic = scores.length / scores.reduce((sum, score) => sum + 1 / Math.max(1, score), 0)
  return clamp(weakest * config.multiRecipient.minimumReceiverWeight + harmonic * config.multiRecipient.averageReceiverWeight - penalty.total)
}

function receiverDelays(input, count) {
  if (Array.isArray(input.receiverDelaysMinutes) && input.receiverDelaysMinutes.length === count) {
    return input.receiverDelaysMinutes.map((value) => Math.max(0, Number(value) || 0))
  }
  const spacing = Math.max(0, Number(input.plannedSpacingMinutes) || 0)
  return Array.from({ length: count }, (_, index) => index * spacing)
}

function invalidPlan(input, capabilities, error, remainingAmount = null) {
  return {
    available: false, valid: false, disabled: false, provider: input.provider, capabilities,
    error, unavailableReason: error, remainingAmount, planScore: null, planBand: 'UNAVAILABLE', notice: ESTIMATE_NOTICE,
  }
}

function projectedPlan(input, config, amounts, valuationAmounts, delays, baseWaitMinutes, ratesByReceiver) {
  const receiverEstimates = amounts.map((amount, index) => ({
    index: index + 1,
    amount,
    amountUsd: valuationAmounts[index],
    plannedDelaySeconds: (delays[index] + baseWaitMinutes) * 60,
    estimate: calculateCore({ ...input, amountUsd: valuationAmounts[index] }, config, { waitMinutes: delays[index] + baseWaitMinutes, rates: ratesByReceiver[index] }),
  }))
  if (receiverEstimates.some(({ estimate }) => !estimate.available)) return { available: false, receiverEstimates }
  const penalty = coordinationPenalty(amounts, delays, Number(input.totalAmount), ratesByReceiver[0], config)
  const score = planScore(receiverEstimates, penalty, config)
  const data = inputData({ ...input, amountUsd: valuationAmounts[0] })
  const noCover = baseWaitMinutes === 0 && delays.every((delay) => delay === 0)
    && valuationAmounts.reduce((sum, amount) => sum + amount, 0) > data.tvl
  return {
    available: true,
    receiverEstimates,
    coordinationPenalty: penalty,
    score: noCover ? 0 : score,
    band: noCover ? 'NOT PRIVATE' : privacyBand(score, config),
    noCover,
    privacyConstraint: noCover ? { code: 'NO_COVER', message: 'Immediate combined transfer exceeds the current same-asset pool balance.' } : null,
  }
}

export function estimateMultiReceiverPlan(input, overrides = {}) {
  const config = createPrivacyConfig(overrides)
  const capabilities = getProviderCapabilities(input?.provider, input?.capabilities || PROVIDER_CAPABILITIES)
  if (!capabilities) return invalidPlan(input || {}, null, `Unknown provider: ${input?.provider}`)
  if (!capabilities.supportsMultiRecipient) {
    const reason = 'Multiple-recipient withdrawal is not currently supported by this provider.'
    return {
      available: false, valid: true, disabled: true, provider: input.provider, capabilities,
      reason, unavailableReason: reason,
      planScore: null, planBand: 'UNAVAILABLE', notice: ESTIMATE_NOTICE,
    }
  }
  const amounts = Array.isArray(input.receiverAmounts) ? input.receiverAmounts.map(Number) : []
  const totalAmount = Number(input.totalAmount)
  if (!finite(totalAmount) || totalAmount <= 0) return invalidPlan(input, capabilities, 'Total amount must be positive.')
  if (amounts.length < 2 || amounts.some((amount) => !finite(amount) || amount <= 0)) {
    return invalidPlan(input, capabilities, 'At least two positive receiver amounts are required.')
  }
  if (capabilities.maxRecipients != null && amounts.length > capabilities.maxRecipients) {
    return invalidPlan(input, capabilities, `This provider supports at most ${capabilities.maxRecipients} receiver(s).`)
  }
  const sum = amounts.reduce((total, amount) => total + amount, 0)
  const tolerance = Math.max(1e-8, Math.abs(totalAmount) * 1e-8)
  if (Math.abs(sum - totalAmount) > tolerance) {
    return invalidPlan(input, capabilities, 'Receiver amounts must equal the total amount.', totalAmount - sum)
  }
  const tokenPrice = Number(input.tokenPrices?.[String(input.token || '').toUpperCase()])
  const valuationAmounts = Array.isArray(input.receiverAmountsUsd) && input.receiverAmountsUsd.length === amounts.length
    ? input.receiverAmountsUsd.map(Number)
    : amounts.map((amount) => tokenPrice > 0 ? amount * tokenPrice : amount)
  if (valuationAmounts.some((amount) => !finite(amount) || amount <= 0)) {
    return invalidPlan(input, capabilities, 'Positive common-unit values are required for every receiver.')
  }
  const delays = receiverDelays(input, amounts.length)
  const firstData = inputData({ ...input, amountUsd: valuationAmounts[0] })
  if (firstData.missing.length) return { ...invalidPlan(input, capabilities, 'Required historical metrics are unavailable.'), missingData: firstData.missing }
  const ratesByReceiver = valuationAmounts.map((amount) => flowRates(firstData.metrics, firstData.flows, amount, firstData.now, config))
  const current = projectedPlan(input, config, amounts, valuationAmounts, delays, 0, ratesByReceiver)
  if (!current.available) return { ...invalidPlan(input, capabilities, 'Required historical metrics are unavailable.'), receiverEstimates: current.receiverEstimates }
  const target = getPrivacyTarget(input.target || 'high', input.targets || PRIVACY_TARGETS)
  if (!target) throw new TypeError(`Unknown privacy target: ${input.target}`)
  let eta
  if (current.score >= target.score) {
    eta = { status: 'already_reached', target, seconds: 0, display: 'Available now', projectedScore: Math.round(current.score) }
  } else if (!ratesByReceiver.some((rates) => rates.volumePerMinute > 0 || rates.similarWeightPerMinute > 0 || rates.transactionsPerMinute > 0)) {
    eta = { status: 'insufficient_activity', target, seconds: null, display: 'Not enough activity to estimate', projectedScore: Math.round(current.score) }
  } else {
    const crossing = binaryTargetSearch({
      evaluate: (minute) => projectedPlan(input, config, amounts, valuationAmounts, delays, minute, ratesByReceiver),
      targetScore: target.score,
      minimumMinute: config.eta.stepMinutes,
      maximumMinute: config.eta.maxHorizonMinutes,
      stepMinutes: config.eta.stepMinutes,
    })
    eta = crossing
      ? { status: 'reached', target, seconds: crossing.minute * 60, display: formatMinutes(crossing.minute), projectedScore: Math.round(crossing.estimate.score) }
      : { status: 'beyond_horizon', target, seconds: null, display: `> ${formatMinutes(config.eta.maxHorizonMinutes).replace(/^~/, '')}`, projectedScore: Math.round(projectedPlan(input, config, amounts, valuationAmounts, delays, config.eta.maxHorizonMinutes, ratesByReceiver).score) }
  }
  const receiverEstimates = current.receiverEstimates.map((receiver, index) => {
    const crossing = binaryTargetSearch({
      evaluate: (minute) => calculateCore({ ...input, amountUsd: receiver.amountUsd }, config, { waitMinutes: minute, rates: ratesByReceiver[index] }),
      targetScore: target.score,
      minimumMinute: delays[index],
      maximumMinute: config.eta.maxHorizonMinutes,
      stepMinutes: config.eta.stepMinutes,
    })
    const receiverEta = crossing
      ? { status: crossing.minute === 0 ? 'already_reached' : 'reached', target, seconds: crossing.minute * 60, display: crossing.minute <= 0 ? 'Available now' : formatMinutes(crossing.minute), projectedScore: crossing.estimate.score, confidence: crossing.estimate.confidence, notice: ESTIMATE_NOTICE }
      : { status: 'beyond_horizon', target, seconds: null, display: `> ${formatMinutes(config.eta.maxHorizonMinutes).replace(/^~/, '')}`, projectedScore: receiver.estimate.score, confidence: receiver.estimate.confidence, notice: ESTIMATE_NOTICE }
    return { ...receiver, estimatedTimeToTarget: receiverEta }
  })
  const fee = estimateProviderFee({
    provider: input.provider, token: input.token, amount: totalAmount, recipientCount: amounts.length,
    tokenPrices: input.tokenPrices, capabilities: input.capabilities || PROVIDER_CAPABILITIES,
  })
  return {
    available: true,
    valid: true,
    disabled: false,
    provider: input.provider,
    token: input.token,
    totalAmount,
    receiverCount: amounts.length,
    capabilities,
    receiverEstimates,
    coordinationPenalty: current.coordinationPenalty,
    planScore: Math.round(current.score),
    rawPlanScore: current.score,
    planBand: current.band,
    noCover: current.noCover,
    privacyConstraint: current.privacyConstraint,
    estimatedTimeToTarget: { ...eta, confidence: current.receiverEstimates.reduce((lowest, item) => item.estimate.confidence.score < lowest.score ? item.estimate.confidence : lowest, current.receiverEstimates[0].estimate.confidence), notice: ESTIMATE_NOTICE },
    fee,
    label: 'Estimated plan privacy',
    notice: ESTIMATE_NOTICE,
  }
}
