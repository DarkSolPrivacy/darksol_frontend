// The send button's progress for an Umbra v2 payment. Each step gets a share of
// the bar in proportion to how long it usually takes, so the bar moves at an
// even pace, whether the step is a 3-second request or a first read that takes
// minutes. Status lines carry the hint send-progress.js eases toward:
// { to, seconds, note }, `note` being a longer line shown under the button.

// Seconds per step, measured on mainnet in November 2026 (darksol.app with
// Solflare, a 6-core machine). A laptop proves slower; the bar's easing absorbs it.
export const STEP_SECONDS = Object.freeze({
  open: 3, // load the SDK and connect it to the wallet
  unlock: 8, // the wallet's unlock message, once per tab
  register: 35, // first payment of a wallet: approve, land, wait for the indexer
  read: 5, // reading the balance when this browser already holds it
  page: 24, // one page of a longer read: up to 1,000 notes checked and stored in the browser
  prepare: 4,
  prove: 25, // the deposit's proof
  approve: 8, // the wallet's approval
  deposit: 9, // funding and deposit landing
  settle: 3,
  payoutProve: 25,
  payoutSend: 8, // relayed and confirmed
  swap: 20, // the one-time wallet's Jupiter swap and payout
})

// A read's pages, one per 1,000 notes and one for the unsealed tail. A store this
// browser has never filled reads from the wallet's registration on (the SDK asks
// Umbra's context API where that is, nimbus-solana-web 0.5), which the page cannot
// know beforehand, so it plans a typical first read; a known store reads only what
// was added since its last read. `nextLeaf` is the pool's note count from the
// indexer's CDN manifest, `savedLeaf` the count at this browser's last full read.
// The SDK reads PAGES_PER_ROUND pages of each stream per round (its reads.js).
export const NOTES_PER_PAGE = 1000
export const PAGES_PER_ROUND = 4
const FIRST_READ_GUESS = 4
export function expectedPages({ known, savedLeaf, nextLeaf }) {
  const count = Number.isSafeInteger(nextLeaf) && nextLeaf >= 0 ? nextLeaf : null
  if (!known) return FIRST_READ_GUESS
  if (count === null || !Number.isSafeInteger(savedLeaf)) return 1
  return 1 + Math.floor(Math.max(0, count - savedLeaf) / NOTES_PER_PAGE)
}

// The steps of one payment, in order, with their seconds.
export function planSteps({ unlocked = true, register = false, pages = 1, deposit = true, payout = true, swap = false } = {}) {
  const S = STEP_SECONDS
  const steps = [['open', S.open]]
  if (!unlocked) steps.push(['unlock', S.unlock])
  if (register) steps.push(['register', S.register])
  steps.push(['read', pages > 1 ? pages * S.page : S.read])
  if (deposit) steps.push(['prepare', S.prepare], ['prove', S.prove], ['approve', S.approve], ['deposit', S.deposit])
  if (deposit && (payout || swap)) steps.push(['settle', S.settle])
  if (payout || swap) steps.push(['payoutProve', S.payoutProve], ['payoutSend', S.payoutSend])
  if (swap) steps.push(['swap', S.swap])
  return steps
}

// Reports steps against a plan. `step(name, text, { part, seconds, note })` eases
// the bar toward `part` (0 to 1) of the step's share, over `seconds` (by default
// that part of the step's own); a step the plan lacks reports the text alone.
// `replan` swaps the plan once the session says what the payment needs; the bar
// never moves back (send-progress.js).
export function createProgress(onStatus, steps) {
  let marks = new Map()
  const replan = (next) => {
    const total = next.reduce((sum, [, seconds]) => sum + seconds, 0) || 1
    let elapsed = 0
    marks = new Map(next.map(([name, seconds]) => {
      const mark = { from: elapsed / total, to: (elapsed + seconds) / total, seconds }
      elapsed += seconds
      return [name, mark]
    }))
  }
  replan(steps)
  return {
    replan,
    has: (name) => marks.has(name),
    step(name, text, { part = 1, seconds, note } = {}) {
      const mark = marks.get(name)
      if (!mark) return onStatus(text)
      const share = Math.min(1, Math.max(0, part))
      onStatus(text, { to: mark.from + (mark.to - mark.from) * share, seconds: Math.max(1, seconds ?? mark.seconds * share), ...(note ? { note } : {}) })
    },
  }
}

// What a long read says while `page` (of about `pages`) is being read: the
// button's line, and the note under it with the minutes left.
export function readLines({ known, page, pages }) {
  const total = Math.max(pages, page)
  const left = Math.max(1, Math.round(((total - page + 1) * STEP_SECONDS.page) / 60))
  const minutes = `about ${left} min left`
  return known
    ? { text: `Catching up on Umbra v2… (page ${page} of ${total})`, note: `Reading what happened in the pool since your last visit: ${minutes}.` }
    : { text: `Setting up Umbra v2 on this device… (page ${page} of ${total})`, note: `First time here: Umbra v2 checks the pool's notes since you registered, in your browser, to find your funds, so nobody else learns which are yours. This happens only once: ${minutes}. Next time it takes seconds.` }
}
