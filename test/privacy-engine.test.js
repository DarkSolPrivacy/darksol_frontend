import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROVIDER_CAPABILITIES,
  calculatePrivacyEstimate,
  estimateMultiReceiverPlan,
  estimateProviderFee,
  simulatePrivacyEta,
} from '../server/privacy-engine.js'

const NOW = 1_750_000_000

function flows(amounts, { hours = 24, type = 'WITHDRAW', start = NOW - 23 * 3600 } = {}) {
  return amounts.map((amount, index) => ({
    amount,
    timestamp: start + Math.floor(index * hours * 3600 / Math.max(1, amounts.length)),
    type,
    signature: `tx-${amount}-${index}`,
  }))
}

function metrics({
  tvl = 2_000_000,
  volume1h = 100_000,
  volume6h = 600_000,
  volume24h = 2_000_000,
  recentFlows = [],
  recentTransactionCount = recentFlows.length,
} = {}) {
  return {
    provider: 'privacycash', token: 'USDC', timestamp: NOW, historySeconds: 30 * 86400, tvl,
    externalVolume1m: volume1h / 60,
    externalVolume5m: volume1h / 12,
    externalVolume15m: volume1h / 4,
    externalVolume1h: volume1h,
    externalVolume6h: volume6h,
    externalVolume24h: volume24h,
    externalVolume7d: volume24h * 7,
    recentTransactionCount,
    recentFlows,
  }
}

test('A: small transfer, high activity, and many comparable flows estimates HIGH privacy', () => {
  const recentFlows = flows(Array.from({ length: 80 }, (_, index) => 340 + index * 2))
  const estimate = calculatePrivacyEstimate({
    provider: 'privacycash', token: 'USDC', amount: 400, now: NOW,
    depositTimestamp: NOW - 6 * 3600,
    metrics: metrics({ volume1h: 150_000, volume6h: 900_000, volume24h: 3_000_000, recentFlows, recentTransactionCount: 500 }),
  }, { includeEta: false })
  assert.equal(estimate.available, true)
  assert.match(estimate.label, /Estimated privacy/)
  assert.equal(estimate.band === 'HIGH' || estimate.band === 'VERY HIGH', true)
  assert.ok(estimate.weightedSimilarFlowCount > 20)
})

test('B: 20% pool share, low activity, no comparable flows, and immediate exit is LOW or VERY LOW', () => {
  const recentFlows = flows([100, 120, 80, 140, 90])
  const estimate = calculatePrivacyEstimate({
    provider: 'privacycash', token: 'USDC', amount: 400_000, now: NOW, depositTimestamp: NOW,
    metrics: metrics({ tvl: 2_000_000, volume1h: 25_000, volume6h: 50_000, volume24h: 100_000, recentFlows, recentTransactionCount: 5 }),
  }, { includeEta: false })
  assert.ok(['LOW', 'VERY LOW'].includes(estimate.band))
  assert.equal(estimate.similarFlowCount, 0)
  assert.ok(estimate.depthScore < 30)
})

test('C: four immediate equal exits with little surrounding activity do not become HIGH', () => {
  const recentFlows = flows([75, 100, 125, 150])
  const plan = estimateMultiReceiverPlan({
    provider: 'privacycash', token: 'USDC', totalAmount: 400_000,
    receiverAmounts: [100_000, 100_000, 100_000, 100_000], receiverDelaysMinutes: [0, 0.25, 0.5, 0.75],
    now: NOW, depositTimestamp: NOW,
    metrics: metrics({ tvl: 2_000_000, volume1h: 25_000, volume6h: 50_000, volume24h: 120_000, recentFlows, recentTransactionCount: 4 }),
    tokenPrices: { SOL: 100, USDC: 1 },
  }, { eta: { maxHorizonMinutes: 60 } })
  assert.equal(plan.available, true)
  assert.ok(plan.planScore < 75)
  assert.notEqual(plan.planBand, 'HIGH')
  assert.equal(plan.coordinationPenalty.band, 'HIGH')
})

test('D: multiple staggered exits gain privacy only when depth and comparable independent activity support them', () => {
  const recentFlows = flows(Array.from({ length: 100 }, (_, index) => 75_000 + (index % 25) * 2_000))
  const plan = estimateMultiReceiverPlan({
    provider: 'privacycash', token: 'USDC', totalAmount: 400_000,
    receiverAmounts: [120_000, 95_000, 105_000, 80_000], receiverDelaysMinutes: [180, 240, 315, 420],
    now: NOW, depositTimestamp: NOW - 6 * 3600,
    metrics: metrics({ tvl: 20_000_000, volume1h: 2_000_000, volume6h: 8_000_000, volume24h: 25_000_000, recentFlows, recentTransactionCount: 800 }),
    tokenPrices: { SOL: 100, USDC: 1 },
  }, { eta: { maxHorizonMinutes: 60 } })
  assert.equal(plan.available, true)
  assert.ok(plan.planScore >= 75, `expected HIGH plan, received ${plan.planScore}`)
  assert.ok(['HIGH', 'VERY HIGH'].includes(plan.planBand))
  assert.equal(plan.coordinationPenalty.band, 'LOW')
})

test('E: Cloak remains visible but disabled for a multi-receiver plan', () => {
  assert.equal(PROVIDER_CAPABILITIES.cloakc.supportsMultiRecipient, false)
  assert.equal(PROVIDER_CAPABILITIES.cloakc.maxRecipients, 1)
  const plan = estimateMultiReceiverPlan({
    provider: 'cloakc', token: 'USDC', totalAmount: 400, receiverAmounts: [200, 200],
  })
  assert.equal(plan.disabled, true)
  assert.equal(plan.available, false)
  assert.equal(plan.reason, 'Multiple-recipient withdrawal is not currently supported by this provider.')
})

test('F: PrivacyCash supports multiple receivers and its fixed fee is charged per recipient', () => {
  const recentFlows = flows(Array.from({ length: 30 }, (_, index) => 80 + index))
  const plan = estimateMultiReceiverPlan({
    provider: 'privacycash', token: 'USDC', totalAmount: 400, receiverAmounts: [100, 100, 100, 100],
    now: NOW, depositTimestamp: NOW - 3600,
    metrics: metrics({ recentFlows, recentTransactionCount: 100 }),
    tokenPrices: { SOL: 100, USDC: 1 },
  }, { eta: { maxHorizonMinutes: 1 } })
  assert.equal(PROVIDER_CAPABILITIES.privacycash.supportsMultiRecipient, true)
  assert.equal(plan.disabled, false)
  assert.equal(plan.fee.available, true)
  assert.equal(plan.fee.components.fixedBasis, 'recipient')
  assert.equal(plan.fee.components.fixedUnits, 4)
  assert.equal(plan.fee.components.fixedFee, 2.4)
  assert.equal(plan.fee.total, 3.8)
  assert.equal(plan.receiverEstimates.every((receiver) => Object.hasOwn(receiver.estimatedTimeToTarget, 'seconds')), true)
})

function fiveTimesCoverEstimates() {
  const tiny = flows(Array.from({ length: 100 }, (_, index) => 75 + index))
  const comparable = flows(Array.from({ length: 30 }, (_, index) => 250_000 + (index % 15) * 16_000))
  const common = { provider: 'privacycash', token: 'USDC', amount: 400_000, now: NOW, depositTimestamp: NOW - 3600 }
  const tinyEstimate = calculatePrivacyEstimate({
    ...common,
    metrics: metrics({ tvl: 2_000_000, volume1h: 250_000, volume6h: 900_000, volume24h: 2_000_000, recentFlows: tiny, recentTransactionCount: 100 }),
  }, { includeEta: false })
  const comparableEstimate = calculatePrivacyEstimate({
    ...common,
    metrics: metrics({ tvl: 2_000_000, volume1h: 250_000, volume6h: 900_000, volume24h: 2_000_000, recentFlows: comparable, recentTransactionCount: 100 }),
  }, { includeEta: false })
  return { tinyEstimate, comparableEstimate }
}

test('G: 5x volume made exclusively of tiny unrelated flows is not automatically HIGH', () => {
  const { tinyEstimate } = fiveTimesCoverEstimates()
  assert.equal(tinyEstimate.coverRatio, 5)
  assert.equal(tinyEstimate.band === 'HIGH' || tinyEstimate.band === 'VERY HIGH', false)
  assert.equal(tinyEstimate.similarFlowCount, 0)
})

test('H: 5x volume with many comparable independent flows scores substantially higher', () => {
  const { tinyEstimate, comparableEstimate } = fiveTimesCoverEstimates()
  assert.ok(comparableEstimate.score >= tinyEstimate.score + 20, `${comparableEstimate.score} should substantially exceed ${tinyEstimate.score}`)
  assert.ok(comparableEstimate.similarityScore > tinyEstimate.similarityScore)
})

test('I: an immediate transfer larger than the same-asset pool is explicitly NOT PRIVATE', () => {
  const estimate = calculatePrivacyEstimate({
    provider: 'privacycash', token: 'USDC', amount: 10_000, now: NOW, depositTimestamp: NOW,
    metrics: metrics({ tvl: 100, volume1h: 10, volume6h: 50, volume24h: 100, recentFlows: flows([10, 20]), recentTransactionCount: 2 }),
  }, { includeEta: false })
  assert.equal(estimate.available, true)
  assert.equal(estimate.score, 0)
  assert.equal(estimate.band, 'NOT PRIVATE')
  assert.equal(estimate.noCover, true)
  assert.equal(estimate.privacyConstraint.code, 'NO_COVER')
})

test('J: simultaneous split outputs cannot bypass the no-cover constraint', () => {
  const plan = estimateMultiReceiverPlan({
    provider: 'privacycash', token: 'USDC', totalAmount: 10_000,
    receiverAmounts: [5_000, 5_000], receiverDelaysMinutes: [0, 0],
    now: NOW, depositTimestamp: NOW,
    metrics: metrics({ tvl: 100, volume1h: 10, volume6h: 50, volume24h: 100, recentFlows: flows([10, 20]), recentTransactionCount: 2 }),
    tokenPrices: { USDC: 1, SOL: 100 },
  }, { eta: { maxHorizonMinutes: 1 } })
  assert.equal(plan.planScore, 0)
  assert.equal(plan.planBand, 'NOT PRIVATE')
  assert.equal(plan.noCover, true)
})

test('ETA is explicitly historical, confidence-labelled, and unavailable without activity', () => {
  const noActivity = metrics({ volume1h: 0, volume6h: 0, volume24h: 0, recentFlows: [], recentTransactionCount: 0 })
  const eta = simulatePrivacyEta({ provider: 'privacycash', token: 'USDC', amount: 10_000, now: NOW, metrics: noActivity }, 'high')
  assert.equal(eta.status, 'insufficient_activity')
  assert.equal(eta.seconds, null)
  assert.match(eta.display, /Not enough activity/)
  assert.match(eta.notice, /not guaranteed/i)
  assert.ok(eta.confidence.band)
})

test('Curvy is configured for Arbitrum and uses the documented aggregation plus unshielding fee', () => {
  assert.equal(PROVIDER_CAPABILITIES.curvy.network, 'Arbitrum One')
  assert.equal(PROVIDER_CAPABILITIES.curvy.swapAggregator, 'LiFi')
  assert.equal(PROVIDER_CAPABILITIES.curvy.supportsMultiRecipient, false)
  const fee = estimateProviderFee({ provider: 'curvy', token: 'USDC', amount: 10_000 })
  assert.equal(fee.available, true)
  assert.equal(fee.components.variableRate, 0.003)
  assert.equal(fee.total, 30)
})
