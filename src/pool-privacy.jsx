import { useEffect, useState } from 'react'
import { ArrowUpRight, CircleHelp } from 'lucide-react'
import { PRIVACY_POOLS, SOON_CLUES, outsideSummary, privacyTiles, ruleRows } from './pool-privacy.js'

const RANGE_TEXT = { '1H': 'last hour', '6H': 'last 6 hours', '1D': 'last 24 hours', '30D': 'last 30 days', '90D': 'last 90 days' }

/** A "?" that shows what a figure means on hover or tap, so the page itself stays short. */
export function Hint({ text }) {
  return <button type="button" className="hint" aria-label={text} data-tooltip={text}><CircleHelp /></button>
}

// GET /api/pool-privacy for the dashboard's pool and range, every 30 s like the
// rest of the page. Null until the backend has stats for it: then the section
// stays hidden instead of showing zeros.
function usePoolPrivacy(protocol, range) {
  const [stats, setStats] = useState(null)
  useEffect(() => {
    setStats(null)
    if (!PRIVACY_POOLS.includes(protocol)) return undefined
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(`/api/pool-privacy?protocol=${protocol}&interval=${range.toLowerCase()}`, { signal: controller.signal })
        setStats(response.ok ? await response.json() : null)
      } catch (error) { if (error.name !== 'AbortError') setStats(null) }
    }
    load(); const timer = setInterval(load, 30_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [protocol, range])
  return stats
}

export default function PoolPrivacy({ protocol, range }) {
  const stats = usePoolPrivacy(protocol, range)
  if (!stats) return null
  const rules = ruleRows(stats)
  const outside = outsideSummary(stats.outside24h)
  return <section className="poolPrivacy" aria-label="Pool privacy">
    <div className="sectionTitle"><h2>What gives withdrawals away</h2><span>{RANGE_TEXT[range]} · {stats.withdrawals.toLocaleString('en-US')} withdrawals</span></div>
    <section className="activityMetrics privacyMetrics">{privacyTiles(stats).map(({ label, value, note, hint }) => <div className="metric" key={label}><p>{label}<Hint text={hint} /></p><strong>{value}</strong><small>{note}</small></div>)}</section>
    <div className="analyticsRow">
      <section className="panel privacyRules">
        <div className="panelHead"><div><h2>Why one wallet stood out</h2><p>The rule that pointed to one wallet</p></div><a className="ghost" href="/trace">Trace one <ArrowUpRight /></a></div>
        {rules.length ? <div className="privacyBars">{rules.map(({ rule, name, count, width }) => <div className={rule} key={rule}><span>{name}</span><i><b style={{ width: `${width}%` }} /></i><strong>{count.toLocaleString('en-US')}</strong></div>)}</div> : <div className="empty smallEmpty">No strongest candidate in this window</div>}
      </section>
      <section className="panel privacyOutside">
        <div className="panelHead"><div><h2>Met outside the pool<Hint text="People often withdraw to a fresh wallet, then need SOL in it for fees. The easiest place to get it is their own deposit wallet. One small transfer between the two ties them together, however carefully the pool was used." /></h2><p>Recipients of the last 24 hours’ withdrawals</p></div></div>
        <div className="privacyHeadline"><strong>{outside.value}</strong><span>{outside.note}</span></div>
        {outside.parts.length > 0 && <ul className="privacyParts">{outside.parts.map(({ key, label, count }) => <li className={key} key={key}><span>{label}</span><b>{count.toLocaleString('en-US')}</b></li>)}</ul>}
      </section>
    </div>
    <p className="privacySoon"><span>Coming soon</span>{SOON_CLUES.map(({ title, text }) => <em key={title} data-tooltip={text} tabIndex={0}>{title}</em>)}</p>
  </section>
}

const CI_RULES = [
  ['same_account', 'Back to the same account'],
  ['value', 'Only entry of that dollar value'],
  ['exact_amount', 'Same token and amount'],
  ['solver_leg', 'Solver paid in the input token'],
  ['same_address', 'Withdrawn to the depositor’s wallet'],
]
const CI_SENDS = [['exact', 'now', 'Exact, now'], ['keep', '6h', 'Keep part, 6 h'], ['keep', '24h', 'Keep part, 24 h'], ['balance', 'now', 'From balance']]
const pct = (part, whole) => whole ? `${Math.round(100 * part / whole)}%` : '—'

/**
 * NEAR Confidential Intents on the analytics page (darksol-backend
 * docs/NEAR_CI.md): what the linker pairs over the CI Treasury's public flows,
 * and how often a typical DarkSol send would be traced. GET /api/near-ci/stats.
 */
export function NearCiPrivacy() {
  const [stats, setStats] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/near-ci/stats', { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error('unavailable'); setStats(await response.json()) })
      .catch((error) => { if (error.name !== 'AbortError') setFailed(true) })
    return () => controller.abort()
  }, [])
  if (!stats) return failed ? <section className="notice"><span>NEAR Confidential Intents measurements are still loading; try again in a few minutes.</span></section> : null
  const days = Math.round((Date.parse(stats.window.to) - Date.parse(stats.window.from)) / 86_400_000)
  const max = Math.max(1, ...CI_RULES.map(([rule]) => stats.rules[rule] ?? 0))
  const tiles = [
    { label: 'Exit paired with its entry', value: pct(stats.paired, stats.considered), note: `${stats.paired.toLocaleString('en-US')} of ${stats.considered.toLocaleString('en-US')}`, hint: 'Exits where one public clue points to exactly one entry: the same account, a solver payment, the same amount, or the only entry of that dollar value in the 5 minutes before.' },
    { label: 'Back to the same account', value: pct(stats.rules.same_account, stats.considered), note: 'within 5 minutes', hint: 'The money came back out to the very account that put it in. For these swaps the confidential pool hid nothing.' },
    { label: 'Only look-alike nearby', value: pct(stats.rules.value, stats.considered), note: 'within 2% in dollars, 5 minutes', hint: 'No other entry of a similar dollar value in the 5 minutes before the exit, whatever the token.' },
    { label: 'User entries', value: stats.entries.toLocaleString('en-US'), note: `$${Math.round(stats.volumeUsd / 1e6).toLocaleString('en-US')}M in ${days} days`, hint: 'Deposits into the CI Treasury by accounts other than market makers.' },
  ]
  return <section className="poolPrivacy" aria-label="NEAR Confidential Intents privacy">
    <div className="sectionTitle"><h2>What gives NEAR Confidential Intents swaps away</h2><span>last {days} days · {stats.considered.toLocaleString('en-US')} exits</span></div>
    <section className="activityMetrics privacyMetrics">{tiles.map(({ label, value, note, hint }) => <div className="metric" key={label}><p>{label}<Hint text={hint} /></p><strong>{value}</strong><small>{note}</small></div>)}</section>
    <div className="analyticsRow">
      <section className="panel privacyRules">
        <div className="panelHead"><div><h2>Why one entry stood out</h2><p>The clue that paired an exit with its entry</p></div></div>
        <div className="privacyBars">{CI_RULES.map(([rule, name]) => <div className={rule} key={rule}><span>{name}</span><i><b style={{ width: `${Math.round(100 * (stats.rules[rule] ?? 0) / max)}%` }} /></i><strong>{(stats.rules[rule] ?? 0).toLocaleString('en-US')}</strong></div>)}</div>
      </section>
      <section className="panel privacyOutside">
        <div className="panelHead"><div><h2>A DarkSol send through it<Hint text="Simulated sends on the same data: a fresh 1Click account in and another out, the same token, as DarkSol sends. Traced means a clue above, or an observer who knows DarkSol's strategies, named the send's entry." /></h2><p>Share of simulated sends traced</p></div></div>
        <table className="ciSends"><thead><tr><th />{CI_SENDS.map(([, , label]) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{stats.examples.map(({ asset, amount, cells }) => <tr key={asset}><th>{amount} {asset}</th>{CI_SENDS.map(([strategy, wait, label]) => {
            const cell = cells.find((one) => one.strategy === strategy && one.wait === wait)
            return <td key={label}>{cell?.sends ? pct(cell.traced, cell.sends) : '—'}</td>
          })}</tr>)}</tbody></table>
      </section>
    </div>
    <p className="privacyNote">Measured from the public flows of the CI Treasury on intents.near. CI hides who paid whom only from the public: 1Click, which runs the swaps, and the permissioned validators of NEAR’s private chain see every transfer.</p>
  </section>
}
