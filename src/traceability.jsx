import React, { useEffect, useMemo, useState } from 'react'
import { ArrowRight, ArrowUpRight, Check, LoaderCircle } from 'lucide-react'
import { LOGOS } from '../protocols/registry.js'
import {
  BEHIND_REASONS, CREATED_BY, DISCLOSURES, LIMIT_TEXT, REASON_TITLES, STATUS, amountLead, amountMatches, candidateTiers, clueTiles, depositorOf, exampleAmount, exampleLag,
  formatAmount, formatCount, formatSpan, groupCandidates, historyBehind, observationsById, parseSignature, pickExamples, poolName, reasonText, shortSignature, slotSpan,
  traceVerdict,
} from './traceability.js'

const PAGE = 40
// Rows a section shows before "Show all".
const ROWS = 6

const solscan = (signature) => `https://solscan.io/tx/${signature}`
const solscanAccount = (address) => `https://solscan.io/account/${address}`

function Address({ address }) {
  return <a href={solscanAccount(address)} target="_blank" rel="noreferrer" title={address}><code>{shortSignature(address)}</code><ArrowUpRight /></a>
}
function Transaction({ signature }) {
  return <a href={solscan(signature)} target="_blank" rel="noreferrer" title={signature}><code>{shortSignature(signature)}</code><ArrowUpRight /></a>
}

// `signature` comes from parseSignature, so it is plain base58; encoding it
// still keeps anything else from changing the API path.
async function fetchReport(signature, cursor = null) {
  const query = new URLSearchParams({ limit: String(PAGE), ...(cursor && { cursor }) })
  // auto: the backend picks the pool (Privacy Cash or Cloak) from the stored transaction.
  const response = await fetch(`/api/traceability/auto/${encodeURIComponent(signature)}?${query}`, { cache: 'no-store' })
  const body = await response.json().catch(() => null)
  if (response.status === 409) throw new Error('This transaction holds several pool instructions; tracing one of them is not supported here yet.')
  if (!response.ok || !body) throw new Error(body?.detail || body?.error || `The trace service answered ${response.status}.`)
  return body
}

function PoolLogo({ protocol, name }) {
  const logo = LOGOS[protocol]
  return logo ? <img className="traceLogo" src={logo.src} alt={name ?? ''} title={name ?? undefined} /> : null
}

// Recent off-grid withdrawals a same-amount deposit paid for seconds before.
function Examples({ onPick }) {
  const [examples, setExamples] = useState(null)
  useEffect(() => {
    let live = true
    fetch('/api/traceability/examples')
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null)
      .then((body) => live && setExamples(pickExamples(body?.examples)))
    return () => { live = false }
  }, [])
  return <div className="traceExamples">
    {examples && <>
      <span>Try</span>
      {examples.map((example) => <button key={example.signature} type="button" onClick={() => onPick(example.signature)}
        title={`Withdrawn ${formatSpan(exampleLag(example))} after a deposit of the same amount`}>
        <PoolLogo protocol={example.protocol} />{exampleAmount(example)}
      </button>)}
    </>}
  </div>
}

// The pool's logo, what the transaction was and moved, and when.
function Meta({ report, deposit }) {
  const asset = report.deployment?.asset ?? null
  const amounts = report.target.amounts ?? null
  const kind = deposit ? 'Deposit' : { withdraw: 'Withdrawal', swap: 'Swap' }[report.target.direction]
  const blockTime = report.target.blockTime ?? report.linkage?.blockTime
  if (!kind && !LOGOS[report.target.protocol]) return null
  return <div className="traceMeta">
    <PoolLogo protocol={report.target.protocol} name={poolName(report)} />
    {kind && <span>{kind}{amounts && <> of <strong title={deposit ? undefined : `${formatAmount(amounts.net, asset)} reached the recipient`}>{formatAmount(amounts.gross, asset)}</strong></>}</span>}
    {blockTime && <time dateTime={new Date(Number(blockTime) * 1000).toISOString()}>{formatSpan(Date.now() / 1000 - Number(blockTime))} ago</time>}
  </div>
}

function Verdict({ verdict, linkage, lead }) {
  const strongest = verdict.tone === 'strongest'
  const own = strongest ? linkage.top?.find((entry) => entry.wallet === linkage.wallet)?.lastDeposit : null
  return <div className={`traceVerdict ${verdict.tone}`}>
    <h2>{verdict.title}</h2>
    <p>{verdict.text}</p>
    {strongest && <p className="traceVerdictWallet">
      Wallet <Address address={linkage.wallet} />
      {/* Its deposit is shown below when it is the same-amount one. */}
      {own && own.signature !== lead?.signature && <><span aria-hidden="true">·</span> last deposit <Transaction signature={own.signature} /></>}
      {linkage.partner && <><span aria-hidden="true">·</span> with <Transaction signature={linkage.partner} /></>}
    </p>}
  </div>
}

// The same-amount deposit right before the withdrawal, as a deposit → withdrawal pair.
function Lead({ lead, report }) {
  const amounts = report.target.amounts ?? null
  // Its depositor, when the report names one and the verdict has not already named it.
  const named = report.linkage?.status === 'linked' && report.linkage.tier === 'strong' ? report.linkage.wallet : null
  const depositor = depositorOf(report, lead.signature)
  const wallet = depositor === named ? null : depositor
  return <div className="traceLead">
    <div className="traceLeadFlow">
      <div className="traceLeadNode">
        <small>Deposit</small>
        <Transaction signature={lead.signature} />
        {wallet && <span>from <Address address={wallet} /></span>}
      </div>
      <div className="traceLeadGap">
        {amounts && <strong>{formatAmount(amounts.gross, report.deployment?.asset)}</strong>}
        <i aria-hidden="true" />
        <small>{formatSpan(lead.seconds)} later</small>
      </div>
      <div className="traceLeadNode end">
        <small>Withdrawal</small>
        <span>This one</span>
      </div>
    </div>
    <ul className="traceLeadFacts">
      <li><Check />Same amount</li>
      {lead.alone && <li><Check />Nothing else that minute</li>}
      {lead.proofAfter && <li><Check />Proof made right after it</li>}
    </ul>
  </div>
}

function Clues({ report }) {
  const tiles = clueTiles(report)
  if (!tiles.length) return null
  return <dl className="traceClues">
    {tiles.map((tile) => <div key={tile.id} className={tile.flag ? 'flag' : undefined} title={tile.hint}>
      <dt>{tile.label}</dt><dd>{formatCount(tile.value)}</dd>
    </div>)}
  </dl>
}

// The clue a rule already states, so a row does not say it twice.
const RULE_CLUE = { exact_balance: 'Exact balance', exact_deposit: 'Same-amount deposit', pair_sum: 'Completes a pair', root_pinned: 'Deposit before proof' }

const TIERS = [
  { id: 'strongest', name: 'Strongest', hint: 'Clearly the one' },
  { id: 'probable', name: 'Probable', hint: 'Clues fit, not certain' },
  { id: 'possible', name: 'Possible', hint: 'Could have paid' },
]

// The candidate wallets in their tiers, strongest first; the possible ones fold after a few rows.
function Candidates({ report }) {
  const [all, setAll] = useState(false)
  const tiers = useMemo(() => candidateTiers(report), [report])
  const linkage = report.linkage ?? null
  const listed = TIERS.filter(({ id }) => tiers[id].length)
  if (!listed.length) return null
  // Cloak's candidates are wallets that deposited enough, not ones known to hold it (backend candidatesMeaning).
  const enough = linkage?.candidatesMeaning ? 'Deposited enough' : 'Had enough in the pool'
  const why = (row) => [LINK_RULE_NAMES[row.rule], ...row.clues.filter((clue) => clue !== RULE_CLUE[row.rule])].filter(Boolean).join(' · ') || enough
  return <section className="panel traceSection">
    <div className="traceSectionHead">
      <h2>Candidates</h2>
      {linkage?.candidates != null && <span>{formatCount(linkage.candidates)} {linkage.candidatesMeaning ? 'wallets deposited enough' : 'wallets could have paid'}</span>}
    </div>
    <ul className="traceTierCounts" aria-label="Candidates per tier">
      {TIERS.map(({ id, name }) => <li className={id} key={id}><i aria-hidden="true" /><b>{tiers[id].length}{id === 'possible' && tiers.unlisted ? '+' : ''}</b>{name}</li>)}
    </ul>
    <div className="traceTable candidates" role="table" aria-label="Candidate wallets">
      <div className="traceRow head" role="row"><span role="columnheader">Wallet</span><span role="columnheader">Deposit</span><span role="columnheader">Clue</span><span role="columnheader">Before</span></div>
      {listed.map(({ id, name, hint }) => {
        const rows = id === 'possible' && !all ? tiers[id].slice(0, ROWS) : tiers[id]
        return <div className={`traceTier ${id}`} role="rowgroup" key={id}>
          <div className="traceTierHead" role="row"><span role="columnheader"><i aria-hidden="true" />{name}<small>{hint}</small></span></div>
          {rows.map((row) => <div className={`traceRow${row.lead ? ' match' : ''}`} role="row" key={row.wallet ?? row.signature}>
            <span role="cell">{row.wallet ? <Address address={row.wallet} /> : '–'}</span>
            <span role="cell">{row.signature && <Transaction signature={row.signature} />}</span>
            <span role="cell" className="traceWhy">{why(row)}</span>
            <code role="cell">{row.seconds === null ? '' : formatSpan(row.seconds)}</code>
          </div>)}
        </div>
      })}
    </div>
    {!all && tiers.possible.length > ROWS && <button className="ghost traceMore" type="button" onClick={() => setAll(true)}>Show all {tiers.possible.length} possible</button>}
  </section>
}

// A deposit: the withdrawals the linker names its wallet for from then on.
function DepositLinks({ linkage, asset, slot }) {
  const rows = linkage.withdrawals ?? []
  if (!rows.length) return null
  return <section className="panel traceSection">
    <div className="traceSectionHead"><h2>Withdrawals this wallet is the candidate for</h2></div>
    <div className="traceTable" role="table" aria-label="Withdrawals this wallet is the candidate for">
      <div className="traceRow head" role="row"><span role="columnheader">Withdrawal</span><span role="columnheader">Clue</span><span role="columnheader">Amount</span><span role="columnheader">After</span></div>
      {rows.map((row) => <div className="traceRow" role="row" key={row.signature}>
        <span role="cell"><Transaction signature={row.signature} /></span>
        <span role="cell" className="traceWhy">{LINK_RULE_NAMES[row.rule] ?? row.rule} · {row.tier === 'strong' ? 'Strongest' : 'Probable'}</span>
        <code role="cell">{formatAmount(row.gross, asset)}</code>
        <code role="cell">{formatSpan(slotSpan(row.slot, slot))}</code>
      </div>)}
    </div>
  </section>
}

const LINK_RULE_NAMES = {
  self_relay: 'Own signature', same_address: 'Paid back to itself', only_feasible: 'Only wallet with enough',
  exact_balance: 'Emptied the wallet', exact_deposit: 'Same amount', pair_sum: 'Pair emptied the wallet', root_pinned: 'Proof right after deposit',
}

// The newest transactions before the withdrawal on a time axis that ends at
// it. Log scale, so the last minute and the last day both stay readable.
function NoteStrip({ groups, targetSlot, matches }) {
  const spans = groups.map((group) => Math.max(0, Number(targetSlot) - Number(group.slot)))
  const widest = Math.max(1, ...spans)
  const at = (slots) => 100 - (Math.log1p(slots) / Math.log1p(widest)) * 100
  const ticks = [[150, '1 min'], [1500, '10 min'], [9000, '1 h'], [54000, '6 h'], [216000, '1 day'], [1512000, '1 week']]
    // Clear of the end labels, which would otherwise overlap them.
    .filter(([slots]) => at(slots) > 22 && at(slots) < 78)
  return <div className="traceStrip" role="img" aria-label={`${groups.length} newest transactions over the ${formatSpan(slotSpan(widest, 0))} before the withdrawal`}>
    <div className="traceStripAxis" />
    {ticks.map(([slots, label]) => <span className="traceStripTick" key={label} style={{ left: `${at(slots)}%` }}><small>{label}</small></span>)}
    <span className="traceStripTick target" style={{ left: '100%' }}><small>Withdrawal</small></span>
    <span className="traceStripTick oldest" style={{ left: '0%' }}><small>{formatSpan(slotSpan(widest, 0))}</small></span>
    {groups.map((group, index) => {
      const match = matches.has(group.signature)
      return <i key={group.signature} className={`traceDot ${group.createdBy === 'deposit' ? 'deposit' : 'change'}${match ? ' match' : ''}`}
        style={{ left: `${at(spans[index])}%` }} title={`${CREATED_BY[group.createdBy] ?? 'Transaction'}${match ? ', same amount' : ''}, ${formatSpan(slotSpan(spans[index], 0))} before`} />
    })}
  </div>
}

// What happened in the pool right before the withdrawal.
function Activity({ report, signature }) {
  const [groups, setGroups] = useState(() => groupCandidates(report.candidates?.items))
  const [next, setNext] = useState(report.candidates?.page?.next ?? null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const matches = useMemo(() => amountMatches(report.observations), [report])
  const targetSlot = report.target.slot

  const expanded = open || groups.length <= ROWS
  async function more() {
    if (!expanded) return setOpen(true)
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
  const shown = expanded ? groups : groups.slice(0, ROWS)
  return <section className="panel traceSection">
    <div className="traceSectionHead">
      <h2>Pool activity before it</h2>
      <ul className="traceLegend" aria-label="Legend">
        <li><i className="traceDot deposit" />Deposit</li>
        <li><i className="traceDot change" />Withdrawal change</li>
        {matches.size > 0 && <li><i className="traceDot deposit match" />Same amount</li>}
      </ul>
    </div>
    <NoteStrip groups={groups} targetSlot={targetSlot} matches={matches} />
    <div className="traceTable activity" role="table" aria-label="Pool activity before the withdrawal">
      {shown.map((group) => {
        const match = matches.has(group.signature)
        return <div className={`traceRow${match ? ' match' : ''}`} role="row" key={group.signature}>
          <span role="cell" className="traceKind"><i className={`traceDot ${group.createdBy === 'deposit' ? 'deposit' : 'change'}${match ? ' match' : ''}`} />{CREATED_BY[group.createdBy] ?? 'Transaction'}{match && <em>Same amount</em>}</span>
          <span role="cell"><Transaction signature={group.signature} /></span>
          <code role="cell">{formatSpan(slotSpan(targetSlot, group.slot))} before</code>
        </div>
      })}
    </div>
    {error && <p className="paymentError traceInlineError" role="alert">{error}</p>}
    {(!expanded || next) && <button className="ghost traceMore" type="button" onClick={more} disabled={loading}>
      {loading ? <><LoaderCircle className="spin" /> Loading…</> : expanded ? 'Show older' : 'Show more'}
    </button>}
  </section>
}

// Everything behind the figures above, for whoever wants to check them.
function Details({ report }) {
  const byId = observationsById(report.observations)
  const candidates = report.candidates
  const rootLag = byId.root_lag_leaves?.value
  const replay = report.coverage?.rootReconstruction
  const live = replay?.liveCheck
  const build = report.deployment?.verification?.verifiedBuild
  const facts = [
    candidates && ['Notes in the pool', candidates.exact ? formatCount(candidates.count) : `${formatCount(candidates.bounds?.min)}–${formatCount(candidates.bounds?.max)}`, 'Every note that could have paid, change included'],
    rootLag != null && ['Proof freshness', rootLag === '0' ? 'Newest' : `${formatCount(rootLag)} behind`, rootLag === '0' ? 'Built on the pool’s latest state' : 'Notes added after the proof are excluded'],
    byId.oldest_eligible_seconds?.value != null && ['Oldest possible source', formatSpan(byId.oldest_eligible_seconds.value), 'before this withdrawal'],
    report.root?.root && ['Proof root', <code key="root" title={report.root.root}>{shortSignature(report.root.root)}</code>, report.root.validation === 'validated' ? 'Matched by replay' : report.root.validation],
    replay?.replayedLeaves && ['Pool history', `${formatCount(replay.replayedLeaves)} notes`, replay.fromGenesis ? 'Replayed from the first note' : 'Partly replayed'],
    replay?.proofRootsChecked && ['On-chain proofs', `${formatCount(replay.proofRootsMatched)} / ${formatCount(replay.proofRootsChecked)}`, 'Proof roots that match the replay'],
    live && ['Live pool', live.root && live.frontier && live.ring ? 'Matches' : 'Differs', `Checked at slot ${formatCount(live.slot)}`],
    build && ['Program', `${build.version} verified build`, `Commit ${build.commit.slice(0, 7)}`],
  ].filter(Boolean)
  const limits = report.reasons.filter(({ code }) => DISCLOSURES.has(code))
  if (!facts.length && !limits.length) return null
  return <details className="traceDetails">
    <summary>How this was checked</summary>
    {facts.length > 0 && <dl>{facts.map(([label, value, note]) => <div key={label}><dt>{label}</dt><dd>{value}</dd><small>{note}</small></div>)}</dl>}
    {limits.length > 0 && <>
      <h3>What this report cannot tell</h3>
      <ul>{limits.map(({ code, detail }) => <li key={code}><strong>{reasonText(REASON_TITLES, report.target.protocol, code) ?? code}</strong> {reasonText(LIMIT_TEXT, report.target.protocol, code) ?? detail}</li>)}</ul>
    </>}
  </details>
}

function Report({ report, signature }) {
  const linkage = report.linkage ?? null
  // A deposit is refused as a withdrawal target, but its wallet's links are shown instead.
  const deposit = linkage?.status === 'deposit'
  // The status line already says a transaction is not indexed.
  // The verdict already says when the history has not reached it.
  const behind = Boolean(historyBehind(report))
  const blocking = report.reasons.filter(({ code }) => !DISCLOSURES.has(code) && code !== 'TARGET_NOT_INDEXED' && !(deposit && code === 'TARGET_NOT_WITHDRAWAL')
    && !(behind && BEHIND_REASONS.has(code)))
  const verdict = traceVerdict(report)
  const lead = amountLead(report)
  const traced = Boolean(report.candidates)
  const withdrawals = linkage?.withdrawals?.length ?? 0
  return <>
    <section className="panel traceSummary">
      <Meta report={report} deposit={deposit} />
      {verdict ? <Verdict verdict={verdict} linkage={linkage} lead={lead} />
        : deposit ? <div className="traceVerdict">
          <h2>{withdrawals ? `Its wallet is the candidate for ${withdrawals} withdrawal${withdrawals === 1 ? '' : 's'}` : 'No withdrawal points to its wallet yet'}</h2>
          {linkage.wallet && <p className="traceVerdictWallet">Wallet <Address address={linkage.wallet} /></p>}
        </div>
          : STATUS[report.status] && <p className="traceStatusText">{STATUS[report.status]}</p>}
      {blocking.length > 0 && <ul className="traceBlocking">{blocking.map(({ code, detail }) => <li key={code} title={detail}>{REASON_TITLES[code] ?? detail}</li>)}</ul>}
      {traced && (lead || clueTiles(report).length > 0) && <div className="traceCluesBlock">
        <h3>Public clues</h3>
        {lead && <Lead lead={lead} report={report} />}
        <Clues report={report} />
      </div>}
    </section>
    {deposit && <DepositLinks linkage={linkage} asset={report.deployment?.asset ?? null} slot={report.target.slot} />}
    {traced && <>
      <Candidates report={report} />
      <Activity report={report} signature={signature} />
      <Details report={report} />
    </>}
  </>
}

export default function TracePage({ signature = '', onTrace }) {
  // Only a parsed signature reaches the API; a hand-typed path is checked like the input.
  const target = parseSignature(signature)
  const [input, setInput] = useState(target ?? signature)
  const [invalid, setInvalid] = useState(Boolean(signature) && !target)
  const [result, setResult] = useState(target ? { state: 'loading' } : { state: 'idle' })

  useEffect(() => {
    if (!target) return
    let live = true
    setResult({ state: 'loading' })
    fetchReport(target)
      .then((report) => live && setResult({ state: 'done', report }))
      .catch((error) => live && setResult({ state: 'error', error: error.message }))
    return () => { live = false }
  }, [target])

  function submit(event) {
    event.preventDefault()
    const parsed = parseSignature(input)
    setInvalid(!parsed)
    if (parsed) {
      setInput(parsed)
      onTrace(parsed)
    }
  }

  return <div className="tracePage">
    <header className="traceHeader"><h1>Trace a withdrawal</h1></header>
    <form className="traceSearch" onSubmit={submit} noValidate>
      <label className="paymentFieldLabel" htmlFor="traceSignature">Privacy pool tx hash</label>
      <div className="traceSearchRow">
        <input id="traceSignature" value={input} onChange={(event) => { setInput(event.target.value); setInvalid(false) }}
          placeholder="Tx hash or Solscan link" spellCheck={false} autoComplete="off" aria-invalid={invalid} aria-describedby={invalid ? 'traceSignatureError' : undefined} />
        <button className="paymentPrimary" type="submit" disabled={result.state === 'loading'}>Trace <ArrowRight /></button>
      </div>
      {invalid ? <p className="paymentAmountError" id="traceSignatureError" role="status">That is not a transaction hash.</p>
        : !target && <Examples onPick={(example) => { setInput(example); onTrace(example) }} />}
    </form>
    {result.state === 'loading' && <p className="traceLoading"><LoaderCircle className="spin" /> Tracing…</p>}
    {result.state === 'error' && <p className="paymentError" role="alert">{result.error}</p>}
    {result.state === 'done' && <Report report={result.report} signature={target} />}
  </div>
}
