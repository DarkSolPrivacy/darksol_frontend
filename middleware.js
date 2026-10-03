import { next, rewrite, waitUntil } from '@vercel/functions'

// Count document requests only. Nothing is injected into the browser.
export const config = { matcher: ['/', '/analytics', '/payment-links', '/pay/:id'] }

export default function middleware(request) {
  const token = process.env.TRAFFIC_INGEST_TOKEN
  const url = new URL(request.url)
  // Middleware runs before static files, including the app's root index.html.
  if (url.hostname === 'docs.darksol.app' && url.pathname === '/') {
    return rewrite(new URL('/docs/index.html', request.url))
  }
  const page = ['/', '/analytics', '/payment-links'].includes(url.pathname.replace(/\/$/, '') || '/')
    || /^\/pay\/[a-f0-9]{64}\/?$/.test(url.pathname)
  if (process.env.VERCEL_ENV !== 'production' || !/^[a-f0-9]{64}$/.test(token || '')
    || url.hostname !== 'darksol.app' || !page || request.method !== 'GET'
    || !request.headers.get('accept')?.includes('text/html')
    || /prefetch|prerender/i.test(`${request.headers.get('purpose')} ${request.headers.get('sec-purpose')}`)
    || /bot|crawler|spider|headless|preview/i.test(request.headers.get('user-agent') || '')
    || request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1') return next()
  // Vercel supplies this header at the edge. Never forward the visitor's IP,
  // headers, URL, payment ID, referrer or user agent to the counter endpoint.
  const country = request.headers.get('x-vercel-ip-country') || 'ZZ'
  waitUntil(fetch('https://api.darksol.app/internal/traffic', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: /^[A-Z]{2}$/.test(country) ? country : 'ZZ',
      page: url.pathname.startsWith('/pay/') ? '/pay' : url.pathname.replace(/\/$/, '') || '/' }),
    signal: AbortSignal.timeout(3000), redirect: 'error',
  }).then((response) => {
    if (!response.ok) console.warn('Traffic counter unavailable')
  }).catch(() => { console.warn('Traffic counter unavailable') }))
  return next()
}
