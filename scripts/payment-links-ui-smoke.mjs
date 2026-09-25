// Run with a Chrome remote-debugging session; use real pointer events so labels
// exercise focus/blur and native radio activation (element.click() misses the crash).
import assert from 'node:assert/strict'

const target = process.argv[2] || 'http://127.0.0.1:5173/payment-links'
const port = process.env.CHROME_DEBUG_PORT || '9223'
const page = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
const pending = new Map()
const errors = []
let id = 0
let crashed = false
const timeout = setTimeout(() => { console.error('Payment links browser check timed out'); process.exit(1) }, 30_000)

socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
  if (message.method === 'Inspector.targetCrashed') {
    crashed = true
    for (const request of pending.values()) request.reject(new Error('Chrome renderer crashed'))
    pending.clear()
  }
  const request = pending.get(message.id)
  if (request) {
    pending.delete(message.id)
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
  }
})

function call(method, params = {}) {
  if (crashed) return Promise.reject(new Error('Chrome renderer crashed'))
  const nextId = ++id
  return new Promise((resolve, reject) => {
    pending.set(nextId, { resolve, reject })
    socket.send(JSON.stringify({ id: nextId, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const tick = () => new Promise(resolve => setTimeout(resolve, 100))
async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    element.scrollIntoView({ block: 'center' })
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await tick()
}

try {
  await call('Inspector.enable')
  await call('Runtime.enable')
  await call('Page.navigate', { url: target })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('Boolean(document.querySelector(".paymentSort"))')) break
    await tick()
  }
  assert.equal(await evaluate('document.querySelector("h1")?.textContent'), 'Receive privately')
  for (const width of [880, 390, 320]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 714, deviceScaleFactor: 1, mobile: width < 760 })
    // Media queries re-apply on the next frame; a click before that lands on the old layout.
    await call('Runtime.evaluate', { expression: 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))', awaitPromise: true })
    for (let attempt = 0; attempt < 3; attempt++) {
      await click('.paymentSort summary')
      await click('.paymentSortOptions label:nth-of-type(2)')
      assert.equal(await evaluate('document.querySelector(".paymentSortLabel").textContent'), 'Most active first')
      await click('.paymentSortOptions label:nth-of-type(1)')
      assert.equal(await evaluate('document.querySelector(".paymentSortLabel").textContent'), 'Lowest fees first')
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown' })
      await tick()
      assert.equal(await evaluate('document.querySelector(".paymentSortLabel").textContent'), 'Most active first')
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
      assert.equal(await evaluate('document.querySelector(".paymentSort").open'), false)
      assert.equal(await evaluate('document.activeElement === document.querySelector(".paymentSort summary")'), true)
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS: option text clicks, keyboard selection and Escape at 880px, 390px and 320px')
} finally {
  clearTimeout(timeout)
  if (!crashed) await call('Page.close')
  socket.close()
}
