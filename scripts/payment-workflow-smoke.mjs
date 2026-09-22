import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import bs58 from 'bs58'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const target = process.env.PAYMENT_UI_URL || 'http://localhost:5173'
const artifacts = process.env.PAYMENT_ARTIFACTS || join(tmpdir(), 'darksol-payment-ui')
await mkdir(artifacts, { recursive: true })
const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
const address = bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
const privateKey = [...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript(({ address, privateKey }) => {
  const key = crypto.subtle.importKey('pkcs8', new Uint8Array(privateKey), 'Ed25519', false, ['sign'])
  const events = new Map()
  window.__paymentWallet = { signatures: [], transactions: 0 }
  window.solana = {
    publicKey: null, isConnected: false,
    async connect() { this.publicKey = address; this.isConnected = true; return { publicKey: address } },
    async disconnect() { this.isConnected = false; this.publicKey = null; for (const fn of events.get('disconnect') || []) fn() },
    async signMessage(bytes) {
      window.__paymentWallet.signatures.push(new TextDecoder().decode(bytes))
      return new Uint8Array(await crypto.subtle.sign('Ed25519', await key, bytes))
    },
    signTransaction() { window.__paymentWallet.transactions++; throw new Error('No live payments in browser tests') },
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn) },
    off(name, fn) { events.get(name)?.delete(fn) },
    changeAccount(value) { this.publicKey = value; for (const fn of events.get('accountChanged') || []) fn(value) },
  }
}, { address, privateKey })

const records = []
const creates = []
const errors = []
const requests = []
let failCreate = true
let acceptDeposit = false
await context.route('**/api/**', async (route) => {
  const request = route.request()
  const path = new URL(request.url()).pathname
  requests.push({ path, headers: request.headers(), method: request.method() })
  const send = (body, status = 200) => route.fulfill({ status, json: body })
  if (path === '/api/summary') return send({ pools: [{ protocol: 'cloakc', inflow: 1000, outflow: 2000 }, { protocol: 'privacycash', inflow: 5000, outflow: 1000 }] })
  if (path === '/api/payment-links') {
    const merchant = request.headers()['x-merchant-id']
    assert.match(merchant, /^[0-9a-f]{64}$/)
    assert.match(request.headers().authorization, /^Bearer [0-9a-f]{64}$/)
    if (request.method() === 'GET') return send({ payments: records.filter((row) => row.merchant === merchant), next_offset: null })
    const record = request.postDataJSON()
    creates.push(record)
    assert.equal(request.postData().includes(address), false)
    assert.equal(/privateKey|spendingKey|"signature"/.test(request.postData()), false)
    if (failCreate) { failCreate = false; return send({ error: 'Temporarily unavailable' }, 503) }
    let row = records.find((row) => row.record.invoice.id === record.invoice.id)
    if (!row) {
      const payment_id = randomBytes(32).toString('hex')
      row = { payment_id, payment_url: `${target}/pay/${payment_id}`, merchant, status: 'pending', created_at: new Date().toISOString(), paid_at: null, deposit_transaction: null, deposit_slot: null, record }
      records.unshift(row)
    }
    return send({ payment_id: row.payment_id, payment_url: row.payment_url, status: row.status }, 201)
  }
  const match = /^\/api\/payment-links\/([a-f0-9]{64})(\/deposit)?$/.exec(path)
  if (match) {
    assert.equal(request.headers().authorization, undefined)
    assert.equal(request.headers()['x-merchant-id'], undefined)
    const row = records.find((record) => record.payment_id === match[1])
    if (!row) return send({ error: 'Payment not found' }, 404)
    if (match[2]) {
      assert.deepEqual(Object.keys(request.postDataJSON()), ['transaction_id'])
      if (!acceptDeposit) return send({ error: 'No finalized deposit for the expected note commitments' }, 422)
      row.status = 'paid'; row.paid_at = new Date().toISOString(); row.deposit_transaction = request.postDataJSON().transaction_id
      return send({ payment_id: row.payment_id, status: 'paid' })
    }
    const { protocol, network, asset, amount, outputs } = row.record.invoice
    return send({ payment_id: row.payment_id, version: 1, protocol, network, asset, amount, outputs, status: row.status })
  }
  return send({ pools: [] })
})
await context.route('https://api.mainnet-beta.solana.com/**', async (route) => {
  const rpc = route.request().postDataJSON()
  assert.equal(rpc.method, 'getGenesisHash')
  await route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: 'devnet' } })
})

const page = await context.newPage()
page.on('pageerror', (error) => errors.push(error.message))
const waitText = (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text })
async function screenshot(name) {
  await page.screenshot({ path: join(artifacts, name + '.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name + ': horizontal overflow')
}
try {
  await page.goto(target + '/payment-links')
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  await page.getByLabel('REQUEST AMOUNT').fill('0.001')
  assert.equal(await page.getByRole('button', { name: 'Create payment link' }).isDisabled(), true)
  await page.getByLabel('REQUEST AMOUNT').fill('0.02')
  await page.locator('#paymentReference').fill('Invoice-'.repeat(10))
  await page.getByRole('button', { name: 'Create payment link' }).click()
  await page.getByRole('button', { name: 'Publish link' }).waitFor()
  await page.getByRole('button', { name: 'Publish link' }).click()
  await page.getByRole('button', { name: 'Copy payment link' }).waitFor()
  assert.equal(creates[0].invoice.id, creates[1].invoice.id)
  assert.equal(await page.evaluate(() => window.__paymentWallet.signatures.length), 2)
  await page.getByRole('radio', { name: /Privacy Cash/ }).check()
  await page.getByRole('button', { name: 'Create payment link' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Copy payment link"]').length === 2)
  assert.equal(records[0].record.invoice.outputs.length, 2)
  const cloak = records.find((row) => row.record.invoice.protocol === 'cloakc')
  const privacycash = records.find((row) => row.record.invoice.protocol === 'privacycash')
  await screenshot('merchant-desktop')
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await screenshot('merchant-' + width)
  }
  await page.reload()
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Load payment links' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Copy payment link"]').length === 2)
  await page.evaluate(() => window.solana.changeAccount('11111111111111111111111111111111'))
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Copy payment link"]').length === 0)
  await page.reload()
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Load payment links' }).click()
  await page.getByRole('button', { name: 'Verify deposit', exact: true }).last().click()
  const transaction = bs58.encode(randomBytes(64))
  await page.locator('#merchantDeposit').fill(transaction)
  await page.locator('.paymentReport button[type=submit]').click()
  await waitText('.paymentError', 'No finalized deposit')
  assert.equal(cloak.status, 'pending')
  acceptDeposit = true
  await page.locator('.paymentReport button[type=submit]').click()
  await page.locator('.paymentStatus.paid').waitFor()
  await page.goto(cloak.payment_url)
  await waitText('h1', 'Payment received')
  assert.equal(await page.getByRole('button', { name: /pay invoice|connect wallet to pay/i }).count(), 0)
  await screenshot('checkout-paid-mobile')

  acceptDeposit = false
  await page.goto(privacycash.payment_url)
  await page.getByRole('button', { name: 'Connect wallet to pay' }).click()
  await page.getByRole('button', { name: 'Pay invoice' }).click()
  await waitText('.paymentError', 'mainnet')
  assert.equal(await page.evaluate(() => window.__paymentWallet.transactions), 0)
  await screenshot('checkout-error-mobile')
  await page.evaluate(({ id, transaction }) => localStorage.setItem('darksol:payment-deposit:v1:' + id, transaction), { id: privacycash.payment_id, transaction })
  await page.reload()
  await waitText('.paymentCheckoutState', 'Awaiting deposit confirmation')
  assert.equal(await page.getByRole('button', { name: /pay invoice|connect wallet to pay/i }).count(), 0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await screenshot('checkout-pending-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await screenshot('checkout-pending-mobile')
  acceptDeposit = true
  await page.getByRole('button', { name: 'Verify deposit' }).click()
  await waitText('h1', 'Payment received')
  await page.reload()
  await waitText('h1', 'Payment received')
  await page.goto(target + '/pay/' + '0'.repeat(64))
  await waitText('.paymentError', 'not found')
  assert.deepEqual(errors, [])
  console.log('PASS: real wallet note creation, retry without re-signing, backend history, account isolation, verified status, checkout reload, wrong-network guard, desktop/mobile layouts')
  console.log('Screenshots:', artifacts)
} catch (error) {
  console.error(await page.locator('main').innerText())
  console.error('Browser errors:', errors)
  await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true })
  throw error
} finally {
  await browser.close()
}
