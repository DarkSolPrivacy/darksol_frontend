import assert from 'node:assert/strict'
import test from 'node:test'
import { STEP_SECONDS, createProgress, expectedPages, planSteps, readLines } from '../protocols/umbrav2/progress-plan.js'

test('a first read on a device reads the whole pool, a known one only what was added', () => {
  // The CDN manifest of 2026-11-07: 10,000 notes, read as 11 pages here.
  assert.equal(expectedPages({ known: false, nextLeaf: 10_000 }), 11)
  assert.equal(expectedPages({ known: false }), 11)
  assert.equal(expectedPages({ known: true, savedLeaf: 9_950, nextLeaf: 10_000 }), 1)
  assert.equal(expectedPages({ known: true, savedLeaf: 6_000, nextLeaf: 10_400 }), 5)
  assert.equal(expectedPages({ known: true }), 1)
})

test('each step takes a share of the bar in proportion to its time', () => {
  const lines = []
  const progress = createProgress((text, hint) => lines.push([text, hint]), planSteps({ unlocked: true, pages: 1, deposit: true, payout: true }))
  progress.step('prove', 'Proving')
  progress.step('payoutSend', 'Confirming')
  const total = planSteps({ unlocked: true }).reduce((sum, [, seconds]) => sum + seconds, 0)
  const S = STEP_SECONDS
  assert.equal(lines[0][1].to, (S.open + S.read + S.prepare + S.prove) / total)
  assert.equal(lines[0][1].seconds, S.prove)
  assert.equal(lines[1][1].to, 1)
})

test('a first read takes most of the bar, so the bar moves while it runs', () => {
  const cold = planSteps({ unlocked: false, register: true, pages: 11, deposit: true, payout: true })
  const total = cold.reduce((sum, [, seconds]) => sum + seconds, 0)
  const read = cold.find(([name]) => name === 'read')[1]
  assert.ok(read / total > 0.6)
  const warm = planSteps({ unlocked: true, pages: 1 })
  assert.equal(warm.find(([name]) => name === 'read')[1], STEP_SECONDS.read)
})

test('a page of a read moves the bar one page on, over one page of time, with its note', () => {
  const lines = []
  const progress = createProgress((text, hint) => lines.push(hint), planSteps({ pages: 10, deposit: false, payout: true }))
  const { text, note } = readLines({ known: false, page: 4, pages: 10 })
  progress.step('read', text, { part: 4 / 10, seconds: STEP_SECONDS.page, note })
  assert.equal(lines[0].seconds, STEP_SECONDS.page)
  assert.match(lines[0].note, /^First time here/)
  assert.match(text, /page 4 of 10/)
})

test('a step outside the plan reports its text alone, and replanning never needs the bar back', () => {
  const lines = []
  const progress = createProgress((...args) => lines.push(args), [])
  progress.step('prove', 'Proving')
  assert.deepEqual(lines, [['Proving']])
  const planned = createProgress((text, hint) => lines.push(hint), planSteps({ pages: 1 }))
  planned.replan(planSteps({ pages: 11 }))
  planned.step('read', 'Reading', { part: 0.5 })
  assert.ok(lines.at(-1).to > 0 && lines.at(-1).to < 1)
})

test('the read lines say how long is left, and that it happens once', () => {
  const first = readLines({ known: false, page: 1, pages: 11 })
  assert.match(first.text, /^Setting up Umbra v2 on this device… \(page 1 of 11\)$/)
  assert.match(first.note, /only once: about \d+ min left/)
  assert.match(readLines({ known: false, page: 11, pages: 11 }).note, /about 1 min left/)
  // More pages than planned: the count grows, never "page 13 of 11".
  assert.match(readLines({ known: false, page: 13, pages: 11 }).text, /page 13 of 13/)
  assert.match(readLines({ known: true, page: 2, pages: 4 }).text, /^Catching up on Umbra v2…/)
})
