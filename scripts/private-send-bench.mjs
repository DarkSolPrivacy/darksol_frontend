// Times a private send in headless Chromium without moving money, for
// docs/PRIVATE_SEND_PERFORMANCE.md. It serves a build at https://darksol-test.app,
// connects a throwaway wallet made for the run (its key never leaves this
// process and is never written anywhere), fakes only that wallet's SOL balance
// in RPC answers, picks the pool's "Now" option, clicks send and reads the
// stage table the send prints (protocols/shared/stage-timings.js).
//
// Nothing is broadcast: POSTs to the Privacy Cash relayer's /deposit and
// /withdraw, Cloak's /transact and every sendTransaction are aborted. So a run
// reaches the signed deposit only (Umbra v2: the registration, which an
// unfunded wallet cannot pay for). Request interception disables the browser's
// HTTP cache, so every run downloads as a first visit does.
//
// Needs playwright-core and a Chromium, neither a dependency of this repo. In
// the Playwright image, with the build in dist/ and playwright-core installed
// in some directory (Node resolves it from beside the script, hence the mount):
//   docker run --rm --init --shm-size=256m -v "$PWD":/app:ro -v "$PWD/bench-out":/out \
//     -v <that directory>/node_modules:/pw/node_modules:ro -v "$PWD/scripts/private-send-bench.mjs":/pw/bench.mjs:ro \
//     -e DIST=/app/dist -e OUT=/out/privacycash.json -e POOL=privacycash \
//     -e RPC_KEY=<the k of vercel.json's /api/solana-rpc rewrite> \
//     -w /pw mcr.microsoft.com/playwright:v1.56.0-noble node bench.mjs
//
// env: DIST (build directory), OUT (result file), RPC_KEY, POOL (privacycash | cloakc | umbrav2),
//      ASSET (SOL), AMOUNT (0.05), RUNS (3),
//      WAIT_PRELOAD_MS (pause between choosing the route and the click, for the preload to finish),
//      LINK_MBIT (the build's own files arrive as over one link of this speed),
//      KEEP_PROFILE=1 (one browser profile for every run: a returning browser),
//      SEND_TIMEOUT_MS (420000).
import { chromium } from 'playwright-core'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DIST = process.env.DIST || '/dist'
const POOL = process.env.POOL || 'privacycash'
const ASSET = process.env.ASSET || 'SOL'
const AMOUNT = process.env.AMOUNT || '0.05'
const RUNS = Number(process.env.RUNS || 3)
const OUT = process.env.OUT || '/out/run.json'
const WAIT_PRELOAD_MS = Number(process.env.WAIT_PRELOAD_MS || 0)
const KEEP_PROFILE = process.env.KEEP_PROFILE === '1'
const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS || 420_000)
const LINK_MBIT = Number(process.env.LINK_MBIT || 0)
const link = { freeAt: 0 }
const ORIGIN = 'https://darksol-test.app'
const API = 'https://api.darksol.app'
const RPC_KEY = process.env.RPC_KEY || ''
const POOL_NAMES = { privacycash: 'Privacy Cash', cloakc: 'Cloak', umbrav2: 'Umbra v2' }
// A recipient that is not the sender: a second throwaway key, never used again.
const FAKE_LAMPORTS = 5_000_000_000

const log = (text) => { const line = `${new Date().toISOString().slice(11, 19)} ${text}`; console.log(line); try { fs.appendFileSync(OUT.replace(/\.json$/, '.log'), line + '\n') } catch {} }
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes) {
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let text = ''
  while (value > 0n) { text = ALPHABET[Number(value % 58n)] + text; value /= 58n }
  for (const byte of bytes) { if (byte) break; text = '1' + text }
  return text
}
function throwaway() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' })).slice(-32)
  return { privateKey, raw, address: base58(raw) }
}
const wallet = throwaway()
const recipient = throwaway().address

function shortvec(bytes, offset) {
  let value = 0, size = 0
  for (;;) { const byte = bytes[offset + size]; value |= (byte & 0x7f) << (7 * size); size++; if (!(byte & 0x80)) break }
  return [value, size]
}
function signTransaction(bytes) {
  const [count, size] = shortvec(bytes, 0)
  const message = bytes.subarray(size + count * 64)
  let at = message[0] & 0x80 ? 1 : 0
  const required = message[at]; at += 3
  const [keys, keySize] = shortvec(message, at); at += keySize
  let index = -1
  for (let i = 0; i < Math.min(keys, required); i++) if (Buffer.compare(message.subarray(at + 32 * i, at + 32 * i + 32), wallet.raw) === 0) index = i
  if (index < 0) throw new Error('the throwaway wallet is not a signer of this transaction')
  const signed = Uint8Array.from(bytes)
  signed.set(crypto.sign(null, message, wallet.privateKey), size + index * 64)
  return signed
}

const walletScript = `(() => {
  const account = { address: ${JSON.stringify(wallet.address)}, publicKey: new Uint8Array(${JSON.stringify([...wallet.raw])}), chains: ['solana:mainnet'], features: ['solana:signMessage', 'solana:signTransaction'], label: 'Bench' }
  let connected = []
  const listeners = new Set()
  const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  const emit = () => listeners.forEach((listener) => listener({ accounts: connected }))
  const wallet = {
    version: '1.0.0', name: 'Bench Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
    chains: ['solana:mainnet'],
    get accounts() { return connected },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { if (!connected.length) { connected = [account]; emit() } return { accounts: connected } } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = []; emit() } },
      'standard:events': { version: '1.0.0', on: (event, listener) => { if (event !== 'change') return () => {}; listeners.add(listener); return () => listeners.delete(listener) } },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => Promise.all(inputs.map(async ({ message }) => ({ signedMessage: message, signature: unb64(await window.__benchSign('message', b64(message))) }))) },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => Promise.all(inputs.map(async ({ transaction }) => ({ signedTransaction: unb64(await window.__benchSign('transaction', b64(transaction))) }))) },
    },
  }
  const register = (api) => api.register(wallet)
  class RegisterEvent extends Event { constructor() { super('wallet-standard:register-wallet', { bubbles: false, cancelable: false, composed: false }) } get detail() { return register } }
  try { window.dispatchEvent(new RegisterEvent()) } catch {}
  window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail))
  try {
    localStorage.setItem('darksol:onboarded:v2', '1')
    localStorage.setItem('darksol:wallet:v1', 'Bench Wallet')
    localStorage.setItem('darksol:send-settings:v1', JSON.stringify({ mode: 'custom', maxWait: 'now' }))
  } catch {}
})()`

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml', '.zkey': 'application/octet-stream', '.bin': 'application/octet-stream', '.wcd': 'application/octet-stream' }
const ISOLATED = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

function fakeAccount(encoding) {
  return { data: encoding === 'jsonParsed' || encoding === 'base64' || !encoding ? ['', 'base64'] : '', executable: false, lamports: FAKE_LAMPORTS, owner: '11111111111111111111111111111111', rentEpoch: 18446744073709552000, space: 0 }
}

async function answerRpc(route, request, state) {
  const forward = async (body) => {
    const response = await route.fetch({ url: `${API}/api/solana-rpc?k=${RPC_KEY}`, postData: JSON.stringify(body), headers: { 'content-type': 'application/json', dnt: '1' } })
    return response.json()
  }
  let body
  try { body = JSON.parse(request.postData() || 'null') } catch { body = null }
  if (!body) return route.abort('failed')
  const calls = Array.isArray(body) ? body : [body]
  if (calls.some((call) => call.method === 'sendTransaction' || call.method === 'sendRawTransaction')) {
    state.aborted.push({ what: 'rpc sendTransaction', at: Date.now() })
    return route.abort('failed')
  }
  const answers = await Promise.all(calls.map(async (call) => {
    const [first, config] = call.params ?? []
    const context = { apiVersion: '3.0.0', slot: state.slot }
    if (call.method === 'getBalance' && first === wallet.address) return { jsonrpc: '2.0', id: call.id, result: { context, value: FAKE_LAMPORTS } }
    if (call.method === 'getAccountInfo' && first === wallet.address) return { jsonrpc: '2.0', id: call.id, result: { context, value: fakeAccount(config?.encoding) } }
    const answer = await forward(call)
    if (call.method === 'getMultipleAccounts' && Array.isArray(first) && first.includes(wallet.address) && answer?.result?.value) {
      first.forEach((key, index) => { if (key === wallet.address) answer.result.value[index] = fakeAccount(config?.encoding) })
    }
    if (call.method === 'getSlot' && Number.isSafeInteger(answer?.result)) state.slot = answer.result
    if (answer?.result?.context?.slot) state.slot = answer.result.context.slot
    return answer
  }))
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? answers : answers[0]) })
}

async function handle(route, state) {
  const request = route.request()
  const url = new URL(request.url())
  const method = request.method()
  try {
    if (url.origin === ORIGIN) {
      if (url.pathname === '/api/solana-rpc') return await answerRpc(route, request, state)
      if (url.pathname === '/api/event' || url.pathname === '/api/page-view') return await route.fulfill({ status: 204, body: '' })
      // Umbra's relayer submissions go through the gateway; a throwaway wallet has nothing to relay, but never let one out.
      if (method === 'POST' && /^\/api\/umbra-gateway\/relayer\/.*(submit|relay|send)/i.test(url.pathname)) { state.aborted.push({ what: `umbra ${url.pathname}`, at: Date.now() }); return await route.abort('failed') }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin-stats')) {
        const response = await route.fetch({ url: `${API}${url.pathname}${url.search}`, headers: { ...request.headers(), dnt: '1' } })
        return await route.fulfill({ response })
      }
      let file = path.join(DIST, decodeURIComponent(url.pathname))
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
      // LINK_MBIT: the build's own files arrive as over one link of that speed, one after another.
      if (LINK_MBIT) {
        const ready = Math.max(Date.now(), link.freeAt) + fs.statSync(file).size * 8 / (LINK_MBIT * 1e6) * 1000
        link.freeAt = ready
        await new Promise((resolve) => setTimeout(resolve, ready - Date.now()))
      }
      return await route.fulfill({ status: 200, path: file, contentType: TYPES[path.extname(file)] || 'application/octet-stream', headers: ISOLATED })
    }
    if (url.hostname === 'api3.privacycash.org' && method === 'POST' && /^\/(deposit|withdraw)(\/spl)?$/.test(url.pathname)) {
      state.aborted.push({ what: `privacycash ${url.pathname}`, at: Date.now() })
      return await route.abort('failed')
    }
    if (url.hostname === 'api.cloak.ag' && method === 'POST' && /\/transact/.test(url.pathname)) {
      state.aborted.push({ what: `cloak ${url.pathname}`, at: Date.now() })
      return await route.abort('failed')
    }
    if (method === 'POST' && /sendTransaction/.test(request.postData() || '')) {
      state.aborted.push({ what: `sendTransaction to ${url.host}`, at: Date.now() })
      return await route.abort('failed')
    }
    if (url.hostname.endsWith('umbraprivacy.com') && /registration\/sponsor/.test(url.pathname)) return await route.abort('failed')
    return await route.continue()
  } catch (error) {
    if (!/closed|disposed|Target page/.test(String(error))) console.error('route error', url.href.slice(0, 120), String(error).slice(0, 200))
    try { await route.abort('failed') } catch {}
  }
}

const classify = (url) => {
  if (url.hostname === 'api3.privacycash.org') return url.pathname.startsWith('/utxos/range') ? 'pc scan' : `pc ${url.pathname.split('/').slice(0, 3).join('/')}`
  if (/\/circuit2\//.test(url.pathname)) return 'pc circuit'
  if (url.hostname === 'storage.googleapis.com') return 'cloak circuit'
  if (url.hostname === 'api.cloak.ag') return 'cloak relay'
  if (/\.(zkey|wcd)$/.test(url.pathname) || /proving|circuit/i.test(url.pathname)) return 'umbra keys'
  if (url.pathname.startsWith('/nimbus/')) return 'umbra assets'
  if (url.pathname.startsWith('/api/umbra-gateway')) return 'umbra gateway'
  if (url.pathname === '/api/solana-rpc') return 'rpc'
  if (url.pathname.startsWith('/assets/')) return 'app code'
  return null
}

async function oneRun(browser, shared, index) {
  const context = shared ?? await browser.newContext({ viewport: { width: 1280, height: 950 }, ignoreHTTPSErrors: true })
  const state = { slot: 300_000_000, aborted: [], signs: [], tables: [], logs: [], net: {} }
  if (!shared || index === 0) {
    await context.addInitScript(walletScript)
    await context.exposeBinding('__benchSign', (source, kind, data) => {
      const bytes = new Uint8Array(Buffer.from(data, 'base64'))
      const live = context.__state
      live.signs.push({ kind, at: Date.now() })
      const out = kind === 'message' ? new Uint8Array(crypto.sign(null, bytes, wallet.privateKey)) : signTransaction(bytes)
      return Buffer.from(out).toString('base64')
    })
    await context.route('**/*', (route) => handle(route, context.__state))
  }
  context.__state = state
  const page = await context.newPage()
  page.on('console', async (message) => {
    try {
      if (message.type() === 'table') state.tables.push({ at: Date.now(), rows: await message.args()[0].jsonValue() })
      else if (/send timings|\[warn\]|\[error\]/i.test(message.text())) state.logs.push(message.text().slice(0, 300))
    } catch {}
  })
  page.on('pageerror', (error) => state.logs.push(`pageerror ${String(error).slice(0, 300)}`))
  page.on('requestfinished', async (request) => {
    try {
      const kind = classify(new URL(request.url()))
      if (!kind) return
      const sizes = await request.sizes()
      const entry = state.net[kind] ??= { requests: 0, bytes: 0, afterClick: { requests: 0, bytes: 0 } }
      entry.requests++; entry.bytes += sizes.responseBodySize
      if (state.clickAt) { entry.afterClick.requests++; entry.afterClick.bytes += sizes.responseBodySize }
    } catch {}
  })

  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' })
  await page.waitForSelector('[aria-label="Amount"]', { timeout: 60_000 })
  const isolated = await page.evaluate(() => window.crossOriginIsolated)
  // Asset: the amount field's token button opens a menu.
  const setAsset = async () => {
    const current = await page.evaluate(() => document.querySelector('.assetSelect, [aria-label="Asset"], .amountAsset')?.textContent?.trim() ?? null)
    if (current && current.includes(ASSET)) return
    const opener = page.locator('.sendCard button', { hasText: /^(USDC|SOL|USDT)$/ }).first()
    await opener.click()
    await page.locator('.sendCard [role="menu"] button, .sendCard [role="listbox"] button, .assetMenu button', { hasText: new RegExp(`^${ASSET}$`) }).first().click()
  }
  await setAsset()
  // The destination follows only when it is set too; otherwise the form plans a swap.
  if (!(await page.locator('[aria-label="Destination asset"]').textContent()).includes(ASSET)) {
    await page.click('[aria-label="Destination asset"]')
    await page.locator('.destinationAssetMenu button', { hasText: new RegExp(`^\\s*${ASSET}\\s*$`) }).first().click()
  }
  await page.fill('[aria-label="Amount"]', AMOUNT)
  await page.fill('[aria-label="Receiver 1 address"]', recipient)
  // The pool's group, then its "Now" option.
  const head = page.locator(`button.privGroupHead[aria-label^="${POOL_NAMES[POOL]},"]`)
  await head.waitFor({ timeout: 60_000 })
  if (await head.getAttribute('aria-expanded') !== 'true') await head.click()
  const now = page.locator('.privGroup', { has: head }).locator('label.privOption', { hasText: 'Now' }).first()
  await now.locator('input[type=radio]').check()
  const button = page.locator('.actionArea > button')
  await page.waitForFunction(() => /now/i.test(document.querySelector('.actionArea > button')?.textContent ?? '') && !document.querySelector('.actionArea > button').disabled, null, { timeout: 60_000 })
  if (WAIT_PRELOAD_MS) await page.waitForTimeout(WAIT_PRELOAD_MS)
  const before = state.tables.length
  state.clickAt = Date.now()
  await button.click()
  log(`run ${index + 1}: clicked`)
  // The send ends when its timings table prints or, on a build without one,
  // when the page reports the send's result.
  const deadline = Date.now() + SEND_TIMEOUT_MS
  let ended = null
  // Never waits on a busy page for longer than 3 s per look.
  const look = (fn) => Promise.race([page.evaluate(fn).catch(() => null), new Promise((resolve) => setTimeout(() => resolve(undefined), 3000))])
  const readError = () => document.querySelector('.transferResult')?.textContent ?? ''
  const readButton = () => document.querySelector('.actionArea > button')?.textContent ?? ''
  let lastLog = 0
  while (Date.now() < deadline) {
    if (state.tables.length > before) { ended = 'table'; break }
    const error = await look(readError)
    if (error) { await page.waitForTimeout(700); ended = state.tables.length > before ? 'table' : 'error'; break }
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now()
      log(`  t+${Math.round((Date.now() - state.clickAt) / 1000)}s button="${String(await look(readButton)).slice(0, 60)}" signs=${state.signs.length} aborted=${state.aborted.length} net=${Object.entries(state.net).map(([kind, entry]) => `${kind}:${entry.requests}`).join(',')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const endAt = Date.now()
  const errorText = String(await look(readError) ?? '')
  if (!ended) await page.screenshot({ path: OUT.replace(/\.json$/, `-timeout-${index + 1}.png`) }).catch(() => {})
  const signedTx = state.signs.find((sign) => sign.kind === 'transaction' && sign.at >= state.clickAt)
  const result = {
    run: index + 1, pool: POOL, asset: ASSET, isolated, ended,
    clickToSignedMs: signedTx ? signedTx.at - state.clickAt : null,
    clickToEndMs: endAt - state.clickAt,
    signs: state.signs.filter((sign) => sign.at >= state.clickAt).map((sign) => ({ kind: sign.kind, ms: sign.at - state.clickAt })),
    aborted: state.aborted.map((entry) => ({ what: entry.what, ms: entry.at - state.clickAt })),
    table: state.tables.at(-1)?.rows ?? null,
    net: state.net, error: errorText.slice(0, 300), logs: state.logs.slice(-8),
  }
  await page.close()
  if (!shared) await context.close()
  return result
}

// Median and range per stage across the runs, in seconds.
function summary(results) {
  const stages = new Map()
  for (const result of results) {
    const run = new Map()
    for (const row of result.table ?? []) { const key = row.stage ? `${row.leg} / ${row.stage}` : 'total'; run.set(key, (run.get(key) ?? 0) + row.ms) }
    if (result.clickToSignedMs !== null) run.set('click to signed deposit', result.clickToSignedMs)
    for (const [key, ms] of run) stages.set(key, [...(stages.get(key) ?? []), ms])
  }
  const seconds = (ms) => (ms / 1000).toFixed(1)
  return [...stages].map(([stage, values]) => {
    const all = [...values, ...Array(results.length - values.length).fill(0)].sort((a, b) => a - b)
    const median = all.length % 2 ? all[(all.length - 1) / 2] : (all[all.length / 2 - 1] + all[all.length / 2]) / 2
    return `${stage.padEnd(34)}${seconds(median).padStart(7)} s  [${seconds(all[0])}–${seconds(all.at(-1))}]`
  }).join('\n')
}

const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-dev-shm-usage'] })
const results = []
try {
  const shared = KEEP_PROFILE ? await browser.newContext({ viewport: { width: 1280, height: 950 }, ignoreHTTPSErrors: true }) : null
  for (let index = 0; index < RUNS; index++) {
    const result = await oneRun(browser, shared, index)
    results.push(result)
    log(JSON.stringify({ run: result.run, ended: result.ended, clickToSignedMs: result.clickToSignedMs, clickToEndMs: result.clickToEndMs, aborted: result.aborted.map((entry) => entry.what), error: result.error.slice(0, 120) }))
    fs.writeFileSync(OUT, JSON.stringify({ pool: POOL, asset: ASSET, amount: AMOUNT, linkMbit: LINK_MBIT, waitPreloadMs: WAIT_PRELOAD_MS, cores: (await import('node:os')).cpus().length, results }, null, 1))
  }
} finally { await browser.close() }
log(`${POOL}, ${results.length} runs, median [range]:\n${summary(results)}`)
