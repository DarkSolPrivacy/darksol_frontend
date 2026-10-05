import { next, rewrite, waitUntil } from '@vercel/functions'

// Direct loads and anonymous in-app page changes share the same aggregate counter.
export const config = { matcher: ['/', '/analytics', '/payment-links', '/pay/:id', '/trace/:path*', '/docs/:path*', '/api/page-view'] }

export default function middleware(request) {
  const token = process.env.TRAFFIC_INGEST_TOKEN
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '') || '/'
  const routeView = path === '/api/page-view'
  // Preserve the docs rewrite even when traffic collection is skipped.
  const docsRoot = url.hostname === 'docs.darksol.app' && path === '/'
  const response = routeView ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    : docsRoot ? rewrite(new URL('/docs/index.html', request.url)) : next()
  const page = routeView ? url.searchParams.get('page')
    : docsRoot || ['/docs', '/docs/index.html'].includes(path) ? '/docs'
    : url.hostname !== 'darksol.app' ? null
    : ['/', '/analytics', '/payment-links'].includes(path) ? path
    : /^\/trace(?:\/|$)/.test(path) ? '/trace'
    : /^\/pay\/[a-f0-9]{64}$/.test(path) ? '/pay' : null
  // Terminate every route-view request here, including ignored ones. Only a
  // same-origin POST with one bounded category can increment the counter.
  if (routeView && (request.method !== 'POST' || url.hostname !== 'darksol.app'
    || request.headers.get('origin') !== 'https://darksol.app'
    || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')
    || url.searchParams.size !== 1 || !['/', '/analytics', '/payment-links', '/trace', '/pay'].includes(page))) return response
  if (process.env.VERCEL_ENV !== 'production' || !/^[a-f0-9]{64}$/.test(token || '')
    || !['darksol.app', 'docs.darksol.app'].includes(url.hostname) || !page
    || (!routeView && (request.method !== 'GET' || !request.headers.get('accept')?.includes('text/html')))
    || /prefetch|prerender/i.test(`${request.headers.get('purpose')} ${request.headers.get('sec-purpose')}`)
    || /bot|crawler|spider|headless|preview/i.test(request.headers.get('user-agent') || '')
    || request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1') return response
  // Vercel supplies this header at the edge. Never forward the visitor's IP,
  // headers, URL, payment ID, transaction signature, referrer or user agent to the counter endpoint.
  const country = request.headers.get('x-vercel-ip-country') || 'ZZ'
  waitUntil(fetch('https://api.darksol.app/internal/traffic', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: /^[A-Z]{2}$/.test(country) ? country : 'ZZ', page }),
    signal: AbortSignal.timeout(3000), redirect: 'error',
  }).then((response) => {
    if (!response.ok) console.warn('Traffic counter unavailable')
  }).catch(() => { console.warn('Traffic counter unavailable') }))
  return response
}
