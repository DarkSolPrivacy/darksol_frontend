import React, { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpDown, Check, ChevronDown, Copy, Download, ExternalLink, LoaderCircle, RefreshCw, Trash2, Upload, Wallet, X } from 'lucide-react'
import { LOGOS, PROTOCOLS } from '../protocols/registry.js'
import { parseAmount, sanitizeAmount, sanitizeSolanaAddress, validateSolanaAddress } from './transfer-validation.js'
import { Connection } from '@solana/web3.js'
import { prepareMerchantAccess, preparePaymentKeys, preparePaymentNote, readPaymentDrafts, removePaymentDraft } from './payment-notes.js'
import { createPaymentLink, deletePaymentLink, getPaymentLink, listPaymentLinks, paymentLinkUrl, reportPaymentDeposit } from './payment-api.js'
import { payPaymentInvoice, paymentRpcUrl, validateCheckout } from './payment-deposit.js'
import { pairNotes, withdrawPaymentNotes } from './payment-withdraw.js'
import { usdText, useUsdPrices } from './token-price.js'
import { PAYMENT_ASSETS, assetAmount, cloakMinimum } from './payment-assets.js'

const PRICED = Object.keys(PAYMENT_ASSETS)
export const POOLS = [{ id: 'privacycash', name: 'Privacy Cash' }, { id: 'cloakc', name: 'Cloak' }]
const short = (value) => `${value.slice(0, 6)}…${value.slice(-6)}`
const format = (value, digits = 6) => Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)
const tokenAmount = (raw, asset) => format(assetAmount(raw, asset), 9)
const approx = (value) => Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(value)
const usd = (value) => Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
const assetLogo = (asset) => `/logos/${asset.toLowerCase()}.svg`
const poolName = (protocol) => POOLS.find((item) => item.id === protocol)?.name ?? protocol
const dateText = (value) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const solscan = (signature) => `https://solscan.io/tx/${encodeURIComponent(signature)}`

// The merchant credential lists and deletes links; it cannot spend, so this browser
// keeps it until Disconnect. Payment note keys can spend and are never stored.
const accessKey = (address) => `darksol:merchant-access:v1:${address}`
function savedAccess(address) {
  try {
    const saved = JSON.parse(localStorage.getItem(accessKey(address)))
    return /^[0-9a-f]{64}$/.test(saved?.merchant_id) && /^[0-9a-f]{64}$/.test(saved?.credential)
      ? { merchant_id: saved.merchant_id, credential: saved.credential, address } : null
  } catch { return null }
}
export const forgetAccess = (address) => { try { localStorage.removeItem(accessKey(address)) } catch { /* Nothing was saved. */ } }
async function signAccess(wallet, signal) {
  const result = await prepareMerchantAccess({ ...wallet, signal })
  signal?.throwIfAborted()
  try { localStorage.setItem(accessKey(wallet.address), JSON.stringify({ merchant_id: result.merchant_id, credential: result.credential })) } catch { /* Sign again next visit. */ }
  return { ...result, address: wallet.address }
}
// Every derived index this browser or the server has used; the next note takes the one after.
const nextNoteIndex = (serverNext, drafts) => Math.max(serverNext ?? 0, ...drafts.filter((record) => record.version === 2).map((record) => record.index + 1))

// Shields `amount` as a payment link the wallet pays itself: the note is derived
// from the wallet's signature and the server keeps its record, so the deposit is
// recovered and collected from Payment links like any customer's.
export async function shieldToSelf({ wallet, protocol, asset, amount, onStatus = () => {} }) {
  let access = savedAccess(wallet.address)
  if (!access) { onStatus('Approve merchant access…'); access = await signAccess(wallet) }
  onStatus('Approve your payment note keys…')
  const keys = await preparePaymentKeys({ ...wallet })
  onStatus('Reserving a private note…')
  // Read fresh: a key reused across two invoices would link them.
  const { next_index } = await listPaymentLinks({ access }).catch(async (cause) => {
    // A saved credential the server no longer accepts: sign again.
    if (cause.status !== 401) throw cause
    forgetAccess(wallet.address); onStatus('Approve merchant access…')
    access = await signAccess(wallet)
    return listPaymentLinks({ access })
  })
  const record = await preparePaymentNote({ ...wallet, keys, index: nextNoteIndex(next_index, readPaymentDrafts(localStorage, wallet.address)),
    protocol, asset, amount, reference: 'Shielded from wallet', onStatus })
  const link = await createPaymentLink({ record, access })
  try { localStorage.setItem(`darksol:published:${wallet.address}:${record.invoice.id}`, link.payment_id) } catch { /* The server record remains. */ }
  const invoice = validateCheckout(await getPaymentLink(link.payment_id))
  const pending = (depositSignature, message) => Object.assign(new Error(`${message} Verify it under Payment links with transaction ${depositSignature} before shielding again.`),
    { receipt: { provider: protocol, asset, depositSignature, withdrawals: [] } })
  let depositSignature
  try { depositSignature = await payPaymentInvoice({ invoice, ...wallet, onStatus, onSigned: () => {} }) }
  catch (cause) { throw cause.transactionId ? pending(cause.transactionId, 'The deposit was signed but may not have landed.') : cause }
  // The server marks the link paid once the deposit is finalized, about half a minute.
  onStatus('Confirming the deposit…')
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await reportPaymentDeposit(link.payment_id, depositSignature).catch(() => null)
    if (result?.status === 'paid') return { provider: protocol, asset, depositSignature, withdrawals: [], viaLinks: true }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  throw pending(depositSignature, 'Deposit sent, but not confirmed yet.')
}
// A collection is recorded in this browser only: telling the server would link it to the deposit.
const withdrawnKey = (address, id) => `darksol:withdrawn:${address}:${id}`

// Cloak's token pools take their fixed fee in the token; every other exit pays it in SOL.
function poolFees(protocol, asset) {
  const fees = PROTOCOLS[protocol].fees
  return asset !== 'SOL' && protocol === 'cloakc' ? { ...fees, fixedAmount: 0.45, fixedToken: asset } : { ...fees, fixedToken: 'SOL' }
}

// One withdrawal's estimated fee in the asset withdrawn; NaN while a needed price is unknown.
function withdrawalFee(protocol, asset, amount, prices) {
  const fees = poolFees(protocol, asset)
  const fixed = fees.fixedToken === asset ? fees.fixedAmount : prices.SOL && prices[asset] ? fees.fixedAmount * prices.SOL / prices[asset] : NaN
  return fixed + amount * fees.variableRate
}

// POOLS with each one's estimated withdrawal fee on `amount` and its 24h volume,
// in `sort` order. A pool with an `unavailable` reason goes last.
export function rankPools({ asset, amount, prices, summary, sort, unavailable = {} }) {
  const pools = POOLS.map((item) => {
    const fees = poolFees(item.id, asset)
    const activity = summary.pools.find((entry) => entry.protocol === item.id)
    const hasVolume = !summary.loading && !summary.error && activity
      && Number.isFinite(activity.inflow) && activity.inflow >= 0
      && Number.isFinite(activity.outflow) && activity.outflow >= 0
    return {
      ...item, fees, reason: unavailable[item.id],
      // A fee in the requested asset: the SOL-denominated fixed part is converted at the current price.
      fee: withdrawalFee(item.id, asset, amount ?? 0, prices),
      volume: hasVolume ? activity.inflow + activity.outflow : null,
    }
  })
  const volumeAvailable = pools.every((item) => item.volume !== null)
  // Keep the known order when activity is unavailable; missing data is not zero volume.
  pools.sort((a, b) => Boolean(a.reason) - Boolean(b.reason) || (sort === 'fees' ? a.fee - b.fee || 0 : volumeAvailable ? b.volume - a.volume : 0))
  return { pools, volumeAvailable }
}

export function PoolSort({ sort, onSort }) {
  const settings = useRef(null)
  // Closing on blur hides the radio during label activation and can crash Chrome.
  return <details className="paymentSort" ref={settings} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      settings.current.open = false
      settings.current.querySelector('summary').focus()
    }
  }}>
    {/* The current order is the control itself, so it reads as metadata until pressed. */}
    <summary aria-label="Pool sorting preferences" title="Pool sorting preferences"><ArrowUpDown aria-hidden="true" /><span className="paymentSortLabel">{sort === 'fees' ? 'Lowest fees first' : 'Most active first'}</span></summary>
    <fieldset className="paymentSortOptions"><legend>Sort pools by</legend>
      <label><input type="radio" name="paymentSort" value="fees" checked={sort === 'fees'} onChange={() => onSort('fees')} /><span><strong>Lowest fees</strong><small>Lower estimated withdrawal costs first.</small></span></label>
      <label><input type="radio" name="paymentSort" value="volume" checked={sort === 'volume'} onChange={() => onSort('volume')} /><span><strong>Most active pools</strong><small>Higher 24-hour volume first. More activity can offer better privacy cover.</small></span></label>
    </fieldset>
  </details>
}

// `amountValid` shows each pool's fee on the amount; without one, its rates.
// `children` adds rows after the ranked pools.
export function PoolPicker({ pools, value, onChange, asset, amountValid, sort, summary, disabled, labelledBy, children }) {
  return <fieldset className="paymentPoolPicker" aria-labelledby={labelledBy}><div>{pools.map((item) => <label className={item.reason ? 'unavailable' : value === item.id ? 'selected' : ''} key={item.id}>
    <input type="radio" name="paymentPool" disabled={disabled || Boolean(item.reason)} value={item.id} checked={value === item.id} onChange={() => onChange(item.id)} />
    <img src={LOGOS[item.id].src} alt="" /><span>{item.name}<small>{item.reason || (sort === 'fees'
      ? amountValid && Number.isFinite(item.fee) ? `${format(item.fee, 9)} ${asset} est. fee` : `${format(item.fees.variableRate * 100)}% + ${format(item.fees.fixedAmount)} ${item.fees.fixedToken}`
      : summary.loading ? 'Loading volume…' : item.volume === null ? 'Volume unavailable' : `$${format(item.volume, 0)} volume / 24h`)}</small></span>
  </label>)}{children}</div></fieldset>
}

// A preview of an upcoming pool. It is not in POOLS, so it is never ranked or selectable.
function SoonPool({ name, logo, note, tooltip }) {
  return <label className="unavailable soon" data-tooltip={tooltip}>
    <input type="radio" name="paymentPool" disabled aria-label={`${name}, ${note}. ${tooltip}`} />
    <img src={logo} alt="" /><span>{name}<small>{note}</small></span>
  </label>
}

export const poolHint = (sort, summary, volumeAvailable, feeHint) => sort === 'fees' ? feeHint
  : summary.loading ? 'Loading pool activity…' : !volumeAvailable ? 'Activity ranking is unavailable right now. You can still choose a pool.'
    : 'Based on total pool volume over 24 hours. Activity alone does not guarantee privacy.'

// Raw totals per asset, in first-seen order.
function assetTotals(records) {
  const totals = new Map()
  for (const { invoice } of records) totals.set(invoice.asset, (totals.get(invoice.asset) ?? 0n) + BigInt(invoice.amount))
  return [...totals]
}

// What a collection moves and costs per asset. pairNotes decides the transactions.
function collectPlan(records, prices) {
  const rows = new Map()
  const groups = pairNotes(records)
  for (const group of groups) {
    const { asset, protocol } = group[0].invoice
    const raw = group.reduce((sum, record) => sum + BigInt(record.invoice.amount), 0n)
    const row = rows.get(asset) ?? { asset, raw: 0n, count: 0, fee: 0 }
    row.raw += raw
    row.count += group.length
    row.fee += withdrawalFee(protocol, asset, assetAmount(raw, asset), prices)
    rows.set(asset, row)
  }
  // A payment withdrawn alone leaves for the exact amount its customer paid; a pair leaves as one sum.
  return { rows: [...rows.values()], transactions: groups.length, alone: groups.filter((group) => group.length === 1).length }
}

// Every page of the merchant's links, for the actions that must see all of them.
async function allPaymentLinks(access, signal) {
  const payments = []
  for (let offset = 0; offset !== null;) {
    const page = await listPaymentLinks({ access, offset, signal })
    payments.push(...page.payments)
    offset = page.next_offset > offset ? page.next_offset : null
  }
  return payments
}

// Paid links this browser has not collected, as raw totals per asset, for the
// wallet panel. Null without a saved merchant credential: listing needs one.
export async function uncollectedTotals(address, signal) {
  const access = savedAccess(address)
  if (!access) return null
  const collected = (id) => { try { return localStorage.getItem(withdrawnKey(address, id)) !== null } catch { return false } }
  const ready = (await allPaymentLinks(access, signal)).filter((payment) => payment.status === 'paid' && !collected(payment.record.invoice.id))
  return Object.fromEntries(assetTotals(ready.map((payment) => payment.record)))
}

const STATE_LABELS = { pending: 'Awaiting payment', paid: 'Ready to collect', collected: 'Collected', draft: 'Not published' }

function StatusPill({ state }) {
  return <span className={`linkStatus ${state}`}>{state === 'collected' ? <Check aria-hidden="true" /> : <i aria-hidden="true" />}{STATE_LABELS[state]}</span>
}

function TokenMark({ asset, protocol }) {
  return <span className="tokenMark" aria-hidden="true"><img src={assetLogo(asset)} alt="" /><img className="tokenPool" src={LOGOS[protocol].src} alt="" /></span>
}

export default function PaymentLinks({ summary, walletSession }) {
  const [amount, setAmount] = useState('')
  const [asset, setAsset] = useState('USDC')
  const [assetMenuOpen, setAssetMenuOpen] = useState(false)
  const prices = useUsdPrices(PRICED)
  const [reference, setReference] = useState('')
  const [pool, setPool] = useState('cloakc')
  const [sort, setSort] = useState('fees')

  const { wallet, connecting, connectWallet } = walletSession
  const [draftState, setDraftState] = useState({ address: null, records: [] })
  const drafts = wallet && draftState.address === wallet.address ? draftState.records : []
  const [busy, setBusy] = useState(false)
  // Which part of the page the running operation belongs to, so only it shows progress.
  const [task, setTask] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
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
  const [noteKeys, setNoteKeys] = useState(null)
  const [filter, setFilter] = useState('all')
  const [copied, setCopied] = useState(null)
  // null, or the collect dialog's { phase: loading | review | working | done, records, ... }.
  const [collect, setCollect] = useState(null)
  const [recipient, setRecipient] = useState('')
  const [withdrawn, setWithdrawn] = useState(new Map())
  const [pendingDelete, setPendingDelete] = useState(null)
  const dialog = useRef(null)
  const collectDialog = useRef(null)
  const operation = useRef(null)

  useEffect(() => {
    setBusy(false); setStatus(''); setError(''); setListError(''); setNotice(''); setAccess(wallet ? savedAccess(wallet.address) : null)
    setHistory({ payments: [], next_offset: null }); setHistoryError(''); setOffset(0); setDepositFor(null); setFilter('all')
    setPublished(new Set()); setDraftState({ address: wallet?.address ?? null, records: [] })
    setNoteKeys(null); setWithdrawn(new Map())
    dialog.current?.close(); collectDialog.current?.close()
    if (wallet) {
      try {
        const records = readPaymentDrafts(localStorage, wallet.address)
        setDraftState({ address: wallet.address, records })
        setPublished(new Set(records.filter((record) => localStorage.getItem(`darksol:published:${wallet.address}:${record.invoice.id}`)).map((record) => record.invoice.id)))
        const prefix = withdrawnKey(wallet.address, '')
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
        if (controller.signal.aborted) return
        // A saved credential the server no longer accepts: sign again on the next load.
        if (cause.status === 401) { forgetAccess(access.address); setAccess(null); return }
        setHistoryError(cause.message || 'Could not load payment links')
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

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  async function merchantAccess(signal) {
    if (access?.address === wallet.address) return access
    setStatus('Approve merchant access...')
    const scoped = await signAccess(wallet, signal)
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

  const usedIndexes = (serverNext) => nextNoteIndex(serverNext, draftState.records)

  // `fail` receives the message of an error the action throws; `kind` says which
  // part of the page shows the operation's progress.
  async function run(action, fail = setError, kind = 'list') {
    if (operation.current || connecting) return
    setError(''); setListError('')
    if (!wallet) {
      try { await connectWallet() }
      catch (cause) { fail(cause instanceof Error ? cause.message : 'Could not connect wallet') }
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setTask(kind)
    try {
      await action(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted) fail(cause instanceof Error ? cause.message : 'Could not complete payment request')
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setBusy(false); setTask(null); setStatus('')
      }
    }
  }

  async function publish(record, signal, identity) {
    setStatus('Creating payment link...')
    const result = await createPaymentLink({ record, access: identity, signal })
    signal.throwIfAborted()
    setPublished((previous) => new Set([...previous, record.invoice.id]))
    try { localStorage.setItem(`darksol:published:${wallet.address}:${record.invoice.id}`, result.payment_id) } catch { /* The encrypted draft and server record remain intact. */ }
    setOffset(0); setFilter('all'); setRefresh((value) => value + 1)
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
    }, setError, 'create')
  }

  async function copyLink(payment) {
    try {
      await navigator.clipboard.writeText(paymentLinkUrl(payment.payment_url))
      setCopied(payment.payment_id); setNotice('Payment link copied')
      setTimeout(() => setCopied((current) => current === payment.payment_id ? null : current), 1600)
    } catch { setListError('Could not copy the link. Open it to copy from the address bar.') }
  }

  function saveFile(contents, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(contents, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // One file for everything: a version 1 record is the only way to reach its note,
  // and a Cloak note is found from its record, so keep backups easy to keep.
  function backup(records) {
    saveFile(records, `darksol-payments-${new Date().toISOString().slice(0, 10)}.json`)
    setNotice(`Saved ${plural(records.length, 'recovery record')}`)
  }

  // The loaded page is enough when it is the only one.
  const everyPayment = (identity, signal) => offset === 0 && history.next_offset === null ? history.payments : allPaymentLinks(identity, signal)

  function downloadAll() {
    run(async (signal) => {
      const payments = access ? await everyPayment(access, signal) : []
      backup([...payments.map((payment) => payment.record), ...unpublished])
    }, setListError)
  }

  function askDelete(entry) {
    setPendingDelete(entry)
    dialog.current.showModal()
  }

  function removePending(withBackup) {
    const { payment, draft } = pendingDelete
    dialog.current.close()
    if (withBackup) backup([payment ? payment.record : draft])
    run(async (signal) => {
      if (payment) {
        const identity = await merchantAccess(signal)
        await deletePaymentLink(payment.payment_id, identity, signal)
        signal.throwIfAborted()
        try { localStorage.removeItem(`darksol:published:${wallet.address}:${payment.record.invoice.id}`) } catch { /* The draft stays listed as unpublished. */ }
        setHistory((previous) => ({ ...previous, payments: previous.payments.filter((item) => item.payment_id !== payment.payment_id) }))
        setRefresh((value) => value + 1)
      } else {
        // Never published, so nobody holds a link to pay it.
        removePaymentDraft(localStorage, wallet.address, draft.invoice.id)
        setDraftState((current) => ({ ...current, records: current.records.filter((record) => record.invoice.id !== draft.invoice.id) }))
      }
      setNotice('Payment link deleted')
    }, setListError)
  }

  function markWithdrawn(id, signature = '') {
    setWithdrawn((previous) => new Map(previous).set(id, signature))
    try { localStorage.setItem(withdrawnKey(wallet.address, id), signature) } catch { /* Shown until reload. */ }
  }

  function openCollect() {
    if (operation.current) return
    setRecipient(''); setCollect({ phase: 'loading' })
    collectDialog.current.showModal()
    run(async (signal) => {
      const payments = await everyPayment(await merchantAccess(signal), signal)
      setCollect({ phase: 'review', records: payments.filter((payment) => payment.status === 'paid' && !isWithdrawn(payment.record)).map((payment) => payment.record) })
    }, (message) => setCollect({ phase: 'review', records: ready, error: message }))
  }

  // Spends every paid note in as few transactions as pairNotes allows. Each one is
  // marked collected as it lands, so a retry picks up only what is left.
  function startCollect(event) {
    event.preventDefault()
    const records = collectRecords
    const target = recipientCheck.sanitized
    run(async (signal) => {
      let done = 0
      const signatures = []
      const progress = (message) => { if (!signal.aborted) setCollect((current) => ({ ...current, done, signatures: [...signatures], status: message })) }
      setCollect((current) => ({ ...current, phase: 'working', total: records.length, done, signatures, status: '', error: '' }))
      const keys = records.some((record) => record.version === 2) ? await paymentKeys(signal) : undefined
      const connection = new Connection(paymentRpcUrl(), 'confirmed')
      async function spend(group) {
        signal.throwIfAborted()
        try {
          const signature = await withdrawPaymentNotes({ ...wallet, records: group, keys, recipient: target, signal, connection, onStatus: progress })
          for (const record of group) markWithdrawn(record.invoice.id, signature)
          signatures.push(signature)
        } catch (cause) {
          // A verified deposit with nothing unspent was collected already, likely from another device.
          if (group.length > 1 || !/No unspent funds/.test(cause.message)) throw cause
          markWithdrawn(group[0].invoice.id)
        }
        done += group.length
        progress('')
      }
      try {
        for (const group of pairNotes(records)) {
          try { await spend(group) } catch (cause) {
            // Retry a failed pair note by note, so one bad note does not hold back its partner.
            if (group.length === 1 || signal.aborted) throw cause
            for (const record of group) await spend([record])
          }
        }
      } catch (cause) {
        if (done && !signal.aborted) throw new Error(`Collected ${done} of ${records.length}, then: ${cause.message}`)
        throw cause
      }
      signal.throwIfAborted()
      setCollect((current) => ({ ...current, phase: 'done', done, signatures }))
      setRefresh((value) => value + 1)
    }, (message) => setCollect((current) => ({ ...current, phase: 'review', error: message })))
  }

  // An open wallet prompt outlives the abort, so the page is freed now rather than
  // when that prompt settles. A withdrawal already relayed still lands and is
  // marked; the loop starts no further one.
  function stopCollect() {
    operation.current?.abort()
    operation.current = null
    setBusy(false); setTask(null); setStatus('')
    setCollect((current) => ({ ...current, phase: 'review', error: 'Stopped. Payments collected so far are marked; the rest stay shielded.' }))
  }

  const isWithdrawn = (record) => withdrawn.has(record.invoice.id)
  const rowState = (payment) => isWithdrawn(payment.record) ? 'collected' : payment.status === 'paid' ? 'paid' : 'pending'
  const ready = history.payments.filter((payment) => rowState(payment) === 'paid').map((payment) => payment.record)
  const readyTotals = assetTotals(ready)
  const readyUsd = readyTotals.every(([symbol]) => prices[symbol]) ? readyTotals.reduce((sum, [symbol, raw]) => sum + assetAmount(raw, symbol) * prices[symbol], 0) : null
  const counts = { all: history.payments.length, pending: 0, paid: 0, collected: 0 }
  for (const payment of history.payments) counts[rowState(payment)]++
  const visible = history.payments.filter((payment) => filter === 'all' || rowState(payment) === filter)
  const unpublished = drafts.filter((draft) => !published.has(draft.invoice.id))
  const collectRecords = collect?.records?.filter((record) => !isWithdrawn(record)) ?? []
  const plan = collectPlan(collectRecords, prices)
  const recipientCheck = validateSolanaAddress(recipient)

  const amountResult = parseAmount(amount, asset)
  const amountError = amount && !amountResult.valid ? amountResult.error
    : pool === 'cloakc' && amountResult.valid && amountResult.baseUnits < PAYMENT_ASSETS[asset].cloakMin ? `Cloak requires at least ${cloakMinimum(asset)}.` : ''
  const { pools, volumeAvailable } = rankPools({ asset, amount: amountResult.valid ? Number(amountResult.normalized) : 0, prices, summary, sort })

  const verifyForm = (payment) => <form className="linkVerify" onSubmit={(event) => {
    event.preventDefault()
    run(async (signal) => {
      setStatus('Verifying deposit...')
      await reportPaymentDeposit(payment.payment_id, transactionId.trim(), signal)
      signal.throwIfAborted()
      setHistory((previous) => ({ ...previous, payments: previous.payments.map((item) => item.payment_id === payment.payment_id ? { ...item, status: 'paid' } : item) }))
      setDepositFor(null); setRefresh((value) => value + 1); setNotice('Deposit verified')
    }, setListError, 'verify')
  }}>
    <label htmlFor="merchantDeposit">Paste the customer's deposit transaction ID</label>
    <div>
      <input id="merchantDeposit" value={transactionId} onChange={(event) => setTransactionId(event.target.value)} disabled={busy} maxLength={88} autoComplete="off" spellCheck="false" placeholder="Transaction ID" required autoFocus />
      <button className="linkText strong" disabled={busy || !transactionId.trim()} type="submit">{busy && task === 'verify' ? 'Verifying…' : 'Verify'}</button>
      <button className="linkIcon" type="button" aria-label="Cancel deposit verification" disabled={busy} onClick={() => setDepositFor(null)}><X /></button>
    </div>
  </form>

  const linkRow = (payment) => {
    const { record } = payment
    const state = rowState(payment)
    const collection = withdrawn.get(record.invoice.id)
    return <React.Fragment key={payment.payment_id}>
      <article className={`linkRow ${state}${depositFor === payment.payment_id ? ' expanded' : ''}`}>
        <TokenMark asset={record.invoice.asset} protocol={record.invoice.protocol} />
        <div className="linkMain">
          <strong>{record.reference || 'Payment request'}</strong>
          <span>{poolName(record.invoice.protocol)}<i aria-hidden="true">·</i>{dateText(payment.created_at)}</span>
        </div>
        <div className="linkAmount"><b>{tokenAmount(record.invoice.amount, record.invoice.asset)}<small>{record.invoice.asset}</small></b></div>
        <StatusPill state={state} />
        <div className="linkActions">
          {payment.deposit_transaction && <a className="linkText" href={solscan(payment.deposit_transaction)} target="_blank" rel="noreferrer">Deposit<ExternalLink /></a>}
          {collection && <a className="linkText" href={solscan(collection)} target="_blank" rel="noreferrer">Collection<ExternalLink /></a>}
          {state === 'pending' && <button type="button" className="linkText" disabled={busy} aria-expanded={depositFor === payment.payment_id}
            onClick={() => { setDepositFor(depositFor === payment.payment_id ? null : payment.payment_id); setTransactionId('') }}>Verify deposit</button>}
          <button type="button" className={`linkIcon${copied === payment.payment_id ? ' done' : ''}`} data-tooltip={copied === payment.payment_id ? 'Copied' : 'Copy link'} aria-label="Copy payment link" onClick={() => copyLink(payment)}>
            {copied === payment.payment_id ? <Check /> : <Copy />}</button>
          <a className="linkIcon" data-tooltip="Open checkout" aria-label="Open checkout" href={paymentLinkUrl(payment.payment_url)} target="_blank" rel="noreferrer"><ExternalLink /></a>
          {payment.status !== 'paid' && <button type="button" className="linkIcon linkDelete" data-tooltip="Delete link" aria-label={`Delete ${record.reference || 'payment request'}`} disabled={busy} onClick={() => askDelete({ payment })}><Trash2 /></button>}
        </div>
      </article>
      {depositFor === payment.payment_id && state === 'pending' && verifyForm(payment)}
    </React.Fragment>
  }

  return <div className="homePage paymentLinksPage">
    <header><h1>Receive privately</h1></header>
    <p className="paymentIntro">Get paid without sharing your wallet address with your customer.</p>

    <form className="sendCard panel paymentCreate" onSubmit={createPayment}>
      <label className="paymentFieldLabel" htmlFor="paymentAmount">Request amount</label>
      <div className="amountRow paymentAmountRow">
        <span className="amountUsd">{usdText(amount, prices[asset])}</span>
        <input id="paymentAmount" disabled={busy} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" maxLength={30} value={amount} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'paymentAmountError' : undefined} onChange={(event) => setAmount(sanitizeAmount(event.target.value))} />
        <div className="assetPicker">
          <button type="button" aria-label="Request asset" aria-haspopup="listbox" aria-expanded={assetMenuOpen} disabled={busy} onClick={() => setAssetMenuOpen(!assetMenuOpen)}>
            <img className="assetLogo" src={assetLogo(asset)} alt="" /><b>{asset}</b><ChevronDown /></button>
          {assetMenuOpen && <div className="assetMenu" role="listbox">{PRICED.map((symbol) => <button type="button" role="option" aria-selected={asset === symbol} key={symbol}
            onClick={() => { setAsset(symbol); setAssetMenuOpen(false) }}><img className="assetLogo" src={assetLogo(symbol)} alt="" />{symbol}</button>)}</div>}
        </div>
      </div>
      {amountError && <p className="paymentAmountError" id="paymentAmountError" role="status">{amountError}</p>}
      <div className="paymentReference"><label className="paymentFieldLabel" htmlFor="paymentReference">Reference <span>Optional</span></label><input id="paymentReference" disabled={busy} placeholder="Add an invoice or order reference" maxLength={80} value={reference} onChange={(event) => setReference(event.target.value)} /></div>
      <div className="paymentPoolHeading">
        <span className="paymentFieldLabel" id="paymentPoolLabel">Receive through</span>
        <PoolSort sort={sort} onSort={setSort} />
      </div>
      <PoolPicker pools={pools} value={pool} onChange={setPool} asset={asset} amountValid={amountResult.valid} sort={sort} summary={summary} disabled={busy} labelledBy="paymentPoolLabel">
        <SoonPool name="Helius Rings" logo="/logos/helius.svg" note="0% fees" tooltip="Soon · only on devnet for now" />
      </PoolPicker>
      <p className="paymentPoolHint" role="status">{poolHint(sort, summary, volumeAvailable, 'Estimated withdrawal fees. Network and deposit costs are additional.')}</p>
      {error && <p className="paymentError" role="alert">{error}</p>}
      <div className="paymentActions">
        <button className="paymentPrimary" type="submit" disabled={busy || connecting || Boolean(wallet && (!amountResult.valid || amountError))} aria-describedby={wallet ? 'paymentAvailability' : undefined}>
          {connecting ? 'Connecting…' : busy && task === 'create' ? <><LoaderCircle className="spin" aria-hidden="true" />{status || 'Preparing note…'}</>
            : !wallet ? <><Wallet aria-hidden="true" />Connect wallet</> : <>Create payment link <ArrowRight aria-hidden="true" /></>}
        </button>
      </div>
      {wallet && <p className="paymentFormHint" id="paymentAvailability">Sign a message to prepare your payment note.</p>}
    </form>

    <section className="linksSection" aria-labelledby="paymentHistoryTitle">
      <div className="linksHeader">
        <h2 id="paymentHistoryTitle">Your payment links</h2>
        {wallet && access && <div className="linksTools">
          <button type="button" className="toolButton" data-tooltip="Refresh" aria-label="Refresh payment links" disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw className={loading ? 'spin' : ''} /></button>
          {(history.payments.length > 0 || unpublished.length > 0) && <button type="button" className="toolButton" data-tooltip="Download backup" aria-label="Download a backup of every payment link" disabled={busy} onClick={downloadAll}><Download /></button>}
        </div>}
      </div>

      {ready.length > 0 && <div className="collectCard">
        <div className="collectSummary">
          <p>Ready to collect</p>
          <strong>{readyTotals.map(([symbol, raw]) => `${tokenAmount(raw, symbol)} ${symbol}`).join(' + ')}</strong>
          <span>{plural(ready.length, 'payment')}{readyUsd ? ` · ≈ ${usd(readyUsd)}` : ''}</span>
        </div>
        <button type="button" className="collectButton" disabled={busy} onClick={openCollect}><ArrowDownToLine aria-hidden="true" />Collect</button>
      </div>}

      {history.payments.length > 0 && <div className="linkTabs" role="group" aria-label="Filter payment links">
        {[['all', 'All'], ['pending', 'Awaiting'], ['paid', 'Ready'], ['collected', 'Collected']].map(([key, label]) =>
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{counts[key]}</span></button>)}
      </div>}

      {(listError || historyError) && <p className="paymentError" role="alert">{listError || historyError}</p>}
      {/* Only the first load shows placeholders; the 15s refresh updates rows in place. */}
      {loading && !history.payments.length && <div className="linkList" aria-busy="true" aria-label="Loading payment links">
        {[0, 1, 2].map((index) => <div className="linkRow skeleton" key={index}><span /><div><i /><i /></div><b /></div>)}
      </div>}
      {visible.length > 0 && <div className="linkList" key={filter}>{visible.map(linkRow)}</div>}
      {history.payments.length > 0 && !visible.length && <p className="linksNone">No {filter === 'pending' ? 'links awaiting payment' : filter === 'paid' ? 'payments waiting to be collected' : 'collected payments'} on this page.</p>}
      {(offset > 0 || history.next_offset !== null) && <div className="paymentPagination">
        <button className="ghost" type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ArrowLeft />Previous</button>
        <button className="ghost" type="button" disabled={loading || history.next_offset === null} onClick={() => setOffset(history.next_offset)}>Next<ArrowRight /></button>
      </div>}

      {unpublished.length > 0 && filter === 'all' && <div className="linkList drafts">
        <p className="linkListLabel">Saved in this browser</p>
        {unpublished.map((draft) => <article className="linkRow draft" key={draft.invoice.id}>
          <TokenMark asset={draft.invoice.asset} protocol={draft.invoice.protocol} />
          <div className="linkMain"><strong>{draft.reference || 'Payment request'}</strong><span>{poolName(draft.invoice.protocol)}<i aria-hidden="true">·</i>{dateText(draft.createdAt)}</span></div>
          <div className="linkAmount"><b>{tokenAmount(draft.invoice.amount, draft.invoice.asset)}<small>{draft.invoice.asset}</small></b></div>
          <StatusPill state="draft" />
          <div className="linkActions"><button type="button" className="linkText strong" disabled={busy} onClick={() => run(async (signal) => publish(draft, signal, await merchantAccess(signal)), setListError)}><Upload />Publish</button>
            <button type="button" className="linkIcon linkDelete" data-tooltip="Delete request" aria-label={`Delete ${draft.reference || 'payment request'}`} disabled={busy} onClick={() => askDelete({ draft })}><Trash2 /></button></div>
        </article>)}
      </div>}

      {!loading && !history.payments.length && !unpublished.length && <div className="linksEmpty">
        <h3>{!wallet ? 'Your payments, in one place' : !access ? 'Load your payment links' : 'No payment links yet'}</h3>
        <p>{!wallet ? 'Connect your wallet to view your payment links.' : !access ? 'Sign a message to see the links you created, on any device.' : 'Create your first link above and share it with a customer.'}</p>
        {wallet && !access && <button type="button" className="ghost" disabled={busy} onClick={() => run(async (signal) => { await merchantAccess(signal); setRefresh((value) => value + 1) }, setListError)}>
          {busy ? <LoaderCircle className="spin" /> : <RefreshCw />}Load payment links</button>}
      </div>}
    </section>

    {notice && <div className="toast" role="status" key={notice}><Check aria-hidden="true" />{notice}</div>}

    <dialog className="paymentDialog" ref={dialog} aria-labelledby="paymentDialogTitle" onClose={() => setPendingDelete(null)}>
      {pendingDelete && <>
        <h3 id="paymentDialogTitle">{pendingDelete.payment ? 'Delete this payment link?' : 'Delete this saved request?'}</h3>
        <p>{pendingDelete.payment ? 'The link stops working for anyone who has it. A downloaded copy keeps its note’s recovery record.'
          : 'It was never published, so nobody can pay it. A downloaded copy keeps its recovery record.'}</p>
        <div className="paymentDialogActions">
          <button className="ghost" type="button" autoFocus onClick={() => dialog.current.close()}>Cancel</button>
          <button className="ghost" type="button" onClick={() => removePending(true)}><Download aria-hidden="true" />Download and delete</button>
          <button className="ghost paymentDanger" type="button" onClick={() => removePending(false)}><Trash2 aria-hidden="true" />Delete</button>
        </div>
      </>}
    </dialog>

    <dialog className="paymentDialog collectDialog" ref={collectDialog} aria-labelledby="collectTitle"
      onCancel={(event) => { if (collect?.phase === 'working') event.preventDefault() }} onClose={() => setCollect(null)}>
      {collect && <>
        <div className="dialogHead">
          <h3 id="collectTitle">{collect.phase === 'working' ? 'Collecting payments' : collect.phase === 'done' ? 'Payments collected' : 'Collect payments'}</h3>
          {collect.phase !== 'working' && <button type="button" className="linkIcon" aria-label="Close" onClick={() => collectDialog.current.close()}><X /></button>}
        </div>

        {collect.phase === 'loading' && <div className="collectLoading" role="status"><LoaderCircle className="spin" aria-hidden="true" />{status || 'Finding paid payments…'}</div>}

        {collect.phase === 'review' && (collectRecords.length ? <form className="collectForm" onSubmit={startCollect}>
          <ul className="collectAssets">{plan.rows.map((row) => <li key={row.asset}>
            <img src={assetLogo(row.asset)} alt="" />
            <div><b>{tokenAmount(row.raw, row.asset)} {row.asset}</b><small>{plural(row.count, 'payment')}</small></div>
            {Number.isFinite(row.fee) && <span>≈ {approx(row.fee)} {row.asset}<small>pool fees</small></span>}
          </li>)}</ul>
          <label className="paymentFieldLabel" htmlFor="collectRecipient">Send to</label>
          <div className="collectRecipient">
            <input id="collectRecipient" value={recipient} onChange={(event) => setRecipient(sanitizeSolanaAddress(event.target.value))} disabled={busy} maxLength={44}
              autoComplete="off" spellCheck="false" placeholder="Solana address" aria-invalid={Boolean(recipient && !recipientCheck.valid)} autoFocus />
            {wallet && <button type="button" className="linkText" disabled={busy} onClick={() => setRecipient(wallet.address)}>My wallet</button>}
          </div>
          {recipient && !recipientCheck.valid && <p className="paymentAmountError">{recipientCheck.error}</p>}
          <p className={`collectHint${plan.alone ? ' tip' : ''}`}>{!plan.alone
            ? 'The pool breaks the link to your customers, and each withdrawal combines two payments, so no amount matches what a single customer paid.'
            : `The pool breaks the link to your customers, but ${collectRecords.length === 1 ? 'this payment leaves' : plan.alone === 1 ? '1 payment leaves' : `${plan.alone} payments leave`} on ${plan.alone === 1 ? 'its' : 'their'} own, for the exact amount paid. Wait for another payment in the same pool and token so Collect can combine them; the activity in between also hides the timing. A new address adds more distance.`}</p>
          {collect.error && <p className="paymentError" role="alert">{collect.error}</p>}
          <button className="paymentPrimary" type="submit" disabled={busy || !recipientCheck.valid}><ArrowDownToLine aria-hidden="true" />Collect {plural(collectRecords.length, 'payment')}</button>
          <p className="collectFoot">{plural(plan.transactions, 'private withdrawal')} · the pool&apos;s relayer pays the network fee</p>
        </form> : <div className="collectDone">
          <span className="doneMark"><Check /></span>
          <p>{collect.error || 'Everything is collected.'}</p>
          <button className="ghost" type="button" onClick={() => collectDialog.current.close()}>Close</button>
        </div>)}

        {collect.phase === 'working' && <div className="collectProgress" role="status">
          <div className="progressTrack"><i style={{ width: `${Math.max(6, (collect.done / collect.total) * 100)}%` }} /></div>
          <p><b>{collect.done} of {collect.total}</b> collected</p>
          <p className="collectStatus"><LoaderCircle className="spin" aria-hidden="true" />{collect.status || status || 'Preparing…'}</p>
          {collect.signatures.length > 0 && <ul className="collectReceipts">{collect.signatures.map((signature) => <li key={signature}><Check /><a href={solscan(signature)} target="_blank" rel="noreferrer">{short(signature)}<ExternalLink /></a></li>)}</ul>}
          <button className="ghost" type="button" onClick={stopCollect}>Stop</button>
        </div>}

        {collect.phase === 'done' && <div className="collectDone">
          <span className="doneMark"><Check /></span>
          <p>{collect.signatures.length ? `${plural(collect.done, 'payment')} sent to ${short(recipientCheck.sanitized || recipient)}.` : 'These payments were already collected.'}</p>
          {collect.signatures.length > 0 && <ul className="collectReceipts">{collect.signatures.map((signature) => <li key={signature}><Check /><a href={solscan(signature)} target="_blank" rel="noreferrer">{short(signature)}<ExternalLink /></a></li>)}</ul>}
          <button className="paymentPrimary" type="button" onClick={() => collectDialog.current.close()}>Done</button>
        </div>}
      </>}
    </dialog>
  </div>
}
