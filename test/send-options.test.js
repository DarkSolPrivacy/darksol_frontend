import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, MIN_SENDS, bucketFor, effectiveSettings, measuredPrivacy, meterLevel, poolFee, popularDeposit, sendOptions, withSimulation } from '../src/send-options.js'

const USDC = (value) => BigInt(Math.round(value * 1e6))
const prices = { USDC: 1, USDT: 1, SOL: 100 }
const cell = (strategy, wait, bucket, sends, traced) => ({ strategy, wait, bucket, planned: sends, sends, traced })
const buckets = ['1-10', '10-100', '100-1000', '1000-10000']
// Shaped like the simulation's USDC results: an exact send is always traced;
// keeping part shielded and waiting a day hides it well only in Privacy Cash.
const quote = {
  asset: 'USDC', buckets,
  pools: {
    privacycash: {
      cells: ['1-10', '10-100'].flatMap((bucket) => [
        cell('exact', 'now', bucket, 30, 30), cell('keep', '6h', bucket, 28, 14), cell('keep', '24h', bucket, 28, 1), cell('balance', 'now', bucket, 30, 0),
      ]),
      popular: [{ amount: '25000000', deposits: 40 }, { amount: '20000000', deposits: 30 }, { amount: '2000000', deposits: 12 }],
    },
    umbrav2: { cells: ['1-10', '10-100'].flatMap((bucket) => [cell('exact', 'now', bucket, 30, 30), cell('keep', '24h', bucket, 12, 9)]), popular: [] },
    cloakc: { cells: ['1-10', '10-100'].flatMap((bucket) => [cell('exact', 'now', bucket, 30, 30)]), popular: [] },
  },
}
const options = (amount, extra = {}) => sendOptions({ quote, asset: 'USDC', raw: USDC(amount), prices, ...extra })

test('fees, meter steps, buckets and the copied deposit', () => {
  // 0.35% + 0.006 SOL at $100.
  assert.equal(poolFee('privacycash', 'USDC', USDC(19.28), prices), 667_480n)
  // Cloak's USDC pool: 0.125% + 0.45 USDC since 2026-11-05.
  assert.equal(poolFee('cloakc', 'USDC', USDC(19.28), prices), 474_100n)
  assert.equal(poolFee('cloakc', 'SOL', 10n ** 9n, prices), 8_000_000n)
  assert.equal(poolFee('umbrav2', 'USDC', USDC(19.28), prices), 19_280n)
  assert.equal(poolFee('privacycash', 'USDC', USDC(19.28), { USDC: 1 }), null)
  // Never 0 from a measurement: the pool alone leaves no proof it is the same money.
  assert.deepEqual([96, 48, 19, 0].map(meterLevel), [5, 2, 1, 1])
  assert.equal(bucketFor(19.28, buckets), '10-100')
  assert.equal(bucketFor(0.5, buckets), '1-10')
  assert.equal(bucketFor(50_000, buckets), '1000-10000')
  assert.equal(popularDeposit(quote.pools.privacycash.popular, USDC(19.28)), USDC(25))
  assert.equal(popularDeposit(quote.pools.privacycash.popular, USDC(18)), USDC(25))
  assert.equal(popularDeposit(quote.pools.privacycash.popular, USDC(30)), null)
})

test('new money: deposit a common amount, keep the rest, send in a day; the plain send is the cheapest pool now', () => {
  const result = options(19.28)
  assert.equal(result.suggested.id, 'privacycash:later:24h')
  assert.equal(result.suggested.score, 96)
  assert.equal(result.suggested.deposit, USDC(25))
  assert.equal(result.suggested.kept, USDC(5.72))
  assert.equal(result.asTyped.id, 'umbrav2:now:now')
  assert.equal(result.asTyped.score, 0)
  // Umbra v2's keep cell has too few sends, and Umbra v2 cannot keep change anyway.
  assert.ok(!result.options.some((option) => option.id.startsWith('umbrav2:later')))
  // The fastest really private one: a day's wait in Privacy Cash.
  assert.equal(result.fastest.id, 'privacycash:later:24h')
})

test('priorities: time sends now in the cheapest pool, fees takes the cheapest option', () => {
  const custom = (priority) => ({ ...DEFAULT_SETTINGS, mode: 'custom', priority })
  assert.equal(options(19.28, { settings: custom('time') }).suggested.id, 'umbrav2:now:now')
  assert.equal(options(19.28, { settings: custom('fees') }).suggested.id, 'umbrav2:now:now')
  assert.equal(options(19.28, { settings: custom('privacy') }).suggested.id, 'privacycash:later:24h')
  assert.equal(options(19.28, { settings: { ...custom('privacy'), maxWait: '6h' } }).suggested.id, 'privacycash:later:6h')
  assert.equal(options(19.28, { settings: { ...custom('privacy'), pools: { privacycash: false } } }).suggested.id, 'umbrav2:now:now')
  // Why the suggestion leads.
  assert.equal(options(19.28).reason, 'privacy')
  assert.equal(options(19.28, { settings: custom('time') }).reason, 'time')
  assert.equal(options(19.28, { settings: custom('fees') }).reason, 'fees')
  assert.equal(options(1).reason, 'fees')
  // Auto ignores the custom choices.
  assert.equal(effectiveSettings({ mode: 'auto', priority: 'fees', maxWait: 'now' }).priority, 'auto')
})

test('once two waits show the same meter step at the same fee, the sooner one is suggested', () => {
  // 90 USDC: 6 h scores 90 and 24 h 97, both 5 of 5; less the fee, 6 h ranked a step lower.
  const both = { ...quote, pools: { privacycash: { cells: [cell('exact', 'now', '10-100', 30, 30), cell('exact', '6h', '10-100', 30, 3), cell('exact', '24h', '10-100', 30, 1)], popular: [] } } }
  const result = sendOptions({ quote: both, asset: 'USDC', raw: USDC(90), prices })
  assert.deepEqual(result.options.filter((option) => option.kind === 'later').map((option) => option.level), [5, 5])
  assert.equal(result.suggested.id, 'privacycash:later:6h')
  assert.equal(result.options[0], result.suggested)
})

test('a fee that is most of a small payment outweighs the wait', () => {
  // $1.50: Privacy Cash's fee is half the payment, yet a day's wait still wins a step.
  assert.equal(options(1.5).suggested.id, 'privacycash:later:24h')
  // $1: its fee is three quarters of the payment; every option is on the lowest step, so the cheapest wins.
  assert.equal(options(1).suggested.id, 'umbrav2:now:now')
})

test('without the top-up every option deposits only what is sent; with it, now and the waits deposit the common amount', () => {
  const plain = options(19.28, { topUp: false })
  assert.ok(plain.options.every((option) => option.kind === 'balance' || option.deposit === USDC(19.28)))
  assert.equal(plain.suggested.id, 'umbrav2:now:now')
  const more = options(19.28)
  assert.ok(more.options.filter((option) => option.protocol === 'privacycash').every((option) => option.deposit === USDC(25)))
})

test('keep nothing in pools deposits only what is sent', () => {
  const result = options(19.28, { settings: { ...DEFAULT_SETTINGS, keepNothing: true } })
  assert.ok(!result.options.some((option) => option.kept > 0n))
  assert.equal(result.suggested.id, 'umbrav2:now:now')
})

test('a shielded balance that covers the payment is the suggestion, with no new deposit', () => {
  const result = options(19.28, { shielded: { privacycash: USDC(50) } })
  assert.equal(result.suggested.id, 'privacycash:balance:now')
  assert.equal(result.suggested.score, 100)
  assert.equal(result.suggested.deposit, 0n)
  assert.equal(result.suggested.balanceAfter, USDC(30.72))
  // Too small a balance offers nothing from it.
  assert.ok(!options(19.28, { shielded: { privacycash: USDC(10) } }).options.some((option) => option.kind === 'balance'))
})

test('a pool that paused deposits still shows its deposits, unpickable, and can pay from a balance', () => {
  const result = options(19.28, { shielded: { privacycash: USDC(50) }, paused: { privacycash: 'Deposits temporarily paused' } })
  const deposits = result.options.filter((option) => option.protocol === 'privacycash' && option.kind !== 'balance')
  assert.ok(deposits.length && deposits.every((option) => !option.executable && option.paused === 'Deposits temporarily paused'))
  assert.equal(result.suggested.id, 'privacycash:balance:now')
  assert.notEqual(options(19.28, { paused: { privacycash: 'Paused' } }).suggested?.protocol, 'privacycash')
})

test('options need enough measured sends and a pool that can run here', () => {
  const thin = { ...quote, pools: { privacycash: { cells: [cell('exact', 'now', '10-100', MIN_SENDS - 1, 5)], popular: [] } } }
  assert.equal(sendOptions({ quote: thin, asset: 'USDC', raw: USDC(19.28), prices }).suggested, null)
  // Below Cloak's minimum deposit, Cloak is listed but not suggested.
  const cloakOnly = { ...quote, pools: { cloakc: quote.pools.cloakc } }
  const small = sendOptions({ quote: cloakOnly, asset: 'USDC', raw: USDC(0.5), prices })
  assert.equal(small.suggested, null)
  assert.equal(small.options[0].executable, false)
  const blocked = options(19.28, { canRun: (protocol) => protocol !== 'umbrav2' })
  assert.equal(blocked.asTyped.id, 'cloakc:now:now')
  assert.equal(sendOptions({ quote, asset: 'USDC', raw: 0n, prices }), null)
})

test('a send set up by hand gets the measured privacy of what it does', () => {
  const pools = { ...quote.pools, privacycash: { ...quote.pools.privacycash, cells: [...quote.pools.privacycash.cells, cell('keep', 'now', '10-100', 30, 29), cell('split', 'now', '10-100', 30, 30)] } }
  const measure = (kind, extra = {}) => measuredPrivacy({ quote: { ...quote, pools }, protocol: 'privacycash', asset: 'USDC', raw: USDC(19.28), prices, kind, ...extra })
  // Keeping part of a common deposit and sending now: the keep cell. Of any other deposit: an exact send's.
  const bucket = '10-100'
  assert.deepEqual(measure('keep', { deposit: USDC(25) }), { score: 3, sends: 30, bucket, level: 1 })
  assert.deepEqual(measure('keep', { deposit: USDC(23.4) }), { score: 0, sends: 30, bucket, level: 1 })
  assert.deepEqual(measure('balance'), { score: 100, sends: 30, bucket, level: 5 })
  assert.deepEqual(measure('split'), { score: 0, sends: 30, bucket, level: 1 })
  // Sent now and larger than all the pool holds: 0.
  const small = { ...quote, pools: { ...pools, privacycash: { ...pools.privacycash, balance: 10 } } }
  assert.equal(measuredPrivacy({ quote: small, protocol: 'privacycash', asset: 'USDC', raw: USDC(19.28), prices, kind: 'split' }).level, 0)
  assert.equal(measuredPrivacy({ quote: small, protocol: 'privacycash', asset: 'USDC', raw: USDC(9), prices, kind: 'split' }), null)
  assert.equal(measuredPrivacy({ quote: { ...quote, pools: { ...pools, privacycash: { ...pools.privacycash, balance: 10 } } }, protocol: 'privacycash', asset: 'USDC', raw: USDC(19.28), prices, kind: 'keep', deposit: USDC(25) }).level, 0)
  assert.equal(measuredPrivacy({ quote: { ...quote, pools: { ...pools, privacycash: { ...pools.privacycash, balance: 1000 } } }, protocol: 'privacycash', asset: 'USDC', raw: USDC(19.28), prices, kind: 'keep', deposit: USDC(25) }).level, 1)
  assert.equal(measuredPrivacy({ quote, protocol: 'curvy', asset: 'USDC', raw: USDC(19.28), prices, kind: 'balance' }), null)
  assert.equal(measuredPrivacy({ quote, protocol: 'cloakc', asset: 'USDC', raw: USDC(19.28), prices, kind: 'split' }), null)
})

// The same pools with the waits measured for exact, split and later sends.
const timed = {
  ...quote,
  pools: {
    ...quote.pools,
    privacycash: {
      ...quote.pools.privacycash,
      cells: [...quote.pools.privacycash.cells, ...['1-10', '10-100'].flatMap((bucket) => [
        cell('exact', '6h', bucket, 30, 30), cell('exact', '24h', bucket, 30, 29), cell('keep', 'now', bucket, 30, 30), cell('keep', '12h', bucket, 26, 4),
        cell('split', 'now', bucket, 30, 30), cell('split', '6h', bucket, 30, 30), cell('split', '24h', bucket, 30, 27),
      ])],
    },
  },
}
const timedOptions = (amount, extra = {}) => sendOptions({ quote: timed, asset: 'USDC', raw: USDC(amount), prices, ...extra })

test('a common deposit reads the keep cell, else falls back to exact, so pools with few keep sends still show', () => {
  // 25 USDC is a common deposit in every pool; Umbra v2 and Cloak have no keep cell for now.
  const popular = [{ amount: '25000000', deposits: 40 }]
  const common = { ...timed, pools: { ...timed.pools, umbrav2: { ...timed.pools.umbrav2, popular }, cloakc: { ...timed.pools.cloakc, popular } } }
  const result = sendOptions({ quote: common, asset: 'USDC', raw: USDC(25), prices, settings: { ...DEFAULT_SETTINGS, keepNothing: true } })
  assert.deepEqual([...new Set(result.options.map((option) => option.protocol))].sort(), ['cloakc', 'privacycash', 'umbrav2'])
  // Privacy Cash measures keep sends: a day's wait among other 25 USDC deposits hides it.
  assert.equal(result.options.find((option) => option.id === 'privacycash:later:24h').score, 96)
  assert.equal(result.options.find((option) => option.id === 'umbrav2:now:now').score, 0)
})

test('with no common amount to copy, the waits still show, measured as an exact deposit', () => {
  // 4 USDC: no popular deposit in [4, 6].
  const result = timedOptions(4)
  const later = result.options.filter((option) => option.protocol === 'privacycash' && option.kind === 'later')
  assert.deepEqual(later.map((option) => option.wait).sort(), ['24h', '6h'])
  assert.ok(later.every((option) => option.deposit === USDC(4) && option.kept === 0n && option.level === 1))
  // Nothing reaches 4 of 5, so the page says what a shielded balance would score.
  assert.equal(result.fastest, null)
  assert.deepEqual(result.balanceHint, { protocol: 'privacycash', score: 100, sends: 30, level: 5, known: false })
  // A balance that covers it is the fastest private one, and the hint goes.
  const funded = timedOptions(4, { shielded: { privacycash: USDC(10) } })
  assert.equal(funded.fastest.id, 'privacycash:balance:now')
  assert.equal(funded.balanceHint, null)
})

test('a 12 h wait shows once the quote measures it', () => {
  const result = timedOptions(19.28)
  assert.equal(result.options.find((option) => option.id === 'privacycash:later:12h').score, 85)
  // 12 h hides it well enough and comes before a day.
  assert.equal(result.fastest.id, 'privacycash:later:12h')
  assert.ok(!options(19.28).options.some((option) => option.wait === '12h'))
})

test('keeping part shielded: every option deposits what the user set, in the pools that keep change', () => {
  // A common deposit (25) reads as keep, any other as exact.
  const common = timedOptions(19.28, { deposit: USDC(25) })
  // Every pool keeps change now; Cloak and Umbra v2 send now only, since this quote measures no waits for them.
  assert.deepEqual([...new Set(common.options.map((option) => option.protocol))].sort(), ['cloakc', 'privacycash', 'umbrav2'])
  assert.deepEqual(common.options.filter((option) => option.protocol === 'umbrav2').map((option) => option.id), ['umbrav2:now:now'])
  assert.deepEqual(common.options.filter((option) => option.protocol === 'cloakc').map((option) => option.id), ['cloakc:now:now'])
  const pc = common.options.filter((option) => option.protocol === 'privacycash')
  assert.deepEqual(pc.filter((option) => option.kind !== 'balance').map((option) => [option.wait, option.score]).sort(),
    [['12h', 85], ['24h', 96], ['6h', 50], ['now', 0]])
  assert.ok(common.options.every((option) => option.deposit === USDC(25) && option.kept === USDC(5.72)))
  const odd = timedOptions(3, { deposit: USDC(4) })
  assert.deepEqual(odd.options.filter((option) => option.protocol === 'privacycash').map((option) => [option.wait, option.score]).sort(), [['24h', 3], ['6h', 0], ['now', 0]])
  assert.equal(odd.balanceHint.level, 5)
})

test('Cloak and Umbra v2 pay from a shielded balance, and wait to send from it, once the quote measures it', () => {
  const pools = Object.fromEntries(['cloakc', 'umbrav2'].map((protocol) => [protocol, { popular: [], cells: ['1-10', '10-100'].flatMap((bucket) => [
    cell('exact', 'now', bucket, 30, 30), cell('exact', '24h', bucket, 30, 12), cell('balance', 'now', bucket, 30, 2)]) }]))
  const both = { ...quote, pools }
  const run = (extra) => sendOptions({ quote: both, asset: 'USDC', raw: USDC(19.28), prices, ...extra })
  // Unread balances: no option from them, but the hint says what one would score.
  const unread = run()
  assert.ok(!unread.options.some((option) => option.kind === 'balance'))
  assert.equal(unread.balanceHint.protocol, 'cloakc')
  assert.deepEqual(unread.options.filter((option) => option.kind === 'later').map((option) => option.id).sort(), ['cloakc:later:24h', 'umbrav2:later:24h'])
  // A balance that covers it in either pool is offered, and the cheaper pool leads.
  const funded = run({ shielded: { cloakc: USDC(30), umbrav2: USDC(20) } })
  assert.deepEqual(funded.options.filter((option) => option.kind === 'balance').map((option) => option.id).sort(), ['cloakc:balance:now', 'umbrav2:balance:now'])
  assert.equal(funded.suggested.id, 'umbrav2:balance:now')
  assert.equal(funded.suggested.balanceAfter, USDC(0.72))
  // Too little in one pool offers only the other.
  assert.deepEqual(run({ shielded: { cloakc: USDC(30), umbrav2: USDC(10) } }).options.filter((option) => option.kind === 'balance').map((option) => option.id), ['cloakc:balance:now'])
  // Use shielded funds: only the payments from a balance, ranked by privacy and fee like the rest.
  const only = run({ shielded: { cloakc: USDC(30), umbrav2: USDC(20) }, balanceOnly: true })
  assert.deepEqual(only.options.map((option) => option.id), ['umbrav2:balance:now', 'cloakc:balance:now'])
  assert.equal(only.balanceOnly, true)
  assert.equal(run({ balanceOnly: true }).suggested, null)
})

test('several recipients: measured as a split, in the pools that pay several, the fixed fee per recipient', () => {
  const result = timedOptions(19.28, { recipients: 3 })
  assert.ok(result.options.every((option) => option.protocol === 'privacycash'))
  assert.deepEqual(result.options.map((option) => [option.wait, option.score]).sort(), [['24h', 10], ['6h', 0], ['now', 0]])
  // 0.35% once, 0.006 SOL ($0.60) three times.
  assert.equal(result.options[0].fee, poolFee('privacycash', 'USDC', USDC(19.28), prices) + 2n * 600_000n)
  // Without split cells there is nothing to offer.
  assert.equal(options(19.28, { recipients: 2 }).suggested, null)
})

// POST /api/privacy-sim for 19.28 USDC: Privacy Cash measured for this exact amount, Cloak still loading.
const simCell = (strategy, wait, sends, traced) => ({ strategy, wait, planned: sends, sends, traced, linked: traced, timed: 0 })
const sim = {
  asset: 'USDC', model: 'privacy-sim/1', days: 90, samples: 300,
  pools: { privacycash: { asOf: '2026-11-01T00:00:00.000Z', cells: [simCell('exact', 'now', 300, 300), simCell('keep', '30m', 300, 150), simCell('keep', '6h', 300, 3), simCell('balance', 'now', 300, 0)] } },
}

test('the simulation replaces its pools\' cells for the amount\'s bucket, and keeps the rest of the quote', () => {
  const merged = withSimulation(quote, sim, '10-100')
  const pc = merged.pools.privacycash
  assert.deepEqual(pc.cells.filter((item) => item.bucket === '10-100').map(({ strategy, wait, sends, simulated }) => [strategy, wait, sends, simulated]),
    [['exact', 'now', 300, { days: 90, samples: 300 }], ['keep', '30m', 300, { days: 90, samples: 300 }], ['keep', '6h', 300, { days: 90, samples: 300 }], ['balance', 'now', 300, { days: 90, samples: 300 }]])
  assert.deepEqual(pc.cells.filter((item) => item.bucket === '1-10'), quote.pools.privacycash.cells.filter((item) => item.bucket === '1-10'))
  assert.equal(pc.popular, quote.pools.privacycash.popular)
  assert.equal(merged.pools.umbrav2, quote.pools.umbrav2)
  assert.equal(merged.pools.cloakc, quote.pools.cloakc)
  assert.equal(merged.buckets, buckets)
  // The quote itself is untouched, and nothing to merge leaves it as is.
  assert.equal(quote.pools.privacycash.cells.length, 8)
  assert.equal(withSimulation(quote, null, '10-100'), quote)
  assert.equal(withSimulation(quote, sim, null), quote)
  // No quote yet (404): the simulation alone.
  const alone = withSimulation(null, sim, 'exact')
  assert.deepEqual(alone.buckets, ['exact'])
  assert.deepEqual(Object.keys(alone.pools), ['privacycash'])
  // With no popular amounts to copy, a deposit reads as exact: it sends now, and the balance would hide it.
  const result = sendOptions({ quote: alone, asset: 'USDC', raw: USDC(19.28), prices })
  assert.deepEqual(result.options.map((option) => option.id), ['privacycash:now:now'])
  assert.deepEqual(result.options[0].simulated, { days: 90, samples: 300 })
  assert.equal(result.balanceHint.score, 100)
  assert.equal(sendOptions({ quote: alone, asset: 'USDC', raw: USDC(19.28), prices, shielded: { privacycash: USDC(50) } }).suggested.id, 'privacycash:balance:now')
})

test('options use a simulated cell for this exact amount, and never offer its 30 min wait', () => {
  const before = options(19.28).options.find((option) => option.id === 'privacycash:later:6h')
  assert.equal(before.score, 50)
  assert.equal(before.simulated, undefined)
  const result = sendOptions({ quote: withSimulation(quote, sim, '10-100'), asset: 'USDC', raw: USDC(19.28), prices })
  const after = result.options.find((option) => option.id === 'privacycash:later:6h')
  assert.equal(after.score, 99)
  assert.equal(after.sends, 300)
  assert.deepEqual(after.simulated, { days: 90, samples: 300 })
  assert.ok(!result.options.some((option) => option.wait === '30m'))
  // The simulation measured no day's wait for this amount; Umbra v2 still reads the quote.
  assert.ok(!result.options.some((option) => option.id === 'privacycash:later:24h'))
  assert.equal(result.options.find((option) => option.id === 'umbrav2:now:now').simulated, undefined)
  assert.equal(result.suggested.id, 'privacycash:later:6h')
  assert.deepEqual(measuredPrivacy({ quote: withSimulation(quote, sim, '10-100'), protocol: 'privacycash', asset: 'USDC', raw: USDC(19.28), prices, kind: 'balance' }),
    { score: 100, sends: 300, simulated: { days: 90, samples: 300 }, bucket: '10-100', level: 5 })
})
