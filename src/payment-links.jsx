import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CheckCircle2, Copy, Download, ExternalLink, Link2, LogOut, RefreshCw, Settings, Upload, Wallet, X } from 'lucide-react'
import { LOGOS, PROTOCOLS } from '../protocols/registry.js'
import { parseAmount, sanitizeAmount } from './transfer-validation.js'
import { prepareMerchantAccess, preparePaymentNote, readPaymentDrafts } from './payment-notes.js'
import { createPaymentLink, listPaymentLinks, paymentLinkUrl, reportPaymentDeposit } from './payment-api.js'

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
  const [notice, setNotice] = useState('')
  const [access, setAccess] = useState(null)
  const [historyState, setHistory] = useState({ payments: [], next_offset: null })
  const history = wallet && access?.address === wallet.address ? historyState : { payments: [], next_offset: null }
  const [historyError, setHistoryError] = useState('')
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [published, setPublished] = useState(new Set())
  const [depositFor, setDepositFor] = useState(null)
  const [transactionId, setTransactionId] = useState('')
  const operation = useRef(null)

  useEffect(() => {
    setBusy(false); setStatus(''); setError(''); setNotice(''); setAccess(null)
    setHistory({ payments: [], next_offset: null }); setHistoryError(''); setOffset(0); setDepositFor(null)
    setPublished(new Set()); setDraftState({ address: wallet?.address ?? null, records: [] })
    if (wallet) {
      try {
        const records = readPaymentDrafts(localStorage, wallet.address)
        setDraftState({ address: wallet.address, records })
        setPublished(new Set(records.filter((record) => localStorage.getItem(`darksol:published:${wallet.address}:${record.invoice.id}`)).map((record) => record.invoice.id)))
      }
      catch { setError('Could not read saved payment notes. Check that browser storage is available.') }
    }
    return () => { operation.current?.abort(); operation.current = null }
  }, [wallet])

  useEffect(() => {
    if (!access || access.address !== wallet?.address) return
    const controller = new AbortController()
    let timer
    async function load() {
      setLoading(true)
      try {
        const result = await listPaymentLinks({ access, offset, signal: controller.signal })
        if (controller.signal.aborted) return
        setHistory(result); setHistoryError('')
        setPublished((previous) => new Set([...previous, ...result.payments.map((payment) => payment.record.invoice.id)]))
      } catch (cause) {
        if (!controller.signal.aborted) setHistoryError(cause.message || 'Could not load payment links')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          timer = setTimeout(load, 15000)
        }
      }
    }
    load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [access, wallet, offset, refresh])

  async function merchantAccess(signal) {
    if (access?.address === wallet.address) return access
    setStatus('Approve merchant access...')
    const result = await prepareMerchantAccess({ ...wallet, signal })
    signal.throwIfAborted()
    const scoped = { ...result, address: wallet.address }
    setAccess(scoped)
    return scoped
  }

  async function run(action) {
    if (operation.current || connecting) return
    setError(''); setNotice('')
    if (!wallet) {
      try { await connectWallet() }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect wallet') }
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    try {
      await action(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not complete payment request')
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setBusy(false); setStatus('')
      }
    }
  }

  async function publish(record, signal, identity) {
    setStatus('Creating payment link...')
    const result = await createPaymentLink({ record, access: identity, signal })
    signal.throwIfAborted()
    setPublished((previous) => new Set([...previous, record.invoice.id]))
    try { localStorage.setItem(`darksol:published:${wallet.address}:${record.invoice.id}`, result.payment_id) } catch { /* The encrypted draft and server record remain intact. */ }
    setOffset(0); setRefresh((value) => value + 1)
    setNotice('Payment link created')
  }

  function createPayment(event) {
    event.preventDefault()
    if (wallet && (!amountResult.valid || amountError)) return
    run(async (signal) => {
      const identity = await merchantAccess(signal)
      const record = await preparePaymentNote({ ...wallet, protocol: pool, amount, reference, signal,
        onStatus: (message) => { if (!signal.aborted) setStatus(message) } })
      signal.throwIfAborted()
      setDraftState((current) => ({ address: wallet.address, records: [record, ...current.records] }))
      await publish(record, signal, identity)
    })
  }

  async function copyLink(url) {
    try { await navigator.clipboard.writeText(paymentLinkUrl(url)); setNotice('Payment link copied') }
    catch { setError('Could not copy the link. Open it to copy from the address bar.') }
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
  const amountError = amount && !amountResult.valid ? amountResult.error
    : pool === 'cloakc' && amountResult.valid && amountResult.baseUnits < 10000000n ? 'Cloak requires at least 0.01 SOL.' : ''
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
        <button className="paymentPrimary" type="submit" disabled={busy || connecting || Boolean(wallet && (!amountResult.valid || amountError))} aria-describedby="paymentAvailability">
          {connecting ? 'Connecting…' : busy ? status || 'Preparing note…' : !wallet ? <><Wallet aria-hidden="true" />Connect wallet</> : <>Create payment link <ArrowRight aria-hidden="true" /></>}
        </button>
        {wallet && <button className="paymentDisconnect" type="button" aria-label="Disconnect wallet" title="Disconnect wallet" disabled={busy} onClick={disconnectWallet}><LogOut /></button>}
      </div>
      <p className="paymentFormHint" id="paymentAvailability">{wallet ? `Connected: ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)} · Sign a message to prepare your payment note.` : 'Connect your Solana wallet to prepare a payment link.'}</p>
      {notice && <div className="paymentPrepared" role="status"><CheckCircle2 aria-hidden="true" /><strong>{notice}</strong></div>}
    </form>

    <section className="paymentHistory" aria-labelledby="paymentHistoryTitle">
      <div className="paymentHistoryHeading"><h2 id="paymentHistoryTitle">Your payment links</h2>
        {wallet && <button className="ghost" type="button" disabled={busy || loading} onClick={() => run(async (signal) => { await merchantAccess(signal); setRefresh((value) => value + 1) })}>
          <RefreshCw aria-hidden="true" />{access ? 'Refresh' : 'Load payment links'}
        </button>}
      </div>
      {historyError && <p className="paymentError" role="alert">{historyError}</p>}
      {loading && <p className="paymentLoading" role="status">Loading payment links...</p>}
      {history.payments.length > 0 && <div className="paymentDrafts">{history.payments.map((payment) => <React.Fragment key={payment.payment_id}>
        <article className="paymentDraft">
          <div><strong>{payment.record.reference || 'Payment request'}</strong><span>{format(Number(payment.record.invoice.amount) / 1e9, 9)} SOL · {POOLS.find((item) => item.id === payment.record.invoice.protocol)?.name}</span>
            <small>{new Date(payment.created_at).toLocaleDateString()}</small>
            <span className={`paymentStatus ${payment.status}`}><span aria-hidden="true">{payment.status === 'paid' ? <CheckCircle2 /> : <span className="paymentStatusDot" />}</span>{payment.status === 'paid' ? 'Paid' : 'Awaiting payment'}</span>
            {payment.deposit_transaction && <a className="paymentReceipt" href={`https://solscan.io/tx/${encodeURIComponent(payment.deposit_transaction)}`} target="_blank" rel="noreferrer">Deposit receipt <ExternalLink /></a>}
          </div>
          <div className="paymentRowActions">
            <button type="button" className="ghost paymentIcon" title="Copy payment link" aria-label="Copy payment link" onClick={() => copyLink(payment.payment_url)}><Copy /></button>
            <a className="ghost paymentIcon" title="Open checkout" aria-label="Open checkout" href={paymentLinkUrl(payment.payment_url)} target="_blank" rel="noreferrer"><ExternalLink /></a>
            <button type="button" className="ghost paymentIcon" title="Download recovery backup" aria-label="Download recovery backup" onClick={() => downloadRecovery(payment.record)}><Download /></button>
            {payment.status !== 'paid' && <button type="button" className="ghost" disabled={busy} onClick={() => { setDepositFor(payment.payment_id); setTransactionId('') }}>Verify deposit</button>}
          </div>
        </article>
        {depositFor === payment.payment_id && payment.status !== 'paid' && <form className="paymentReport" onSubmit={(event) => {
          event.preventDefault()
          run(async (signal) => {
            setStatus('Verifying deposit...')
            await reportPaymentDeposit(payment.payment_id, transactionId.trim(), signal)
            signal.throwIfAborted()
            setHistory((previous) => ({ ...previous, payments: previous.payments.map((item) => item.payment_id === payment.payment_id ? { ...item, status: 'paid' } : item) }))
            setDepositFor(null); setRefresh((value) => value + 1); setNotice('Deposit verified')
          })
        }}><label htmlFor="merchantDeposit">Deposit transaction ID</label><input id="merchantDeposit" value={transactionId} onChange={(event) => setTransactionId(event.target.value)} disabled={busy} maxLength={88} autoComplete="off" required />
          <button className="ghost" disabled={busy || !transactionId.trim()} type="submit">{busy ? 'Verifying...' : 'Verify deposit'}</button>
          <button className="ghost paymentIcon" type="button" title="Cancel" aria-label="Cancel deposit verification" disabled={busy} onClick={() => setDepositFor(null)}><X /></button>
        </form>}
      </React.Fragment>)}</div>}
      {(offset > 0 || history.next_offset !== null) && <div className="paymentPagination">
        <button className="ghost" type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ArrowLeft />Previous</button>
        <button className="ghost" type="button" disabled={loading || history.next_offset === null} onClick={() => setOffset(history.next_offset)}>Next<ArrowRight /></button>
      </div>}
      {drafts.filter((draft) => !published.has(draft.invoice.id)).map((draft) => <article className="paymentDraft paymentLocal" key={draft.invoice.id}>
        <div><strong>{draft.reference || 'Payment request'}</strong><span>{format(Number(draft.invoice.amount) / 1e9, 9)} SOL</span><small>Not published</small></div>
        <div className="paymentRowActions"><button type="button" className="ghost paymentIcon" title="Download recovery backup" aria-label="Download recovery backup" onClick={() => downloadRecovery(draft)}><Download /></button>
          <button type="button" className="ghost" disabled={busy} onClick={() => run(async (signal) => publish(draft, signal, await merchantAccess(signal)))}><Upload />Publish link</button></div>
      </article>)}
      {!history.payments.length && !drafts.length && !loading && <div className="paymentEmpty"><Link2 aria-hidden="true" /><h3>{access ? 'No payment links yet' : 'Your payments, in one place'}</h3><p>{wallet ? 'Your payment requests will appear here.' : 'Connect your wallet to view your payment links.'}</p></div>}
    </section>
  </div>
}
