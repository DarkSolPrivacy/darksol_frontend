// Client for the backend queue that relays a proven withdrawal before a
// deadline. Requests carry the SDK payload and nothing else: no cookies, no
// wallet address, no merchant credentials. The job id lives only in this
// browser's localStorage.
const API = '/api/scheduled-withdrawals'
const KEY = 'darksol-scheduled-send'
const PRIVATE = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }

export const DELAY_MINUTES = [10, 20, 30]

export async function scheduleWithdrawal(params, minutes) {
  const response = await fetch(API, {
    ...PRIVATE, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params, deadline: Date.now() + minutes * 60_000 }),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Scheduling failed')
  return { id: result.id, sendBy: result.send_by }
}

// 404: the server no longer knows the job. It purges an hour after sending and
// forgets everything on restart, so this is "unknown", never "not sent".
export async function scheduledStatus(id) {
  const response = await fetch(`${API}/${id}`, PRIVATE)
  if (response.status === 404) return { status: 'unknown' }
  if (!response.ok) throw new Error('Delivery status unavailable')
  return response.json()
}

export async function cancelScheduled(id) {
  return (await fetch(`${API}/${id}`, { ...PRIVATE, method: 'DELETE' })).ok
}

export function loadScheduled() {
  try { return JSON.parse(localStorage.getItem(KEY)) } catch { return null }
}

export function saveScheduled(job) {
  try { job ? localStorage.setItem(KEY, JSON.stringify(job)) : localStorage.removeItem(KEY) } catch {}
}
