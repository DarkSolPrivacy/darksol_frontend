import React, { useRef, useState } from 'react'
import { ArrowRight, Link2, Settings } from 'lucide-react'
import { LOGOS, PROTOCOLS } from '../protocols/registry.js'
import { parseAmount, sanitizeAmount } from './transfer-validation.js'

const POOLS = [{ id: 'privacycash', name: 'Privacy Cash' }, { id: 'cloakc', name: 'Cloak' }]
const format = (value, digits = 6) => Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)

export default function PaymentLinks({ summary }) {
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [pool, setPool] = useState('cloakc')
  const [sort, setSort] = useState('fees')
  const settings = useRef(null)
  const amountResult = parseAmount(amount, 'SOL')
  const amountError = amount && !amountResult.valid ? amountResult.error : ''
  const pools = POOLS.map((item) => {
    const fees = PROTOCOLS[item.id].fees
    const activity = summary.pools.find((entry) => entry.protocol === item.id)
    const hasVolume = !summary.loading && !summary.error && activity
      && Number.isFinite(activity.inflow) && activity.inflow >= 0
      && Number.isFinite(activity.outflow) && activity.outflow >= 0
    return {
      ...item, fees,
      fee: fees.fixedAmount + (amountResult.valid ? Number(amountResult.normalized) * fees.variableRate : 0),
      volume: hasVolume ? activity.inflow + activity.outflow : null,
    }
  })
  const volumeAvailable = pools.every((item) => item.volume !== null)
  // Keep the known order when activity is unavailable; missing data is not zero volume.
  pools.sort((a, b) => sort === 'fees' ? a.fee - b.fee : volumeAvailable ? b.volume - a.volume : 0)

  return <div className="homePage paymentLinksPage">
    <header><div><p className="eyebrow">PAYMENT LINKS</p><h1>Receive privately</h1></div></header>
    <p className="paymentIntro">Get paid without sharing your wallet address with your customer.</p>

    <form className="sendCard panel paymentCreate" onSubmit={(event) => event.preventDefault()}>
      <div className="paymentSectionTitle"><Link2 aria-hidden="true" /><h2>Create a payment link</h2><span>Solana</span></div>
      <label className="paymentFieldLabel" htmlFor="paymentAmount">REQUEST AMOUNT</label>
      <div className="amountRow paymentAmountRow">
        <input id="paymentAmount" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" maxLength={30} value={amount} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'paymentAmountError' : undefined} onChange={(event) => setAmount(sanitizeAmount(event.target.value))} />
        <span className="paymentAsset"><img src="/logos/sol.svg" alt="" />SOL</span>
      </div>
      {amountError && <p className="paymentAmountError" id="paymentAmountError" role="status">{amountError}</p>}
      <div className="paymentReference"><label className="paymentFieldLabel" htmlFor="paymentReference">REFERENCE <span>Optional</span></label><input id="paymentReference" placeholder="Add an invoice or order reference" maxLength={80} value={reference} onChange={(event) => setReference(event.target.value)} /></div>
      <div className="paymentPoolHeading">
        <span className="paymentFieldLabel" id="paymentPoolLabel">RECEIVE THROUGH</span>
        {/* Closing on blur hides the radio during label activation and can crash Chrome. */}
        <details className="paymentSort" ref={settings} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            settings.current.open = false
            settings.current.querySelector('summary').focus()
          }
        }}>
          <summary aria-label="Pool sorting preferences" title="Pool sorting preferences"><Settings aria-hidden="true" /></summary>
          <fieldset className="paymentSortOptions"><legend>Sort pools by</legend>
            <label><input type="radio" name="paymentSort" value="fees" checked={sort === 'fees'} onChange={() => setSort('fees')} /><span><strong>Lowest fees</strong><small>Lower estimated withdrawal costs first.</small></span></label>
            <label><input type="radio" name="paymentSort" value="volume" checked={sort === 'volume'} onChange={() => setSort('volume')} /><span><strong>Most active pools</strong><small>Higher 24-hour volume first. More activity can offer better privacy cover.</small></span></label>
          </fieldset>
        </details>
        <span className="paymentSortLabel">{sort === 'fees' ? 'Lowest fees first' : 'Most active first'}</span>
      </div>
      <fieldset className="paymentPoolPicker" aria-labelledby="paymentPoolLabel"><div>{pools.map((item) => <label className={pool === item.id ? 'selected' : ''} key={item.id}>
        <input type="radio" name="paymentPool" value={item.id} checked={pool === item.id} onChange={() => setPool(item.id)} />
        <img src={LOGOS[item.id].src} alt="" /><span>{item.name}<small>{sort === 'fees'
          ? amountResult.valid ? `${format(item.fee, 9)} SOL est. fee` : `${format(item.fees.variableRate * 100)}% + ${format(item.fees.fixedAmount)} SOL`
          : summary.loading ? 'Loading volume…' : item.volume === null ? 'Volume unavailable' : `$${format(item.volume, 0)} volume / 24h`}</small></span>
      </label>)}</div></fieldset>
      <p className="paymentPoolHint" role="status">{sort === 'fees'
        ? 'Estimated withdrawal fees. Network and deposit costs are additional.'
        : summary.loading ? 'Loading pool activity…' : !volumeAvailable ? 'Activity ranking is unavailable right now. You can still choose a pool.'
          : 'Based on total pool volume over 24 hours. Activity alone does not guarantee privacy.'}</p>
      <button className="paymentPrimary" type="submit" disabled aria-describedby="paymentAvailability">Create payment link <ArrowRight aria-hidden="true" /></button>
      <p className="paymentFormHint" id="paymentAvailability">Payment link creation is coming soon.</p>
    </form>

    <section className="paymentHistory" aria-labelledby="paymentHistoryTitle">
      <div className="paymentHistoryHeading"><h2 id="paymentHistoryTitle">Your payment links</h2></div>
      <div className="paymentEmpty"><Link2 aria-hidden="true" /><h3>Your payments, in one place</h3><p>Your links and payment confirmations will appear here.</p></div>
    </section>
  </div>
}
