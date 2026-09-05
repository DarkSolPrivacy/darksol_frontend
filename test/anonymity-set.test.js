import assert from 'node:assert/strict'
import test from 'node:test'
import { calculatePrivacyEstimate } from '../server/privacy-engine.js'

const NOW = 1_750_000_000

// A deep pool with plenty of comparable cover, so any change in the result comes
// from the anonymity set rather than from the value-based signals.
const flows = Array.from({ length: 80 }, (_, index) => ({
  amount: 340 + index * 2,
  timestamp: NOW - 23 * 3600 + index * 1000,
  type: 'WITHDRAW',
  signature: `tx-${index}`,
}))

function metrics(anonymitySet) {
  return {
    provider: 'umbra', token: 'USDC', timestamp: NOW, historySeconds: 30 * 86400, tvl: 2_000_000,
    externalVolume1m: 2_500, externalVolume5m: 12_500, externalVolume15m: 37_500,
    externalVolume1h: 150_000, externalVolume6h: 900_000, externalVolume24h: 3_000_000,
    externalVolume7d: 21_000_000,
    recentTransactionCount: 500, recentFlows: flows,
    ...(anonymitySet === undefined ? {} : { anonymitySet }),
  }
}

const estimate = (anonymitySet, overrides) => calculatePrivacyEstimate({
  provider: 'umbra', token: 'USDC', amount: 400, now: NOW,
  depositTimestamp: NOW - 6 * 3600,
  metrics: metrics(anonymitySet),
}, { includeEta: false, ...overrides })

test('a pool that publishes no anonymity set is scored exactly as before', () => {
  const without = estimate(undefined)
  const explicitNull = estimate(null)
  assert.equal(without.available, true)
  assert.equal(without.anonymitySetSize, null)
  assert.equal(without.thinAnonymitySet, false)
  assert.equal(without.privacyConstraint, null)
  // The three protocols that cannot report this must be unaffected.
  assert.equal(without.score, explicitNull.score)
  assert.equal(without.band, explicitNull.band)
})

test('a healthy anonymity set is reported without changing the score', () => {
  const without = estimate(undefined)
  const withSet = estimate({ size: 7708, source: 'umbra indexer /v1/stats' })
  assert.equal(withSet.anonymitySetSize, 7708)
  assert.equal(withSet.anonymitySetSource, 'umbra indexer /v1/stats')
  assert.equal(withSet.thinAnonymitySet, false)
  // Deliberately unweighted: reporting it must not move the number, or the
  // ranking would tilt toward whichever provider happens to publish it.
  assert.equal(withSet.score, without.score)
  assert.equal(withSet.band, without.band)
  assert.ok(withSet.explanations.some((entry) => entry.metric === 'anonymity set'))
})

test('a set below the floor is NOT PRIVATE regardless of value cover', () => {
  const thin = estimate({ size: 12, source: 'umbra indexer /v1/stats' })
  assert.equal(thin.thinAnonymitySet, true)
  assert.equal(thin.band, 'NOT PRIVATE')
  assert.equal(thin.score, 0)
  assert.equal(thin.privacyConstraint.code, 'THIN_ANONYMITY_SET')
  assert.match(thin.privacyConstraint.message, /12 notes/)
  // The pool is deep in value terms; only the set size makes it unusable, which
  // is the whole point of keeping this separate from the weighted score.
  assert.ok(thin.depthScore > 50, 'value depth should still be healthy')
})

test('the floor is configurable rather than baked-in policy', () => {
  assert.equal(estimate({ size: 200, source: 'test' }).thinAnonymitySet, false)
  const strict = estimate({ size: 200, source: 'test' }, { anonymitySet: { minimumSet: 500 } })
  assert.equal(strict.thinAnonymitySet, true)
  assert.equal(strict.band, 'NOT PRIVATE')
})

test('a malformed anonymity set is ignored rather than trusted', () => {
  for (const bad of [{ size: 'many' }, { size: NaN }, {}, { size: undefined }]) {
    const result = estimate(bad)
    assert.equal(result.anonymitySetSize, null, `${JSON.stringify(bad)} should be ignored`)
    assert.equal(result.thinAnonymitySet, false)
  }
})
