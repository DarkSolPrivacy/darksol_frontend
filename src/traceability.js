// Pure helpers for the trace page (src/traceability.jsx). The report itself is
// the backend's traceability/1 contract: GET /api/traceability/auto/:signature,
// which answers for the Privacy Cash and Cloak SOL, USDC and USDT pools alike.
import bs58 from 'bs58'

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/
// What a copy from a chat or a PDF can carry unseen: soft hyphens, zero-width
// spaces and joiners, bidi marks, word joiners and the BOM.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g
// Solana's target slot time. Every span on the page is counted in slots, so the
// same deposit reads the same everywhere.
const SECONDS_PER_SLOT = 0.4
// The crowding window of the observations: 150 slots, about a minute.
export const CLOSE_SLOTS = 150

/**
 * A pasted transaction hash, or an explorer link (Solscan, Solana Explorer, …)
 * to one, as a 64-byte base58 signature; null otherwise. It is the only thing
 * the page puts in an API path or a link.
 */
export function parseSignature(input) {
  const text = String(input ?? '').normalize('NFKC').replace(INVISIBLE, '').trim()
  const candidate = BASE58_SIGNATURE.test(text) ? text : /\/tx\/([1-9A-HJ-NP-Za-km-z]+)(?:[/?#]|$)/.exec(text)?.[1]
  if (!candidate || !BASE58_SIGNATURE.test(candidate)) return null
  try { return bs58.decode(candidate).length === 64 ? candidate : null } catch { return null }
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

/** Seconds from slot `earlier` to slot `later` (decimal strings), or null. */
export const slotSpan = (later, earlier) => later == null || earlier == null ? null : slotsToSeconds(Number(later) - Number(earlier))

/** Observations by id, so the page can read the ones it explains by name. */
export const observationsById = (observations = []) => Object.fromEntries(observations.map((o) => [o.id, o]))

/** Signatures of the deposits either amount observation counted (the target, listed first, excluded), newest first. */
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

const value = (observation) => observation?.value === null || observation?.value === undefined ? null : Number(observation.value)

/**
 * The newest deposit of exactly the withdrawn amount when it landed within about
 * a minute: the first thing an observer checks. `alone`: no other transfer in
 * that minute. `proofAfter`: the proof was built on the pool right after it.
 */
export function amountLead(report) {
  const byId = observationsById(report?.observations)
  const slots = value(byId.nearest_amount_match_slots)
  if (slots === null || slots > CLOSE_SLOTS) return null
  const signature = signatureOfEvent(byId.nearest_amount_match_slots.sources?.[0])
  return {
    signature,
    seconds: slotsToSeconds(slots),
    alone: value(byId.crowding_deposits) === 1 && value(byId.crowding_withdrawals) === 0,
    proofAfter: byId.root_lag_leaves?.value === '0' && signatureOfEvent(byId.root_lag_slots?.sources?.[0]) === signature,
  }
}

/**
 * The public clues as tiles, most telling first. `flag` marks a value that
 * makes the withdrawal easier to trace. Missing observations are left out.
 */
export function clueTiles(report) {
  const byId = observationsById(report?.observations)
  const net = value(byId.deposits_net_equal_gross)
  const gross = value(byId.deposits_gross_equal_net)
  const deposits = value(byId.crowding_deposits)
  const withdrawals = value(byId.crowding_withdrawals)
  const size = value(byId.same_size_transacts)
  // A deposit cannot match both ways: that would need a withdrawal without a fee.
  const matching = net === null && gross === null ? null : (net ?? 0) + (gross ?? 0)
  // Quiet and rare only give a withdrawal away when there is something to pair it with.
  return [
    matching !== null && { id: 'matching', label: 'Same-amount deposits', value: matching, flag: matching === 1,
      hint: 'Deposits in the last ~1,000 transfers whose amount fits this withdrawal exactly. One is a strong lead; many weaken it.' },
    deposits !== null && { id: 'deposits', label: 'Deposits in the minute before', value: deposits, flag: deposits === 1,
      hint: 'A single deposit right before a withdrawal makes it easy to guess which one it follows.' },
    withdrawals !== null && { id: 'withdrawals', label: 'Withdrawals in the minute before', value: withdrawals, flag: withdrawals === 0 && deposits > 0,
      hint: 'Other withdrawals at the same time blur which deposit belongs to which.' },
    size !== null && { id: 'size', label: 'Transfers of this size', value: size, flag: size <= 1 && matching > 0,
      hint: 'How common this exact amount is in the last ~1,000 transfers. A rare amount makes a match stronger.' },
  ].filter(Boolean)
}

export const STATUS = {
  incomplete: 'Evidence is still being collected, so the figures below are bounds.',
  not_indexed: 'No Privacy Cash or Cloak transaction with this hash is stored yet. A very recent one appears within minutes.',
  unsupported: 'This transaction cannot be traced.',
}

// Plain titles for the reason codes; the backend's own detail text follows each.
export const REASON_TITLES = {
  TARGET_NOT_WITHDRAWAL: 'This is a deposit. Only withdrawals can be traced.',
  TARGET_FAILED: 'This transaction failed on chain, so it moved no funds.',
  TARGET_NOT_PROTOCOL_INSTRUCTION: 'This transaction does not withdraw from a traced pool.',
  TREE_NOT_SUPPORTED: 'This pool is not traced. The Privacy Cash and Cloak SOL, USDC and USDT pools are.',
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
  TARGET_NOT_INDEXED: 'No stored evidence for this hash yet.',
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

/** Why a candidate wallet ranks where it does, in a few words. */
export function candidateReason(entry, linked) {
  if (linked) return 'Linked'
  if (entry.exact) return 'Exact balance'
  if (entry.match) return 'Same-amount deposit'
  if (entry.pair) return 'Completes a pair'
  if (entry.pinned) return 'Deposit before proof'
  return 'Can cover it'
}

/**
 * What an observer concludes about a withdrawal, or null for a deposit or a
 * report with nothing to conclude. A rule's link comes first; without one, a
 * same-amount deposit seconds before is what an observer would bet on, even
 * when its round amount keeps every rule from naming a wallet.
 */
export function traceVerdict(report) {
  const linkage = report?.linkage ?? null
  if (linkage?.status === 'deposit') return null
  if (linkage?.status === 'linked') {
    const strong = linkage.tier === 'strong'
    return { tone: strong ? 'linked' : 'likely', title: strong ? 'Linked to one wallet' : 'Probably linked to one wallet', text: LINK_RULES[linkage.rule] ?? 'A linking rule named one wallet.' }
  }
  const lead = amountLead(report)
  if (lead) {
    return { tone: 'likely', title: `Likely paid by a deposit ${formatSpan(lead.seconds)} earlier`, text: 'Not proven, but it is the first match an observer checks.' }
  }
  if (linkage?.status === 'ranked') return { tone: 'hidden', title: `Hidden among ${formatCount(linkage.candidates)} wallets`, text: 'No rule singles out one wallet.' }
  if (linkage?.status === 'unexplained') {
    return { tone: 'hidden', title: 'No single wallet could have paid for it', text: 'No depositor had enough left in the pool, so the money may come from deposits made for someone else.' }
  }
  if (linkage?.status === 'not_computed') return { tone: 'pending', title: 'Not linked yet', text: 'Linking has not reached this transaction. It appears after the next indexing cycle.' }
  return null
}

/** The report's same-amount deposits (`related`) by signature: their slot and depositor wallet. */
export const sameAmountDeposits = (report) => new Map((report?.related ?? [])
  .filter((row) => row.relation === 'same_amount_deposit').map((row) => [row.signature, row]))

/** The wallet that made a deposit, when the report names it. */
export const depositorOf = (report, signature) => sameAmountDeposits(report).get(signature)?.wallet
  ?? report?.linkage?.top?.find((entry) => entry.lastDeposit?.signature === signature)?.wallet ?? null

/**
 * The deposits and wallets most likely to have paid for a withdrawal, one row
 * per deposit, best first: the linked wallet, the same-amount deposit seconds
 * before, the other same-amount deposits, then the linker's ranked wallets.
 * `seconds` is how long before the withdrawal the deposit landed, where known.
 */
export function sourceRows(report) {
  const linkage = report?.linkage ?? null
  const lead = amountLead(report)
  const target = report?.target?.slot ?? null
  const linked = linkage?.status === 'linked' ? linkage.wallet : null
  const slots = new Map((report?.candidates?.items ?? []).map((item) => [item.signature, item.slot]))
  const matched = sameAmountDeposits(report)
  const rows = new Map()
  const add = (key, row) => {
    const known = rows.get(key)
    if (!known) return rows.set(key, { ...row, reasons: new Set(row.reasons) })
    for (const reason of row.reasons) known.reasons.add(reason)
    known.rank = Math.min(known.rank, row.rank)
    known.wallet ??= row.wallet
    known.seconds ??= row.seconds
  }
  ;(linkage?.top ?? []).forEach((entry, index) => {
    const signature = entry.lastDeposit?.signature ?? null
    const own = entry.wallet === linked
    add(signature ?? entry.wallet, { signature, wallet: entry.wallet, reasons: [candidateReason(entry, own)], seconds: slotSpan(target, entry.lastDeposit?.slot), rank: own ? 0 : 3000 + index })
  })
  ;[...amountMatches(report?.observations)].forEach((signature, index) => {
    const closest = signature === lead?.signature
    const known = matched.get(signature)
    add(signature, {
      signature, wallet: known?.wallet ?? null, reasons: ['Same-amount deposit'],
      seconds: closest ? lead.seconds : slotSpan(target, known?.slot ?? slots.get(signature)), rank: closest ? 1 : 2000 + index,
    })
  })
  return [...rows.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank, reasons, ...row }) => ({ ...row, reasons: [...reasons], highlight: rank <= 1 }))
}

/** The examples' amount, in the form a chip shows: "1.1284 SOL". */
export const exampleAmount = (example) => formatAmount(example.gross, example.asset)

/** Seconds from an example's deposit to its withdrawal. */
export const exampleLag = (example) => example.depositSlots != null ? slotsToSeconds(example.depositSlots) : slotSpan(example.slot, example.deposit?.slot)

// Recent Privacy Cash withdrawals of an off-grid amount that one deposit of
// exactly that amount paid for seconds before (GET /api/traceability/examples
// picks fresher ones the same way). Shown while that endpoint is unreachable.
export const FALLBACK_EXAMPLES = [
  ['5Nahu8FFrbdiwJVMc92PD7UZFMSaraFNFdToJXpEL9DusrvCBjLH1k71VAjgJGdLYsRSj9BVuAruMyUUrLQn7dMK', '1128403100', 36],
  ['2SXxty6QYwQwb5PKgK7vdzcKEeV9LF49m9TDV8edghvBahuT9XrWb7zKKPKiy4SpwdBY59des5p1HKRdZRsVFkNE', '1806570700', 53],
  ['3BovQpp5pK9oDzhGKZnwdjMxyKgyCdHmG2WyWWH5PNCEuMyGw84tCqE4wY3cm8Yq1NRyeTtrd85fjpvTB6cTjnsD', '1779224700', 32],
  ['3pfRj1agNvfCWdGLc3D2LQrEqkECLvTMEZQqKfRfCzPTzFq8xE8fC2y2s6mSoM8URVHxQ3vysst4etR5ofmWJ3Ui', '19863201100', 30],
  ['53M9NeE1aEhvDxXuenuuxXPWGJXMKBTrsYaXvLHutbVMmofJosyaCB4erAePFWZa7NnQJTX5q5Mmbkiu2YHiCJ5z', '6976116000', 41],
  ['dzi2FeMKky1LwoENeXTRBWJDKon7NeE9ZC5H2Bwxm1mZnoV7hNF93obbRWTyGth5byBAvBxFxFb267n37Rm6sTT', '11865907300', 56],
  ['61aTD114fPc9fTPJeCaMjK1oQfdBx4Mzt7hCuCjnohC7oTaEvDNVWncbxsVsDFbuJnYz3WW8HVRQ6oXJe188D6md', '28082317700', 77],
  ['5ftZKakYLv2sJUkz8QgtF5mfyGRHaoN1uNyjjhVPcQxCazyp6g9CK7P13q1TRThC1r8knnukSEqoXa1P9Vda212J', '8743880500', 126],
].map(([signature, gross, slots]) => ({ protocol: 'privacycash', signature, asset: { symbol: 'SOL', decimals: 9 }, gross, depositSlots: slots }))

/**
 * Up to `count` examples from an examples response, or from the fallback when
 * it has none, in a random order so each visit suggests different ones. Only
 * entries with a valid signature are kept.
 */
export function pickExamples(examples, count = 3, random = Math.random) {
  const valid = (examples ?? []).filter((example) => parseSignature(example?.signature) === example.signature && example.gross != null)
  const pool = (valid.length ? valid : FALLBACK_EXAMPLES).map((example) => [random(), example])
  return pool.sort((a, b) => a[0] - b[0]).slice(0, count).map(([, example]) => example)
}
