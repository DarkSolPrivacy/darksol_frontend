import {
  getSyncState, readLatestPoolSnapshot, readLatestTokenPrices, readLinkedFlowLatencies,
  readPlanningFlows, readProtocolHistoryBounds,
} from './db.js'

const WINDOW_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 }
const FLOW_TYPES = ['DEPOSIT', 'WITHDRAW', 'SWAP_IN', 'SWAP_OUT']
const TYPE_WEIGHT = { DEPOSIT: 0.6, WITHDRAW: 1, SWAP_IN: 0.6, SWAP_OUT: 1 }
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]
}

function coefficientOfVariation(values) {
  if (!values.length) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (!mean) return null
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length
  return Math.sqrt(variance) / mean
}

function operationKey(flow) {
  if (!flow.linkedFlowId) return flow.signature
  return [flow.id, flow.linkedFlowId].sort()[0]
}

function emptyWindow(price) {
  return {
    total: { token: 0, usd: price ? 0 : null },
    byType: Object.fromEntries(FLOW_TYPES.map((type) => [type, { token: 0, usd: price ? 0 : null, eventCount: 0 }])),
    eventCount: 0, observedOperationCount: 0,
    rate: { tokenPerMinute: 0, tokenPerHour: 0, usdPerMinute: price ? 0 : null, usdPerHour: price ? 0 : null, operationsPerMinute: 0, operationsPerHour: 0 },
  }
}

function targetBand(ratio) {
  if (ratio < 0.25) return '<0.25x'
  if (ratio < 0.5) return '0.25–0.5x'
  if (ratio < 0.8) return '0.5–0.8x'
  if (ratio <= 1.25) return '0.8–1.25x'
  if (ratio <= 2) return '1.25–2x'
  if (ratio <= 4) return '2–4x'
  return '>4x'
}

function similarFlowSummary(flows, targetAmount, now) {
  const bands = Object.fromEntries(['<0.25x', '0.25–0.5x', '0.5–0.8x', '0.8–1.25x', '1.25–2x', '2–4x', '>4x']
    .map((label) => [label, { eventCount: 0, operationCount: 0, tokenVolume: 0 }]))
  const bandOperations = Object.fromEntries(Object.keys(bands).map((label) => [label, new Set()]))
  const arrivalCounts = { oneHour: 0, sixHours: 0, twentyFourHours: 0, sevenDays: 0 }
  let weightedCount = 0
  let weightedVolume = 0
  let weightedOutboundCount = 0
  let weightedInboundCount = 0
  let nearExactCount = 0
  const sigmaLog = Math.log(1.5)
  if (!(targetAmount > 0)) return { bands, weightedCount, weightedVolume, weightedOutboundCount, weightedInboundCount, nearExactCount, arrivalCounts }
  for (const flow of flows) {
    const ratio = flow.amount / targetAmount
    if (!(ratio > 0)) continue
    const band = targetBand(ratio)
    bands[band].eventCount += 1
    bands[band].tokenVolume += flow.amount
    bandOperations[band].add(operationKey(flow))
    if (ratio >= 0.98 && ratio <= 1.02) nearExactCount += 1
    const distance = Math.abs(Math.log(ratio))
    if (distance > Math.log(4)) continue
    const sizeWeight = Math.exp(-0.5 * ((distance / sigmaLog) ** 2))
    const age = Math.max(0, now - flow.timestamp)
    const ageWeight = 2 ** (-age / 86400)
    const type = String(flow.flowType || flow.direction).toUpperCase()
    const directionWeight = TYPE_WEIGHT[type] ?? 0.5
    const weight = sizeWeight * ageWeight * directionWeight
    weightedCount += weight
    weightedVolume += flow.amount * weight
    if (directionWeight === 1) weightedOutboundCount += weight
    else weightedInboundCount += weight
    if (age <= 3600) arrivalCounts.oneHour += sizeWeight * directionWeight
    if (age <= 21600) arrivalCounts.sixHours += sizeWeight * directionWeight
    if (age <= 86400) arrivalCounts.twentyFourHours += sizeWeight * directionWeight
    if (age <= 604800) arrivalCounts.sevenDays += sizeWeight * directionWeight
  }
  for (const label of Object.keys(bands)) bands[label].operationCount = bandOperations[label].size
  return { bands, weightedCount, weightedVolume, weightedOutboundCount, weightedInboundCount, nearExactCount, arrivalCounts }
}

function zeroFilledBins(flows, now, seconds, bucketSeconds) {
  const count = Math.ceil(seconds / bucketSeconds)
  const start = now - count * bucketSeconds
  const bins = Array.from({ length: count }, (_, index) => ({ timestamp: start + index * bucketSeconds, eventCount: 0, operationCount: 0, tokenVolume: 0 }))
  const operations = Array.from({ length: count }, () => new Set())
  for (const flow of flows) {
    if (flow.timestamp < start || flow.timestamp > now) continue
    const index = Math.min(count - 1, Math.floor((flow.timestamp - start) / bucketSeconds))
    bins[index].eventCount += 1
    bins[index].tokenVolume += flow.amount
    operations[index].add(operationKey(flow))
  }
  return bins.map((bin, index) => ({ ...bin, operationCount: operations[index].size }))
}

function sourceAge(now, timestamp) { return timestamp == null ? null : Math.max(0, now - timestamp) }

// `priceRows` is optional so a caller building metrics for several protocols at
// once reads the shared price table once instead of once per protocol.
export async function buildPlanningMetrics(protocol, asset, targetAmount, now = Math.floor(Date.now() / 1000), sharedPriceRows = null) {
  const priceRows = sharedPriceRows ?? await readLatestTokenPrices()
  const priceRow = priceRows[asset]
  const price = Number(priceRow?.usdPrice) > 0 ? Number(priceRow.usdPrice) : null
  const [snapshot, state, history, flows] = await Promise.all([
    readLatestPoolSnapshot(protocol),
    getSyncState(protocol),
    readProtocolHistoryBounds(protocol),
    readPlanningFlows(protocol, asset, now - WINDOW_SECONDS['7d'], now),
  ])
  const publicFlows = flows.map((flow) => ({ ...flow, amountUsd: price ? flow.amount * price : null }))
  const activity = Object.fromEntries(Object.keys(WINDOW_SECONDS).map((window) => [window, emptyWindow(price)]))
  const operationSets = Object.fromEntries(Object.keys(WINDOW_SECONDS).map((window) => [window, new Set()]))

  for (const flow of publicFlows) {
    const age = Math.max(0, now - flow.timestamp)
    const type = String(flow.flowType || flow.direction).toUpperCase()
    for (const [window, seconds] of Object.entries(WINDOW_SECONDS)) {
      if (age > seconds) continue
      const entry = activity[window]
      entry.total.token += flow.amount
      if (price) entry.total.usd += flow.amountUsd
      entry.eventCount += 1
      operationSets[window].add(operationKey(flow))
      if (entry.byType[type]) {
        entry.byType[type].token += flow.amount
        if (price) entry.byType[type].usd += flow.amountUsd
        entry.byType[type].eventCount += 1
      }
    }
  }
  for (const [window, seconds] of Object.entries(WINDOW_SECONDS)) {
    const entry = activity[window]
    const minutes = seconds / 60
    entry.observedOperationCount = operationSets[window].size
    entry.rate = {
      tokenPerMinute: entry.total.token / minutes, tokenPerHour: entry.total.token / minutes * 60,
      usdPerMinute: price ? entry.total.usd / minutes : null, usdPerHour: price ? entry.total.usd / minutes * 60 : null,
      operationsPerMinute: entry.observedOperationCount / minutes, operationsPerHour: entry.observedOperationCount / minutes * 60,
    }
  }

  const similarFlowBuckets = similarFlowSummary(publicFlows, targetAmount, now)
  const timeDistribution5m6h = zeroFilledBins(publicFlows, now, 21600, 300)
  const timeDistribution1h7d = zeroFilledBins(publicFlows, now, 604800, 3600)
  const recentTimes = publicFlows.filter(({ timestamp }) => timestamp >= now - 86400).map(({ timestamp }) => timestamp).sort((a, b) => a - b)
  const gaps = recentTimes.slice(1).map((timestamp, index) => timestamp - recentTimes[index])
  const observedSwapGaps = (await readLinkedFlowLatencies(protocol, now - 30 * 86400, now)).sort((a, b) => a - b)
  const balance = snapshot?.balances?.[asset] ?? null
  const tvl = balance !== null && price ? Math.max(0, balance * price) : null
  const amountUsd = price ? targetAmount * price : null
  const coverageStart = state?.historyComplete ? 0 : (state?.backfilledFrom ?? history?.earliest ?? now)
  const coverageEnd = Math.min(now, state?.syncedThrough ?? history?.latest ?? 0)
  const coveredStart = Math.max(now - WINDOW_SECONDS['7d'], coverageStart)
  const coverage7d = clamp((coverageEnd - coveredStart) / WINDOW_SECONDS['7d'])
  const flowAgeSeconds = sourceAge(now, state?.syncedThrough ?? history?.latest)
  const snapshotAgeSeconds = sourceAge(now, snapshot?.blockTime)
  const priceAgeSeconds = sourceAge(now, priceRow?.blockTime)
  const availabilityReasons = []
  if (!price) availabilityReasons.push('missing_price')
  if (balance === null) availabilityReasons.push('missing_pool_snapshot')
  if (!state?.syncedThrough) availabilityReasons.push('missing_flow_watermark')
  const rates = ['1h', '6h', '24h'].map((window) => activity[window].rate)
  const robustOperationRatePerMinute = median(rates.map(({ operationsPerMinute }) => operationsPerMinute))
  const robustTokenRatePerMinute = median(rates.map(({ tokenPerMinute }) => tokenPerMinute))
  const robustUsdRatePerMinute = price ? median(rates.map(({ usdPerMinute }) => usdPerMinute)) : null

  return {
    provider: protocol, token: asset, timestamp: now, tokenPriceUsd: price, amountUsd,
    availability: { available: availabilityReasons.length === 0, reasons: availabilityReasons },
    dataAvailable: availabilityReasons.length === 0,
    tvl, poolBalance: balance, poolSource: protocol === 'privacycash'
      ? 'on-chain pool accounts'
      : protocol === 'curvy' ? 'on-chain Arbitrum Vault balance' : 'reconstructed indexed net flows',
    providerTotalTvlUsd: snapshot && price ? Object.entries(snapshot.balances).reduce((sum, [token, amount]) => {
      const tokenPrice = Number(priceRows[token]?.usdPrice)
      return sum + (tokenPrice > 0 ? amount * tokenPrice : 0)
    }, 0) : null,
    activity,
    ...Object.fromEntries(Object.keys(WINDOW_SECONDS).map((window) => [`externalVolume${window}`, activity[window].total.usd])),
    deposits: activity['24h'].byType.DEPOSIT.usd,
    withdrawals: activity['24h'].byType.WITHDRAW.usd,
    swapIn: activity['24h'].byType.SWAP_IN.usd,
    swapOut: activity['24h'].byType.SWAP_OUT.usd,
    recentTransactionCount: activity['24h'].observedOperationCount,
    rawTransactionCount24h: new Set(publicFlows.filter(({ timestamp }) => timestamp >= now - 86400).map(({ signature }) => signature)).size,
    flowRatePerMinute: robustOperationRatePerMinute, flowRatePerHour: robustOperationRatePerMinute * 60,
    tokenVolumeRatePerMinute: robustTokenRatePerMinute, tokenVolumeRatePerHour: robustTokenRatePerMinute * 60,
    volumeRatePerMinute: robustUsdRatePerMinute, volumeRatePerHour: robustUsdRatePerMinute === null ? null : robustUsdRatePerMinute * 60,
    similarFlowBuckets,
    weightedSimilarFlowCount: similarFlowBuckets.weightedCount,
    weightedSimilarFlowVolume: similarFlowBuckets.weightedVolume,
    distinctAmountCount7d: new Set(publicFlows.map(({ amountRaw }) => amountRaw)).size,
    medianInterarrivalSeconds: gaps.length ? median(gaps) : null,
    activeHours24h: timeDistribution1h7d.slice(-24).filter(({ eventCount }) => eventCount > 0).length,
    timeDistribution5m6h, timeDistribution1h7d,
    hourlyVolumes24h: timeDistribution1h7d.slice(-24).map(({ tokenVolume }) => price ? tokenVolume * price : null),
    hourlyCounts24h: timeDistribution1h7d.slice(-24).map(({ operationCount }) => operationCount),
    activityVolatility: coefficientOfVariation(timeDistribution1h7d.slice(-24).map(({ operationCount }) => operationCount)),
    executionLatencyP50: null, executionLatencyP95: null,
    executionLatency: { status: 'unavailable', p50Seconds: null, p95Seconds: null, reason: 'No defensible submitted-to-finalized lifecycle timestamps are stored.' },
    observedSwapTransitionGapP50: percentile(observedSwapGaps, 0.5),
    observedSwapTransitionGapP95: percentile(observedSwapGaps, 0.95),
    observedSwapTransitionSamples: observedSwapGaps.length,
    flowSyncedThrough: state?.syncedThrough ?? null, flowAgeSeconds,
    snapshotAt: snapshot?.blockTime ?? null, snapshotAgeSeconds,
    priceAt: priceRow?.blockTime ?? null, priceAgeSeconds,
    historyComplete: Boolean(state?.historyComplete), coverageFrom: coverageStart, coverage7d,
    coverageAssumption: 'watermark_contiguous', historySeconds: coverage7d * WINDOW_SECONDS['7d'],
    flows: publicFlows,
  }
}
