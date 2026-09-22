import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { recoverPaymentNote } from '../src/payment-notes.js'

const target = process.argv[2] || 'http://127.0.0.1:5178'
const port = process.env.CHROME_DEBUG_PORT || '9225'
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
const address = new PublicKey(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))).toBase58()
const privateBytes = [...new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey))]
const page = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
let id = 0
const pending = new Map()
const errors = []
const writes = []
const timeout = setTimeout(() => { console.error('Payment wallet browser check timed out'); process.exit(1) }, 60_000)
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
}
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
  if (message.method === 'Inspector.targetCrashed') { console.error('Browser renderer crashed'); process.exit(1) }
  if (message.method === 'Fetch.requestPaused') {
    const request = message.params.request
    const path = new URL(request.url).pathname
    let body = {}
    if (path === '/api/summary') body = { pools: [] }
    else if (path === '/api/plan') body = { estimates: [] }
    else if (path === '/api/solana-rpc') {
      const rpc = JSON.parse(request.postData)
      if (!['getBalance', 'getTokenAccountsByOwner'].includes(rpc.method)) writes.push(rpc.method)
      body = { jsonrpc: '2.0', id: rpc.id, result: { context: { slot: 1 }, value: rpc.method === 'getBalance' ? 0 : [] } }
    } else writes.push(path)
    call('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') })
  }
  const request = pending.get(message.id)
  if (request) {
    pending.delete(message.id)
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
  }
})
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const tick = () => new Promise(resolve => setTimeout(resolve, 100))
async function until(expression) {
  for (let count = 0; count < 150; count++) {
    if (await evaluate(expression)) return
    await tick()
  }
  throw new Error('Browser condition timed out: ' + expression + ' ' + await evaluate('JSON.stringify({paymentError:document.querySelector(".paymentError")?.textContent,transferError:document.querySelector(".transferResult")?.textContent,button:document.querySelector(".actionArea > button")?.textContent,connects:window.__walletTest?.connects})'))
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    el.scrollIntoView({ block: 'center' })
    const rect = el.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await tick()
}
const providerSource = `(() => {
  const signingKey = crypto.subtle.importKey('pkcs8', new Uint8Array(${JSON.stringify(privateBytes)}), 'Ed25519', false, ['sign'])
  const listeners = new Map()
  window.__walletTest = { connects: 0, signatures: 0, transactions: 0, mode: 'approve', messages: [] }
  const state = window.__walletTest
  window.solana = {
    publicKey: null, isConnected: false,
    async connect() { state.connects++; this.publicKey = ${JSON.stringify(address)}; this.isConnected = true; return { publicKey: this.publicKey } },
    async disconnect() { this.publicKey = null; this.isConnected = false; for (const callback of listeners.get('disconnect') || []) callback() },
    async signMessage(message) {
      state.signatures++; state.messages.push(new TextDecoder().decode(message))
      if (state.mode === 'reject') throw new Error('User rejected request')
      if (state.mode === 'hold') await new Promise(resolve => { state.release = resolve })
      return { signature: new Uint8Array(await crypto.subtle.sign('Ed25519', await signingKey, message)) }
    },
    signTransaction() { state.transactions++; throw new Error('Unexpected transaction signing') },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn) },
    off(event, fn) { listeners.get(event)?.delete(fn) },
  }
})()`
try {
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Inspector.enable')
  await call('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
  await call('Page.addScriptToEvaluateOnNewDocument', { source: providerSource })
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
  await call('Page.navigate', { url: target + '/' })
  await until('Boolean(document.querySelector(".actionArea > button"))')
  assert.equal(await evaluate('Boolean(window.__walletTest)'), true, 'Disposable wallet was not injected')
  await click('.actionArea > button')
  await until('Boolean(document.querySelector(".walletSession"))')
  await click('nav a:nth-child(2)')
  await until('Boolean(document.querySelector(".paymentCreate"))')
  assert.equal(await evaluate('document.querySelector(".paymentPrimary").textContent.includes("Create payment link")'), true)
  assert.equal(await evaluate('window.__walletTest.connects'), 1)
  await evaluate(`(() => {
    const input = document.getElementById('paymentAmount')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.02')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await tick()
  for (const [index, protocol] of ['cloakc', 'privacycash'].entries()) {
    await click('input[name="paymentPool"][value="' + protocol + '"]')
    await click('.paymentPrimary')
    await until(`document.querySelectorAll('.paymentDraft').length === ${index + 1}`)
    assert.equal(await evaluate('window.__walletTest.signatures'), index + 1)
    assert.equal(await evaluate('document.querySelector(".paymentPrepared").textContent.includes("not available yet")'), true)
  }
  const records = await evaluate(`Object.keys(localStorage).filter(key => key.startsWith('darksol:payment-note:v1:${address}:')).map(key => JSON.parse(localStorage.getItem(key)))`)
  assert.equal(records.length, 2)
  for (const record of records) {
    const recovered = await recoverPaymentNote({
      record, address, provider: { publicKey: address, signMessage: async message => new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, message)) },
    })
    assert.equal(recovered.notes[0].amount.toString(), '20000000')
    assert.equal(JSON.stringify(record).includes(address), false)
  }
  await evaluate('window.__walletTest.mode = "reject"')
  await click('.paymentPrimary')
  await until('Boolean(document.querySelector(".paymentError"))')
  assert.equal(await evaluate('document.querySelectorAll(".paymentDraft").length'), 2)
  await evaluate('window.__walletTest.mode = "hold"')
  await click('.paymentPrimary')
  await until('Boolean(window.__walletTest.release)')
  await evaluate('window.solana.disconnect(); window.__walletTest.release()')
  await until('document.querySelector(".paymentPrimary").textContent.includes("Connect wallet")')
  assert.equal(await evaluate('document.querySelectorAll(".paymentDraft").length'), 0)
  await evaluate('window.__walletTest.mode = "approve"')
  await click('.paymentPrimary')
  await until('document.querySelectorAll(".paymentDraft").length === 2')
  await click('nav a:first-child')
  await until('Boolean(document.querySelector(".walletSession"))')
  assert.equal(await evaluate('window.__walletTest.connects'), 2)
  assert.equal(await evaluate('window.__walletTest.transactions'), 0)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
  console.log('PASS: shared wallet, both browser SDKs, encrypted recovery round-trip, rejection, disconnect cancellation, and zero transactions')
} finally {
  clearTimeout(timeout)
  await evaluate(`Object.keys(localStorage).filter(key => key.startsWith('darksol:payment-note:v1:${address}:')).forEach(key => localStorage.removeItem(key))`)
  await call('Page.close')
  socket.close()
}
