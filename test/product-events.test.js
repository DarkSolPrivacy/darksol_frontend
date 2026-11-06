import assert from 'node:assert/strict'
import test from 'node:test'
import { failureReason, track, walletKind } from '../src/product-events.js'
import { dropCampaignTags } from '../src/page-views.js'

function browser(t, href = 'https://darksol.app/') {
  const history = { state: { from: 'app' }, replaceState(state, _title, url) { this.calls.push([state, String(url)]) }, calls: [] }
  const browser = { location: { hostname: new URL(href).hostname, href }, navigator: {}, history }
  for (const [key, value] of Object.entries(browser)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true })
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key])
  }
  return browser
}

test('events send a fixed name and safe categories only, without credentials or a referrer', (t) => {
  browser(t)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }) })
  track('send_completed', { kind: 'swap', protocol: 'umbrav2', asset: 'USDC', wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', amount: '1.5', missing: undefined })
  assert.equal(requests[0].url, `/api/event?${new URLSearchParams({ e: 'send_completed', kind: 'swap', protocol: 'umbrav2', asset: 'usdc' })}`)
  assert.deepEqual(requests[0].options, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', keepalive: true })
  track('route_details_opened', {}, { once: true }); track('route_details_opened', {}, { once: true })
  assert.equal(requests.filter(({ url }) => url.includes('route_details_opened')).length, 1)
  track('send_started', { kind: 'send' }); track('send_started', { kind: 'send' })
  assert.equal(requests.filter(({ url }) => url.includes('send_started')).length, 2)
})

test('events respect opt-outs, skip other hosts and cannot break the page', (t) => {
  const { navigator, location } = browser(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => {})
  navigator.doNotTrack = '1'; track('send_started')
  navigator.doNotTrack = '0'; navigator.globalPrivacyControl = true; track('send_started')
  navigator.globalPrivacyControl = false; location.hostname = 'preview.vercel.app'; track('send_started')
  assert.equal(fetch.mock.callCount(), 0)
  location.hostname = 'darksol.app'
  t.mock.method(globalThis, 'fetch', () => { throw new Error('blocked') })
  assert.doesNotThrow(() => track('send_started'))
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  assert.doesNotThrow(() => track('send_started'))
})

test('failures and wallets reduce to a few categories', () => {
  for (const [message, reason] of [['Install a Solana wallet such as Phantom or Solflare', 'no_wallet'], ['User rejected the request.', 'rejected'],
    ['Approval Denied', 'rejected'], ['Transaction cancelled', 'rejected'], ['403 Forbidden: access denied', 'network'],
    ['Attempt to debit an account but found no record of a prior credit.', 'insufficient_funds'], ['insufficient lamports 5000, need 9000', 'insufficient_funds'],
    ['custom program error: 0x1771', 'slippage'], ['TypeError: Failed to fetch', 'network'], ['block height exceeded', 'network'],
    ['Transaction was not confirmed in 60.00 seconds', 'network'], ['Unsupported payment pool', 'other'], ['', 'other']]) {
    assert.equal(failureReason(new Error(message)), reason, message)
  }
  assert.equal(failureReason('User rejected'), 'rejected'); assert.equal(failureReason(undefined), 'other')
  assert.deepEqual(['Phantom', 'Coinbase Wallet', 'OKX Wallet', 'Browser wallet', '', '  Back!pack  '].map(walletKind),
    ['phantom', 'coinbase_wallet', 'okx_wallet', 'browser_wallet', 'unknown', 'back_pack'])
})

test('campaign tags leave the address after the load that counted them', (t) => {
  const { history } = browser(t, 'https://darksol.app/payment-links?utm_source=x&keep=1&utm_campaign=launch#top')
  dropCampaignTags()
  assert.deepEqual(history.calls, [[{ from: 'app' }, 'https://darksol.app/payment-links?keep=1#top']])
  globalThis.location.href = 'https://darksol.app/?keep=1'
  dropCampaignTags()
  assert.equal(history.calls.length, 1)
})
