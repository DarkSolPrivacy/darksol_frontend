// The send button's progress bar while a payment runs.
//
// The bar is `{ to, seconds, key, note }`: the button's fill eases toward `to`
// (0 to 1) over about `seconds`, so a long step (a proof that takes a minute)
// keeps moving instead of sitting still, and the next status line retargets it
// from wherever it got to.
//
// An adapter that knows its steps passes a hint with its status line,
// `onStatus(text, { to, seconds, note })` (Umbra v2 does); `note` is a longer
// line shown under the button while that step runs, such as why it takes long.
// A line without one still moves the bar: each new kind of step goes a third of
// the way to CEILING, and lines that differ only in numbers ("Scanning notes
// 400…", "… 800…") count as the same step. The bar never moves back, and only
// a finished payment fills it.

export const START = Object.freeze({ to: 0.04, seconds: 0.4, key: '', note: '' })
export const CEILING = 0.92
const GUESSED_STEP_SECONDS = 20

const stepKey = (text) => String(text ?? '').replace(/[\d.,]+/g, '#').trim()
const clamp = (value) => Math.min(0.99, Math.max(0, value))

export function nextProgress(current, text, hint) {
  const bar = current ?? START
  const key = stepKey(text)
  if (hint && Number.isFinite(hint.to)) {
    return { to: Math.max(bar.to, clamp(hint.to)), seconds: Math.max(0.2, Number(hint.seconds) || 2), key, note: typeof hint.note === 'string' ? hint.note : '' }
  }
  if (key === bar.key) return bar
  return { to: Math.max(bar.to, bar.to + (CEILING - bar.to) / 3), seconds: GUESSED_STEP_SECONDS, key, note: '' }
}

// Waiting on the user: the wallet has a prompt open.
export const awaitsWallet = (text) => /^Approve\b/i.test(String(text ?? ''))
