import assert from 'node:assert/strict'
import test from 'node:test'
import { exclusive, withdrawalCapacity } from '../protocols/privacycash/browser.js'

// PrivacyCash's withdraw spends the two largest notes and, when they fall short,
// pays out what they hold instead of failing. Paying from the shielded balance
// must refuse any amount above this, or the recipient silently gets less.
test('one withdrawal can send at most the two largest notes', () => {
  assert.equal(withdrawalCapacity([5n, 3n, 2n]), 8n)
  assert.equal(withdrawalCapacity([4n]), 4n)
  assert.equal(withdrawalCapacity([]), 0n)
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
