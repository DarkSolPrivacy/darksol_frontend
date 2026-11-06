// The send page's private options (src/send-options.js picks them), grouped by
// pool: a 5-step privacy meter per option and per pool (its best), what is
// shielded before and after, the settings,
// and the payments waiting to go out. Little text: the meter, the wait and the fee.
import React from 'react'
import { ArrowRight, Check, ChevronDown, Coins, ShieldCheck, X, Zap } from 'lucide-react'
import { LOGOS } from '../protocols/registry.js'
import { TOKEN_DECIMALS } from '../protocols/shared/units.js'

const POOL_NAMES = { privacycash: 'Privacy Cash', cloakc: 'Cloak', umbrav2: 'Umbra v2' }
const WAIT_LABEL = { now: 'Now', '6h': 'In 6 h', '12h': 'In 12 h', '24h': 'In 24 h' }
const usd = (value) => Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value < 0.1 ? 3 : 2 }).format(value)

export function tokenText(raw, asset) {
  const decimals = TOKEN_DECIMALS[asset]
  const value = Number(raw) / 10 ** decimals
  // Cut, never rounded up: "they get 1.00" for 0.995 would overstate it.
  return value.toLocaleString('en-US', { maximumFractionDigits: asset === 'SOL' ? 4 : value < 10 ? 3 : 2, minimumFractionDigits: asset === 'SOL' ? 0 : 2, roundingMode: 'trunc' })
}

const optionLabel = (option) => option.kind === 'balance' ? 'From shielded' : WAIT_LABEL[option.wait]
const meterTone = (level) => level >= 4 ? 'high' : level >= 2 ? 'mid' : 'low'

// How likely a send like this is traced, in words: about 30 sends per measurement
// is good to roughly ±10 points, too coarse to quote as a percentage.
// 0 only when the send is larger than the whole pool and goes out at once.
const TRACE_WORDS = ['Larger than the pool: traced', 'Most likely traced', 'Often traced', 'Sometimes traced', 'Rarely traced', 'Very rarely traced']

/** Privacy as 5 steps; how likely it is traced is in the label for screen readers and on hover. */
export function Meter({ option, large = false }) {
  const level = option?.level ?? 0
  const label = `Privacy ${level} of 5 · ${option ? TRACE_WORDS[level] : 'Not measured'}`
  return <span className={`privMeter ${meterTone(level)}${large ? ' large' : ''}`} role="img" aria-label={label} title={label}>
    {[1, 2, 3, 4, 5].map((step) => <i key={step} className={step <= level ? 'on' : ''} />)}
  </span>
}

// Why the suggestion is the best one (result.reason, src/send-options.js).
const REASONS = {
  privacy: { Icon: ShieldCheck, text: 'Best for privacy: it hides you best' },
  fees: { Icon: Coins, text: 'Best for fees: the lowest fee for its privacy' },
  time: { Icon: Zap, text: 'Best to send now: the most private without a wait' },
}
function BestBadge({ reason }) {
  const { Icon, text } = REASONS[reason] ?? REASONS.privacy
  return <em className="privBest" data-tooltip={text} aria-label={text}><Icon aria-hidden="true" />Best</em>
}

// `shielded` holds the balance of each pool DarkSol reads: undefined while
// unread (Show reads it). A pool missing from it shows no balance. `reading`:
// a read is already running, which Show cannot speed up; `status` says how far it got.
// `more`: the shield-more offer ({ option, base, on, onToggle }), shown beside the meter.
export function PrivateOptions({ result, chosen, onChoose, asset, shielded = {}, reading = false, onReveal, more }) {
  // Pools opened or closed by hand; the chosen option's pool starts open.
  const [toggled, setToggled] = React.useState({})
  if (!result?.suggested || !chosen) return null
  // Every option, grouped by pool: the suggested pool first, then the most private.
  const groups = []
  for (const option of result.options) {
    const group = groups.find((item) => item.protocol === option.protocol)
    if (group) group.options.push(option)
    else groups.push({ protocol: option.protocol, options: [option] })
  }
  for (const group of groups) {
    // The suggestion on top, then the most private; the sooner, then the cheaper, of equals.
    group.options.sort((a, b) => (b === result.suggested) - (a === result.suggested) || b.executable - a.executable
      || b.score - a.score || a.waitSeconds - b.waitSeconds || a.feeUsd - b.feeUsd)
    // Its best scenario: the most private option it can run, else any.
    const pick = group.options.some((option) => option.executable) ? group.options.filter((option) => option.executable) : group.options
    group.best = pick.reduce((best, option) => option.score > best.score ? option : best)
  }
  groups.sort((a, b) => (b.protocol === result.suggested.protocol) - (a.protocol === result.suggested.protocol)
    || b.options.some((option) => option.executable) - a.options.some((option) => option.executable) || b.best.score - a.best.score)
  const row = (option) => <label className={`privOption${option.id === chosen.id ? ' chosen' : ''}${option.executable ? '' : ' off'}`} key={option.id}>
    <input type="radio" name="privOption" checked={option.id === chosen.id} disabled={!option.executable} onChange={() => onChoose(option.id)} />
    <span className="privOptionLabel"><b>{optionLabel(option)}</b>{option.id === result.suggested.id && <BestBadge reason={result.reason} />}{option === result.fastest && <em className="private">Private</em>}{option.paused && <small>Paused</small>}</span>
    <Meter option={option} />
  </label>
  const group = ({ protocol, options, best }) => {
    const open = toggled[protocol] ?? protocol === chosen.protocol
    const name = POOL_NAMES[protocol]
    return <div className={`privGroup${options.includes(result.suggested) ? ' best' : ''}`} key={protocol}>
      <button type="button" className="privGroupHead" aria-expanded={open} aria-label={`${name}, ${options.length} ${options.length === 1 ? 'option' : 'options'}`} onClick={() => setToggled({ ...toggled, [protocol]: !open })}>
        <img src={LOGOS[protocol]?.src} alt="" />
        <span className="privOptionLabel"><b className="privPoolName">{name}</b><small className="privPoolFee">(Fee {usd(best.feeUsd)})</small>{!open && options.includes(result.suggested) && <BestBadge reason={result.reason} />}{!open && options.includes(chosen) && <small className="chosen">{optionLabel(chosen)}</small>}{options.every((option) => option.paused) && <small>{options[0].paused}</small>}</span>
        <Meter option={best} />
        <ChevronDown aria-hidden="true" />
      </button>
      {open && options.map(row)}
    </div>
  }

  return <section className="privOptions" aria-label="How to send">
    {more && <ShieldMore {...more} base={more.on ? more.base : chosen} asset={asset} />}
    <div className="privList" role="radiogroup" aria-label="How to send">
      {groups.map(group)}
    </div>
    {!result.fastest && <PrivateHint result={result} prefix="None of these hides you well." canReveal={!reading && result.balanceHint?.protocol in shielded && shielded[result.balanceHint.protocol] === undefined} onReveal={onReveal} />}
    <div className="privTiles">
      <div><small>{chosen.kind === 'balance' ? 'From shielded' : 'You deposit'}</small><b>{tokenText(chosen.kind === 'balance' ? chosen.receives + chosen.fee : chosen.deposit, asset)}</b></div>
      <div><small>They get ≈</small><b>{tokenText(chosen.receives, asset)}</b></div>
      <div><small>Stays shielded</small><b className={chosen.kept > 0n ? 'up' : ''}>{chosen.kept > 0n ? `+${tokenText(chosen.kept, asset)}` : tokenText(chosen.kind === 'balance' ? chosen.balanceAfter : 0n, asset)}</b></div>
    </div>
  </section>
}

/** Optional: deposit a common amount, send what was typed and keep the rest shielded, for more privacy. */
// Grey until switched on: today's meter, an arrow, the meter with the extra shielded.
export function ShieldMore({ option, base, asset, on, onToggle }) {
  const detail = `Deposit ${tokenText(option.deposit, asset)}: they still get what you typed, the rest stays yours, shielded`
  return <label className={`privHero privMore${on ? ' on' : ''}`} title={detail}>
    {base && <><Meter option={base} large /><b className="privMoreWait">{optionLabel(base)}</b></>}
    <ArrowRight className="privMoreArrow" aria-hidden="true" />
    <Meter option={option} large /><b className="privMoreWait">{optionLabel(option)}</b>
    <span>More private shielding {tokenText(option.kept, asset)} {asset}</span>
    <input type="checkbox" role="switch" className="privSwitch" aria-label={`More private shielding ${tokenText(option.kept, asset)} ${asset}. ${detail}`} checked={on} onChange={(event) => onToggle(event.target.checked)} />
  </label>
}

/** When nothing reaches 4 of 5: what paying from a shielded balance would score, and a way to read it. */
export function PrivateHint({ result, prefix, canReveal, onReveal }) {
  const lead = prefix ? `${prefix} ` : ''
  return <p className="privHint">{result.balanceHint
    ? <>{lead}Paying from a shielded balance scores {result.balanceHint.level} of 5.{canReveal && <button type="button" onClick={onReveal}>Show balance</button>}</>
    : result.balanceOnly ? lead.trim() : `${lead}Try a longer wait or another pool in settings.`}</p>
}

/** Measured privacy for shield only and paying from shielded funds: one line, a hint when it is weak. */
export function MeasuredSummary({ privacy, title, detail, hint, action, onAction }) {
  return <section className="privOptions privMeasured" aria-label="How private this send is">
    <div className="privHero">
      {privacy && <Meter option={privacy} large />}
      <div><b>{title}</b><span>{detail}</span></div>
    </div>
    {hint && <p className="privHint">{hint}{action && <button type="button" onClick={onAction}>{action}</button>}</p>}
  </section>
}

const PRIORITIES = [['privacy', 'Privacy'], ['time', 'Time'], ['fees', 'Fees']]
const MAX_WAITS = [['now', 'None'], ['6h', '6 h'], ['12h', '12 h'], ['24h', '24 h']]

/** The send settings, a modal over the blurred page; a click outside closes it. */
export function SendSettings({ open, settings, onChange, onClose }) {
  const dialog = React.useRef(null)
  React.useEffect(() => { open ? dialog.current?.showModal() : dialog.current?.close() }, [open])
  const set = (patch) => onChange({ ...settings, ...patch })
  const custom = settings.mode === 'custom'
  // One setting per row: what it is on the left, its control on the right.
  const row = (label, detail, control) => <div className="privRow"><span>{label}{detail && <small>{detail}</small>}</span>{control}</div>
  const segment = (items, value, pick, label) => <div className="privSegment" role="group" aria-label={label}>
    {items.map(([id, text]) => <button type="button" key={id} aria-pressed={value === id} onClick={() => pick(id)}>{text}</button>)}
  </div>
  const toggle = (label, detail, checked, onToggle, disabled = false) => <label className="privRow" key={label}>
    <span>{label}{detail && <small>{detail}</small>}</span>
    <input type="checkbox" role="switch" className="privSwitch" checked={checked} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} />
  </label>
  return <dialog className="paymentDialog privSettings" ref={dialog} aria-label="Send settings" onClose={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) dialog.current.close() }}>
    <div className="privSettingsHead"><b>Settings</b><button type="button" aria-label="Close settings" onClick={() => dialog.current.close()}><X /></button></div>
    {row('Mode', custom ? 'You pick the priority and the wait' : 'Privacy first, waits up to 24 h, every pool',
      segment([['auto', 'Auto'], ['custom', 'Custom']], settings.mode, (mode) => set({ mode }), 'Mode'))}
    {custom && <>
      {row('Optimize for', null, segment(PRIORITIES, settings.priority, (priority) => set({ priority }), 'Optimize for'))}
      {row('Longest wait', null, segment(MAX_WAITS, settings.maxWait, (maxWait) => set({ maxWait }), 'Longest wait'))}
    </>}
    {toggle('Never suggest shielding more', 'Deposit only what you send', settings.keepNothing, (keepNothing) => set({ keepNothing }))}
    {toggle('Remind me when ready', 'Notify me when a waiting payment can go out', settings.remind, (remind) => set({ remind }))}
    <hr className="privDivider" />
    {row(<b className="privSection">Pools</b>, custom ? null : 'Auto uses every pool. Switch to Custom to choose.', null)}
    {Object.entries(POOL_NAMES).map(([id, name]) => toggle(name, null, custom ? settings.pools[id] !== false : true,
      (on) => set({ pools: { ...settings.pools, [id]: on } }), !custom))}
  </dialog>
}

const remaining = (ms) => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`
}

/** Payments whose deposit is in: a progress bar until ready, then one tap. */
export function PendingPayments({ items, now, onSend, onKeep, sending }) {
  if (!items.length) return null
  return <section className="privPending" aria-label="Pending payments">
    {items.map((item) => {
      const ready = now >= item.readyAt
      const share = Math.min(1, Math.max(0, (now - item.createdAt) / (item.readyAt - item.createdAt || 1)))
      return <div className={`privPendingItem panel${ready ? ' ready' : ''}`} key={item.id}>
        <div className="privPendingHead">
          <b>{tokenText(BigInt(item.baseUnits), item.asset)} {item.asset}</b>
          <code>→ {item.recipients?.length > 1 ? `${item.recipients.length} recipients` : `${item.recipient.slice(0, 4)}…${item.recipient.slice(-4)}`}</code>
        </div>
        {ready ? <span className="privPendingReady"><Check aria-hidden="true" />Ready to send</span>
          : <div className="privProgress"><span>Ready in {remaining(item.readyAt - now)}</span><i><b style={{ width: `${Math.round(share * 100)}%` }} /></i></div>}
        <div className="privPendingActions">
          <button type="button" className={ready ? 'primary' : ''} onClick={() => onSend(item)} disabled={sending}>{ready ? 'Send' : 'Send early'}</button>
          <button type="button" onClick={() => onKeep(item)} disabled={sending}>Keep shielded</button>
        </div>
      </div>
    })}
  </section>
}
