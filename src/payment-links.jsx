import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CheckCircle2, Copy, Download, ExternalLink, Link2, LogOut, RefreshCw, Search, Settings, Trash2, Upload, Wallet, X } from 'lucide-react'
import { LOGOS, PROTOCOLS } from '../protocols/registry.js'
import { parseAmount, sanitizeAmount } from './transfer-validation.js'
import { Connection } from '@solana/web3.js'
import { prepareMerchantAccess, preparePaymentKeys, preparePaymentNote, readPaymentDrafts, removePaymentDraft } from './payment-notes.js'
import { createPaymentLink, deletePaymentLink, listPaymentLinks, paymentLinkUrl, reportPaymentDeposit } from './payment-api.js'
import { paymentRpcUrl } from './payment-deposit.js'
import { SCAN_GAP, scanPrivacyCashNotes, withdrawPaymentNote } from './payment-withdraw.js'
import { usdText, useUsdPrices } from './token-price.js'
import { PAYMENT_ASSETS, assetAmount, cloakMinimum } from './payment-assets.js'

const PRICED = Object.keys(PAYMENT_ASSETS)
const POOLS = [{ id: 'privacycash', name: 'Privacy Cash' }, { id: 'cloakc', name: 'Cloak' }]
const short = (value) => `${value.slice(0, 6)}…${value.slice(-6)}`
const format = (value, digits = 6) => Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)
const invoiceAmount = ({ amount, asset }) => `${format(assetAmount(amount, asset), 9)} ${asset}`

export default function PaymentLinks({ summary, walletSession }) {
  const [amount, setAmount] = useState('')
  const [asset, setAsset] = useState('SOL')
  const prices = useUsdPrices(PRICED)
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
  const [picking, setPicking] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [noteKeys, setNoteKeys] = useState(null)
  const [withdrawFor, setWithdrawFor] = useState(null)
  const [recipient, setRecipient] = useState('')
  const [recovered, setRecovered] = useState(null)
  // Kept in this browser only: telling the server would link the withdrawal to the deposit.
  const [withdrawn, setWithdrawn] = useState(new Map())
  const [pendingDelete, setPendingDelete] = useState(null)
  const dialog = useRef(null)
  const operation = useRef(null)

  useEffect(() => {
    setBusy(false); setStatus(''); setError(''); setNotice(''); setAccess(null)
    setHistory({ payments: [], next_offset: null }); setHistoryError(''); setOffset(0); setDepositFor(null)
    setPublished(new Set()); setDraftState({ address: wallet?.address ?? null, records: [] })
    setPicking(null); setSelected(new Set()); setNoteKeys(null); setWithdrawFor(null); setRecovered(null); setWithdrawn(new Map())
    if (wallet) {
      try {
        const records = readPaymentDrafts(localStorage, wallet.address)
        setDraftState({ address: wallet.address, records })
        setPublished(new Set(records.filter((record) => localStorage.getItem(`darksol:published:${wallet.address}:${record.invoice.id}`)).map((record) => record.invoice.id)))
        const prefix = `darksol:withdrawn:${wallet.address}:`
        setWithdrawn(new Map(Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => [key.slice(prefix.length), localStorage.getItem(key)])))
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

  async function paymentKeys(signal) {
    if (noteKeys?.address === wallet.address) return noteKeys
    setStatus('Approve your payment note keys...')
    const keys = await preparePaymentKeys({ ...wallet, signal })
    signal.throwIfAborted()
    setNoteKeys(keys)
    return keys
  }

  // Every derived index this browser or the server has used; the next note takes the one after.
  const usedIndexes = (serverNext) => Math.max(serverNext ?? 0,
    ...draftState.records.filter((record) => record.version === 2).map((record) => record.index + 1))

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
      const keys = await paymentKeys(signal)
      setStatus('Reserving a payment note...')
      // Read fresh: a key reused across two invoices would link them and share an IV.
      const { next_index } = await listPaymentLinks({ access: identity, signal })
      const record = await preparePaymentNote({ ...wallet, keys, index: usedIndexes(next_index), protocol: pool, asset, amount, reference, signal,
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

  function saveFile(contents, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(contents, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const downloadRecovery = (draft) => saveFile(draft, `darksol-payment-${draft.invoice.id}.json`)

  // One file for a batch: a version 1 record is the only way to reach its note,
  // and a Cloak note is found from its record, so keep backups easy to keep.
  function downloadSelected(records) {
    saveFile(records, `darksol-payments-${new Date().toISOString().slice(0, 10)}.json`)
    setNotice(`Saved ${records.length} recovery record${records.length === 1 ? '' : 's'}`)
  }

  function startPicking(mode) {
    setPicking(mode); setSelected(new Set()); setError(''); setNotice('')
  }

  function toggle(paymentId) {
    setSelected((previous) => {
      const next = new Set(previous)
      next.has(paymentId) ? next.delete(paymentId) : next.add(paymentId)
      return next
    })
  }

  // Pressing the active Download or Delete button again acts on the selection;
  // with nothing selected it leaves the mode.
  function confirmPicked() {
    const payments = history.payments.filter((payment) => selected.has(payment.payment_id) && selectable(payment))
    const local = unpublished.filter((draft) => selected.has(draft.invoice.id))
    if (!payments.length && !local.length) { setPicking(null); return }
    if (picking === 'download') {
      downloadSelected([...payments.map((payment) => payment.record), ...local])
      setPicking(null); setSelected(new Set())
      return
    }
    setPendingDelete({ payments, local })
    dialog.current.showModal()
  }

  function removePicked(backup) {
    const { payments, local } = pendingDelete
    dialog.current.close()
    if (backup) downloadSelected([...payments.map((payment) => payment.record), ...local])
    run(async (signal) => {
      if (payments.length) {
        const identity = await merchantAccess(signal)
        for (const payment of payments) {
          await deletePaymentLink(payment.payment_id, identity, signal)
          signal.throwIfAborted()
          try { localStorage.removeItem(`darksol:published:${wallet.address}:${payment.record.invoice.id}`) } catch { /* The draft stays listed as unpublished. */ }
        }
      }
      // Never published, so nobody holds a link to pay them.
      for (const draft of local) removePaymentDraft(localStorage, wallet.address, draft.invoice.id)
      const gone = new Set(local.map((draft) => draft.invoice.id))
      setDraftState((current) => ({ ...current, records: current.records.filter((record) => !gone.has(record.invoice.id)) }))
      setPicking(null); setSelected(new Set()); setRefresh((value) => value + 1)
      const count = payments.length + local.length
      setNotice(`Removed ${count} payment link${count === 1 ? '' : 's'}`)
    })
  }

  function openWithdraw(id) {
    setWithdrawFor(id); setRecipient(''); setError(''); setNotice('')
  }

  function markWithdrawn(id, signature = '') {
    setWithdrawn((previous) => new Map(previous).set(id, signature))
    try { localStorage.setItem(`darksol:withdrawn:${wallet.address}:${id}`, signature) } catch { /* Shown until reload. */ }
  }

  function withdrawRecord(record, paid) {
    run(async (signal) => {
      const keys = record.version === 2 ? await paymentKeys(signal) : undefined
      let signature
      try {
        signature = await withdrawPaymentNote({ ...wallet, record, keys, recipient, signal,
          connection: new Connection(paymentRpcUrl(), 'confirmed'),
          onStatus: (message) => { if (!signal.aborted) setStatus(message) } })
      } catch (cause) {
        // A verified deposit with nothing unspent was withdrawn, likely from another device.
        if (paid && /No unspent funds/.test(cause.message)) { markWithdrawn(record.invoice.id); setWithdrawFor(null) }
        throw cause
      }
      setWithdrawFor(null)
      markWithdrawn(record.invoice.id, signature)
      setNotice(<>Withdrawal submitted · <a className="paymentReceipt" href={`https://solscan.io/tx/${encodeURIComponent(signature)}`} target="_blank" rel="noreferrer">{short(signature)} <ExternalLink /></a></>)
    })
  }

  function recoverFromChain() {
    run(async (signal) => {
      const keys = await paymentKeys(signal)
      const found = await scanPrivacyCashNotes({ keys, signal, toIndex: usedIndexes(history.next_index) + SCAN_GAP,
        connection: new Connection(paymentRpcUrl(), 'confirmed'),
        onStatus: (message) => { if (!signal.aborted) setStatus(message) } })
      setRecovered(found)
      setNotice(found.length ? `Found ${found.length} Privacy Cash payment${found.length === 1 ? '' : 's'} on-chain` : 'No Privacy Cash payments found on-chain')
    })
  }

  const isWithdrawn = (record) => withdrawn.has(record.invoice.id)
  const withdrawalReceipt = (record) => withdrawn.get(record.invoice.id) && <a className="paymentReceipt" href={`https://solscan.io/tx/${encodeURIComponent(withdrawn.get(record.invoice.id))}`} target="_blank" rel="noreferrer">Withdrawal receipt <ExternalLink /></a>
  const withdrawForm = (record, paid) => withdrawFor === record.invoice.id && <form className="paymentReport" onSubmit={(event) => { event.preventDefault(); withdrawRecord(record, paid) }}>
    <label htmlFor="paymentRecipient">Withdraw to address</label>
    <input id="paymentRecipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} disabled={busy} maxLength={44} autoComplete="off" required
      placeholder="A fresh address keeps this payment unlinked" />
    <button className="ghost" disabled={busy || !recipient.trim()} type="submit">{busy ? status || 'Withdrawing...' : 'Withdraw'}</button>
    <button className="ghost paymentIcon" type="button" title="Cancel" aria-label="Cancel withdrawal" disabled={busy} onClick={() => setWithdrawFor(null)}><X /></button>
  </form>

  const selectable = (payment) => picking === 'download' || payment.status !== 'paid'
  const unpublished = drafts.filter((draft) => !published.has(draft.invoice.id))
  const pickBox = (id, label, enabled = true) => picking && <input type="checkbox" className="paymentPick" aria-label={`Select ${label || 'payment request'}`}
    checked={selected.has(id)} disabled={busy || !enabled} onChange={() => toggle(id)} />
  const amountResult = parseAmount(amount, asset)
  const amountError = amount && !amountResult.valid ? amountResult.error
    : pool === 'cloakc' && amountResult.valid && amountResult.baseUnits < PAYMENT_ASSETS[asset].cloakMin ? `Cloak requires at least ${cloakMinimum(asset)}.` : ''
  const pools = POOLS.map((item) => {
    const fees = asset !== 'SOL' && item.id === 'cloakc' ? { ...PROTOCOLS[item.id].fees, fixedAmount: 0.45 } : PROTOCOLS[item.id].fees
    const fixedToken = asset !== 'SOL' && item.id === 'cloakc' ? asset : 'SOL'
    const activity = summary.pools.find((entry) => entry.protocol === item.id)
    const hasVolume = !summary.loading && !summary.error && activity
      && Number.isFinite(activity.inflow) && activity.inflow >= 0
      && Number.isFinite(activity.outflow) && activity.outflow >= 0
    return {
      ...item, fees, fixedToken,
      // A fee in the requested asset: the SOL-denominated fixed part is converted at the current price.
      fee: (fixedToken === asset ? fees.fixedAmount : prices.SOL && prices[asset] ? fees.fixedAmount * prices.SOL / prices[asset] : NaN)
        + (amountResult.valid ? Number(amountResult.normalized) * fees.variableRate : 0),
      volume: hasVolume ? activity.inflow + activity.outflow : null,
    }
  })
  const volumeAvailable = pools.every((item) => item.volume !== null)
  // Keep the known order when activity is unavailable; missing data is not zero volume.
  pools.sort((a, b) => sort === 'fees' ? a.fee - b.fee || 0 : volumeAvailable ? b.volume - a.volume : 0)

  return <div className="homePage paymentLinksPage">
    <header><div><p className="eyebrow">PAYMENT LINKS</p><h1>Receive privately</h1></div></header>
    <p className="paymentIntro">Get paid without sharing your wallet address with your customer.</p>

    <form className="sendCard panel paymentCreate" onSubmit={createPayment}>
      <div className="paymentSectionTitle"><Link2 aria-hidden="true" /><h2>Create a payment link</h2><span>Solana</span></div>
      <label className="paymentFieldLabel" htmlFor="paymentAmount">REQUEST AMOUNT</label>
      <div className="amountRow paymentAmountRow">
        <span className="amountUsd">{usdText(amount, prices[asset])}</span>
        <input id="paymentAmount" disabled={busy} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" maxLength={30} value={amount} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'paymentAmountError' : undefined} onChange={(event) => setAmount(sanitizeAmount(event.target.value))} />
        <label className="paymentAsset"><img src={`/logos/${asset.toLowerCase()}.svg`} alt="" />
          <select aria-label="Request asset" disabled={busy} value={asset} onChange={(event) => setAsset(event.target.value)}>
            {PRICED.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
          </select></label>
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
          ? amountResult.valid && Number.isFinite(item.fee) ? `${format(item.fee, 9)} ${asset} est. fee` : `${format(item.fees.variableRate * 100)}% + ${format(item.fees.fixedAmount)} ${item.fixedToken}`
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
        {wallet && <div className="paymentRowActions">
          <button className="ghost" type="button" disabled={busy || loading} onClick={() => run(async (signal) => { await merchantAccess(signal); setRefresh((value) => value + 1) })}>
            <RefreshCw aria-hidden="true" />{access ? 'Refresh' : 'Load payment links'}
          </button>
          <button className="ghost" type="button" disabled={busy} title="Find Privacy Cash payments from your wallet signature alone" onClick={recoverFromChain}><Search aria-hidden="true" />Find on-chain</button>
          {(history.payments.length > 0 || unpublished.length > 0) && <>
            <button className={`ghost${picking === 'download' ? ' paymentActive' : ''}`} type="button" aria-pressed={picking === 'download'} disabled={busy}
              onClick={() => picking === 'download' ? confirmPicked() : startPicking('download')}><Download aria-hidden="true" />Download{picking === 'download' && selected.size ? ` ${selected.size}` : ''}</button>
            <button className={`ghost paymentDelete${picking === 'delete' ? ' paymentDanger' : ''}`} type="button" aria-pressed={picking === 'delete'} disabled={busy}
              onClick={() => picking === 'delete' ? confirmPicked() : startPicking('delete')}><Trash2 aria-hidden="true" />Delete{picking === 'delete' && selected.size ? ` ${selected.size}` : ''}</button>
          </>}
        </div>}
      </div>
      {picking && <p className="paymentFormHint" role="status">{picking === 'download'
        ? 'Select links to back up, then press Download again.'
        : 'Select links to remove, then press Delete again. Paid links cannot be deleted.'}</p>}
      {historyError && <p className="paymentError" role="alert">{historyError}</p>}
      {loading && <p className="paymentLoading" role="status">Loading payment links...</p>}
      {history.payments.length > 0 && <div className="paymentDrafts">{history.payments.map((payment) => <React.Fragment key={payment.payment_id}>
        <article className={`paymentDraft${picking && selected.has(payment.payment_id) ? ' paymentPicked' : ''}${isWithdrawn(payment.record) ? ' paymentDone' : ''}`}>
          {pickBox(payment.payment_id, payment.record.reference, selectable(payment))}
          <div><strong>{payment.record.reference || 'Payment request'}</strong><span>{invoiceAmount(payment.record.invoice)} · {POOLS.find((item) => item.id === payment.record.invoice.protocol)?.name}</span>
            <small>{new Date(payment.created_at).toLocaleDateString()}</small>
            <span className={`paymentStatus ${payment.status}`}><span aria-hidden="true">{payment.status === 'paid' ? <CheckCircle2 /> : <span className="paymentStatusDot" />}</span>{isWithdrawn(payment.record) ? 'Withdrawn' : payment.status === 'paid' ? 'Paid' : 'Awaiting payment'}</span>
            {payment.deposit_transaction && <a className="paymentReceipt" href={`https://solscan.io/tx/${encodeURIComponent(payment.deposit_transaction)}`} target="_blank" rel="noreferrer">Deposit receipt <ExternalLink /></a>}
            {withdrawalReceipt(payment.record)}
          </div>
          <div className="paymentRowActions">
            <button type="button" className="ghost paymentIcon" title="Copy payment link" aria-label="Copy payment link" onClick={() => copyLink(payment.payment_url)}><Copy /></button>
            <a className="ghost paymentIcon" title="Open checkout" aria-label="Open checkout" href={paymentLinkUrl(payment.payment_url)} target="_blank" rel="noreferrer"><ExternalLink /></a>
            {payment.status !== 'paid' && <button type="button" className="ghost" disabled={busy} onClick={() => { setDepositFor(payment.payment_id); setTransactionId('') }}>Verify deposit</button>}
            {payment.status === 'paid' && !isWithdrawn(payment.record) && <button type="button" className="ghost" disabled={busy} onClick={() => openWithdraw(payment.record.invoice.id)}>Withdraw</button>}
          </div>
        </article>
        {withdrawForm(payment.record, payment.status === 'paid')}
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
      {recovered?.length > 0 && <div className="paymentDrafts">{recovered.map(({ record, spent: onChain }) => { const spent = onChain || isWithdrawn(record); return <React.Fragment key={record.invoice.id}>
        <article className={`paymentDraft paymentLocal${spent ? ' paymentDone' : ''}`}>
          <div><strong>Found on-chain</strong><span>{invoiceAmount(record.invoice)} · Privacy Cash</span><small>Payment note {record.index + 1}</small>
            <span className={`paymentStatus ${spent ? 'paid' : 'pending'}`}><span aria-hidden="true">{spent ? <CheckCircle2 /> : <span className="paymentStatusDot" />}</span>{spent ? 'Withdrawn' : 'Ready to withdraw'}</span>{withdrawalReceipt(record)}</div>
          <div className="paymentRowActions">{!spent && <button type="button" className="ghost" disabled={busy} onClick={() => openWithdraw(record.invoice.id)}>Withdraw</button>}</div>
        </article>
        {withdrawForm(record, true)}
      </React.Fragment> })}</div>}
      {(offset > 0 || history.next_offset !== null) && <div className="paymentPagination">
        <button className="ghost" type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ArrowLeft />Previous</button>
        <button className="ghost" type="button" disabled={loading || history.next_offset === null} onClick={() => setOffset(history.next_offset)}>Next<ArrowRight /></button>
      </div>}
      {unpublished.map((draft) => <article className={`paymentDraft paymentLocal${picking && selected.has(draft.invoice.id) ? ' paymentPicked' : ''}`} key={draft.invoice.id}>
        {pickBox(draft.invoice.id, draft.reference)}
        <div><strong>{draft.reference || 'Payment request'}</strong><span>{invoiceAmount(draft.invoice)}</span><small>Not published</small></div>
        <div className="paymentRowActions"><button type="button" className="ghost paymentIcon" title="Download recovery backup" aria-label="Download recovery backup" onClick={() => downloadRecovery(draft)}><Download /></button>
          <button type="button" className="ghost" disabled={busy} onClick={() => run(async (signal) => publish(draft, signal, await merchantAccess(signal)))}><Upload />Publish link</button></div>
      </article>)}
      {!history.payments.length && !drafts.length && !loading && <div className="paymentEmpty"><Link2 aria-hidden="true" /><h3>{access ? 'No payment links yet' : 'Your payments, in one place'}</h3><p>{wallet ? 'Your payment requests will appear here.' : 'Connect your wallet to view your payment links.'}</p></div>}
    </section>
    <dialog className="paymentDialog" ref={dialog} aria-labelledby="paymentDialogTitle" onClose={() => setPendingDelete(null)}>
      {pendingDelete && <>
        <h3 id="paymentDialogTitle">Remove {pendingDelete.payments.length + pendingDelete.local.length} payment link{pendingDelete.payments.length + pendingDelete.local.length === 1 ? '' : 's'}?</h3>
        <p>Removed links stop working for anyone who has them. A downloaded copy keeps each note's recovery record.</p>
        <div className="paymentDialogActions">
          <button className="ghost" type="button" autoFocus onClick={() => dialog.current.close()}>Cancel</button>
          <button className="ghost" type="button" onClick={() => removePicked(true)}><Download aria-hidden="true" />Download copy and remove</button>
          <button className="ghost paymentDanger" type="button" onClick={() => removePicked(false)}><Trash2 aria-hidden="true" />Remove</button>
        </div>
      </>}
    </dialog>
  </div>
}
