import React, { useEffect, useMemo, useState } from 'react'
import { ArrowRight, ArrowUpRight, Check, Copy, LoaderCircle } from 'lucide-react'
import {
  CREATED_BY, DISCLOSURES, LIMIT_TEXT, REASON_TITLES, STATUS, amountMatches, candidateReason, formatCount, formatSol, formatSpan,
  groupCandidates, linkVerdict, observationsById, parseSignature, secondsBetween, shortSignature, slotsToSeconds,
} from './traceability.js'

const PAGE = 40
// A recent withdrawal with a complete report, for the "Try an example" link.
const EXAMPLE = '3Hsvq9zsWJdD6dxC6CJR479Dj6BxAhpNMiST31bxeREUv2fV3KDVx1W69C6PA3iGidJTeNjbBcvEbWRfWQJP2zjL'
// The crowding window of the observations: 150 slots, about a minute.
const CLOSE_SLOTS = 150

const solscan = (signature) => `https://solscan.io/tx/${signature}`
const solscanAccount = (address) => `https://solscan.io/account/${address}`

function Address({ address }) {
  return <a href={solscanAccount(address)} target="_blank" rel="noreferrer" title={address}><code>{shortSignature(address)}</code><ArrowUpRight /></a>
}
function Transaction({ signature }) {
  return <a href={solscan(signature)} target="_blank" rel="noreferrer" title={signature}><code>{shortSignature(signature)}</code><ArrowUpRight /></a>
}

async function fetchReport(signature, cursor = null) {
  const query = new URLSearchParams({ limit: String(PAGE), ...(cursor && { cursor }) })
  const response = await fetch(`/api/traceability/privacycash/${signature}?${query}`)
  const body = await response.json().catch(() => null)
  if (response.status === 409) throw new Error('This transaction holds several Privacy Cash instructions; tracing one of them is not supported here yet.')
  if (!response.ok || !body) throw new Error(body?.detail || body?.error || `The trace service answered ${response.status}.`)
  return body
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked */ }
  }
  return <button className="traceIconButton" type="button" onClick={copy} aria-label={copied ? 'Copied' : 'Copy signature'} title="Copy signature">{copied ? <Check /> : <Copy />}</button>
}

function Status({ copy }) {
  return <span className={`traceStatus ${copy.tone}`}><i aria-hidden="true" />{copy.label}</span>
}

// What an observer would conclude, ahead of the evidence behind it.
function Verdict({ verdict, linkage }) {
  const last = linkage.top?.[0]?.lastDeposit
  const seconds = secondsBetween(linkage.blockTime, last?.blockTime)
  return <div className={`traceVerdict ${verdict.tone}`}>
    <h2><i aria-hidden="true" />{verdict.title}</h2>
    <p>{verdict.text}</p>
    {linkage.status === 'linked' && <p className="traceVerdictWallet">
      Wallet <Address address={linkage.wallet} />
      {last && <><span aria-hidden="true">·</span> last deposit <Transaction signature={last.signature} />{seconds !== null && ` ${formatSpan(seconds)} before`}</>}
      {linkage.partner && <><span aria-hidden="true">·</span> with <Transaction signature={linkage.partner} /></>}
    </p>}
  </div>
}

// The newest candidate notes on a time axis that ends at the withdrawal. Log
// scale, so the last minute and the last day both stay readable.
function NoteStrip({ groups, targetSlot, matches }) {
  const spans = groups.map((group) => Math.max(0, Number(targetSlot) - Number(group.slot)))
  const widest = Math.max(1, ...spans)
  const at = (slots) => 100 - (Math.log1p(slots) / Math.log1p(widest)) * 100
  const ticks = [[150, '1 min'], [1500, '10 min'], [9000, '1 h'], [54000, '6 h'], [216000, '1 day'], [1512000, '1 week']]
    // Clear of the end labels, which would otherwise overlap them.
    .filter(([slots]) => at(slots) > 22 && at(slots) < 78)
  return <div className="traceStrip" role="img" aria-label={`${groups.length} newest candidate transactions over the ${formatSpan(slotsToSeconds(widest))} before the withdrawal`}>
    <div className="traceStripAxis" />
    {ticks.map(([slots, label]) => <span className="traceStripTick" key={label} style={{ left: `${at(slots)}%` }}><small>{label}</small></span>)}
    <span className="traceStripTick target" style={{ left: '100%' }}><small>Withdrawal</small></span>
    <span className="traceStripTick oldest" style={{ left: '0%' }}><small>{formatSpan(slotsToSeconds(widest))}</small></span>
    {groups.map((group, index) => {
      const match = matches.has(group.signature)
      return <i key={group.signature} className={`traceDot ${group.createdBy === 'deposit' ? 'deposit' : 'change'}${match ? ' match' : ''}`}
        style={{ left: `${at(spans[index])}%` }} title={`${CREATED_BY[group.createdBy] ?? 'Transaction'}${match ? ', same amount' : ''}, ${formatSpan(slotsToSeconds(spans[index]))} before`} />
    })}
  </div>
}

// The linker's best-fitting wallets for a withdrawal, the linked one first.
function LikelySources({ linkage }) {
  const top = linkage?.top ?? []
  if (!top.length) return null
  return <section className="panel traceSection">
    <div className="traceSectionHead"><div><h2>Most likely sources</h2><p>Depositor wallets that had enough in the pool to pay for this withdrawal, best fit first: an exact balance, then a deposit of exactly this amount, then the most recent depositors. A wallet’s balance is what it deposited minus the withdrawals already linked to it.</p></div></div>
    <div className="traceTable" role="table" aria-label="Most likely sources">
      <div className="traceRow head" role="row"><span role="columnheader">Wallet</span><span role="columnheader">Last deposit</span><span role="columnheader">Balance</span><span role="columnheader">Before withdrawal</span></div>
      {top.map((entry) => {
        const linked = linkage.status === 'linked' && entry.wallet === linkage.wallet
        const seconds = secondsBetween(linkage.blockTime, entry.lastDeposit?.blockTime)
        return <div className={`traceRow${linked ? ' match' : ''}`} role="row" key={entry.wallet}>
          <span role="cell" className="traceKind"><Address address={entry.wallet} /><em className={linked ? '' : 'muted'}>{candidateReason(entry, linked)}</em></span>
          <span role="cell">{entry.lastDeposit ? <Transaction signature={entry.lastDeposit.signature} /> : '–'}</span>
          <code role="cell">{formatSol(entry.budget)}</code>
          <code role="cell">{seconds === null ? '–' : formatSpan(seconds)}</code>
        </div>
      })}
    </div>
  </section>
}

// A deposit: the withdrawals the linker attributes to its wallet from then on.
function DepositLinks({ linkage }) {
  const rows = linkage.withdrawals ?? []
  return <section className="panel traceSection">
    <div className="traceSectionHead"><div><h2>Withdrawals linked to this wallet</h2><p>{rows.length
      ? 'Withdrawals from this deposit on that a linking rule attributes to the depositing wallet, oldest first.'
      : 'No withdrawal from this deposit on is linked to the depositing wallet. Its money is still in the pool, or left in withdrawals no rule singles out.'}</p></div></div>
    {rows.length > 0 && <div className="traceTable" role="table" aria-label="Withdrawals linked to this wallet">
      <div className="traceRow head" role="row"><span role="columnheader">Withdrawal</span><span role="columnheader">Linked by</span><span role="columnheader">Amount</span><span role="columnheader">After deposit</span></div>
      {rows.map((row) => {
        const seconds = secondsBetween(row.blockTime, linkage.blockTime)
        return <div className="traceRow" role="row" key={row.signature}>
          <span role="cell"><Transaction signature={row.signature} /></span>
          <span role="cell" className="traceRule">{LINK_RULE_NAMES[row.rule] ?? row.rule}{row.tier === 'likely' ? ' (likely)' : ''}</span>
          <code role="cell">{formatSol(row.gross)}</code>
          <code role="cell">{seconds === null ? '–' : formatSpan(seconds)}</code>
        </div>
      })}
    </div>}
  </section>
}

const LINK_RULE_NAMES = {
  self_relay: 'Own signature', same_address: 'Paid back to itself', only_feasible: 'Only wallet with enough',
  exact_balance: 'Emptied the wallet', exact_deposit: 'Same amount', pair_sum: 'Pair emptied the wallet', root_pinned: 'Proof right after deposit',
}

function Candidates({ report, signature }) {
  const [groups, setGroups] = useState(() => groupCandidates(report.candidates?.items))
  const [next, setNext] = useState(report.candidates?.page?.next ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const matches = useMemo(() => amountMatches(report.observations), [report])
  const targetSlot = report.target.slot

  async function older() {
    setLoading(true)
    setError('')
    try {
      const page = await fetchReport(signature, next)
      setGroups((current) => groupCandidates(page.candidates?.items, current))
      setNext(page.candidates?.page?.next ?? null)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setLoading(false)
    }
  }

  if (!groups.length) return null
  return <section className="panel traceSection">
    <div className="traceSectionHead">
      <div><h2>Newest notes in the pool</h2><p>{report.linkage?.top?.length
        ? 'Every note in the pool when the proof was made could have paid for it in principle; the wallets above are what narrows it down. These are the newest, newest first.'
        : 'The notes created right before this withdrawal, newest first. Any of them, or any older note, could have paid for it.'}</p></div>
      <ul className="traceLegend" aria-label="Legend">
        <li><i className="traceDot deposit" />Deposit</li>
        <li><i className="traceDot change" />Withdrawal change</li>
        {matches.size > 0 && <li><i className="traceDot deposit match" />Same amount</li>}
      </ul>
    </div>
    <NoteStrip groups={groups} targetSlot={targetSlot} matches={matches} />
    <div className="traceTable" role="table" aria-label="Newest possible sources">
      <div className="traceRow head" role="row"><span role="columnheader">Created by</span><span role="columnheader">Transaction</span><span role="columnheader">Notes</span><span role="columnheader">Before withdrawal</span></div>
      {groups.map((group) => {
        const match = matches.has(group.signature)
        return <div className={`traceRow${match ? ' match' : ''}`} role="row" key={group.signature}>
          <span role="cell" className="traceKind"><i className={`traceDot ${group.createdBy === 'deposit' ? 'deposit' : 'change'}${match ? ' match' : ''}`} />{CREATED_BY[group.createdBy] ?? 'Transaction'}{match && <em>Same amount</em>}</span>
          <a role="cell" href={solscan(group.signature)} target="_blank" rel="noreferrer"><code>{shortSignature(group.signature)}</code><ArrowUpRight /></a>
          <code role="cell">{group.leaves.length > 1 ? `${formatCount(group.leaves.at(-1))}–${formatCount(group.leaves[0])}` : formatCount(group.leaves[0])}</code>
          <code role="cell">≈ {formatSpan(slotsToSeconds(Number(targetSlot) - Number(group.slot)))}</code>
        </div>
      })}
    </div>
    {error && <p className="paymentError traceInlineError" role="alert">{error}</p>}
    {next && <button className="ghost traceMore" type="button" onClick={older} disabled={loading}>{loading ? <><LoaderCircle className="spin" /> Loading…</> : 'Show older notes'}</button>}
  </section>
}

// The observations a reader can act on, in plain words. The backend's own
// definition of each stays one click away.
const LEADS = [
  ['nearest_amount_match_slots', 'Nearest same-amount deposit', (o) => o.value === null ? 'None' : `≈ ${formatSpan(slotsToSeconds(o.value))} before`,
    'The newest deposit whose amount fits this withdrawal exactly. An analyst would start here, but a match in time is a coincidence, not a proven link: older notes stay possible sources.'],
  ['deposits_net_equal_gross', 'Deposits matching the amount withdrawn', (o) => formatCount(o.value),
    'Deposits among the last ~1,000 transactions that put into the pool exactly what this withdrawal took out (amount plus fee).'],
  ['deposits_gross_equal_net', 'Deposits matching the amount received', (o) => formatCount(o.value),
    'Deposits in the same window that sent exactly what the recipient received.'],
  ['same_size_transacts', 'Transfers of the same size', (o) => formatCount(o.value),
    'How common this exact amount is. The more transfers share it, the weaker an amount match is.'],
  ['crowding_deposits', 'Deposits in the minute before', (o) => formatCount(o.value),
    'Few deposits right before a withdrawal make it easier to guess which one it follows.'],
  ['crowding_withdrawals', 'Withdrawals in the minute before', (o) => formatCount(o.value),
    'Other withdrawals at the same time blur which deposit belongs to which withdrawal.'],
]

function Leads({ report }) {
  const byId = observationsById(report.observations)
  const nearest = byId.nearest_amount_match_slots
  const close = nearest?.value !== null && nearest?.value !== undefined && Number(nearest.value) <= CLOSE_SLOTS
  // At most two other transfers in the minute before.
  const quiet = Number(byId.crowding_deposits?.value ?? Infinity) + Number(byId.crowding_withdrawals?.value ?? Infinity) <= 3
  const rows = LEADS.filter(([id]) => byId[id])
  if (!rows.length) return null
  return <section className="panel traceSection">
    <div className="traceSectionHead"><div><h2>Public clues</h2><p>What an analyst would compare to narrow the possible sources down. None of these is proof, and they are never combined into a score.</p></div></div>
    {close && <p className="traceCallout">A deposit of a matching amount landed about {formatSpan(slotsToSeconds(nearest.value))} before this withdrawal{quiet ? ', with few other transfers around it' : ''}. That is the pattern an observer would notice first.</p>}
    <dl className="traceLeads">
      {rows.map(([id, label, value, note]) => {
        const observation = byId[id]
        return <div key={id}>
          <dt>{label}</dt>
          <dd><strong>{value(observation)}</strong><p>{observation.missing || note}</p>
            <details><summary>How it is measured</summary><p>{observation.applicability}</p></details>
          </dd>
        </div>
      })}
    </dl>
  </section>
}

function Limits({ report }) {
  const limits = report.reasons.filter(({ code }) => DISCLOSURES.has(code))
  if (!limits.length) return null
  return <section className="traceSection traceLimits">
    <h2>What this report cannot tell</h2>
    <ul>{limits.map(({ code, detail }) => <li key={code}><strong>{REASON_TITLES[code] ?? code}</strong> {LIMIT_TEXT[code] ?? detail}</li>)}</ul>
  </section>
}

function Evidence({ report }) {
  const replay = report.coverage?.rootReconstruction
  const live = replay?.liveCheck
  const build = report.deployment?.verification?.verifiedBuild
  const facts = [
    report.root?.root && ['Proof root', <code key="root" title={report.root.root}>{shortSignature(report.root.root)}</code>, report.root.validation === 'validated' ? 'Matched by replay' : report.root.validation],
    replay?.replayedLeaves && ['Pool history', `${formatCount(replay.replayedLeaves)} notes`, replay.fromGenesis ? 'Replayed from the pool’s first note' : 'Partly replayed'],
    replay?.proofRootsChecked && ['On-chain proofs', `${formatCount(replay.proofRootsMatched)} / ${formatCount(replay.proofRootsChecked)}`, 'Proof roots that match the replay'],
    live && ['Live pool', live.root && live.frontier && live.ring ? 'Matches' : 'Differs', `Checked at slot ${formatCount(live.slot)}`],
    build && ['Program', `${build.version} verified build`, `Commit ${build.commit.slice(0, 7)}, older versions by replay`],
  ].filter(Boolean)
  if (!facts.length) return null
  return <section className="traceSection traceEvidence">
    <h2>How this was checked</h2>
    <dl>{facts.map(([label, value, note]) => <div key={label}><dt>{label}</dt><dd>{value}</dd><small>{note}</small></div>)}</dl>
  </section>
}

function Report({ report, signature }) {
  const copy = STATUS[report.status] ?? STATUS.unsupported
  // A deposit is refused as a withdrawal target, but its wallet's links are shown instead.
  const deposit = report.linkage?.status === 'deposit'
  const blocking = report.reasons.filter(({ code }) => !DISCLOSURES.has(code) && !(deposit && code === 'TARGET_NOT_WITHDRAWAL'))
  const byId = observationsById(report.observations)
  const candidates = report.candidates
  const rootLag = byId.root_lag_leaves?.value
  const oldest = byId.oldest_eligible_seconds?.value
  const linkage = report.linkage ?? null
  const verdict = linkVerdict(linkage)
  const wallets = linkage?.candidates ?? null
  const notes = candidates && (candidates.exact ? formatCount(candidates.count) : `${formatCount(candidates.bounds?.min)}–${formatCount(candidates.bounds?.max)}`)
  return <>
    <section className="panel traceSummary">
      <div className="traceSummaryHead">
        <Status copy={deposit ? DEPOSIT : copy} />
        <div className="traceTarget">
          <code title={signature}>{shortSignature(signature)}</code>
          <CopyButton text={signature} />
          <a className="traceIconButton" href={solscan(signature)} target="_blank" rel="noreferrer" aria-label="View on Solscan" title="View on Solscan"><ArrowUpRight /></a>
        </div>
      </div>
      {verdict ? <Verdict verdict={verdict} linkage={linkage} />
        : deposit ? <p className="traceStatusText traceVerdictWallet">{DEPOSIT.text} <Address address={linkage.wallet} /></p>
          : <p className="traceStatusText">{copy.text}</p>}
      {blocking.length > 0 && <ul className="traceBlocking">{blocking.map(({ code, detail }) => <li key={code} title={detail}>{REASON_TITLES[code] ? <strong>{REASON_TITLES[code]}</strong> : detail}</li>)}</ul>}
      {candidates && <div className="traceFigures">
        {wallets !== null && <div className="metric key"><p>Wallets with enough in the pool</p><strong>{formatCount(wallets)}</strong><small>After the withdrawals already linked to other wallets</small></div>}
        <div className={`metric${wallets === null ? ' key' : ''}`}><p>{wallets === null ? 'Possible source notes' : 'Notes in the pool'}</p><strong>{notes}</strong><small>Every note in the pool when the proof was made</small></div>
        <div className="metric"><p>Proof freshness</p><strong>{rootLag === undefined || rootLag === null ? '–' : rootLag === '0' ? 'Newest' : `${formatCount(rootLag)} behind`}</strong><small>{rootLag === '0' ? 'The proof used the pool’s latest state' : 'Notes added after the proof are excluded'}</small></div>
        {wallets === null && <div className="metric"><p>Oldest possible source</p><strong>{formatSpan(oldest)}</strong><small>before this withdrawal</small></div>}
      </div>}
    </section>
    {deposit && <DepositLinks linkage={linkage} />}
    {candidates && <>
      <LikelySources linkage={linkage} />
      <Candidates report={report} signature={signature} />
      <Leads report={report} />
      <Limits report={report} />
      <Evidence report={report} />
    </>}
  </>
}

const DEPOSIT = { label: 'Deposit', tone: 'ready', text: 'Deposited from' }

export default function TracePage({ signature = '', onTrace }) {
  const [input, setInput] = useState(signature)
  const [invalid, setInvalid] = useState(false)
  const [result, setResult] = useState(signature ? { state: 'loading' } : { state: 'idle' })

  useEffect(() => {
    if (!signature) return
    let live = true
    setResult({ state: 'loading' })
    fetchReport(signature)
      .then((report) => live && setResult({ state: 'done', report }))
      .catch((error) => live && setResult({ state: 'error', error: error.message }))
    return () => { live = false }
  }, [signature])

  function submit(event) {
    event.preventDefault()
    const parsed = parseSignature(input)
    setInvalid(!parsed)
    if (parsed) onTrace(parsed)
  }

  return <div className="tracePage">
    <header className="traceHeader">
      <h1>Trace a withdrawal</h1>
      <p>Paste a Privacy Cash withdrawal to see which wallet most likely paid for it and how many others could have. A deposit shows the withdrawals linked to its wallet.</p>
    </header>
    <form className="traceSearch" onSubmit={submit} noValidate>
      <label className="paymentFieldLabel" htmlFor="traceSignature">Withdrawal or deposit <span>Signature or Solscan link</span></label>
      <div className="traceSearchRow">
        <input id="traceSignature" value={input} onChange={(event) => { setInput(event.target.value); setInvalid(false) }}
          placeholder="5Vf9…, or https://solscan.io/tx/…" spellCheck={false} autoComplete="off" aria-invalid={invalid} aria-describedby={invalid ? 'traceSignatureError' : undefined} />
        <button className="paymentPrimary" type="submit" disabled={result.state === 'loading'}>Trace <ArrowRight /></button>
      </div>
      {invalid ? <p className="paymentAmountError" id="traceSignatureError" role="status">That is not a transaction signature.</p>
        : !signature && <button className="traceExample" type="button" onClick={() => { setInput(EXAMPLE); onTrace(EXAMPLE) }}>Try a recent withdrawal</button>}
    </form>
    {result.state === 'loading' && <p className="traceLoading"><LoaderCircle className="spin" /> Reading the stored evidence…</p>}
    {result.state === 'error' && <p className="paymentError" role="alert">{result.error}</p>}
    {result.state === 'done' && <Report report={result.report} signature={signature} />}
  </div>
}
