import assert from 'node:assert/strict'
import test from 'node:test'
import { exclusive, maxPayable, planShieldedSend, planWithdrawals, withdrawalCapacity, withdrawalFee } from '../protocols/privacycash/browser.js'
import { withdrawalFor } from '../protocols/shared/units.js'

// SOL sent to a recipient for network fees: `net` must still arrive after the
// pool's cut, from the smallest withdrawal that does it, never below the minimum.
test('a withdrawal sized for SOL fees delivers what was asked at the least cost', () => {
  const terms = { rate: 0.0035, fixed: 6_000_000n, minimum: 10_000_000n }
  const privacyCash = (units) => withdrawalFee(terms, units)
  const cloak = (units) => 5_000_000n + units * 3n / 1000n
  for (const fee of [privacyCash, cloak]) {
    const units = withdrawalFor(5_000_000n, fee)
    assert.ok(units - fee(units) >= 5_000_000n)
    assert.ok(units - 1n - fee(units - 1n) < 5_000_000n)
  }
  assert.equal(withdrawalFor(5_000_000n, privacyCash, terms.minimum), 11_038_635n)
  assert.equal(withdrawalFor(1_000_000n, privacyCash, terms.minimum), terms.minimum)
})

// PrivacyCash's withdraw spends the two largest notes and, when they fall short,
// pays out what they hold instead of failing. No single withdrawal may ask for
// more than this, or the recipient silently gets less.
test('one withdrawal can send at most the two largest notes', () => {
  assert.equal(withdrawalCapacity([5n, 3n, 2n]), 8n)
  assert.equal(withdrawalCapacity([4n]), 4n)
  assert.equal(withdrawalCapacity([]), 0n)
})

// A larger payment goes out as consecutive withdrawals, each within that limit.
test('a payment above the two largest notes is planned as several withdrawals', () => {
  assert.deepEqual(planWithdrawals([50n, 30n, 20n], [40n], 10n), [[40n]])
  assert.deepEqual(planWithdrawals([30n, 20n, 50n], [100n], 10n), [[80n, 20n]])
  // The change of one withdrawal is a note the next can spend.
  assert.deepEqual(planWithdrawals([50n, 30n, 20n], [60n, 40n], 10n), [[60n], [40n]])
  assert.equal(planWithdrawals([50n, 30n, 20n], [101n], 10n), null)
})

// The relayer refuses a withdrawal under its minimum, so no piece may fall below it.
test('no planned withdrawal is below the minimum', () => {
  // 85 from notes 50, 30, 5 with a minimum of 20: 80 then 5 would strand 5, so the
  // first withdrawal leaves 20 as change for the second.
  assert.deepEqual(planWithdrawals([50n, 30n, 5n], [85n], 20n), [[65n, 20n]])
  assert.equal(planWithdrawals([50n, 30n], [15n], 20n), null)
  for (const withdrawals of planWithdrawals([50n, 5n, 5n], [60n], 20n)) assert.ok(withdrawals.every((units) => units >= 20n))
})

test('the most a shielded payment can send leaves out only unusable dust', () => {
  assert.equal(maxPayable([50n, 30n, 5n], 20n), 85n)
  assert.equal(maxPayable([5n, 5n], 20n), 0n)
  const reading = { notes: { USDC: [5000n, 3000n, 2000n] }, terms: { USDC: { rate: 0.01, fixed: 20n, minimum: 100n } } }
  // Two withdrawals of 8000 and 2000, each paying 1% plus the fixed 20: 100 + 40.
  assert.deepEqual(planShieldedSend(reading, 'USDC', [10000n]), { withdrawals: 2, fee: 140n, minimum: 100n })
  assert.equal(planShieldedSend(reading, 'USDC', [10001n]), null)
})

// A balance read and a send share the SDK's scan state, so they must not overlap,
// and one that fails must not block the next.
test('note reads and sends run one at a time, past failures', async () => {
  const events = []
  const task = (name, ms, fail) => () => new Promise((resolve, reject) => {
    events.push(`${name} start`)
    setTimeout(() => { events.push(`${name} end`); fail ? reject(new Error(name)) : resolve(name) }, ms)
  })
  const results = await Promise.allSettled([exclusive(task('scan', 20)), exclusive(task('send', 5, true)), exclusive(task('rescan', 1))])
  assert.deepEqual(events, ['scan start', 'scan end', 'send start', 'send end', 'rescan start', 'rescan end'])
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled'])
})
