import assert from 'node:assert/strict'
import test from 'node:test'
import { NO_TIMINGS, STAGES, createTimings, history, tableRows, withTimings } from '../protocols/shared/stage-timings.js'

// A clock the test moves by hand.
function clock() {
  let at = 0
  return { now: () => at, pass: (ms) => { at += ms } }
}
const quiet = { print: () => {}, watch: () => () => {} }
const row = (rows, leg, stage) => rows.find((item) => item.leg === leg && item.stage === stage)?.ms

test('stages add up per leg, in the order they ran, and the rows sum to the total', () => {
  const time = clock()
  const timings = createTimings('privacycash', { ...quiet, now: time.now })
  time.pass(40)
  timings.enter('sdk load'); time.pass(300)
  timings.enter('sign-in'); time.pass(100)
  timings.leg('deposit')
  timings.enter('note scan'); time.pass(2000)
  timings.enter('proof'); time.pass(1500)
  timings.enter('relay request'); time.pass(250)
  timings.leg('withdrawal')
  timings.enter('note scan'); time.pass(400)
  timings.enter('proof'); time.pass(1600)
  const { rows, outcome } = timings.finish()
  assert.equal(outcome, 'sent')
  assert.deepEqual(rows.map((item) => `${item.leg}/${item.stage}`), ['send/queued', 'send/sdk load', 'send/sign-in', 'deposit/note scan', 'deposit/proof', 'deposit/relay request', 'withdrawal/note scan', 'withdrawal/proof', 'total/'])
  assert.equal(row(rows, 'deposit', 'note scan'), 2000)
  assert.equal(row(rows, 'withdrawal', 'proof'), 1600)
  assert.equal(row(rows, 'total', ''), 6190)
  assert.equal(rows.slice(0, -1).reduce((sum, item) => sum + item.ms, 0), 6190)
  assert.ok(rows.every((item) => item.stage === '' || STAGES.includes(item.stage)))
})

test('a stage that lasted no time where a leg began does not take that place in the order', () => {
  const time = clock()
  const timings = createTimings('privacycash', { ...quiet, now: time.now })
  timings.enter('settlement wait'); time.pass(2000)
  // The withdrawal begins: the settlement stage is renamed under it, then left at once.
  timings.leg('withdrawal'); time.pass(0.02); timings.enter('note scan'); time.pass(1500)
  timings.enter('settlement wait'); time.pass(2100)
  const { rows } = timings.finish()
  assert.deepEqual(rows.map((item) => `${item.leg}/${item.stage}`), ['send/settlement wait', 'withdrawal/note scan', 'withdrawal/settlement wait', 'total/'])
})

test('a wallet approval interrupts a stage and hands back to it', async () => {
  const time = clock()
  const timings = createTimings('cloakc', { ...quiet, now: time.now })
  timings.enter('proof'); time.pass(1000)
  const signed = await timings.during('wallet approval', async () => { time.pass(4000); return 'signed' })
  assert.equal(signed, 'signed')
  assert.equal(timings.stage, 'proof')
  time.pass(200)
  await assert.rejects(timings.during('wallet approval', async () => { time.pass(50); throw new Error('declined') }), /declined/)
  assert.equal(timings.stage, 'proof')
  const { rows } = timings.finish('failed')
  assert.equal(row(rows, 'send', 'proof'), 1200)
  assert.equal(row(rows, 'send', 'wallet approval'), 4050)
})

test('a download is taken out of the stage it ran under, parallel files counted once', () => {
  const spans = [{ leg: 'deposit', stage: 'note scan', start: 0, end: 1000 }, { leg: 'deposit', stage: 'proof', start: 1000, end: 6000 }]
  const carved = [
    { stage: 'circuit download', start: 1100, end: 1900 },
    { stage: 'circuit download', start: 1500, end: 4100 },
    // Before the send and after it: not this send's time.
    { stage: 'circuit download', start: -500, end: -100 },
    { stage: 'circuit download', start: 7000, end: 8000 },
  ]
  const rows = tableRows('privacycash', spans, carved)
  assert.equal(row(rows, 'deposit', 'circuit download'), 3000)
  assert.equal(row(rows, 'deposit', 'proof'), 2000)
  assert.equal(row(rows, 'deposit', 'note scan'), 1000)
  assert.equal(row(rows, 'total', ''), 6000)
})

test('downloads reach the table through the watcher, by URL', () => {
  const time = clock()
  let report
  const timings = createTimings('privacycash', {
    print: () => {}, now: time.now,
    downloads: (url) => url.includes('/circuit2/') ? 'circuit download' : null,
    watch: (stageOf, carve) => { report = (url, start, end) => { const stage = stageOf(url); if (stage) carve(stage, start, end) }; return () => {} },
  })
  timings.enter('proof'); time.pass(5000)
  report('https://darksol.app/circuit2/transaction2.zkey', 500, 3500)
  report('https://darksol.app/api/plan', 0, 5000)
  const { rows } = timings.finish()
  assert.equal(row(rows, 'send', 'circuit download'), 3000)
  assert.equal(row(rows, 'send', 'proof'), 2000)
})

test('the table prints once, whether the send resolves or throws, and holds only names and milliseconds', async () => {
  const printed = []
  const options = { ...quiet, print: (run) => printed.push(run) }
  assert.equal(await withTimings('umbrav2', options, async (timings) => { timings.enter('proof'); return 7 }), 7)
  await assert.rejects(withTimings('umbrav2', options, async () => { throw new Error('relayer dropped') }), /relayer dropped/)
  assert.deepEqual(printed.map((run) => run.outcome), ['sent', 'failed'])
  assert.equal(history.at(-1), printed[1])
  for (const run of printed) {
    assert.deepEqual(Object.keys(run), ['pool', 'kind', 'outcome', 'rows'])
    for (const item of run.rows) {
      assert.deepEqual(Object.keys(item), ['pool', 'leg', 'stage', 'ms'])
      assert.equal(typeof item.ms, 'number')
    }
  }
  // Finishing twice keeps the first table.
  const timings = createTimings('cloakc', quiet)
  assert.equal(timings.finish('sent'), timings.finish('failed'))
})

test('an untimed flow runs its tasks and records nothing', async () => {
  NO_TIMINGS.leg('deposit'); NO_TIMINGS.enter('proof')
  assert.equal(await NO_TIMINGS.during('wallet approval', async () => 'ok'), 'ok')
  assert.equal(NO_TIMINGS.finish(), null)
})
