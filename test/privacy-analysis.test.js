import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnalysisResource, preparedSimulation } from '../src/privacy-analysis.js'

const cell = (strategy, wait, traced, deposit) => ({ strategy, wait, sends: 300, planned: 300, traced, ...(deposit && { deposit }) })
const table = { model: 'privacy-analysis/1', asset: 'USDC', pools: { privacycash: {
  model: 'privacy-analysis/1', simulationModel: 'privacy-sim/2', asset: 'USDC', protocol: 'privacycash', validUntil: 2000, computedAt: 900,
  entries: { '28000000': { cells: [cell('exact', 'now', 300), cell('keep', '6h', 30, '30000000'), cell('keep', '24h', 0, '30000000'), cell('balance', 'now', 0), cell('split', '6h', 90)],
    manual: [cell('keep', '6h', 60, '30000000')] } },
} } }
const request = { asset: 'USDC', amount: '28.000000', recipients: 1, maxWait: '6h' }

test('prepared lookup is exact, respects waits and recipients, and never substitutes a nearby amount', () => {
  const hit = preparedSimulation(table, request, 1000)
  assert.deepEqual(hit.pools.privacycash.cells.map(({ strategy, wait }) => [strategy, wait]), [['exact', 'now'], ['keep', '6h'], ['balance', 'now']])
  assert.deepEqual(preparedSimulation(table, { ...request, amount: '028' }, 1000), hit)
  assert.equal(preparedSimulation(table, { ...request, amount: '28.000001' }, 1000), null)
  assert.equal(preparedSimulation(table, { ...request, asset: 'SOL' }, 1000), null)
  assert.equal(preparedSimulation(table, request, 2000), null)
  assert.equal(preparedSimulation(table, { ...request, maxWait: '2d' }, 1000), null)
  assert.deepEqual(preparedSimulation(table, { ...request, recipients: 2 }, 1000).pools.privacycash.cells.map(({ strategy }) => strategy), ['balance', 'split'])
})

test('a manual gross deposit uses its own measured cells and an unprepared deposit is a miss', () => {
  const hit = preparedSimulation(table, { ...request, deposit: '30' }, 1000)
  assert.equal(hit.pools.privacycash.cells.find(({ strategy }) => strategy === 'keep').traced, 60)
  for (const deposit of ['31', '27', 'bad']) assert.equal(preparedSimulation(table, { ...request, deposit }, 1000), null)
})

test('shared resource fetches only the public token table and expires measurements after refresh failures', async () => {
  let clock = 1000, fail = false, seen = []
  const resource = createAnalysisResource({ now: () => clock, ttl: 500, fetcher: async (...args) => {
    seen.push(args)
    if (fail) throw new Error('offline')
    return { ok: true, json: async () => table }
  } })
  await Promise.all([resource.load('USDC'), resource.load('USDC')])
  assert.deepEqual(seen.map(([url]) => url), ['/api/privacy-analysis?asset=USDC'])
  assert.equal(seen[0][1].body, undefined)
  assert.ok(preparedSimulation(resource.get('USDC').data, request, clock))
  await resource.load('USDC')
  assert.equal(seen.length, 1)
  fail = true
  clock = 2001
  await resource.load('USDC')
  assert.equal(resource.get('USDC').loading, false)
  assert.equal(preparedSimulation(resource.get('USDC').data, request, clock), null)
})
