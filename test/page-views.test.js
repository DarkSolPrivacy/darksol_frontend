import assert from 'node:assert/strict'
import test from 'node:test'
import { recordPageView } from '../src/page-views.js'

function browser(t) {
  const browser = { location: { hostname: 'darksol.app' }, navigator: {} }
  for (const [key, value] of Object.entries(browser)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true })
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key])
  }
  return browser
}

test('SPA visits send only page categories, without credentials or a referrer', (t) => {
  browser(t)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }) })
  for (const [path, page] of [['/', '/'], ['/analytics/', '/analytics'], ['/payment-links', '/payment-links'],
    ['/trace', '/trace'], ['/trace/private-signature', '/trace'], [`/pay/${'a'.repeat(64)}`, '/pay']]) {
    recordPageView(path)
    assert.equal(requests.at(-1).url, `/api/page-view?${new URLSearchParams({ page })}`)
    assert.deepEqual(requests.at(-1).options, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', keepalive: true,
    })
  }
  assert.equal(JSON.stringify(requests).includes('private-signature'), false)
  assert.equal(JSON.stringify(requests).includes('a'.repeat(64)), false)
  const count = requests.length
  for (const path of ['/admin-stats', '/pay', '/pay/not-an-invoice', '/api/summary', '/unknown']) recordPageView(path)
  assert.equal(requests.length, count)
})

test('SPA collection respects opt-outs, skips other hosts and cannot break navigation', async (t) => {
  const { location, navigator } = browser(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => {})
  navigator.doNotTrack = '1'
  recordPageView('/trace')
  navigator.doNotTrack = '0'
  navigator.globalPrivacyControl = true
  recordPageView('/trace')
  navigator.globalPrivacyControl = false
  for (const hostname of ['localhost', 'preview.vercel.app', 'darksol.app.evil.test']) {
    location.hostname = hostname
    recordPageView('/trace')
  }
  assert.equal(fetch.mock.callCount(), 0)
  location.hostname = 'darksol.app'
  fetch.mock.mockImplementation(async () => { throw new Error('offline') })
  assert.doesNotThrow(() => recordPageView('/trace'))
  await new Promise(resolve => setImmediate(resolve))
  fetch.mock.mockImplementation(() => { throw new Error('unavailable') })
  assert.doesNotThrow(() => recordPageView('/trace'))
})