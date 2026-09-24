import assert from 'node:assert/strict'
import test from 'node:test'
import { captureWithdrawal } from '../protocols/privacycash/browser.js'
import { scheduleWithdrawal, scheduledStatus } from '../src/scheduled-send.js'

// Stands in for privacycash/dist/withdraw.js: other SDK reads pass through,
// the relayer POST is where the proof leaves the browser.
const fakeWithdraw = (path, body) => async () => {
  assert.equal(await (await fetch('https://api3.privacycash.org/utxos/range?start=0')).text(), 'passed through')
  const response = await fetch(`https://api3.privacycash.org${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  throw new Error(`relayer reached with ${response.status}`)
}

test('the SDK withdrawal is captured at its relayer POST and never sent', async (t) => {
  const passthrough = async () => new Response('passed through')
  t.mock.method(globalThis, 'fetch', passthrough)
  const real = globalThis.fetch
  for (const path of ['/withdraw', '/withdraw/spl']) {
    const body = { serializedProof: 'AAAA', recipient: 'x', extAmount: -1 }
    assert.deepEqual(await captureWithdrawal(fakeWithdraw(path, body)), body)
    assert.equal(globalThis.fetch, real)
  }
  // Any other failure surfaces, and fetch is restored either way.
  await assert.rejects(captureWithdrawal(async () => { throw new Error('no balance') }), /no balance/)
  assert.equal(globalThis.fetch, real)
  await assert.rejects(captureWithdrawal(async () => {}), /built no withdrawal/)
})

test('scheduler requests carry the payload and deadline only, without credentials', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url, init })
    return url.endsWith('/missing') ? new Response('{}', { status: 404 }) : Response.json({ id: 'a'.repeat(32), send_by: 42, status: 'sent' }, { status: 201 })
  })
  const before = Date.now()
  assert.deepEqual(await scheduleWithdrawal({ recipient: 'x' }, 10), { id: 'a'.repeat(32), sendBy: 42 })
  const [{ url, init }] = calls
  const body = JSON.parse(init.body)
  assert.equal(url, '/api/scheduled-withdrawals')
  assert.deepEqual(Object.keys(body), ['params', 'deadline'])
  assert.ok(body.deadline >= before + 10 * 60_000 && body.deadline <= Date.now() + 10 * 60_000)
  assert.equal(init.credentials, 'omit')
  assert.equal(init.referrerPolicy, 'no-referrer')
  assert.deepEqual(Object.keys(init.headers), ['Content-Type'])
  assert.deepEqual(await scheduledStatus('missing'), { status: 'unknown' })
  assert.ok(calls.every(({ init }) => init.credentials === 'omit'))
})
