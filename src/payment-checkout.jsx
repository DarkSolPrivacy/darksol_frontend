import React, { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, RefreshCw, Wallet } from 'lucide-react'
import { getPaymentLink, reportPaymentDeposit, validDepositId } from './payment-api.js'
import { depositExpired, payPaymentInvoice, validateCheckout } from './payment-deposit.js'
import { LOGOS, PROTOCOLS } from '../protocols/registry.js'
import { PAYMENT_ASSETS, assetAmount, cloakMinimum } from './payment-assets.js'
import { failureReason, track } from './product-events.js'

export default function PaymentCheckout({ paymentId, walletSession }) {
  const { wallet, connecting, connectWallet } = walletSession
  const receiptKey = `darksol:payment-deposit:v1:${paymentId}`
  const [invoice, setInvoice] = useState(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [transactionId, setTransactionId] = useState(() => {
    try { const value = localStorage.getItem(receiptKey); return validDepositId(value) ? value : '' } catch { return '' }
  })
  const [reportedId, setReportedId] = useState(transactionId)
  const operation = useRef(null)

  useEffect(() => () => { operation.current?.abort(); operation.current = null }, [])
  useEffect(() => {
    operation.current?.abort(); operation.current = null
    setBusy(false); setStatus('')
  }, [wallet])

  useEffect(() => {
    const controller = new AbortController()
    let timer
    async function update() {
      try {
        const latest = validateCheckout(await getPaymentLink(paymentId, controller.signal))
        if (controller.signal.aborted) return
        // Render the invoice before reporting. A verification outage must not
        // replace a paying customer's whole checkout with a bare error.
        setInvoice((previous) => previous?.status === 'paid' ? previous : latest)
        setLoadError('')
        if (latest.status === 'paid') return
        if (reportedId && !busy) {
          try {
            const result = await reportPaymentDeposit(paymentId, reportedId, controller.signal)
            if (controller.signal.aborted) return
            if (result.status === 'paid') { setInvoice({ ...latest, status: 'paid' }); return }
          } catch (cause) {
            if (cause.status !== 422) throw cause
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause.status === 404 ? 'Payment link not found' : cause.message || 'Unable to load payment')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
      if (!controller.signal.aborted) timer = setTimeout(update, 10000)
    }
    update()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [paymentId, reportedId, refresh, busy])

  function rememberDeposit(id, blockhash) {
    // Keep an uncertain broadcast retryable as a status check, never a second payment.
    if (blockhash) localStorage.setItem(`${receiptKey}:blockhash`, blockhash)
    localStorage.setItem(receiptKey, id)
    if (localStorage.getItem(receiptKey) !== id) throw new Error('Could not save deposit transaction ID')
    setTransactionId(id); setReportedId(id)
  }

  async function fund(signal) {
    const existing = localStorage.getItem(receiptKey)
    if (existing) {
      if (!await depositExpired(existing, localStorage.getItem(`${receiptKey}:blockhash`))) {
        throw new Error('A deposit is already awaiting confirmation. Verify it before paying again.')
      }
      localStorage.removeItem(receiptKey); localStorage.removeItem(`${receiptKey}:blockhash`)
    }
    const id = await payPaymentInvoice({ invoice, ...wallet, signal,
      onStatus: (message) => { if (!signal.aborted) setStatus(message) }, onSigned: rememberDeposit })
    rememberDeposit(id)
  }

  async function pay() {
    if (operation.current || busy || reportedId || invoice?.status === 'paid') return
    if (!wallet) {
      try { await connectWallet() } catch (cause) { setError(cause.message) }
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setError(''); setNotice('')
    const stats = { protocol: invoice?.protocol, asset: invoice?.asset }
    track('checkout_started', stats)
    try {
      // Web Locks also prevent two tabs in this browser from signing the same invoice.
      if (navigator.locks) {
        await navigator.locks.request(`darksol:pay:${paymentId}`, { ifAvailable: true }, async (lease) => {
          if (!lease) throw new Error('This payment is already open in another tab')
          await fund(controller.signal)
        })
      } else await fund(controller.signal)
      track('checkout_completed', stats)
    } catch (cause) {
      if (!controller.signal.aborted) {
        track('checkout_failed', { protocol: stats.protocol, reason: failureReason(cause) })
        setError(cause.transactionId ? 'Deposit confirmation is pending. Check the saved transaction before paying again.' : cause.message || 'Unable to pay invoice')
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null; setBusy(false); setStatus(''); setRefresh((value) => value + 1)
      }
    }
  }

  async function verify(event) {
    event.preventDefault()
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const id = transactionId.trim()
      const result = await reportPaymentDeposit(paymentId, id, controller.signal)
      if (controller.signal.aborted) return
      if (result.status !== 'paid') throw new Error('Deposit is not yet verified')
      setInvoice((previous) => ({ ...previous, status: 'paid' }))
      setReportedId(id)
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause.status === 422) setNotice('No finalized deposit matches this invoice yet. Check the transaction ID or try again shortly.')
        else setError(cause.message)
      }
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false) }
    }
  }

  const paid = invoice?.status === 'paid'
  const tooSmall = invoice?.protocol === 'cloakc' && BigInt(invoice.amount) < PAYMENT_ASSETS[invoice.asset].cloakMin
  const paused = invoice ? PROTOCOLS[invoice.protocol]?.depositsPaused : null
  return <div className="homePage paymentLinksPage paymentCheckout">
    <header><div><p className="eyebrow">DarkSol payment</p><h1>{paid ? 'Payment received' : 'Private checkout'}</h1></div></header>
    {loading && <p className="paymentLoading" role="status">Loading payment...</p>}
    {(error || loadError) && <p className="paymentError" role="alert">{error || loadError}</p>}
    {!loading && !invoice && <button className="ghost" onClick={() => setRefresh((value) => value + 1)}><RefreshCw />Retry</button>}
    {invoice && <section className="paymentCheckoutBody">
      <div className="paymentCheckoutPool"><img src={LOGOS[invoice.protocol].src} alt="" /><span>{invoice.protocol === 'cloakc' ? 'Cloak' : 'Privacy Cash'}</span><small>Solana mainnet</small></div>
      <p className="paymentCheckoutAmount">{assetAmount(invoice.amount, invoice.asset).toLocaleString('en-US', { maximumFractionDigits: 9 })}<span>{invoice.asset}</span></p>
      <div className={`paymentCheckoutState ${paid ? 'paid' : ''}`} role="status">{paid ? <Check /> : <i aria-hidden="true" />}<span>{paid ? 'Paid' : reportedId ? 'Awaiting deposit confirmation' : 'Awaiting payment'}</span></div>
      <p className="paymentCheckoutId">Invoice <code>{paymentId.slice(0, 12)}</code></p>
      {paid ? <p className="paymentFormHint">This invoice is settled.</p> : <>
        {paused && <p className="paymentError">{paused} in Privacy Cash. Try again later or ask the merchant for a Cloak link.</p>}
        {tooSmall && <p className="paymentError">Cloak requires at least {cloakMinimum(invoice.asset)}. Ask the merchant for a new link.</p>}
        {!reportedId && <div className="paymentActions"><button type="button" className="paymentPrimary" disabled={busy || connecting || Boolean(loadError) || tooSmall || Boolean(paused)} onClick={pay}>
          <Wallet />{connecting ? 'Connecting...' : busy ? status || 'Preparing payment...' : wallet ? 'Pay invoice' : 'Connect wallet to pay'}
        </button></div>}
        {busy && reportedId && <p className="paymentLoading" role="status">{status || 'Verifying deposit...'}</p>}
        {!reportedId && <p className="paymentFormHint">{invoice.asset === 'SOL' ? 'Network fees are additional.' : 'Network fees are paid in SOL.'}</p>}
        <form className="paymentReport checkoutReport" onSubmit={verify}><label htmlFor="checkoutDeposit">{reportedId ? 'Deposit transaction ID' : 'Already paid? Verify your deposit'}</label>
          <input id="checkoutDeposit" value={transactionId} maxLength={88} autoComplete="off" disabled={busy} onChange={(event) => setTransactionId(event.target.value)} placeholder="Solana transaction ID" required />
          <button className="ghost" type="submit" disabled={busy || !transactionId.trim()}><RefreshCw />Verify deposit</button>
        </form>
      </>}
      {reportedId && <a className="paymentReceipt" href={`https://solscan.io/tx/${encodeURIComponent(reportedId)}`} target="_blank" rel="noreferrer">View deposit <ExternalLink /></a>}
      {notice && <p className="paymentFormHint" role="status">{notice}</p>}
    </section>}
  </div>
}
