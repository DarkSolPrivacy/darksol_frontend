// Full document loads are counted at the edge. This covers in-app navigation
// using only a fixed page category: never a signature, invoice ID or visitor ID.
export function recordPageView(pathname) {
  if (globalThis.location?.hostname !== 'darksol.app'
    || globalThis.navigator?.doNotTrack === '1' || globalThis.navigator?.globalPrivacyControl) return
  const path = pathname.replace(/\/+$/, '') || '/'
  const page = ['/', '/analytics', '/payment-links'].includes(path) ? path
    : /^\/trace(?:\/|$)/.test(path) ? '/trace'
    : /^\/pay\/[a-f0-9]{64}$/.test(path) ? '/pay' : null
  if (!page) return
  // Analytics failures must never interrupt navigation or wallet operations.
  try {
    void fetch(`/api/page-view?${new URLSearchParams({ page })}`, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
      cache: 'no-store', keepalive: true,
    }).catch(() => {})
  } catch { /* Collection is best effort. */ }
}
