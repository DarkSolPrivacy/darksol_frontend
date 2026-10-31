// The send page's private options (src/send-options.js picks them): a 5-step
// privacy meter per option, what is shielded before and after, the settings,
// and the payments waiting to go out. Little text: the meter, the wait and the fee.
import React from 'react'
import { Check, ChevronDown, ShieldCheck, SlidersHorizontal, TriangleAlert, X } from 'lucide-react'
import { PROTOCOLS } from '../protocols/registry.js'
import { TOKEN_DECIMALS } from '../protocols/shared/units.js'

const POOL_NAMES = { privacycash: 'Privacy Cash', cloakc: 'Cloak', umbrav2: 'Umbra v2' }
// What a user should know about each contract before keeping money in it
// (darksol-backend docs/*_FORENSICS.md). Cloak's multisig is per its own docs.
const POOL_RISK = {
  privacycash: { text: 'Multisig · verified', tone: 'good' },
  cloakc: { text: 'Multisig', tone: 'plain' },
  umbrav2: { text: 'One key', tone: 'warn' },
}
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

/** Privacy as 5 steps; the exact share is in the label for screen readers and on hover. */
export function Meter({ option, large = false }) {
  const level = option?.level ?? 0
  const label = `Privacy ${level} of 5 · ${option ? 100 - option.score : '—'}% of sends like this were traced`
  return <span className={`privMeter ${meterTone(level)}${large ? ' large' : ''}`} role="img" aria-label={label} title={label}>
    {[1, 2, 3, 4, 5].map((step) => <i key={step} className={step <= level ? 'on' : ''} />)}
  </span>
}

export function PrivateOptions({ result, chosen, onChoose, asset, shielded, onReveal, onSettings }) {
  const [othersOpen, setOthersOpen] = React.useState(false)
  if (!result?.suggested || !chosen) return null
  // One row per way to send (now, each wait, from shielded): the suggestion, the
  // fastest really private one, the plain send, then the suggested pool's
  // option, else the best other pool's. The rest fold under "Other pools".
  const main = []
  const taken = new Set()
  const take = (option, always = false) => {
    const slot = option && `${option.kind}:${option.wait}`
    if (!option?.executable || main.includes(option) || (taken.has(slot) && !always)) return
    main.push(option); taken.add(slot)
  }
  take(result.suggested); take(result.fastest, true); take(result.asTyped)
  const runnable = result.options.filter((option) => option.executable)
  for (const option of runnable) if (option.protocol === result.suggested.protocol) take(option)
  for (const option of runnable) take(option)
  const order = { balance: 0, now: 1, later: 2 }
  main.sort((a, b) => order[a.kind] - order[b.kind] || a.waitSeconds - b.waitSeconds)
  const others = result.options.filter((option) => !main.includes(option))
  const before = chosen.kind === 'balance' ? chosen.balanceBefore : shielded ?? null
  const after = chosen.kind === 'balance' ? chosen.balanceAfter : before === null ? chosen.kept : before + chosen.kept
  const row = (option) => <label className={`privOption${option.id === chosen.id ? ' chosen' : ''}${option.executable ? '' : ' off'}`} key={option.id}>
    <input type="radio" name="privOption" checked={option.id === chosen.id} disabled={!option.executable} onChange={() => onChoose(option.id)} />
    <span className="privOptionLabel"><b>{optionLabel(option)}</b>{option.id === result.suggested.id && <em>Best</em>}{option === result.fastest && <em className="private">Private</em>}<small>{POOL_NAMES[option.protocol]}</small></span>
    <Meter option={option} />
  </label>

  return <section className="privOptions" aria-label="How to send">
    <div className="privShielded">
      <span><ShieldCheck aria-hidden="true" />Shielded</span>
      {shielded === undefined && chosen.kind !== 'balance'
        ? <button type="button" className="privReveal" onClick={onReveal}>Show</button>
        : <b>{before === null ? '—' : tokenText(before, asset)} <i aria-hidden="true">→</i> <span className={after > (before ?? 0n) ? 'up' : ''}>{tokenText(after, asset)}</span> <small>{asset}</small></b>}
      <button type="button" className="privSettingsButton" aria-label="Send settings" onClick={onSettings}><SlidersHorizontal /></button>
    </div>
    <div className="privHero">
      <Meter option={chosen} large />
      <div>
        <b>{chosen.waitSeconds ? `Sends ${WAIT_LABEL[chosen.wait].toLowerCase()}` : 'Sends now'}</b>
        <span>Fee {usd(chosen.feeUsd)}{chosen.feePct >= 5 ? ` (${Math.round(chosen.feePct)}%)` : ''} · {POOL_NAMES[chosen.protocol]}</span>
      </div>
    </div>
    <div className="privList" role="radiogroup" aria-label="When to send">
      {main.map(row)}
      {others.length > 0 && <>
        <button type="button" className="privOthers" aria-expanded={othersOpen} onClick={() => setOthersOpen(!othersOpen)}>Other pools <ChevronDown /></button>
        {othersOpen && others.map(row)}
      </>}
    </div>
    {!result.fastest && <PrivateHint result={result} prefix="None of these hides you well." canReveal={shielded === undefined} onReveal={onReveal} />}
    <div className="privTiles">
      <div><small>{chosen.kind === 'balance' ? 'From shielded' : 'You deposit'}</small><b>{tokenText(chosen.kind === 'balance' ? chosen.receives + chosen.fee : chosen.deposit, asset)}</b></div>
      <div><small>They get ≈</small><b>{tokenText(chosen.receives, asset)}</b></div>
      <div><small>Stays shielded</small><b className={chosen.kept > 0n ? 'up' : ''}>{chosen.kept > 0n ? `+${tokenText(chosen.kept, asset)}` : tokenText(chosen.kind === 'balance' ? chosen.balanceAfter : 0n, asset)}</b></div>
    </div>
  </section>
}

/** When nothing reaches 4 of 5: what paying from a shielded balance would score, and a way to read it. */
export function PrivateHint({ result, prefix, canReveal, onReveal }) {
  const lead = prefix ? `${prefix} ` : ''
  return <p className="privHint">{result.balanceHint
    ? <>{lead}Paying from a shielded balance scores {result.balanceHint.level} of 5.{canReveal && <button type="button" onClick={onReveal}>Show balance</button>}</>
    : `${lead}Try a longer wait or another pool in settings.`}</p>
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

export function SendSettings({ settings, onChange, onClose }) {
  const set = (patch) => onChange({ ...settings, ...patch })
  const custom = settings.mode === 'custom'
  const segment = (items, value, pick, label) => <div className="privSegment" role="group" aria-label={label}>
    {items.map(([id, text]) => <button type="button" key={id} aria-pressed={value === id} onClick={() => pick(id)}>{text}</button>)}
  </div>
  return <section className="privSettings panel" aria-label="Send settings">
    <div className="privSettingsHead"><b>Send settings</b><button type="button" aria-label="Close settings" onClick={onClose}><X /></button></div>
    {segment([['auto', 'Auto'], ['custom', 'Custom']], settings.mode, (mode) => set({ mode }), 'Mode')}
    {custom ? <>
      <span className="privSettingsLabel">Optimize for</span>
      {segment(PRIORITIES, settings.priority, (priority) => set({ priority }), 'Optimize for')}
      <span className="privSettingsLabel">Longest wait</span>
      {segment(MAX_WAITS, settings.maxWait, (maxWait) => set({ maxWait }), 'Longest wait')}
    </> : <div className="privChips"><span className="good">Privacy first</span><span>Wait up to 24 h</span><span>Best pool</span></div>}
    <div className="privToggles">
      <label>Keep nothing in pools<input type="checkbox" checked={settings.keepNothing} onChange={(event) => set({ keepNothing: event.target.checked })} /></label>
      <label>Remind me when ready<input type="checkbox" checked={settings.remind} onChange={(event) => set({ remind: event.target.checked })} /></label>
    </div>
    <span className="privSettingsLabel">Pools</span>
    <div className="privToggles">
      {Object.entries(POOL_NAMES).map(([id, name]) => <label key={id}>
        <span>{name}</span>
        <small className={POOL_RISK[id].tone}>{POOL_RISK[id].tone === 'warn' && <TriangleAlert aria-hidden="true" />}{POOL_RISK[id].text}</small>
        <input type="checkbox" checked={custom ? settings.pools[id] !== false : true} disabled={!custom} onChange={(event) => set({ pools: { ...settings.pools, [id]: event.target.checked } })} />
      </label>)}
    </div>
  </section>
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
