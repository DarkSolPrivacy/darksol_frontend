// Pool privacy stats on /analytics: the public clues the trace page reads, counted
// across a whole pool. The backend computes them (darksol-backend
// docs/POOL_PRIVACY.md, GET /api/pool-privacy); everything here is wording.

// The pools the backend counts: the ones the trace page can trace.
export const PRIVACY_POOLS = ['privacycash', 'cloakc', 'umbrav2']

// The linker's rules (backend docs/FORENSIC_LINKER.md) as short names.
export const RULE_NAMES = {
  self_relay: 'Own signature',
  same_address: 'Paid back to itself',
  only_feasible: 'Only wallet with enough',
  exact_balance: 'Emptied the wallet',
  exact_deposit: 'Same amount as one deposit',
  pair_sum: 'Pair emptied the wallet',
  root_pinned: 'Proof right after deposit',
}

// Clues the trace page does not read yet: a name, with what it means on hover.
export const SOON_CLUES = [
  { title: 'Shared funder', text: 'One wallet sent the SOL several deposit wallets started with, so their deposits are one person’s.' },
  { title: 'Matching sets', text: 'Three or more withdrawals that add up to exactly what one wallet deposited.' },
  { title: 'Unusual fees', text: 'A fee or relayer most withdrawals do not use marks every withdrawal made with it.' },
]

const count = (value) => Number(value || 0).toLocaleString('en-US')

/** `part` of `whole` as a percentage, or a dash when there is nothing to divide. */
export function share(part, whole) {
  if (!whole) return '—'
  const percent = (100 * part) / whole
  return `${percent > 0 && percent < 0.1 ? '<0.1' : percent.toLocaleString('en-US', { maximumFractionDigits: percent < 10 ? 1 : 0 })}%`
}

/** The headline figures, in the order the page shows them, each with what it means on hover. */
export function privacyTiles(stats) {
  const { withdrawals, oneToOne, lone, linker } = stats
  return [
    {
      label: 'Strongest candidate found',
      value: share(linker.strong, linker.checked),
      note: linker.checked ? `${count(linker.strong)} of ${count(linker.checked)}` : 'Not checked yet',
      hint: 'Withdrawals where a rule points to one deposit wallet, out of those checked. The trace page lists that wallet as the strongest candidate.',
    },
    {
      label: 'Same amount just before',
      value: share(oneToOne.total, withdrawals),
      note: `${count(oneToOne.total)} of ${count(withdrawals)}`,
      hint: `A deposit of exactly the same amount at most ${oneToOne.withinSeconds / 60} minutes before. An odd amount like 1.2345 makes the match far stronger than a round 1 or 10.`,
    },
    {
      label: 'Only deposit that minute',
      value: share(lone.total, withdrawals),
      note: `${count(lone.total)} of ${count(withdrawals)}`,
      hint: `One deposit and no other withdrawal in the ${lone.withinSeconds} seconds before, so the two are easy to pair up.`,
    },
    {
      label: 'Wallets that could have paid',
      value: linker.candidates.median === null ? '—' : count(linker.candidates.median),
      note: 'for a typical withdrawal',
      hint: 'How many deposit wallets had enough in the pool to pay for a typical withdrawal. The more, the better it hides.',
    },
  ]
}

/** The linker's rules by how many withdrawals each linked, largest first, then the unexplained. */
export function ruleRows(stats) {
  const rows = Object.entries(RULE_NAMES).map(([rule, name]) => ({ rule, name, count: stats.linker.rules[rule] ?? 0 }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count)
  const unexplained = stats.linker.rules.unexplained ?? 0
  if (unexplained) rows.push({ rule: 'unexplained', name: 'No wallet could pay', count: unexplained })
  const max = Math.max(1, ...rows.map(({ count }) => count))
  return rows.map((row) => ({ ...row, width: (100 * row.count) / max }))
}

/** The last day's outside-the-pool scan: the headline and its breakdown. */
export function outsideSummary(outside) {
  return {
    value: share(outside.linked, outside.checked),
    note: outside.checked
      ? `${count(outside.linked)} of ${count(outside.checked)} recipients paid or were paid by a deposit wallet`
      : 'No recipient checked yet',
    parts: [
      { key: 'linked', label: 'Paid by or to a deposit wallet', count: outside.linked },
      { key: 'clean', label: 'No contact found', count: outside.clean },
      { key: 'busy', label: 'Busy wallet, not followed', count: outside.busy },
      { key: 'self', label: 'Withdrew to a deposit wallet', count: outside.self },
      { key: 'shared', label: 'Met through a shared service', count: outside.shared },
      { key: 'pending', label: 'Not checked yet', count: outside.pending },
    ].filter(({ count }) => count > 0),
  }
}
