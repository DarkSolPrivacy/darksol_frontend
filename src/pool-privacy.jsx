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
