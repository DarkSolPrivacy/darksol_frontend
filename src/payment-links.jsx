import React, { useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, Download, Link2, LogOut, Settings, Wallet } from 'lucide-react'
import { LOGOS, PROTOCOLS } from '../protocols/registry.js'
import { parseAmount, sanitizeAmount } from './transfer-validation.js'
import { preparePaymentNote, readPaymentDrafts } from './payment-notes.js'

const POOLS = [{ id: 'privacycash', name: 'Privacy Cash' }, { id: 'cloakc', name: 'Cloak' }]
const format = (value, digits = 6) => Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)

export default function PaymentLinks({ summary, walletSession }) {
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [pool, setPool] = useState('cloakc')
  const [sort, setSort] = useState('fees')
  const settings = useRef(null)

  const { wallet, connecting, connectWallet, disconnectWallet } = walletSession
  const [draftState, setDraftState] = useState({ address: null, records: [] })
  const drafts = wallet && draftState.address === wallet.address ? draftState.records : []
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [prepared, setPrepared] = useState(false)
  const operation = useRef(null)

  useEffect(() => {
    setBusy(false); setStatus(''); setError(''); setPrepared(false); setDraftState({ address: wallet?.address ?? null, records: [] })
    if (wallet) {
      try { setDraftState({ address: wallet.address, records: readPaymentDrafts(localStorage, wallet.address) }) }
      catch { setError('Could not read saved payment notes. Check that browser storage is available.') }
    }
    return () => { operation.current?.abort(); operation.current = null }
  }, [wallet])

  async function createPayment(event) {
    event.preventDefault()
    if (operation.current || connecting) return
    setError('')
    if (!wallet) {
      try { await connectWallet() }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect wallet') }
      return
    }
    if (!amountResult.valid) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setPrepared(false)
    try {
      const draft = await preparePaymentNote({
        provider: wallet.provider, address: wallet.address, protocol: pool,
        amount, reference, signal: controller.signal,
        onStatus: (message) => { if (!controller.signal.aborted) setStatus(message) },
      })
      if (!controller.signal.aborted) {
        setDraftState((current) => ({ address: wallet.address, records: [draft, ...(current.address === wallet.address ? current.records : [])] }))
        setPrepared(true)
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not prepare payment note')
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setBusy(false); setStatus('')
      }
    }
  }

  function downloadRecovery(draft) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `darksol-payment-${draft.invoice.id}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

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

    <form className="sendCard panel paymentCreate" onSubmit={createPayment}>
      <div className="paymentSectionTitle"><Link2 aria-hidden="true" /><h2>Create a payment link</h2><span>Solana</span></div>
      <label className="paymentFieldLabel" htmlFor="paymentAmount">REQUEST AMOUNT</label>
      <div className="amountRow paymentAmountRow">
        <input id="paymentAmount" disabled={busy} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" maxLength={30} value={amount} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'paymentAmountError' : undefined} onChange={(event) => setAmount(sanitizeAmount(event.target.value))} />
        <span className="paymentAsset"><img src="/logos/sol.svg" alt="" />SOL</span>
      </div>
      {amountError && <p className="paymentAmountError" id="paymentAmountError" role="status">{amountError}</p>}
      <div className="paymentReference"><label className="paymentFieldLabel" htmlFor="paymentReference">REFERENCE <span>Optional</span></label><input id="paymentReference" disabled={busy} placeholder="Add an invoice or order reference" maxLength={80} value={reference} onChange={(event) => setReference(event.target.value)} /></div>
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
        <input type="radio" name="paymentPool" disabled={busy} value={item.id} checked={pool === item.id} onChange={() => setPool(item.id)} />
        <img src={LOGOS[item.id].src} alt="" /><span>{item.name}<small>{sort === 'fees'
          ? amountResult.valid ? `${format(item.fee, 9)} SOL est. fee` : `${format(item.fees.variableRate * 100)}% + ${format(item.fees.fixedAmount)} SOL`
          : summary.loading ? 'Loading volume…' : item.volume === null ? 'Volume unavailable' : `$${format(item.volume, 0)} volume / 24h`}</small></span>
      </label>)}</div></fieldset>
      <p className="paymentPoolHint" role="status">{sort === 'fees'
        ? 'Estimated withdrawal fees. Network and deposit costs are additional.'
        : summary.loading ? 'Loading pool activity…' : !volumeAvailable ? 'Activity ranking is unavailable right now. You can still choose a pool.'
          : 'Based on total pool volume over 24 hours. Activity alone does not guarantee privacy.'}</p>
      {error && <p className="paymentError" role="alert">{error}</p>}
      <div className="paymentActions">
        <button className="paymentPrimary" type="submit" disabled={busy || connecting || Boolean(wallet && !amountResult.valid)} aria-describedby="paymentAvailability">
          {connecting ? 'Connecting…' : busy ? status || 'Preparing note…' : !wallet ? <><Wallet aria-hidden="true" />Connect wallet</> : <>Create payment link <ArrowRight aria-hidden="true" /></>}
        </button>
        {wallet && <button className="paymentDisconnect" type="button" aria-label="Disconnect wallet" title="Disconnect wallet" disabled={busy} onClick={disconnectWallet}><LogOut /></button>}
      </div>
      <p className="paymentFormHint" id="paymentAvailability">{wallet ? `Connected: ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)} · Sign a message to prepare your payment note.` : 'Connect your Solana wallet to prepare a payment link.'}</p>
      {prepared && drafts.length > 0 && <div className="paymentPrepared" role="status"><CheckCircle2 aria-hidden="true" /><div><strong>Payment note prepared</strong><p>Saved encrypted in this browser. A shareable link is not available yet.</p></div></div>}
    </form>

    <section className="paymentHistory" aria-labelledby="paymentHistoryTitle">
      <div className="paymentHistoryHeading"><h2 id="paymentHistoryTitle">Your payment links</h2></div>
      {drafts.length ? <div className="paymentDrafts">{drafts.map((draft) => <article className="paymentDraft" key={draft.invoice.id}>
        <div><strong>{draft.reference || 'Payment request'}</strong><span>{format(Number(draft.invoice.amount) / 1e9, 9)} SOL · {POOLS.find((item) => item.id === draft.invoice.protocol)?.name}</span><small>Prepared locally · {new Date(draft.createdAt).toLocaleDateString()}</small></div>
        <button type="button" className="ghost" onClick={() => downloadRecovery(draft)}><Download aria-hidden="true" /><span>Recovery backup</span></button>
      </article>)}</div> : <div className="paymentEmpty"><Link2 aria-hidden="true" /><h3>Your payments, in one place</h3><p>{wallet ? 'Prepared payment notes will appear here.' : 'Connect your wallet to view notes saved in this browser.'}</p></div>}
    </section>
  </div>
}
