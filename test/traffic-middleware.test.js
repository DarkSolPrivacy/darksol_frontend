import test from 'node:test'
import assert from 'node:assert/strict'
import middleware, { config } from '../middleware.js'

test('traffic counts document requests without forwarding identifying data or blocking the page', async (t) => {
  t.mock.property(process, 'env', { ...process.env, VERCEL_ENV: 'production', TRAFFIC_INGEST_TOKEN: 'a'.repeat(64) })
  assert.ok(config.matcher.includes('/trace/:path*'))
  assert.ok(config.matcher.includes('/docs/:path*'))
  const requests = [], pending = []
  const key = Symbol.for('@vercel/request-context'), original = globalThis[key]
  globalThis[key] = { get: () => ({ waitUntil: (promise) => pending.push(promise) }) }
  t.after(() => { if (original) globalThis[key] = original; else delete globalThis[key] })
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, ...options }); return new Response(null, { status: 204 }) })
  const request = (path = '/', headers = {}, method = 'GET') => new Request(`https://darksol.app${path}`, {
    method, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0', 'x-vercel-ip-country': 'ES',
      cookie: 'wallet=secret', 'x-forwarded-for': '192.0.2.3', referer: 'https://example.org/private', ...headers },
  })
  const response = middleware(request(`/pay/${'c'.repeat(64)}?wallet=secret#recovery`))
  assert.equal(response.headers.get('x-middleware-next'), '1')
  assert.equal(response.headers.get('set-cookie'), null)
  await Promise.all(pending)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.darksol.app/internal/traffic')
  assert.deepEqual(JSON.parse(requests[0].body), { country: 'ES', page: '/pay' })
  assert.deepEqual(requests[0].headers, { Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type': 'application/json' })
  assert.equal(JSON.stringify(requests).includes('secret'), false)
  assert.equal(JSON.stringify(requests).includes('192.0.2.3'), false)
  for (const req of [request('/api/summary'), request('/admin-stats'), request('/assets/app.js'), request('/pay/not-an-invoice'),
    request('/', {}, 'POST'), request('/', {}, 'HEAD'), request('/', { accept: 'application/json' }),
    request('/', { 'sec-purpose': 'prefetch;prerender' }), request('/', { 'user-agent': 'Googlebot' }),
    request('/', { dnt: '1' }), request('/', { 'sec-gpc': '1' }), new Request('https://preview.vercel.app/', { headers: { accept: 'text/html' } })]) middleware(req)
  assert.equal(requests.length, 1)
  process.env.VERCEL_ENV = 'preview'; middleware(request()); assert.equal(requests.length, 1)
  process.env.VERCEL_ENV = 'production'; process.env.TRAFFIC_INGEST_TOKEN = ''; middleware(request()); assert.equal(requests.length, 1)
  process.env.TRAFFIC_INGEST_TOKEN = 'a'.repeat(64)
  middleware(request('/analytics', { 'x-vercel-ip-country': 'invalid' }))
  assert.deepEqual(JSON.parse(requests.at(-1).body), { country: 'ZZ', page: '/analytics' })
  for (const page of ['/', '/payment-links', '/analytics', '/trace', '/docs']) {
    middleware(request(`${page}?secret=hidden`))
    assert.deepEqual(JSON.parse(requests.at(-1).body), { country: 'ES', page })
  }
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  assert.equal(middleware(request('/payment-links')).headers.get('x-middleware-next'), '1')
  await Promise.all(pending)
})

test('docs and trace count normalized page loads while preserving rewrites and privacy exclusions', async (t) => {
  t.mock.property(process, 'env', { ...process.env, VERCEL_ENV: 'production', TRAFFIC_INGEST_TOKEN: 'a'.repeat(64) })
  assert.ok(config.matcher.includes('/trace/:path*'))
  assert.ok(config.matcher.includes('/docs/:path*'))
  const requests = [], pending = []
  const key = Symbol.for('@vercel/request-context'), original = globalThis[key]
  globalThis[key] = { get: () => ({ waitUntil: promise => pending.push(promise) }) }
  t.after(() => { if (original) globalThis[key] = original; else delete globalThis[key] })
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body)); return new Response(null, { status: 204 })
  })
  const visit = (url, headers = {}) => middleware(new Request(url, { headers: { accept: 'text/html', ...headers } }))
  const response = visit('https://docs.darksol.app/?ref=secret')
  assert.equal(response.headers.get('x-middleware-rewrite'), 'https://docs.darksol.app/docs/index.html')
  assert.deepEqual(requests.at(-1), { country: 'ZZ', page: '/docs' })
  for (const url of ['https://darksol.app/docs/', 'https://darksol.app/docs/index.html', 'https://docs.darksol.app/docs/']) {
    visit(url); assert.deepEqual(requests.at(-1), { country: 'ZZ', page: '/docs' })
  }
  for (const url of ['https://darksol.app/trace', 'https://darksol.app/trace/', 'https://darksol.app/trace/secret?wallet=secret']) {
    visit(url); assert.deepEqual(requests.at(-1), { country: 'ZZ', page: '/trace' })
  }
  const counted = requests.length
  for (const url of ['https://preview.vercel.app/docs', 'https://docs.darksol.app.evil.test/',
    'https://docs.darksol.app/docs/styles.css', 'https://docs.darksol.app/api/summary', 'https://docs.darksol.app/trace']) visit(url)
  for (const headers of [{ dnt: '1' }, { 'sec-gpc': '1' }, { 'user-agent': 'Googlebot' }, { 'sec-purpose': 'prefetch' }]) {
    assert.equal(visit('https://docs.darksol.app/', headers).headers.get('x-middleware-rewrite'), 'https://docs.darksol.app/docs/index.html')
    visit('https://darksol.app/trace', headers)
  }
  process.env.TRAFFIC_INGEST_TOKEN = ''
  assert.equal(visit('https://docs.darksol.app/').headers.get('x-middleware-rewrite'), 'https://docs.darksol.app/docs/index.html')
  assert.equal(requests.length, counted)
  assert.equal(JSON.stringify(requests).includes('secret'), false)
  await Promise.all(pending)
})

test('in-app page views count once with bounded categories and never proxy or forward identifying data', async (t) => {
  t.mock.property(process, 'env', { ...process.env, VERCEL_ENV: 'production', TRAFFIC_INGEST_TOKEN: 'a'.repeat(64) })
  assert.ok(config.matcher.includes('/api/page-view'))
  const requests = [], pending = []
  const key = Symbol.for('@vercel/request-context'), original = globalThis[key]
  globalThis[key] = { get: () => ({ waitUntil: promise => pending.push(promise) }) }
  t.after(() => { if (original) globalThis[key] = original; else delete globalThis[key] })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options }); return new Response(null, { status: 204 })
  })
  const request = (query = 'page=%2Ftrace', headers = {}, method = 'POST', host = 'darksol.app') =>
    new Request(`https://${host}/api/page-view?${query}`, { method, headers: {
      origin: 'https://darksol.app', 'sec-fetch-site': 'same-origin', 'x-vercel-ip-country': 'ES',
      cookie: 'wallet=secret', 'x-forwarded-for': '192.0.2.3', referer: 'https://darksol.app/trace/secret',
      ...headers,
    } })
  function invoke(req) {
    const response = middleware(req)
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-middleware-next'), null)
    assert.equal(response.headers.get('x-middleware-rewrite'), null)
    assert.equal(response.headers.get('set-cookie'), null)
    return response
  }
  for (const page of ['/', '/analytics', '/payment-links', '/trace', '/pay']) {
    const before = requests.length
    assert.equal(await invoke(request(`page=${encodeURIComponent(page)}`)).text(), '')
    assert.equal(requests.length, before + 1)
    assert.equal(requests.at(-1).url, 'https://api.darksol.app/internal/traffic')
    assert.deepEqual(JSON.parse(requests.at(-1).body), { country: 'ES', page })
    assert.deepEqual(requests.at(-1).headers, { Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type': 'application/json' })
  }
  invoke(new Request('https://darksol.app/api/page-view?page=%2Ftrace', { method: 'POST', headers: { origin: 'https://darksol.app' } }))
  assert.deepEqual(JSON.parse(requests.at(-1).body), { country: 'ZZ', page: '/trace' })
  const counted = requests.length
  for (const query of ['', 'page=', 'page=%2Fdocs', 'page=%2Ftrace%2Fsecret',
    `page=%2Fpay%2F${'c'.repeat(64)}`, 'page=%2Ftrace&wallet=secret', 'page=%2Ftrace&page=%2Ftrace',
    'page=%2Ftrace&page=%2Fpay', 'unknown=%2Ftrace']) invoke(request(query))
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) invoke(request(undefined, {}, method))
  for (const headers of [
    { origin: 'https://evil.test' }, { origin: 'https://docs.darksol.app' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { dnt: '1' }, { 'sec-gpc': '1' }, { 'user-agent': 'HeadlessChrome' }, { 'user-agent': 'Googlebot' },
    { purpose: 'prefetch' }, { 'sec-purpose': 'prerender' },
  ]) invoke(request(undefined, headers))
  invoke(new Request('https://darksol.app/api/page-view?page=%2Ftrace', { method: 'POST' }))
  for (const host of ['docs.darksol.app', 'preview.vercel.app', 'darksol.app.evil.test']) invoke(request(undefined, {}, 'POST', host))
  process.env.VERCEL_ENV = 'preview'; invoke(request())
  process.env.VERCEL_ENV = 'production'; process.env.TRAFFIC_INGEST_TOKEN = ''; invoke(request())
  assert.equal(requests.length, counted)
  assert.equal(JSON.stringify(requests).includes('secret'), false)
  assert.equal(JSON.stringify(requests).includes('192.0.2.3'), false)
  await Promise.all(pending)
})
