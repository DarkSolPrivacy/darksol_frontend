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

// The edge counted the campaign tags with this page load. Dropping them from the
// address keeps a reload or a shared link from counting the campaign again.
export function dropCampaignTags() {
  try {
    const url = new URL(globalThis.location.href)
    const tags = [...url.searchParams.keys()].filter((key) => key.startsWith('utm_'))
    if (!tags.length) return
    for (const key of tags) url.searchParams.delete(key)
    globalThis.history.replaceState(globalThis.history.state, '', url)
  } catch { /* The address keeps its tags. */ }
}
