import test from 'node:test'
import assert from 'node:assert/strict'
import middleware from '../middleware.js'

test('traffic counts document requests without forwarding identifying data or blocking the page', async (t) => {
  t.mock.property(process, 'env', { ...process.env, VERCEL_ENV: 'production', TRAFFIC_INGEST_TOKEN: 'a'.repeat(64) })
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
  for (const page of ['/', '/payment-links', '/analytics']) {
    middleware(request(`${page}?secret=hidden`))
    assert.deepEqual(JSON.parse(requests.at(-1).body), { country: 'ES', page })
  }
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  assert.equal(middleware(request('/payment-links')).headers.get('x-middleware-next'), '1')
  await Promise.all(pending)
})
