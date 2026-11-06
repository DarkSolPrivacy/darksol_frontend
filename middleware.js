import { next, rewrite, waitUntil } from '@vercel/functions'

// Direct loads and anonymous in-app page changes share the same aggregate counter;
// /api/event carries product counters (src/product-events.js).
export const config = { matcher: ['/', '/analytics', '/payment-links', '/pay/:id', '/trace/:path*', '/docs/:path*', '/api/page-view', '/api/event'] }

const EVENT = /^[a-z][a-z_]{0,39}$/, KEY = /^[a-z][a-z_]{0,23}$/, VALUE = /^[a-z0-9][a-z0-9_]{0,31}$/
// A campaign URL's utm_source/utm_campaign, in the only shape the counter accepts.
const CAMPAIGN_TAG = /^[a-z0-9][a-z0-9._-]{0,39}$/

export default function middleware(request) {
  const token = process.env.TRAFFIC_INGEST_TOKEN
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '') || '/'
  const routeView = path === '/api/page-view', productEvent = path === '/api/event'
  const beacon = routeView || productEvent
  // Preserve the docs rewrite even when traffic collection is skipped.
  const docsRoot = url.hostname === 'docs.darksol.app' && path === '/'
  const response = beacon ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    : docsRoot ? rewrite(new URL('/docs/index.html', request.url)) : next()
  const page = productEvent ? null : routeView ? url.searchParams.get('page')
    : docsRoot || ['/docs', '/docs/index.html'].includes(path) ? '/docs'
    : url.hostname !== 'darksol.app' ? null
    : ['/', '/analytics', '/payment-links'].includes(path) ? path
    : /^\/trace(?:\/|$)/.test(path) ? '/trace'
    : /^\/pay\/[a-f0-9]{64}$/.test(path) ? '/pay' : null
  const params = [...url.searchParams]
  const event = productEvent && url.searchParams.get('e')
  const validEvent = productEvent && EVENT.test(event || '') && params.length <= 9 && new Set(params.map(([key]) => key)).size === params.length
    && params.every(([key, value]) => key === 'e' || (KEY.test(key) && VALUE.test(value)))
  // Terminate every beacon request here, including ignored ones. Only a
  // same-origin POST with bounded categories can increment a counter.
  if (beacon && (request.method !== 'POST' || url.hostname !== 'darksol.app'
    || request.headers.get('origin') !== 'https://darksol.app'
    || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')
    || (routeView && (url.searchParams.size !== 1 || !['/', '/analytics', '/payment-links', '/trace', '/pay'].includes(page)))
    || (productEvent && !validEvent))) return response
  if (process.env.VERCEL_ENV !== 'production' || !/^[a-f0-9]{64}$/.test(token || '')
    || !['darksol.app', 'docs.darksol.app'].includes(url.hostname) || !(page || validEvent)
    || (!beacon && (request.method !== 'GET' || !request.headers.get('accept')?.includes('text/html')))
    || /prefetch|prerender/i.test(`${request.headers.get('purpose')} ${request.headers.get('sec-purpose')}`)
    || /bot|crawler|spider|headless|preview/i.test(request.headers.get('user-agent') || '')
    || request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1') return response
  // Vercel supplies the country header at the edge. Never forward the visitor's IP,
  // headers, URL, payment ID, transaction signature, referrer or user agent; an
  // event goes without even the country.
  const country = request.headers.get('x-vercel-ip-country') || 'ZZ'
  const tag = (name) => { const value = url.searchParams.get(name)?.trim().toLowerCase(); return value && CAMPAIGN_TAG.test(value) ? value : null }
  const source = !beacon && tag('utm_source'), campaign = source && tag('utm_campaign')
  const [endpoint, body] = productEvent
    ? ['events', { event, props: Object.fromEntries(params.filter(([key]) => key !== 'e')) }]
    : ['traffic', { country: /^[A-Z]{2}$/.test(country) ? country : 'ZZ', page, ...source && { source }, ...campaign && { campaign } }]
  waitUntil(fetch(`https://api.darksol.app/internal/${endpoint}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000), redirect: 'error',
  }).then((response) => {
    if (!response.ok) console.warn('Traffic counter unavailable')
  }).catch(() => { console.warn('Traffic counter unavailable') }))
  return response
}
