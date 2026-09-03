import express from 'express'
import dotenv from 'dotenv'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { databaseStats, getSyncState, readFlows, readLatestPoolSnapshot, readLatestTokenPrices } from './db.js'
import { buildPlanningMetrics } from './planning-metrics.js'
import {
  ESTIMATE_NOTICE, PROVIDER_CAPABILITIES, calculatePrivacyEstimate, estimateMultiReceiverPlan,
  estimateProviderFee, getPrivacyTarget,
} from './privacy-engine.js'
import { swapEligibility } from '../src/swap-routes.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(root, '.env.local'), override: true, quiet: true })
const ASSETS = ['USDC', 'SOL', 'USDT']
const blankAssets = () => Object.fromEntries(ASSETS.map((asset) => [asset, 0]))
const PROTOCOLS = {
  cloakc: {
    id: 'cloakc', name: 'CLOAKC', programId: 'zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW',
    docs: 'https://docs.cloak.ag/sdk/introduction',
    feePolicy: { label: '0.3% protocol fee', detail: 'SOL exits add 0.005 SOL' },
  },
  privacycash: {
    id: 'privacycash', name: 'PrivacyCash', programId: '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD',
    docs: 'https://privacycash.mintlify.app/',
    feePolicy: { label: '0.35% + base fee', detail: 'Transfers: 0.006 SOL equivalent · swaps: 0.008 SOL equivalent + Jupiter fees' },
  },
  curvy: {
    id: 'curvy', name: 'Curvy', programId: '0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00',
    docs: 'https://docs.curvy.box/', chain: 'arbitrum', chainId: 42161,
    explorerAccount: 'https://arbiscan.io/address/0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00',
    explorerTransaction: 'https://arbiscan.io/tx/',
    feePolicy: { label: '0.3% private exit path', detail: '0.1% aggregation + 0.2% unshielding; shielding separately costs 0.1%' },
  },
}
const INTERVALS = {
  '1h': { bucketSeconds: 300, bucketCount: 12 },
  '6h': { bucketSeconds: 900, bucketCount: 24 },
  '1d': { bucketSeconds: 3600, bucketCount: 24 },
  '30d': { bucketSeconds: 86400, bucketCount: 30 },
  '90d': { bucketSeconds: 86400, bucketCount: 90 },
  '1y': { bucketSeconds: 14 * 86400, bucketCount: 26 },
}
const TYPE_SUFFIX = { deposit: 'Deposit', withdraw: 'Withdraw', swap_in: 'SwapIn', swap_out: 'SwapOut' }
const TYPE_GROUP = { deposit: 'deposits', withdraw: 'withdrawals', swap_in: 'swapIn', swap_out: 'swapOut' }

function prices() {
  const stored = readLatestTokenPrices()
  return Object.fromEntries(ASSETS.map((asset) => {
    const value = Number(stored[asset]?.usdPrice)
    return [asset, value > 0 ? value : null]
  }))
}

function usd(flow, tokenPrices) {
  const price = tokenPrices[flow.asset]
  return price === null ? null : flow.amount * price
}

function activityFor(flows, tokenPrices, now) {
  const distribution = [
    { label: '< $100', min: 0, max: 100, count: 0 }, { label: '$100–1k', min: 100, max: 1000, count: 0 },
    { label: '$1k–10k', min: 1000, max: 10000, count: 0 }, { label: '$10k–100k', min: 10000, max: 100000, count: 0 },
    { label: '$100k+', min: 100000, max: Infinity, count: 0 },
  ]
  const timeDistribution = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }))
  let volume1hUsd = 0
  let volume24hUsd = 0
  let complete1hUsd = true
  let complete24hUsd = true
  for (const flow of flows) {
    const value = usd(flow, tokenPrices)
    if (value !== null) distribution.find(({ min, max }) => value >= min && value < max).count += 1
    timeDistribution[new Date(flow.timestamp * 1000).getUTCHours()].count += 1
    if (flow.timestamp >= now - 3600) {
      if (value === null) complete1hUsd = false
      else volume1hUsd += value
    }
    if (flow.timestamp >= now - 86400) {
      if (value === null) complete24hUsd = false
      else volume24hUsd += value
    }
  }
  return {
    txCount: new Set(flows.map(({ signature }) => signature)).size,
    uniqueAmounts: new Set(flows.map(({ asset, amountRaw }) => `${asset}:${amountRaw}`)).size,
    amountDistribution: distribution.map(({ label, count }) => ({ label, count })),
    recentVolume: {
      oneHourUsd: complete1hUsd ? volume1hUsd : null,
      twentyFourHoursUsd: complete24hUsd ? volume24hUsd : null,
    },
    usdValuationComplete: complete24hUsd,
    timeDistribution,
  }
}

function aggregate(flows, historicalFlows, from, bucketSeconds, bucketCount, poolSnapshot, tokenPrices, now) {
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const bucket = { timestamp: from + index * bucketSeconds, count: 0 }
    for (const asset of ASSETS) for (const suffix of Object.values(TYPE_SUFFIX)) bucket[`${asset}${suffix}`] = 0
    for (const asset of ASSETS) bucket[`${asset}Pool`] = 0
    return bucket
  })
  const externalFlows = { deposits: blankAssets(), withdrawals: blankAssets(), swapIn: blankAssets(), swapOut: blankAssets() }
  const totals = {
    deposits: externalFlows.deposits, withdrawals: externalFlows.withdrawals, swapIn: externalFlows.swapIn, swapOut: externalFlows.swapOut,
    poolSize: blankAssets(), count: 0, counts: { deposit: 0, withdraw: 0, swap_in: 0, swap_out: 0, byAsset: blankAssets() },
  }
  for (const flow of historicalFlows) totals.poolSize[flow.asset] += (flow.direction === 'deposit' ? 1 : -1) * flow.amount
  const windowNet = blankAssets()
  for (const flow of flows) {
    const index = Math.min(buckets.length - 1, Math.floor((flow.timestamp - from) / bucketSeconds))
    if (index < 0) continue
    const type = TYPE_SUFFIX[flow.flowType] ? flow.flowType : flow.direction
    buckets[index][`${flow.asset}${TYPE_SUFFIX[type]}`] += flow.amount
    buckets[index].count += 1
    totals[TYPE_GROUP[type]][flow.asset] += flow.amount
    windowNet[flow.asset] += (flow.direction === 'deposit' ? 1 : -1) * flow.amount
    totals.poolSize[flow.asset] += (flow.direction === 'deposit' ? 1 : -1) * flow.amount
    totals.count += 1
    totals.counts[type] += 1
    totals.counts.byAsset[flow.asset] += 1
  }
  const closingPool = poolSnapshot || totals.poolSize
  const running = Object.fromEntries(ASSETS.map((asset) => [asset, (closingPool[asset] || 0) - windowNet[asset]]))
  totals.poolSize = { ...blankAssets(), ...closingPool }
  for (const bucket of buckets) {
    for (const asset of ASSETS) {
      running[asset] += bucket[`${asset}Deposit`] + bucket[`${asset}SwapIn`] - bucket[`${asset}Withdraw`] - bucket[`${asset}SwapOut`]
      const decimals = asset === 'SOL' ? 9 : 6
      for (const suffix of Object.values(TYPE_SUFFIX)) bucket[`${asset}${suffix}`] = Number(bucket[`${asset}${suffix}`].toFixed(decimals))
      bucket[`${asset}Pool`] = Number(running[asset].toFixed(decimals))
    }
  }
  for (const group of ['deposits', 'withdrawals', 'swapIn', 'swapOut', 'poolSize']) {
    for (const asset of ASSETS) totals[group][asset] = Number((totals[group][asset] || 0).toFixed(asset === 'SOL' ? 9 : 6))
  }
  const poolState = { balances: totals.poolSize, usd: Object.fromEntries(ASSETS.map((asset) => [asset, tokenPrices[asset] === null ? null : totals.poolSize[asset] * tokenPrices[asset]])) }
  const valuedBalances = Object.values(poolState.usd).filter((value) => value !== null)
  poolState.totalUsd = valuedBalances.length === ASSETS.length ? valuedBalances.reduce((sum, value) => sum + value, 0) : null
  return { buckets, totals, externalFlows, poolState, activity: activityFor(flows, tokenPrices, now) }
}

function analytics(protocol, interval) {
  const protocolConfig = PROTOCOLS[protocol]
  const intervalConfig = INTERVALS[interval]
  if (!protocolConfig) throw new Error('protocol must be cloakc, privacycash, or curvy')
  if (!intervalConfig) throw new Error('range must be 1h, 6h, 1d, 30d, 90d, or 1y')
  const now = Math.floor(Date.now() / 1000)
  const currentBucket = Math.floor(now / intervalConfig.bucketSeconds) * intervalConfig.bucketSeconds
  const from = interval === '1y'
    ? now - intervalConfig.bucketCount * intervalConfig.bucketSeconds
    : currentBucket - (intervalConfig.bucketCount - 1) * intervalConfig.bucketSeconds
  const state = getSyncState(protocol)
  const snapshot = readLatestPoolSnapshot(protocol)
  const windowFlows = readFlows(protocol, from, now)
  const historicalFlows = snapshot ? [] : readFlows(protocol, 0, from - 1)
  const tokenPrices = prices()
  return {
    source: 'sqlite', indexedVia: protocol === 'curvy' ? 'alchemy' : 'helius',
    chain: protocolConfig.chain || 'solana', chainId: protocolConfig.chainId || null,
    protocol, protocolName: protocolConfig.name, programId: protocolConfig.programId,
    docs: protocolConfig.docs, feePolicy: protocolConfig.feePolicy, range: interval, bucketSeconds: intervalConfig.bucketSeconds,
    explorerAccount: protocolConfig.explorerAccount || `https://solscan.io/account/${protocolConfig.programId}`,
    explorerTransaction: protocolConfig.explorerTransaction || 'https://solscan.io/tx/',
    from, to: now, prices: tokenPrices, indexedAt: snapshot?.blockTime || state?.syncedThrough || null,
    coverage: {
      complete: Boolean(state?.historyComplete), historyComplete: Boolean(state?.historyComplete),
      backfilledFrom: state?.backfilledFrom ?? null, syncedThrough: state?.syncedThrough ?? null,
    },
    poolSource: snapshot ? 'stored pool snapshot' : 'indexed external flows', storage: databaseStats(protocol),
    ...aggregate(windowFlows, historicalFlows, from, intervalConfig.bucketSeconds, intervalConfig.bucketCount, snapshot?.balances, tokenPrices, now),
    recent: windowFlows.slice(0, 12),
    flowMethod: protocol === 'privacycash'
      ? 'Swaps inferred by one-to-one ephemeral-wallet links within 120 seconds.'
      : protocol === 'curvy'
        ? 'Vault deposits and withdrawals verified from Curvy events on Arbitrum; portal swaps are not inferred without a defensible link.'
        : 'Swap-outs decoded from Cloak TransactSwap instructions; output asset is read from the instruction payload.',
  }
}

const TOKEN_DECIMALS = { SOL: 9, USDC: 6, USDT: 6 }
const MAX_RECEIVERS = 50

function parseTokenAmount(value, asset, label = 'amount') {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label} must be a decimal number`)
  const text = String(value).trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`${label} must be a positive decimal number without exponent notation`)
  const decimals = TOKEN_DECIMALS[asset]
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) throw new Error(`${label} supports at most ${decimals} decimal places for ${asset}`)
  const scale = 10n ** BigInt(decimals)
  const raw = BigInt(whole) * scale + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  if (raw <= 0n) throw new Error(`${label} must be greater than zero`)
  const amount = Number(raw) / (10 ** decimals)
  if (!Number.isFinite(amount)) throw new Error(`${label} is too large`)
  return { amount, raw, normalized: `${whole}.${(fraction + '0'.repeat(decimals)).slice(0, decimals)}` }
}

function validatePlanRequest(body = {}) {
  const asset = String(body.asset || body.token || '').toUpperCase()
  if (!ASSETS.includes(asset)) throw new Error('asset must be SOL, USDC, or USDT')
  const destinationAsset = String(body.destinationAsset || body.outputAsset || asset).toUpperCase()
  if (!ASSETS.includes(destinationAsset)) throw new Error('destinationAsset must be SOL, USDC, or USDT')
  const total = parseTokenAmount(body.amount ?? body.totalAmount, asset, 'amount')
  const strategy = String(body.strategy || 'single').toLowerCase()
  if (!['single', 'multiple'].includes(strategy)) throw new Error('strategy must be single or multiple')
  const privacyTarget = String(body.privacyTarget || body.target || 'balanced').toLowerCase()
  if (!getPrivacyTarget(privacyTarget)) throw new Error('privacyTarget must be balanced, high, or maximum')
  let receivers = [total]
  if (strategy === 'multiple') {
    const values = Array.isArray(body.receiverAmounts)
      ? body.receiverAmounts
      : Array.isArray(body.receivers) ? body.receivers.map((receiver) => receiver?.amount) : []
    if (values.length < 2) throw new Error('At least two receiver amounts are required')
    if (values.length > MAX_RECEIVERS) throw new Error(`At most ${MAX_RECEIVERS} receivers are supported`)
    receivers = values.map((value, index) => parseTokenAmount(value, asset, `receiverAmounts[${index}]`))
    const receiverRaw = receivers.reduce((sum, receiver) => sum + receiver.raw, 0n)
    if (receiverRaw !== total.raw) throw new Error('Receiver amounts must equal the total amount exactly in token units')
  }
  const depositTimestamp = body.depositTimestamp == null ? null : Number(body.depositTimestamp)
  if (depositTimestamp !== null && (!Number.isFinite(depositTimestamp) || depositTimestamp < 0)) throw new Error('depositTimestamp must be a Unix timestamp in seconds')
  return { asset, destinationAsset, total, strategy, receivers, privacyTarget, depositTimestamp }
}

function publicPoolMetrics(metrics) {
  const windows = ['1m', '5m', '15m', '1h', '6h', '24h', '7d']
  return {
    provider: metrics.provider, token: metrics.token, timestamp: metrics.timestamp,
    tokenPriceUsd: metrics.tokenPriceUsd, amountUsd: metrics.amountUsd,
    availability: metrics.availability, dataAvailable: metrics.dataAvailable,
    tvl: metrics.tvl, poolBalance: metrics.poolBalance, poolSource: metrics.poolSource,
    providerTotalTvlUsd: metrics.providerTotalTvlUsd,
    activity: metrics.activity,
    ...Object.fromEntries(windows.map((window) => [`externalVolume${window}`, metrics[`externalVolume${window}`]])),
    deposits: metrics.deposits, withdrawals: metrics.withdrawals,
    swapIn: metrics.swapIn, swapOut: metrics.swapOut,
    recentTransactionCount: metrics.recentTransactionCount,
    flowRatePerMinute: metrics.flowRatePerMinute, flowRatePerHour: metrics.flowRatePerHour,
    volumeRatePerMinute: metrics.volumeRatePerMinute, volumeRatePerHour: metrics.volumeRatePerHour,
    similarFlowBuckets: metrics.similarFlowBuckets,
    weightedSimilarFlowCount: metrics.weightedSimilarFlowCount,
    weightedSimilarFlowVolume: metrics.weightedSimilarFlowVolume,
    distinctAmountCount7d: metrics.distinctAmountCount7d,
    executionLatency: metrics.executionLatency,
    flowSyncedThrough: metrics.flowSyncedThrough, flowAgeSeconds: metrics.flowAgeSeconds,
    snapshotAt: metrics.snapshotAt, snapshotAgeSeconds: metrics.snapshotAgeSeconds,
    priceAt: metrics.priceAt, priceAgeSeconds: metrics.priceAgeSeconds,
    historyComplete: metrics.historyComplete, coverageFrom: metrics.coverageFrom,
    coverage7d: metrics.coverage7d, coverageAssumption: metrics.coverageAssumption,
  }
}

function feeFor(provider, asset, amount, recipientCount, tokenPrices) {
  const fee = estimateProviderFee({ provider, token: asset, amount, recipientCount, tokenPrices })
  if (!fee.available) return { ...fee, native: null, usd: null, asset }
  return {
    ...fee,
    native: fee.total,
    usd: tokenPrices[asset] === null ? null : fee.total * tokenPrices[asset],
    asset,
    detail: fee.label,
  }
}

function commonRanking(provider, asset, metrics, estimate, fee) {
  return {
    provider, protocol: provider, protocolName: PROTOCOLS[provider].name,
    available: Boolean(estimate.available), disabled: Boolean(estimate.disabled),
    unavailableReason: estimate.unavailableReason || estimate.error || null,
    capabilities: PROVIDER_CAPABILITIES[provider],
    score: estimate.score ?? estimate.planScore ?? null,
    privacyScore: estimate.score ?? estimate.planScore ?? null,
    band: estimate.band ?? estimate.planBand ?? 'UNAVAILABLE',
    privacy: estimate.band ?? estimate.planBand ?? 'UNAVAILABLE',
    confidence: estimate.confidence ?? estimate.estimatedTimeToTarget?.confidence ?? null,
    subScores: estimate.subscores ?? null,
    poolMetrics: publicPoolMetrics(metrics),
    poolTvlUsd: metrics.tvl,
    volume24hUsd: metrics.externalVolume24h,
    volume1hUsd: metrics.externalVolume1h,
    recentTransactions: metrics.recentTransactionCount,
    poolShare: estimate.poolShare ?? null,
    coverRatio: estimate.coverRatio ?? null,
    similarFlowCount: estimate.similarFlowCount ?? null,
    weightedSimilarFlowCount: estimate.weightedSimilarFlowCount ?? null,
    noCover: Boolean(estimate.noCover),
    privacyConstraint: estimate.privacyConstraint ?? null,
    fee,
    executionLatency: metrics.executionLatency,
    executionLatencyP50: metrics.executionLatencyP50,
    executionLatencyP95: metrics.executionLatencyP95,
    notice: ESTIMATE_NOTICE,
  }
}

function singleRanking(provider, request, metrics, tokenPrices, now) {
  const input = {
    provider, token: request.asset, amountUsd: metrics.amountUsd, metrics, now,
    depositTimestamp: request.depositTimestamp ?? now, exitTimestamp: now, target: request.privacyTarget,
  }
  const estimate = calculatePrivacyEstimate(input)
  const fee = feeFor(provider, request.asset, request.total.amount, 1, tokenPrices)
  return {
    ...commonRanking(provider, request.asset, metrics, estimate, fee),
    subScores: estimate.subscores ?? null,
    depthScore: estimate.depthScore ?? null,
    coverScore: estimate.coverScore ?? null,
    similarityScore: estimate.similarityScore ?? null,
    temporalScore: estimate.temporalScore ?? null,
    activityScore: estimate.activityScore ?? null,
    uniquenessScore: estimate.uniquenessScore ?? null,
    recommendedWait: estimate.estimatedTimeToTarget ?? null,
    estimatedTimeToTarget: estimate.estimatedTimeToTarget ?? null,
    estimatedTimeToHigh: estimate.estimatedTimeToHigh ?? null,
    estimatedTimeToVeryHigh: estimate.estimatedTimeToVeryHigh ?? null,
    projectedScore: estimate.estimatedTimeToTarget?.projectedScore ?? estimate.score ?? null,
    explanations: estimate.explanations ?? [],
    timeline: estimate.estimatedTimeToTarget?.timeline ?? [],
  }
}

function multiRanking(provider, request, metrics, tokenPrices, now) {
  const fee = feeFor(provider, request.asset, request.total.amount, request.receivers.length, tokenPrices)
  const amountUsd = metrics.amountUsd
  const receiverAmounts = request.receivers.map(({ amount }) => amount)
  const receiverAmountsUsd = metrics.tokenPriceUsd === null ? [] : receiverAmounts.map((amount) => amount * metrics.tokenPriceUsd)
  const base = {
    provider, token: request.asset, totalAmount: request.total.amount, receiverAmounts, receiverAmountsUsd,
    tokenPrices, metrics, now, depositTimestamp: request.depositTimestamp ?? now, exitTimestamp: now,
  }
  const selected = estimateMultiReceiverPlan({ ...base, target: request.privacyTarget })
  if (!selected.available) return {
    ...commonRanking(provider, request.asset, metrics, selected, fee),
    receiverEstimates: selected.receiverEstimates ?? [],
    coordinationPenalty: selected.coordinationPenalty ?? null,
    coordinationRisk: selected.coordinationPenalty?.band ?? null,
    explanations: selected.error ? [{ impact: 'negative', metric: 'availability', message: selected.error }] : [],
  }
  const high = request.privacyTarget === 'high' ? selected : estimateMultiReceiverPlan({ ...base, target: 'high' })
  const maximum = request.privacyTarget === 'maximum' ? selected : estimateMultiReceiverPlan({ ...base, target: 'maximum' })
  const impact = calculatePrivacyEstimate({
    provider, token: request.asset, amountUsd, metrics, now,
    depositTimestamp: request.depositTimestamp ?? now, exitTimestamp: now, target: request.privacyTarget,
  }, { includeEta: false })
  const weakest = selected.receiverEstimates.reduce((current, receiver) => !current || receiver.estimate.score < current.estimate.score ? receiver : current, null)
  const explanations = [
    ...(weakest?.estimate?.explanations ?? []),
    { impact: selected.coordinationPenalty.total >= 12 ? 'negative' : 'neutral', metric: 'coordination risk', message: selected.coordinationPenalty.explanation },
  ]
  return {
    ...commonRanking(provider, request.asset, metrics, selected, fee),
    score: selected.planScore, privacyScore: selected.planScore, band: selected.planBand, privacy: selected.planBand,
    confidence: selected.estimatedTimeToTarget?.confidence ?? weakest?.estimate?.confidence ?? null,
    poolShare: impact.poolShare ?? null,
    coverRatio: impact.coverRatio ?? null,
    similarFlowCount: impact.similarFlowCount ?? null,
    weightedSimilarFlowCount: impact.weightedSimilarFlowCount ?? null,
    subScores: weakest?.estimate?.subscores ?? null,
    receiverEstimates: selected.receiverEstimates,
    coordinationPenalty: selected.coordinationPenalty,
    coordinationRisk: selected.coordinationPenalty.band,
    recommendedWait: selected.estimatedTimeToTarget,
    estimatedTimeToTarget: selected.estimatedTimeToTarget,
    estimatedTimeToHigh: high.estimatedTimeToTarget ?? null,
    estimatedTimeToVeryHigh: maximum.estimatedTimeToTarget ?? null,
    projectedScore: selected.estimatedTimeToTarget?.projectedScore ?? selected.planScore,
    explanations,
    timeline: selected.estimatedTimeToTarget?.timeline ?? [],
  }
}

function planningResult(body) {
  const request = validatePlanRequest(body)
  const now = Math.floor(Date.now() / 1000)
  const tokenPrices = prices()
  const rankings = Object.keys(PROTOCOLS).map((provider) => {
    const metrics = buildPlanningMetrics(provider, request.asset, request.total.amount, now)
    const ranking = request.strategy === 'multiple'
      ? multiRanking(provider, request, metrics, tokenPrices, now)
      : singleRanking(provider, request, metrics, tokenPrices, now)
    if (request.destinationAsset === request.asset) return ranking
    const route = swapEligibility(provider, request.asset, request.destinationAsset)
    return {
      ...ranking,
      available: ranking.available && route.available,
      disabled: ranking.disabled || !route.available,
      unavailableReason: !route.available ? route.reason : ranking.unavailableReason,
      swapRoute: {
        inputAsset: request.asset,
        outputAsset: request.destinationAsset,
        aggregator: PROVIDER_CAPABILITIES[provider].swapAggregator,
        execution: route.capability?.execution || 'unavailable',
      },
    }
  })
  const target = getPrivacyTarget(request.privacyTarget)
  rankings.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1
    const aReached = a.available && a.score >= target.score
    const bReached = b.available && b.score >= target.score
    if (aReached !== bReached) return aReached ? -1 : 1
    const aWait = a.estimatedTimeToTarget?.seconds
    const bWait = b.estimatedTimeToTarget?.seconds
    if (aWait != null && bWait != null && aWait !== bWait) return aWait - bWait
    if ((b.score ?? -1) !== (a.score ?? -1)) return (b.score ?? -1) - (a.score ?? -1)
    return (a.fee?.usd ?? Number.POSITIVE_INFINITY) - (b.fee?.usd ?? Number.POSITIVE_INFINITY)
  })
  return {
    source: 'sqlite', indexedVia: ['helius', 'alchemy'], methodologyVersion: 'privacy-planner-v1', computedAt: now,
    disclaimer: ESTIMATE_NOTICE, asset: request.asset, destinationAsset: request.destinationAsset,
    kind: request.asset === request.destinationAsset ? 'transfer' : 'swap', amount: request.total.amount,
    strategy: request.strategy, receiverAmounts: request.receivers.map(({ amount }) => amount),
    privacyTarget: request.privacyTarget, targetScore: target.score,
    decisionRule: 'Estimated target attainment and wait first; current score and estimated fee break close ties.',
    winner: rankings.find(({ available }) => available)?.protocol ?? null,
    rankings,
  }
}

const app = express()
app.use(express.json({ limit: '32kb' }))
const SWAP_MINTS = Object.freeze({
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
})
app.get('/api/swap-quote', async (request, response) => {
  try {
    const inputAsset = String(request.query.inputAsset || '').toUpperCase()
    const outputAsset = String(request.query.outputAsset || '').toUpperCase()
    const amount = String(request.query.amount || '')
    if (inputAsset !== 'SOL' || !['USDC', 'USDT'].includes(outputAsset)) throw new Error('Only CLOAKC SOL to USDC/USDT quotes are supported')
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error('amount must be positive integer base units')
    const url = new URL('https://lite-api.jup.ag/swap/v1/quote')
    url.search = new URLSearchParams({
      inputMint: SWAP_MINTS[inputAsset], outputMint: SWAP_MINTS[outputAsset], amount,
      slippageBps: '100', restrictIntermediateTokens: 'true',
    }).toString()
    const quoteResponse = await fetch(url)
    if (!quoteResponse.ok) throw new Error(`Jupiter quote failed with HTTP ${quoteResponse.status}`)
    const quote = await quoteResponse.json()
    if (quote.inputMint !== SWAP_MINTS[inputAsset] || quote.outputMint !== SWAP_MINTS[outputAsset]
      || quote.inAmount !== amount || !/^\d+$/.test(quote.outAmount || '') || !/^\d+$/.test(quote.otherAmountThreshold || '')) {
      throw new Error('Jupiter returned a quote for an unexpected route or amount')
    }
    response.json({
      inputAsset, outputAsset, inputBaseUnits: quote.inAmount,
      expectedOutputBaseUnits: quote.outAmount, minimumOutputBaseUnits: quote.otherAmountThreshold,
      priceImpactPct: quote.priceImpactPct, routeLabels: quote.routePlan?.map((leg) => leg.swapInfo?.label).filter(Boolean) || [],
    })
  } catch (error) {
    response.status(400).json({ error: 'Unable to quote swap', detail: error.message })
  }
})
const SOLANA_RPC_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption',
  'getMultipleAccounts', 'getSignatureStatuses', 'getTokenAccountBalance', 'getTokenAccountsByOwner',
])
app.post('/api/solana-rpc', async (request, response) => {
  const calls = Array.isArray(request.body) ? request.body : [request.body]
  if (!calls.length || calls.length > 20 || calls.some((call) => !call || !SOLANA_RPC_METHODS.has(call.method))) {
    return response.status(400).json({ error: 'Unsupported Solana RPC request' })
  }
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
  try {
    const upstream = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(25_000),
    })
    const body = await upstream.text()
    response.status(upstream.status).type('application/json').send(body)
  } catch (error) {
    response.status(502).json({ jsonrpc: '2.0', id: request.body?.id ?? null, error: { code: -32000, message: `Solana RPC unavailable: ${error.message}` } })
  }
})
app.get('/api/health', (_request, response) => response.json({ ok: true, source: 'sqlite', protocols: Object.values(PROTOCOLS).map(({ id, name, programId, chain = 'solana', chainId = null }) => ({ id, name, programId, chain, chainId })) }))
app.get('/api/analytics', (request, response) => {
  try { response.json(analytics(String(request.query.protocol || 'cloakc').toLowerCase(), String(request.query.interval || '1h').toLowerCase())) }
  catch (error) { response.status(400).json({ error: 'Unable to read analytics', detail: error.message }) }
})
app.get('/api/compare', (request, response) => {
  try { response.json(planningResult({ asset: request.query.asset || 'USDC', amount: request.query.amount || '10000', strategy: 'single', privacyTarget: request.query.privacyTarget || 'balanced' })) }
  catch (error) { response.status(400).json({ error: 'Unable to compare pools', detail: error.message }) }
})
app.post('/api/plan', (request, response) => {
  try { response.json(planningResult(request.body)) }
  catch (error) { response.status(400).json({ error: 'Unable to build privacy plan', detail: error.message }) }
})

const dist = resolve(root, 'dist')
if (existsSync(dist)) { app.use(express.static(dist)); app.get('*path', (_request, response) => response.sendFile(resolve(dist, 'index.html'))) }
const port = Number(process.env.PORT || 8787)
app.listen(port, '127.0.0.1', () => console.log(`Dashboard API reading SQLite on http://127.0.0.1:${port}`))
