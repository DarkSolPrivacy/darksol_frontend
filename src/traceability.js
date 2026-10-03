// Pure helpers for the trace page (src/traceability.jsx). The report itself is
// the backend's traceability/1 contract: GET /api/traceability/auto/:signature,
// which answers for Privacy Cash and the Cloak pools alike.

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/
// Solana's target slot time; the report gives block-time spans where it has them.
const SECONDS_PER_SLOT = 0.4

/** A pasted signature or explorer link (Solscan, Solana Explorer, …) to a signature, or null. */
export function parseSignature(input) {
  const text = String(input ?? '').trim()
  if (BASE58_SIGNATURE.test(text)) return text
  const match = /\/tx\/([1-9A-HJ-NP-Za-km-z]+)/.exec(text)
  return match && BASE58_SIGNATURE.test(match[1]) ? match[1] : null
}

/** Event ids are program:tree:epoch:signature:outer[:inner]. */
export const signatureOfEvent = (eventId) => String(eventId ?? '').split(':')[3] || null

export const shortSignature = (signature) => signature ? `${signature.slice(0, 6)}…${signature.slice(-6)}` : ''

export const formatCount = (value) => value === null || value === undefined ? '–' : BigInt(value).toLocaleString('en-US')

/** A span in seconds as one rounded unit: "37 s", "12 min", "5 h", "423 days". */
export function formatSpan(seconds) {
  const s = seconds === null || seconds === undefined ? NaN : Number(seconds)
  if (!Number.isFinite(s) || s < 0) return '–'
  if (s < 90) return `${Math.round(s)} s`
  if (s < 90 * 60) return `${Math.round(s / 60)} min`
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400).toLocaleString('en-US')} days`
}

export const slotsToSeconds = (slots) => Number(slots) * SECONDS_PER_SLOT

/** Observations by id, so the page can read the ones it explains by name. */
export const observationsById = (observations = []) => Object.fromEntries(observations.map((o) => [o.id, o]))

/** Signatures of the deposits either amount observation counted (the target, listed first, excluded). */
export function amountMatches(observations = []) {
  const byId = observationsById(observations)
  const matches = new Set()
  for (const id of ['deposits_net_equal_gross', 'deposits_gross_equal_net']) {
    for (const source of (byId[id]?.sources ?? []).slice(1)) matches.add(signatureOfEvent(source))
  }
  matches.delete(null)
  return matches
}

/**
 * Candidate leaves (newest first) as the transactions that created them, in the
 * same order. Consecutive pages can split one transaction's leaves; `previous`
 * groups are extended instead of repeated.
 */
export function groupCandidates(items = [], previous = []) {
  const groups = previous.map((group) => ({ ...group, leaves: [...group.leaves] }))
  for (const item of items) {
    const last = groups.at(-1)
    if (last?.signature === item.signature) last.leaves.push(item.leafIndex)
    else groups.push({ signature: item.signature, slot: item.slot, createdBy: item.createdBy, leaves: [item.leafIndex] })
  }
  return groups
}

export const STATUS = {
  ready: { label: 'Complete evidence', tone: 'ready', text: 'Every note that could have paid for this withdrawal is known, and the pool history behind it was replayed and checked.' },
  incomplete: { label: 'Evidence still being collected', tone: 'pending', text: 'Part of the history this withdrawal depends on is not verified yet. The figures below are bounds, not exact values.' },
  not_indexed: { label: 'Not found', tone: 'muted', text: 'No Privacy Cash or Cloak transaction with this signature is stored. A withdrawal from the last few minutes appears after the next indexing cycle; anything else is not from a traced pool.' },
  unsupported: { label: 'Cannot be traced', tone: 'muted', text: 'This transaction is outside what the analysis covers.' },
}

// Plain titles for the reason codes; the backend's own detail text follows each.
export const REASON_TITLES = {
  TARGET_NOT_WITHDRAWAL: 'This is a deposit. Only withdrawals can be traced.',
  TARGET_FAILED: 'This transaction failed on chain, so it moved no funds.',
  TARGET_NOT_PROTOCOL_INSTRUCTION: 'This transaction does not withdraw from a traced pool.',
  TREE_NOT_SUPPORTED: 'This pool is not traced. Privacy Cash SOL and the Cloak SOL, USDC and USDT pools are.',
  LAYOUT_UNKNOWN: 'This transaction uses a program format the decoder does not know.',
  LAYOUT_EPOCH_MISMATCH: 'This transaction does not match the program version deployed at its slot.',
  ROOT_NOT_IN_WINDOW: 'The proof root of this withdrawal could not be matched to pool history.',
  REPLAY_MISMATCH: 'The replayed pool history disagrees with the chain.',
  LIVE_STATE_MISMATCH: 'The replayed pool history disagrees with the live pool account.',
  GENESIS_NOT_REACHED: 'The pool history is still being collected back to its start.',
  REPLAY_BEHIND_TARGET: 'The pool history is still being replayed up to this withdrawal.',
  LIVE_STATE_NOT_CHECKED: 'The replayed history has not been checked against the live pool yet.',
  HISTORY_GAP: 'Some pool history before this withdrawal is missing.',
  CANDIDATE_PROVENANCE_MISSING: 'Some candidate notes lack the transaction that created them.',
  SOURCE_QUARANTINED: 'A transaction in the pool history is held back for review.',
  TARGET_NOT_INDEXED: 'No stored evidence for this signature yet.',
  HIDDEN_VALUE: 'Note amounts are private.',
  DUMMY_INDISTINGUISHABLE: 'Empty notes look the same as funded ones.',
  NULLIFIER_UNMAPPED: 'Spent notes are not removed.',
  ANCESTRY_UNRESOLVED: 'Only the last hop is analysed.',
  SAME_SLOT_ORDER_UNKNOWN: 'The order within one slot is not known for every transaction.',
  ENRICHMENT_NOT_PERFORMED: 'Wallet relationships are not analysed.',
  DEPLOYMENT_BEHAVIOUR_VERIFIED: 'Older program versions are verified by replay, not by a reproducible build.',
  'cloakc:DEPLOYMENT_BEHAVIOUR_VERIFIED': 'Program versions are verified by replay, not by a reproducible build.',
  PROGRAM_SOURCE_UNAVAILABLE: 'The program’s source code is not published.',
  SHIELDED_TRANSFERS: 'Money can move between users inside the pool.',
}

// What each limit means for the reader; the backend's detail is written for operators.
export const LIMIT_TEXT = {
  HIDDEN_VALUE: 'The amount inside each note is hidden by the zero-knowledge proof, so notes cannot be filtered by size.',
  DUMMY_INDISTINGUISHABLE: 'Change and zero-value notes count as possible sources too, so the total counts notes, not deposits or people.',
  NULLIFIER_UNMAPPED: 'A note that was already spent cannot be identified, so it stays among the possible sources.',
  ANCESTRY_UNRESOLVED: 'A possible source may itself be change from an earlier private transfer. Where that money first came from is not followed.',
  SAME_SLOT_ORDER_UNKNOWN: 'For some transactions in the same slot as the withdrawal, which came first is not known; they are left out.',
  ENRICHMENT_NOT_PERFORMED: 'Apart from the recipient being the depositor itself, the recipient’s other transactions (who funded it, where it sends) are not checked yet.',
  DEPLOYMENT_BEHAVIOUR_VERIFIED: 'The current program matches its published source. Earlier versions are checked by replaying every transaction they made, not by rebuilding them.',
  'cloakc:DEPLOYMENT_BEHAVIOUR_VERIFIED': 'No Cloak program version has a reproducible build. Each is checked by replaying every transaction it made.',
  PROGRAM_SOURCE_UNAVAILABLE: 'Cloak publishes neither its program nor its circuit. What its instructions do is read from the chain, and the order of its notes is checked by replaying the whole pool against the live account.',
  SHIELDED_TRANSFERS: 'Cloak has private transfers, so a note can hold money its owner never deposited. A wallet’s balance on this page is what it deposited, not what it holds.',
}

// Codes that never block a report: the limits every report states.
export const DISCLOSURES = new Set(['HIDDEN_VALUE', 'DUMMY_INDISTINGUISHABLE', 'NULLIFIER_UNMAPPED', 'ANCESTRY_UNRESOLVED',
  'SAME_SLOT_ORDER_UNKNOWN', 'ENRICHMENT_NOT_PERFORMED', 'DEPLOYMENT_BEHAVIOUR_VERIFIED', 'PROGRAM_SOURCE_UNAVAILABLE', 'SHIELDED_TRANSFERS'])

/** A reason's title or explanation, the pool's own wording first. */
export const reasonText = (table, protocol, code) => table[`${protocol}:${code}`] ?? table[code]

export const CREATED_BY = { deposit: 'Deposit', withdraw: 'Withdrawal change', transfer: 'Transfer', swap: 'Swap change', refund: 'Swap refund' }

const POOLS = { privacycash: 'Privacy Cash', cloakc: 'Cloak' }

/** "Cloak USDC pool", from the report's protocol and asset, or null for a report on no pool. */
export function poolName(report) {
  const protocol = POOLS[report?.target?.protocol]
  const symbol = report?.deployment?.asset?.symbol
  return protocol ? `${protocol} ${symbol ? `${symbol} ` : ''}pool` : null
}

/**
 * Base units (a decimal string) in the pool's asset: SOL has 9 decimals and
 * shows at most 4; USDC and USDT have 6 and show cents. A report without an
 * asset is SOL. "0.3502 SOL", "12.34 USDC".
 */
export function formatAmount(units, asset = null) {
  if (units === null || units === undefined) return '–'
  const decimals = asset?.decimals ?? 9
  return `${(Number(units) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: decimals === 9 ? 4 : 2 })} ${asset?.symbol ?? 'SOL'}`
}

/** Seconds from `earlier` to `later`, both block times as decimal strings, or null. */
export const secondsBetween = (later, earlier) => later == null || earlier == null ? null : Number(later) - Number(earlier)

// The linker's rules (backend docs/FORENSIC_LINKER.md) as an observer would say them.
export const LINK_RULES = {
  self_relay: 'The withdrawal was signed by the depositor’s own wallet.',
  same_address: 'The money went back to the wallet that deposited it.',
  only_feasible: 'Only one wallet had enough left in the pool to pay for it.',
  exact_balance: 'It took exactly what this wallet had left in the pool.',
  exact_deposit: 'It took exactly what this wallet deposited, and no other deposit has that amount.',
  pair_sum: 'With an earlier withdrawal it emptied this wallet exactly.',
  root_pinned: 'Its proof was made right after this wallet deposited exactly this amount.',
}

/** Why a candidate wallet ranks where it does, in a few words (the section text explains them). */
export function candidateReason(entry, linked) {
  if (linked) return 'Linked'
  if (entry.exact) return 'Exact balance'
  if (entry.match) return 'Same-amount deposit'
  if (entry.pair) return 'Completes a pair'
  if (entry.pinned) return 'Deposit before proof'
  return 'Can cover it'
}

/** What an observer concludes from a withdrawal's linkage, or null without one. */
export function linkVerdict(linkage) {
  if (!linkage || linkage.status === 'deposit') return null
  if (linkage.status === 'linked') {
    const strong = linkage.tier === 'strong'
    return { tone: strong ? 'linked' : 'likely', title: strong ? 'Linked to one wallet' : 'Probably linked to one wallet', text: LINK_RULES[linkage.rule] ?? 'A linking rule named one wallet.' }
  }
  if (linkage.status === 'ranked') {
    return { tone: 'hidden', title: `Hidden among ${formatCount(linkage.candidates)} wallets`, text: 'No rule singles out one wallet. Each wallet below could have paid for it, best fit first.' }
  }
  if (linkage.status === 'unexplained') {
    return { tone: 'hidden', title: 'No single wallet could have paid for it', text: 'No depositor had enough left in the pool, so the money may come from deposits made for someone else.' }
  }
  return { tone: 'pending', title: 'Not linked yet', text: 'Linking has not reached this transaction. It appears after the next indexing cycle.' }
}
