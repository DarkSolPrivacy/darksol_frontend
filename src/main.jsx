import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowLeftRight, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleAlert, Clock3, Copy, Database, ExternalLink, Home, Link2, LogOut, Menu, Plus, Shield, ShieldCheck, ShieldX, Wallet, X } from 'lucide-react'
import './styles.css'
import PaymentLinks, { forgetAccess, uncollectedTotals } from './payment-links.jsx'
import PaymentCheckout from './payment-checkout.jsx'
import { useWalletSession } from './wallet-session.js'
import { sanitizeAmount, sanitizeSolanaAddress, validateTransfer } from './transfer-validation.js'
import { swapEligibility } from './swap-routes.js'
import { usdText, useUsdPrices } from './token-price.js'
import { BRIDGE_CHAINS, bridgeChain, bridgeEligibility, sanitizeBridgeAddress, validateBridgeAddress } from './bridge-routes.js'
import {
  LOGOS as PROTOCOL_LOGOS, PROTOCOLS, PROVIDER_CAPABILITIES, listProtocols, resolveProtocolId,
} from '../protocols/registry.js'
import { TOKEN_DECIMALS, withdrawalFor } from '../protocols/shared/units.js'
import { loadBrowserAdapter } from '../protocols/browser.js'
import { DELAY_MINUTES, cancelScheduled, loadScheduled, saveScheduled, scheduleWithdrawal, scheduledStatus } from './scheduled-send.js'

// The pool selector used to hardcode which ids sit under which heading, and the
// bridge picker named privacycash directly. Both follow the manifests now.
const SOLANA_POOL_IDS = listProtocols({ chain: 'solana' }).map(({ id }) => id)
const OTHER_POOL_IDS = listProtocols().filter(({ chain }) => chain !== 'solana').map(({ id }) => id)
const BRIDGE_PROTOCOL_ID = listProtocols({ capability: 'bridge' })[0]?.id || null
const SINGLE_RECIPIENT_IDS = listProtocols().filter(({ recipients }) => !recipients.multi).map(({ id }) => id)
const SHIELDED_POOL_IDS = listProtocols({ chain: 'solana' }).filter(({ modules }) => modules.shieldedBalance).map(({ id }) => id)
const FROM_SHIELDED_IDS = SHIELDED_POOL_IDS.filter((id) => PROTOCOLS[id].send.fromShielded)
const sourceName = (source) => source === 'links' ? 'Payment links' : PROTOCOLS[source]?.name || source
// The last shielded reading per wallet address, shared by the wallet panel and
// the send form, so either shows it at once while a fresh read runs underneath.
const shieldedCache = new Map()

// Each pool's shielded balance for `wallet`: { state: loading | ready | locked |
// error, balances, spendable }, per pool id. Locked means the pool needs a
// signature: reading never asks the wallet to sign, reveal() does.
function useShieldedPools(wallet, active = true) {
  const address = wallet?.address
  const [state, setState] = useState({ address: null, pools: {} })
  const [status, setStatus] = useState('')
  const [round, setRound] = useState(0)
  const scan = useRef(null)
  const pools = state.address === address ? state.pools : shieldedCache.get(address) ?? {}

  useEffect(() => { if (state.address) shieldedCache.set(state.address, state.pools) }, [state])

  function read(id, prompt, signal) {
    const settle = (next) => {
      if (signal.aborted) return
      setState((current) => {
        const base = current.address === address ? current.pools : shieldedCache.get(address) ?? {}
        return { address, pools: { ...base, [id]: { ...base[id], ...next } } }
      })
    }
    settle({ state: 'loading' })
    loadBrowserAdapter(id)
      .then(async (adapter) => {
        const result = await adapter.shieldedBalances({ provider: wallet.provider, prompt, signal,
          onStatus: (message) => { if (!signal.aborted) setStatus(`${sourceName(id)} · ${message}`) } })
        // plan(asset, amounts): how a payment of these amounts would go out, when the pool can say.
        return result && { ...result, plan: adapter.planShieldedSend && ((asset, amounts) => adapter.planShieldedSend(result, asset, amounts)) }
      })
      .then((result) => settle(result ? { state: 'ready', ...result } : { state: 'locked', balances: undefined, spendable: undefined, plan: undefined }),
        () => settle({ state: 'error' }))
      .finally(() => { if (!signal.aborted) setStatus('') })
  }

  useEffect(() => {
    if (!active || !address) return undefined
    const controller = new AbortController()
    scan.current = controller
    for (const id of SHIELDED_POOL_IDS) read(id, false, controller.signal)
    return () => controller.abort()
  }, [active, address, round])

  const reveal = () => SHIELDED_POOL_IDS.filter((id) => ['locked', 'error'].includes(pools[id]?.state))
    .forEach((id) => read(id, true, scan.current.signal))
  return { pools, status, reveal, refresh: () => setRound((value) => value + 1) }
}

// A route runs in the browser only if the protocol ships the module for it and
// declares that capability as actually executing, not merely documented.
function browserCanRun(protocolId, capability) {
  const manifest = protocolId ? PROTOCOLS[protocolId] : null
  if (!manifest) return false
  const module = capability === 'bridge' ? manifest.modules.bridge : manifest.modules.browser
  return Boolean(module && manifest[capability]?.execution === 'sdk')
}

const ASSETS = ['USDC', 'SOL', 'USDT']
// Bridging is offered as a fourth destination choice rather than a separate mode,
// so the amount and asset the user already entered carry straight over.
const BRIDGE_OPTION = 'BRIDGE'
const DESTINATION_OPTIONS = [...ASSETS, BRIDGE_OPTION]
const LOGOS = {
  assets: {
    USDC: { src: '/logos/usdc.svg', source: 'https://www.circle.com/pressroom' },
    SOL: { src: '/logos/sol.svg', source: 'https://solana.com/branding' },
    USDT: { src: '/logos/usdt.svg', source: 'https://tether.to/en/media/' },
  },
  protocols: PROTOCOL_LOGOS,
}
// Every state but pending and sent leaves the deposit shielded, so each offers Send now.
const DELIVERY_TEXT = {
  sent: 'Transfer delivered',
  failed: 'Delivery failed · funds are still shielded',
  expired: 'Delivery window passed · funds are still shielded',
  cancelled: 'Delivery cancelled · funds are still shielded',
  unknown: 'Delivery status unavailable · Send now checks the chain first',
}
const EMPTY_ASSETS = { USDC: 0, SOL: 0, USDT: 0 }
const EMPTY = { buckets: [], totals: { deposits: EMPTY_ASSETS, withdrawals: EMPTY_ASSETS, swapIn: EMPTY_ASSETS, swapOut: EMPTY_ASSETS, poolSize: EMPTY_ASSETS, count: 0, counts: { byAsset: EMPTY_ASSETS } }, poolState: { balances: EMPTY_ASSETS, usd: EMPTY_ASSETS, totalUsd: 0 }, externalFlows: {}, activity: { txCount: 0, uniqueAmounts: 0, amountDistribution: [], recentVolume: {}, timeDistribution: [] }, recent: [] }
const PRIVACY_TARGETS = [
  { value: 'balanced', label: 'Balanced', score: 60 },
  { value: 'high', label: 'High', score: 75 },
  { value: 'maximum', label: 'Maximum', score: 90 },
]
const SUB_SCORE_LABELS = {
  depth: 'Pool depth', cover: 'Relevant cover', similarity: 'Similar-size flows',
  temporal: 'Temporal diversity', activity: 'Recent activity', uniqueness: 'Amount uniqueness',
  swapActivity: 'Swap activity', strategy: 'Withdrawal strategy',
}
const WINDOW_LABELS = { '1H': '5 minute units', '6H': '15 minute units', '1D': '1 hour units', '30D': '1 day units', '90D': '1 day units' }
const FLOW_TYPES = [
  ['deposits', 'Deposits', '#F0F0F0', 'Deposit', undefined], ['withdrawals', 'Withdrawals', '#3E3E3E', 'Withdraw', '8 4'],
  ['swapIn', 'Swap in', '#A0A0A0', 'SwapIn', '2 3'], ['swapOut', 'Swap out', '#666666', 'SwapOut', '12 5 2 5'],
]
const compact = (number, max = 2) => Intl.NumberFormat('en-US', { notation: Math.abs(number || 0) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: max }).format(number || 0)
const money = (number) => Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: Math.abs(number || 0) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(number || 0)
// A token amount at the precision it is paid in: SOL to 5 places, stablecoins to cents unless dust.
const tokenDigits = (value, asset) => asset === 'SOL' ? 5 : Math.abs(value) < 0.01 ? 4 : 2
const tokenFigure = (value, asset) => `${compact(value, tokenDigits(value, asset))} ${asset}`
const short = (value) => value?.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value || 'unknown'
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const pickNumber = (...values) => values.map(finite).find((value) => value !== null) ?? null
const scoreText = (value) => finite(value) === null ? '—' : `${Math.round(Number(value))}/100`
const bandClass = (value) => String(value || '').toLowerCase().replace(/\s+/g, '-')
const displayBand = (value) => value ? String(value).replaceAll('_', ' ').toUpperCase() : 'UNAVAILABLE'
// The band as a word in a sentence-case UI: "VERY_HIGH" reads "Very high".
const bandLabel = (value) => { const text = displayBand(value).toLowerCase(); return text.charAt(0).toUpperCase() + text.slice(1) }
const explanationText = (entry) => typeof entry === 'string' ? entry : entry?.text || entry?.message || entry?.label
const explanationTone = (entry, text) => entry && typeof entry === 'object' ? entry.type || entry.tone || entry.impact : String(text).trim().startsWith('-') ? 'negative' : 'positive'
const formatMetricMoney = (value) => finite(value) === null ? 'Unavailable' : money(Number(value))
const formatPercent = (value) => finite(value) === null ? 'Unavailable' : `${compact(Number(value) * 100, Number(value) < .001 ? 3 : 2)}%`
const rawTokenAmount = (value, asset) => {
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  const decimals = TOKEN_DECIMALS[asset]
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) return null
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
}
const rawTokenText = (raw, asset) => {
  const decimals = TOKEN_DECIMALS[asset]
  const scale = 10n ** BigInt(decimals)
  const whole = raw / scale
  const fraction = String(raw % scale).padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function formatDuration(value) {
  if (value === null || value === undefined || value === '') return 'Not enough activity to estimate'
  if (typeof value === 'string') return value
  if (typeof value === 'object' && finite(value.seconds) === null && value.display) return value.display
  const seconds = finite(typeof value === 'object' ? value.seconds : value)
  if (seconds === null || seconds < 0) return 'Not enough activity to estimate'
  if (seconds === 0) return 'Now'
  if (seconds >= 7 * 86400) return '> 7 days'
  if (seconds < 60) return `< 1 min`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `~${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours < 24) return `~${hours}h${remainder ? ` ${remainder}m` : ''}`
  const days = Math.floor(hours / 24)
  return `~${days}d ${hours % 24}h`
}

function providerKey(item) {
  return resolveProtocolId(item?.provider || item?.protocol || '')
}

// Why a pool cannot pay `amounts` (one per recipient, base units) of `asset` from
// the wallet's shielded balance, or null. A pool that can plan the payment decides
// with its own rules (several withdrawals, a minimum per withdrawal).
function fromShieldedReason(entry, asset, amounts) {
  if (!entry || entry.state === 'loading') return 'Reading your shielded balance…'
  if (entry.state === 'locked') return 'Reveal your shielded balance to pay from it.'
  if (entry.state === 'error') return 'Your shielded balance could not be read.'
  const available = BigInt(entry.spendable?.[asset] ?? 0n)
  if (!available) return `No shielded ${asset} in this pool.`
  if (!amounts) return null
  const fits = entry.plan ? entry.plan(asset, amounts) : amounts.reduce((sum, value) => sum + value, 0n) <= available
  if (fits) return null
  const minimum = entry.terms?.[asset]?.minimum
  return `Your shielded ${asset} here can pay at most ${rawTokenText(available, asset)}${minimum ? `, in withdrawals of at least ${rawTokenText(minimum, asset)}` : ''}.`
}

// `shield` is null for a plain send, or { mode: 'keep' | 'use', pools, amounts }:
// keep deposits more than it sends, use pays `amounts` from the shielded balance.
function normalizeEstimate(item, strategy, inputAsset, outputAsset, bridge, delayed = false, shield = null) {
  const protocol = providerKey(item)
  const configured = PROVIDER_CAPABILITIES[protocol] || {}
  const send = PROTOCOLS[protocol]?.send || {}
  const shieldBlocked = !shield ? null
    : shield.mode === 'keep' ? (send.keepShielded ? null : 'Keeping part of a send shielded is not supported by this provider.')
      : send.fromShielded ? fromShieldedReason(shield.pools[protocol], inputAsset, shield.amounts) : 'Paying from shielded funds is not supported by this provider.'
  const poolMetrics = item?.poolMetrics || {}
  const capabilities = { ...configured, ...(item?.capabilities || {}) }
  // A server response must not widen a protocol past what its manifest declares.
  if (!configured.supportsMultiRecipient) capabilities.supportsMultiRecipient = false
  if (!configured.supportsDeadline) capabilities.supportsDeadline = false
  const deadlineBlocked = delayed && !capabilities.supportsDeadline
  // A bridge is ranked on its own route table: the swap table would report the
  // wrong answer, since bridging leaves Solana entirely.
  const route = bridge ? bridgeEligibility(protocol, inputAsset, bridge.chainId, bridge.token)
    : inputAsset && outputAsset ? swapEligibility(protocol, inputAsset, outputAsset) : { available: true }
  const capabilityBlocked = strategy === 'multiple' && !capabilities.supportsMultiRecipient
  const routeBlocked = bridge ? !route.available : inputAsset !== outputAsset && !route.available
  const subScores = item?.subScores || item?.subscores || {
    depth: item?.depthScore, cover: item?.coverScore, similarity: item?.similarityScore,
    temporal: item?.temporalScore, activity: item?.activityScore, uniqueness: item?.uniquenessScore,
  }
  return {
    ...item,
    protocol,
    protocolName: item?.protocolName || item?.providerName || PROTOCOLS[protocol]?.name || item?.provider || item?.protocol || 'Unknown pool',
    available: item?.available !== false && item?.eligible !== false && !capabilityBlocked && !routeBlocked && !deadlineBlocked && !shieldBlocked,
    unavailableReason: capabilityBlocked
      ? 'Multiple-recipient withdrawal is not currently supported by this provider.'
      : deadlineBlocked ? 'A delivery deadline is not supported by this provider.'
      : shieldBlocked ? shieldBlocked
      : routeBlocked ? route.reason
      : item?.unavailableReason || item?.ineligibleReason || item?.reason,
    capabilities,
    score: pickNumber(item?.score, item?.privacyScore, item?.planScore),
    band: item?.band || item?.privacy || item?.planBand,
    confidence: item?.confidence && typeof item.confidence === 'object' ? item.confidence.band : item?.confidence || item?.estimatedTimeToTarget?.confidence?.band,
    confidenceDetails: item?.confidence && typeof item.confidence === 'object' ? item.confidence : item?.estimatedTimeToTarget?.confidence,
    subScores,
    poolMetrics: {
      ...poolMetrics,
      tvl: pickNumber(poolMetrics.tvl, poolMetrics.tvlUsd, item?.poolTvlUsd),
      externalVolume24h: pickNumber(poolMetrics.externalVolume24h, poolMetrics.volume24hUsd, item?.volume24hUsd),
      externalVolume1h: pickNumber(poolMetrics.externalVolume1h, poolMetrics.volume1hUsd, item?.volume1hUsd),
      recentTransactionCount: pickNumber(poolMetrics.recentTransactionCount, poolMetrics.recentTxCount, item?.recentTransactions),
    },
    similarFlowCount: pickNumber(item?.similarFlowCount, item?.similarSizeFlows),
    weightedSimilarFlowCount: pickNumber(item?.weightedSimilarFlowCount),
    projectedScore: pickNumber(item?.projectedScore, item?.estimatedTimeToTarget?.projectedScore),
    coordinationPenalty: pickNumber(item?.coordinationPenalty, item?.coordinationPenalty?.total),
    coordinationRisk: item?.coordinationRisk || item?.coordinationPenalty?.band,
    executionLatency: item?.executionLatency || ((item?.executionLatencyP50 !== undefined || item?.executionLatencyP95 !== undefined)
      ? { p50: item.executionLatencyP50, p95: item.executionLatencyP95 }
      : null),
    receiverEstimates: Array.isArray(item?.receiverEstimates) ? item.receiverEstimates : [],
    explanations: Array.isArray(item?.explanations) ? item.explanations : [],
    timeline: Array.isArray(item?.timeline) ? item.timeline : Array.isArray(item?.estimatedTimeToTarget?.timeline) ? item.estimatedTimeToTarget.timeline : [],
    // What a swap delivers and where each fee goes. Swaps only: a send's one pool
    // fee is the estimated fee already, and a bridge's cross-chain fees are the relayer's to quote.
    settlement: !bridge && inputAsset !== outputAsset && item?.settlement?.available ? item.settlement : null,
  }
}

function feeDisplay(fee, asset) {
  if (!fee) return { primary: 'Unavailable', secondary: '' }
  if (typeof fee === 'number') return { primary: money(fee), secondary: '' }
  if (typeof fee === 'string') return { primary: fee, secondary: '' }
  const usd = pickNumber(fee.usd, fee.estimatedUsd, fee.totalUsd)
  const native = pickNumber(fee.native, fee.amount, fee.total)
  return {
    primary: usd === null ? (native === null ? 'Unavailable' : `${compact(native, 6)} ${fee.asset || asset}`) : money(usd),
    secondary: usd !== null && native !== null ? `${compact(native, 6)} ${fee.asset || asset}` : fee.detail || '',
  }
}

function bucketLabel(timestamp, range) {
  const date = new Date(timestamp * 1000)
  if (range === '30D' || range === '90D') return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
}

function age(timestamp) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function Metric({ label, value, note }) {
  return <div className="metric"><p>{label}</p><strong>{value}</strong>{note && <small>{note}</small>}</div>
}

function EstimateTimeline({ timeline, targetScore }) {
  if (!timeline?.length) return null
  const points = timeline.slice(0, 6)
  return <div className="estimateTimeline" aria-label="Estimated privacy over time">
    <div className="timelineTrack" />
    {points.map((point, index) => {
      const seconds = pickNumber(point.seconds, point.timeSeconds, point.offsetSeconds, finite(point.minutes) !== null ? Number(point.minutes) * 60 : null)
      const pointScore = pickNumber(point.score, point.privacyScore)
      return <div className="timelinePoint" key={`${seconds}-${index}`}>
        <i className={pointScore !== null && pointScore >= targetScore ? 'crossed' : ''} />
        <span>{index === 0 ? 'Now' : formatDuration(seconds)}</span><b>{pointScore === null ? '—' : Math.round(pointScore)}</b>
      </div>
    })}
  </div>
}

function ReceiverBreakdown({ receivers, asset, targetLabel }) {
  if (!receivers?.length) return null
  return <div className="receiverResults"><p>Receiver privacy</p>{receivers.map((receiver, index) => {
    const receiverEstimate = receiver.estimate || receiver
    const receiverScore = pickNumber(receiver.score, receiver.privacyScore, receiverEstimate.score, receiverEstimate.privacyScore)
    const receiverBand = receiver.band || receiver.privacy || receiverEstimate.band || receiverEstimate.privacy
    const receiverAmount = pickNumber(receiver.amount, receiver.receiverAmount)
    const receiverWait = receiver.recommendedWait ?? receiver.estimatedTimeToTarget ?? receiver.estimatedTimeToHigh
    return <div key={receiver.id || index}><span>#{index + 1} <b>{receiverAmount === null ? '—' : compact(receiverAmount, 6)} {receiver.asset || asset}</b></span><span className={bandClass(receiverBand)}>{scoreText(receiverScore)} {displayBand(receiverBand)}</span><em>{targetLabel}: {formatDuration(receiverWait)}</em></div>
  })}</div>
}

function AssetLogo({ asset }) {
  const logo = LOGOS.assets[asset]
  // Bridge destinations reach into tokens this dashboard holds no mark for
  // (ETH, DAI, BNB, POL, BTC), so those fall back to a lettered badge.
  if (!logo) return <span className="assetLogo" aria-hidden="true">{String(asset || '?').slice(0, 1)}</span>
  return <img className="assetLogo" src={logo.src} alt="" aria-hidden="true" />
}

function ProtocolLogo({ protocol, name }) {
  const key = providerKey({ protocol }) || 'unknown'
  const logo = LOGOS.protocols[key]
  return logo
    ? <img className="protocolLogo" src={logo.src} alt={name} title={name} />
    : <span className="protocolLogo fallback" role="img" aria-label={name} title={name}>{String(name || '?').slice(0, 1)}</span>
}

// The eclipse mark is generated by scripts/eclipse-mark.mjs.
function EclipseLogo() {
  return <div className="brandLockup" aria-label="DarkSol">
    <img className="eclipseMark" src="/logo.svg" alt="" aria-hidden="true" />
    <span>DARKSOL<small>Private routing</small></span>
  </div>
}

function MobileBar({ onOpen }) {
  return <div className="mobileBar"><button className="mobile" type="button" aria-label="Open navigation" aria-controls="primaryNav" onClick={onOpen}><Menu /></button><EclipseLogo /></div>
}

const xLink = <a className="xLink" href="https://x.com/DarkSolapp" target="_blank" rel="noopener noreferrer" aria-label="DarkSol on X"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>@DarkSolapp</a>

function Sidebar({ open, view, onToggle, onHome, onPaymentLinks, onAnalytics, onClose }) {
  return <aside id="primaryNav"><div className="sideTop"><EclipseLogo /><button className="sidebarToggle" type="button" aria-label={open ? 'Collapse navigation' : 'Expand navigation'} onClick={onToggle}><Menu /></button><button className="drawerClose" type="button" aria-label="Close navigation" onClick={onClose}><X /></button></div><nav><a className={view === 'home' ? 'active' : ''} href="/" onClick={onHome}><Home /><span>Private transfer</span></a><a className={view === 'payments' ? 'active' : ''} href="/payment-links" aria-label="Payment links" onClick={onPaymentLinks}><Link2 /><span>Payment links</span></a><a className={view === 'analytics' ? 'analyticsNav active' : 'analyticsNav'} href="/analytics" onClick={onAnalytics}><Database /><span>Analytics</span><ArrowUpRight className="navArrow" /></a></nav><div className="sideBottom"><p>DarkSol private routing</p><code>v1.0 / MAINNET</code>{xLink}</div></aside>
}

function PlanCard({ estimate, asset, strategy, targetLabel, targetScore, selected, suggested, onSelect, onOpenProtocol }) {
  const metrics = estimate.poolMetrics || {}
  const fee = feeDisplay(estimate.fee || estimate.estimatedFee, asset)
  const targetWait = estimate.recommendedWait ?? estimate.estimatedTimeToTarget
  const coordinationPenalty = pickNumber(estimate.coordinationPenalty)
  const unavailable = !estimate.available
  const selection = { ...estimate, _plan: { asset, amount: estimate.planAmount, strategy, targetLabel, targetScore } }
  return <article className={`rankCard planCard panel ${selected ? 'winner selectedPool' : 'alternativePool'} ${unavailable ? 'unavailable' : ''}`}>
    <div className="rankTop"><div><small>{unavailable ? 'UNAVAILABLE' : selected ? (suggested ? 'RECOMMENDED' : 'SELECTED') : suggested ? 'RECOMMENDED' : 'ALTERNATIVE'}</small><div className="protocolTitle"><ProtocolLogo protocol={estimate.protocol} name={estimate.protocolName} /><h2>{estimate.protocolName}</h2></div><div className="capabilityLine"><span>{estimate.capabilities?.network || 'Solana'}</span>{estimate.swapRoute && <span>{estimate.swapRoute.inputAsset} -&gt; {estimate.swapRoute.outputAsset} via {estimate.swapRoute.aggregator}</span>}</div></div><div className={`privacy ${bandClass(estimate.band)}`}><span>ESTIMATED PRIVACY</span><strong>{displayBand(estimate.band)}</strong><em>{scoreText(estimate.score)}</em></div></div>
    {unavailable ? <div className="unavailableBody"><ShieldX /><h3>Unavailable for this strategy</h3><p>{estimate.unavailableReason || 'This provider cannot evaluate the selected transfer strategy.'}</p><small>Provider capability, not a privacy-score penalty.</small></div> : <>
      <div className="cardSection"><p>CURRENT POOL</p><dl><div><dt>TVL</dt><dd>{formatMetricMoney(metrics.tvl)}</dd></div><div><dt>24h external volume</dt><dd>{formatMetricMoney(metrics.externalVolume24h)}</dd></div><div><dt>1h external volume</dt><dd>{formatMetricMoney(metrics.externalVolume1h)}</dd></div><div><dt>Recent transactions</dt><dd>{finite(metrics.recentTransactionCount) === null ? 'Unavailable' : compact(metrics.recentTransactionCount, 0)}</dd></div></dl></div>
      <div className="cardColumns"><div className="cardSection"><p>TRANSFER IMPACT</p><dl><div><dt>Pool share</dt><dd>{formatPercent(estimate.poolShare)}</dd></div><div><dt>Similar-size flows</dt><dd>{finite(estimate.similarFlowCount) === null ? 'Unavailable' : compact(estimate.similarFlowCount, 0)}</dd></div></dl></div>
      <div className="cardSection timingSection"><p>TIMING</p><dl><div><dt>If exiting now</dt><dd>{scoreText(estimate.score)} <small>{displayBand(estimate.band)}</small></dd></div><div><dt>{targetLabel} target</dt><dd>{formatDuration(targetWait)}</dd></div><div><dt>High privacy estimate</dt><dd>{formatDuration(estimate.estimatedTimeToHigh)}</dd></div><div><dt>Very high estimate</dt><dd>{formatDuration(estimate.estimatedTimeToVeryHigh)}</dd></div></dl></div></div>
      {strategy === 'multiple' && <ReceiverBreakdown receivers={estimate.receiverEstimates} asset={asset} targetLabel={targetLabel} />}
      {strategy === 'multiple' && <div className="coordination"><span>COORDINATION RISK</span><b className={bandClass(estimate.coordinationRisk)}>{displayBand(estimate.coordinationRisk || 'Unavailable')}</b><small>{coordinationPenalty === null ? 'Penalty unavailable' : `−${compact(coordinationPenalty, 1)} score points`}</small></div>}
      <EstimateTimeline timeline={estimate.timeline} targetScore={targetScore} />
      <div className="executionRow privacyWaitOnly"><div><span>RECOMMENDED PRIVACY WAIT</span><b>{formatDuration(targetWait)}</b></div></div>
      <div className="feeRow"><span>ESTIMATED FEE</span><strong>{fee.primary}</strong><small>{fee.secondary}</small></div>
      <footer className="cardFoot"><span>Historical activity does not guarantee future anonymity.</span><div>{!selected && !unavailable && <button className="selectPool" onClick={() => onSelect(estimate.protocol)}>Select</button>}<button onClick={() => onOpenProtocol(estimate.protocol, selection)}>View analytics <ArrowUpRight /></button></div></footer>
    </>}
  </article>
}

function RouteDetails({ estimate, alternatives, asset, amount, targetLabel, open, onToggle }) {
  const metrics = estimate.poolMetrics || {}
  const fee = feeDisplay(estimate.fee || estimate.estimatedFee, asset)
  const targetWait = estimate.recommendedWait ?? estimate.estimatedTimeToTarget
  const rivals = alternatives.filter((item) => item.available && finite(item.score) !== null)
  const runnerUp = rivals.reduce((best, item) => !best || item.score > best.score ? item : best, null)
  const margin = runnerUp && finite(estimate.score) !== null ? estimate.score - runnerUp.score : null
  const planAmount = finite(amount)
  const leadReason = !runnerUp
    ? 'Only pool able to route this transfer right now'
    : margin > 0 ? `${compact(margin, 1)} points ahead of ${runnerUp.protocolName} (${scoreText(runnerUp.score)})`
    : `Level with ${runnerUp.protocolName} on score, ahead on pool depth`
  return <section className={`routeDetails ${open ? 'open' : ''}`}>
    <button type="button" className="routeDetailsToggle" aria-expanded={open} onClick={onToggle}>Details <ChevronDown /></button>
    {open && <div className="routeDetailsBody panel">
      <div className="routeDetailsHead">
        <h3>{estimate.protocolName} ranks first{planAmount === null ? '' : ` for ${compact(planAmount, 6)} ${asset}`}</h3>
        <div className={`privacy ${bandClass(estimate.band)}`}><span>Estimated privacy</span><strong>{bandLabel(estimate.band)}</strong><em>{scoreText(estimate.score)}</em></div>
      </div>
      <ul className="routeReasons">
        <li className={margin > 0 || !runnerUp ? 'positive' : 'neutral'}><i>{margin > 0 || !runnerUp ? '+' : '='}</i><span>{leadReason}</span></li>
        {estimate.explanations.map((entry, index) => { const text = explanationText(entry); const tone = explanationTone(entry, text); return <li className={tone} key={index}><i>{tone === 'negative' || tone === 'risk' ? '−' : '+'}</i><span>{text}</span></li> })}
      </ul>
      <dl className="routeFacts">
        <div><dt>Pool TVL</dt><dd>{formatMetricMoney(metrics.tvl)}</dd></div>
        <div><dt>Your pool share</dt><dd>{formatPercent(estimate.poolShare)}</dd></div>
        <div><dt>Similar-size flows</dt><dd>{finite(estimate.similarFlowCount) === null ? 'Unavailable' : compact(estimate.similarFlowCount, 0)}</dd></div>
        <div><dt>{targetLabel} wait</dt><dd>{formatDuration(targetWait)}</dd></div>
        <div><dt>Estimated fee</dt><dd>{fee.primary}</dd></div>
      </dl>
      {estimate.settlement && <details className="settlement">
        <summary>Where the fees go <ChevronDown /></summary>
        <div className="settlementOutput"><span>Recipient receives</span><b>≈ {tokenFigure(estimate.settlement.output.amount, estimate.settlement.output.asset)}{finite(estimate.settlement.output.usd) !== null && <small>{money(estimate.settlement.output.usd)}</small>}</b></div>
        {estimate.settlement.extra && <div className="settlementOutput"><span>Plus SOL for fees</span><b>≈ {tokenFigure(estimate.settlement.extra.amount, 'SOL')}{finite(estimate.settlement.extra.usd) !== null && <small>{money(estimate.settlement.extra.usd)}</small>}</b></div>}
        {estimate.settlement.fees.map((item, index) => <div key={index}><span>{item.label}</span><em>{item.to}{item.fromWallet ? ' · from wallet SOL' : ''}</em><b>{tokenFigure(item.amount, item.asset)}{finite(item.usd) !== null && <small>{item.usd > 0 && item.usd < 0.005 ? '<$0.01' : money(item.usd)}</small>}</b></div>)}
      </details>}
      {alternatives.length > 0 && <div className="routeAlternatives"><p>Compared against</p>{alternatives.map((item) => <div key={item.protocol}><ProtocolLogo protocol={item.protocol} name={item.protocolName} /><span>{item.protocolName}</span>{item.available ? <b>{scoreText(item.score)} <small>{bandLabel(item.band)}</small></b> : <small className="routeUnavailable">{item.unavailableReason || 'Unavailable for this transfer'}</small>}</div>)}</div>}
      <p className="estimateDisclaimer">This is an estimate, not a guarantee of anonymity.</p>
    </div>}
  </section>
}

function PrivacyHome({ walletSession }) {
  const { wallet, connecting, connectWallet: connectSession } = walletSession
  const [asset, setAsset] = useState('USDC')
  const [destinationAsset, setDestinationAsset] = useState('USDC')
  const prices = useUsdPrices(ASSETS)
  const [amount, setAmount] = useState('')
  const [receiverAmounts, setReceiverAmounts] = useState([''])
  const [recipientAddresses, setRecipientAddresses] = useState([''])
  const [assetMenuOpen, setAssetMenuOpen] = useState(false)
  const [destinationMenuOpen, setDestinationMenuOpen] = useState(false)
  const [bridgeChainId, setBridgeChainId] = useState(BRIDGE_CHAINS[0].id)
  const [bridgeToken, setBridgeToken] = useState(BRIDGE_CHAINS[0].tokens[0])
  const [privacyTarget, setPrivacyTarget] = useState('balanced')
  const [comparison, setComparison] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendStatus, setSendStatus] = useState('')
  const [sendError, setSendError] = useState('')
  const [receipt, setReceipt] = useState(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [sendAttempted, setSendAttempted] = useState(false)
  const [selectedProtocol, setSelectedProtocol] = useState(null)
  const [walletBalance, setWalletBalance] = useState(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [delay, setDelay] = useState(0)
  const [delayMenuOpen, setDelayMenuOpen] = useState(false)
  // off: deposit and send it all. keep: deposit the amount, send part of it and
  // leave the rest in the wallet's shielded balance. use: pay from that balance.
  const [shieldMode, setShieldMode] = useState('off')
  const [keepAmount, setKeepAmount] = useState('')
  const [shieldMenuOpen, setShieldMenuOpen] = useState(false)
  // A delayed delivery outlives this page: it is reloaded from localStorage.
  const [scheduled, setScheduled] = useState(loadScheduled)
  // The SOL-for-fees question askForGas puts to the user, while it is open.
  const [gasOffer, setGasOffer] = useState(null)
  const requestSequence = useRef(0)
  const balanceSequence = useRef(0)
  const receiverCount = receiverAmounts.length
  const strategy = receiverCount > 1 ? 'multiple' : 'single'
  const isBridge = destinationAsset === BRIDGE_OPTION
  const isSwap = !isBridge && asset !== destinationAsset
  const selectedBridgeChain = bridgeChain(bridgeChainId)
  const bridgeRoute = isBridge ? bridgeEligibility(BRIDGE_PROTOCOL_ID, asset, bridgeChainId, bridgeToken) : null
  // Shielding applies to a plain send; a swap or bridge always sends everything.
  const activeShield = !isSwap && !isBridge ? shieldMode : 'off'
  const keeping = activeShield === 'keep'
  const payingShielded = activeShield === 'use'
  const shielded = useShieldedPools(wallet, payingShielded)
  // Only a plain send to one recipient can be proved ahead and delivered later,
  // and the proof spends the deposit it follows, so shielded funds cannot wait.
  const deadlineMinutes = !isSwap && !isBridge && receiverCount === 1 && !payingShielded ? delay : 0
  const delayLabel = receiverCount > 1 ? 'Delay supports one recipient' : payingShielded ? 'Delay needs a fresh deposit' : deadlineMinutes ? `Arrives within ${deadlineMinutes} min` : 'Delay'

  const total = finite(amount)
  const totalRaw = rawTokenAmount(amount, asset)
  // An empty keep amount counts as nothing kept until one is typed.
  const keepRaw = !keeping ? 0n : keepAmount.trim() ? rawTokenAmount(keepAmount, asset) : 0n
  // What leaves the pool for the recipients: the amount, less what stays shielded.
  const sentRaw = totalRaw === null || keepRaw === null ? null : totalRaw - keepRaw
  const sentAmount = keeping ? (sentRaw !== null && sentRaw > 0n ? rawTokenText(sentRaw, asset) : '') : amount
  const keepError = !keeping ? '' : keepRaw === null ? 'Enter a valid amount to keep shielded'
    : !keepRaw ? 'Enter how much to keep shielded' : sentRaw !== null && sentRaw <= 0n ? 'Keep less than the full amount' : ''
  const receiverRaws = receiverAmounts.map((value) => rawTokenAmount(value, asset))
  const receiverTotalRaw = receiverRaws.every((value) => value !== null) ? receiverRaws.reduce((sum, value) => sum + value, 0n) : null
  const receiverTotal = receiverTotalRaw === null ? null : Number(rawTokenText(receiverTotalRaw, asset))
  const remainingRaw = sentRaw === null || receiverTotalRaw === null ? null : sentRaw - receiverTotalRaw
  const remaining = remainingRaw === null ? null : Number(rawTokenText(remainingRaw < 0n ? -remainingRaw : remainingRaw, asset)) * (remainingRaw < 0n ? -1 : 1)
  const amountsMatch = sentRaw !== null && receiverTotalRaw === sentRaw
  const receiversValid = receiverRaws.every((value) => value !== null && value > 0n) && amountsMatch
  const formValid = sentRaw !== null && sentRaw > 0n && receiversValid && !keepError
  // The most one withdrawal can pay from the shielded balance, in the pool holding the most.
  const shieldedSpendable = FROM_SHIELDED_IDS.map((id) => shielded.pools[id]).filter((entry) => entry?.state === 'ready')
    .reduce((best, entry) => { const value = BigInt(entry.spendable?.[asset] ?? 0n); return value > best ? value : best }, 0n)
  const shieldedLocked = FROM_SHIELDED_IDS.some((id) => ['locked', 'error'].includes(shielded.pools[id]?.state))
  const shieldedReading = FROM_SHIELDED_IDS.some((id) => !shielded.pools[id] || shielded.pools[id].state === 'loading')
  const selectedTarget = PRIVACY_TARGETS.find((target) => target.value === privacyTarget) || PRIVACY_TARGETS[0]
  const transferValidation = validateTransfer({
    asset,
    amount: sentAmount,
    recipients: receiverAmounts.map((receiverAmount, index) => ({ address: recipientAddresses[index], amount: receiverAmount })),
    senderAddress: wallet?.address,
  })
  // A bridge always has a single recipient on another chain, so the Solana address
  // and split-amount rules in `validateTransfer` do not apply to it. The relayer's
  // own minimum is enforced later, against its live config.
  const bridgeAddress = isBridge ? validateBridgeAddress(recipientAddresses[0], bridgeChainId) : null
  const bridgeValidation = !isBridge ? null
    : !bridgeRoute?.available ? { valid: false, error: bridgeRoute?.reason || 'This bridge route is unavailable' }
      : !transferValidation.total.valid ? { valid: false, error: transferValidation.total.error }
        : !bridgeAddress.valid ? { valid: false, error: bridgeAddress.error }
          : { valid: true, total: transferValidation.total, recipient: bridgeAddress.sanitized }
  const activeValidation = isBridge ? bridgeValidation : transferValidation
  // The planner only scores the private Solana leg. For a bridge that leg is a
  // same-asset withdrawal, so it is planned as a transfer rather than a swap and
  // the 'BRIDGE' sentinel never reaches the API.
  const plannedDestinationAsset = isBridge ? asset : destinationAsset

  useEffect(() => {
    setReceipt(null); setSendError(''); setSendStatus(''); setSendAttempted(false)
  }, [wallet])

  useEffect(() => saveScheduled(scheduled), [scheduled])

  const pendingId = scheduled?.status === 'pending' ? scheduled.id : null
  useEffect(() => {
    if (!pendingId) return undefined
    let live = true
    const poll = () => scheduledStatus(pendingId)
      .then((next) => { if (live && next.status !== 'pending') setScheduled((job) => job?.id === pendingId ? { ...job, ...next } : job) })
      .catch(() => {})
    poll()
    const timer = setInterval(poll, 15_000)
    return () => { live = false; clearInterval(timer) }
  }, [pendingId])

  useEffect(() => {
    const requestId = ++balanceSequence.current
    setWalletBalance(null)
    if (!wallet?.address) { setBalanceLoading(false); return }
    setBalanceLoading(true)
    import('./wallet-balance.js')
      .then(({ getWalletAssetBalance }) => getWalletAssetBalance(wallet.address, asset))
      .then((balance) => { if (requestId === balanceSequence.current) setWalletBalance(balance) })
      .catch(() => { if (requestId === balanceSequence.current) setWalletBalance(null) })
      .finally(() => { if (requestId === balanceSequence.current) setBalanceLoading(false) })
  }, [wallet?.address, asset])

  async function requestPlan(payload, signal) {
    const requestId = ++requestSequence.current
    setLoading(true)
    try {
      const response = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || result.error || 'Privacy plan failed')
      if (requestId === requestSequence.current) { setComparison(result); setError(''); setDirty(false) }
    } catch (requestError) {
      if (requestError.name !== 'AbortError' && requestId === requestSequence.current) setError(requestError.message)
    } finally {
      if (requestId === requestSequence.current) setLoading(false)
    }
  }

  function calculate() {
    if (!formValid) return
    requestPlan({
      asset,
      destinationAsset: plannedDestinationAsset,
      amount: sentAmount,
      strategy,
      receiverAmounts: strategy === 'multiple' ? receiverAmounts : [sentAmount],
      privacyTarget,
    })
  }

  useEffect(() => {
    requestSequence.current += 1
    setError('')
    if (!formValid) { setLoading(false); return undefined }
    const controller = new AbortController()
    setLoading(true)
    // Scored on what leaves the pool: a kept part never reaches a recipient.
    const timeout = setTimeout(() => requestPlan({
      asset,
      destinationAsset: plannedDestinationAsset,
      amount: sentAmount,
      strategy,
      receiverAmounts: strategy === 'multiple' ? receiverAmounts : [sentAmount],
      privacyTarget,
    }, controller.signal), 350)
    return () => { clearTimeout(timeout); controller.abort() }
  }, [asset, plannedDestinationAsset, sentAmount, strategy, receiverAmounts, privacyTarget, formValid])

  // `raw` split across `count` recipients, the last taking the remainder.
  const shares = (raw, count) => {
    const shareRaw = raw / BigInt(count)
    return Array.from({ length: count }, (_, index) => rawTokenText(index === count - 1 ? raw - shareRaw * BigInt(count - 1) : shareRaw, asset))
  }
  // a − b in the current asset, floored at zero; '' while either is not an amount.
  const minus = (a, b) => {
    const left = rawTokenAmount(a, asset)
    const right = b.trim() ? rawTokenAmount(b, asset) : 0n
    return left === null || right === null ? '' : rawTokenText(left > right ? left - right : 0n, asset)
  }

  function splitEvenly(count = receiverCount) {
    if (sentRaw === null || sentRaw <= 0n) return setReceiverAmounts(Array.from({ length: count }, () => ''))
    setReceiverAmounts(shares(sentRaw, count)); setDirty(true)
  }

  // Fills the amount with `raw`; recipients split what is not kept shielded.
  function useMaximum(raw) {
    if (raw === undefined || raw === null || raw <= 0n) return
    const kept = keeping && keepRaw !== null && keepRaw < raw ? keepRaw : 0n
    setAmount(rawTokenText(raw, asset)); setReceiverAmounts(shares(raw - kept, receiverCount)); setDirty(true); setReceipt(null)
  }

  function chooseShield(mode) {
    setShieldMode(mode); setShieldMenuOpen(false); setReceipt(null); setDirty(true)
    if (mode === 'use') setDelay(0)
    if (mode !== 'keep') setKeepAmount('')
    if (receiverCount === 1) setReceiverAmounts([mode === 'keep' ? minus(amount, keepAmount) : amount])
  }

  function addReceiver() {
    splitEvenly(receiverCount + 1)
    setRecipientAddresses((current) => [...current, ''])
  }

  function removeReceiver(index) {
    if (receiverCount === 1) return
    const next = receiverAmounts.filter((_, receiverIndex) => receiverIndex !== index)
    const nextRaws = next.map((value) => rawTokenAmount(value, asset))
    if (sentRaw !== null && nextRaws.every((value) => value !== null)) {
      const nextTotal = nextRaws.reduce((sum, value) => sum + value, 0n)
      if (sentRaw >= nextTotal) next[next.length - 1] = rawTokenText(nextRaws[nextRaws.length - 1] + sentRaw - nextTotal, asset)
    }
    setReceiverAmounts(next); setDirty(true)
    setRecipientAddresses((current) => current.filter((_, receiverIndex) => receiverIndex !== index))
  }

  async function connectWallet() {
    setSendError('')
    try { await connectSession() }
    catch (error) { setSendError(error instanceof Error ? error.message : String(error)) }
  }

  // A recipient holding too little SOL to move what it receives is offered SOL
  // for network fees. On a send, PrivacyCash withdraws it after the payment: the
  // one pool that can pay it from shielded SOL, and any route can use it. A swap
  // paid in SOL carries it in its own deposit instead. Not with a delay, which
  // an immediate SOL withdrawal to the same address would give away. Resolves to
  // null when the user backs out, {} for no SOL, else { indexes, units, net, source }.
  async function askForGas(kind) {
    if (deadlineMinutes || !(kind === 'send' ? asset !== 'SOL' : kind === 'swap' && asset === 'SOL')) return {}
    // A PrivacyCash swap wallet already leaves the recipient the rest of its SOL reserve.
    if (kind === 'swap' && PROTOCOLS[recommended?.protocol]?.swap?.swapWallet) return {}
    const rows = transferValidation.rows
    let indexes, walletLamports, withdrawal, reserve
    try {
      setSendStatus('Checking the recipient…')
      const { solBalances, RECIPIENT_SOL_FLOOR, SOL_FEE_RESERVE } = await import('./wallet-balance.js')
      const lamports = await solBalances([...rows.map((row) => row.address.sanitized), wallet.address])
      walletLamports = lamports.pop()
      indexes = rows.map((_, index) => index).filter((index) => lamports[index] < RECIPIENT_SOL_FLOOR)
      if (!indexes.length) return {}
      reserve = SOL_FEE_RESERVE
      const { solWithdrawalFee } = await loadBrowserAdapter(kind === 'swap' ? recommended.protocol : 'privacycash')
      if (!solWithdrawalFee) return {}
      withdrawal = await solWithdrawalFee()
    } catch { return {} } // the check never holds up the payment
    finally { setSendStatus('') }
    const count = BigInt(indexes.length)
    const shieldedSol = payingShielded ? shielded.pools.privacycash : null
    const quote = (net) => {
      const units = withdrawalFor(net, withdrawal.fee, withdrawal.minimum)
      const source = kind === 'swap' ? 'swap' : shieldedSol?.plan?.('SOL', indexes.map(() => units)) ? 'shielded' : 'wallet'
      const needs = source === 'shielded' ? 0n : units * count + (kind === 'swap' ? activeValidation.total.baseUnits : 0n) + reserve
      return { units, total: units * count, fee: withdrawal.fee(units) * count, source, needs }
    }
    return new Promise((resolve) => setGasOffer({
      addresses: indexes.map((index) => rows[index].address.sanitized), asset: destinationAsset, verb: kind === 'swap' ? 'Swap' : 'Send', walletLamports, quote,
      resolve: (choice) => { setGasOffer(null); resolve(choice?.units ? { ...choice, indexes } : choice) },
    }))
  }

  // PrivacyCash sends each chosen recipient its SOL once the payment has landed,
  // so this failing never undoes the payment.
  async function sendGas({ indexes, units, source }) {
    setSendStatus('Sending SOL for fees…')
    try {
      const { execute } = await loadBrowserAdapter('privacycash')
      const recipients = indexes.map((index) => ({ publicKey: transferValidation.rows[index].address.publicKey, baseUnits: units }))
      const sent = await execute({ kind: 'send', provider: wallet.provider, asset: 'SOL', recipients, totalBaseUnits: units * BigInt(recipients.length), source, onStatus: setSendStatus })
      return { gas: sent.withdrawals.at(-1) }
    } catch (error) { return { gasError: error instanceof Error ? error.message : String(error) } }
  }

  async function sendTransfer() {
    setSendAttempted(true); setSendError('')
    if (submitted) return setSendError(receipt.depositSignature ? 'This deposit was already submitted. Do not send it again.' : 'This payment was already sent. Do not send it again.')
    setReceipt(null)
    if (!wallet) return connectWallet()
    if (!activeValidation.valid) return setSendError(activeValidation.error)
    const kind = isBridge ? 'bridge' : isSwap ? 'swap' : 'send'
    if (!browserCanRun(recommended?.protocol, kind)) {
      return setSendError('This recommended route is not enabled for browser execution yet')
    }
    if (scheduledBlocks) return setSendError('Finish or dismiss the delayed delivery above first.')
    setSending(true)
    try {
      const gas = await askForGas(kind)
      if (!gas) return
      // One dispatch for every protocol and every capability. The adapter is
      // still a lazy chunk, so no privacy SDK reaches the entry bundle.
      const { execute } = await loadBrowserAdapter(recommended.protocol)
      const result = await execute({
        kind,
        provider: wallet.provider,
        asset,
        inputAsset: asset,
        outputAsset: destinationAsset,
        chainId: bridgeChainId,
        outputToken: bridgeToken,
        recipient: isBridge ? activeValidation.recipient : transferValidation.rows[0]?.address.publicKey,
        recipients: transferValidation.rows.map((row) => ({ publicKey: row.address.publicKey, baseUnits: row.amount.baseUnits })),
        // Keeping part shielded deposits the full amount; the recipients take the rest.
        totalBaseUnits: keeping ? totalRaw : activeValidation.total.baseUnits,
        source: payingShielded ? 'shielded' : 'wallet',
        delayMinutes: kind === 'send' ? deadlineMinutes : 0,
        // SOL for fees a swap paid in SOL carries in its own deposit.
        gasBaseUnits: kind === 'swap' ? gas.units : undefined,
        onStatus: setSendStatus,
      })
      if (gas.units) {
        if (kind === 'send') Object.assign(result, await sendGas(gas))
        result.gasText = `${rawTokenText(gas.net, 'SOL')} SOL${gas.indexes.length > 1 ? ' each' : ''}`
      }
      // The shielded balance changed; the next read must not start from the old figure.
      if (keeping || payingShielded || kind === 'swap' || gas.units) { shieldedCache.delete(wallet.address); shielded.refresh() }
      if (kind === 'send' && deadlineMinutes) {
        const [row] = transferValidation.rows
        const job = { protocol: recommended.protocol, owner: wallet.address, asset, recipient: row.address.sanitized,
          baseUnits: String(row.amount.baseUnits), depositSignature: result.depositSignature, status: 'failed' }
        if (result.withdrawal) {
          job.nullifiers = [result.withdrawal.nullifier0PDA, result.withdrawal.nullifier1PDA]
          setSendStatus('Scheduling delivery…')
          // Either way the deposit stands and the funds stay shielded; failed offers Send now.
          try { Object.assign(job, await scheduleWithdrawal(result.withdrawal, deadlineMinutes), { status: 'pending' }) } catch {}
        }
        setScheduled(job); setSendStatus('')
        return
      }
      setReceipt({ ...result, kept: keeping ? `${rawTokenText(keepRaw, asset)} ${asset}` : null }); setSendStatus('Sent')
    } catch (transferError) {
      if (transferError?.receipt) setReceipt(transferError.receipt)
      const message = transferError instanceof Error ? transferError.message : String(transferError)
      setSendError(/403|access forbidden/i.test(message) ? 'Solana RPC access was denied. Check the server RPC configuration.' : message); setSendStatus('')
    } finally { setSending(false) }
  }

  async function deliverNow() {
    setSendError('')
    if (!wallet) return connectWallet()
    if (wallet.address !== scheduled.owner) return setSendError(`Connect ${short(scheduled.owner)}, the wallet that made this deposit`)
    setSending(true)
    try {
      const { sendScheduledNow } = await loadBrowserAdapter(scheduled.protocol)
      const result = await sendScheduledNow({ provider: wallet.provider, job: scheduled, onStatus: setSendStatus })
      setScheduled((job) => ({ ...job, status: 'sent', signature: result.tx || undefined }))
    } catch (deliveryError) {
      setSendError(deliveryError instanceof Error ? deliveryError.message : String(deliveryError))
    } finally { setSending(false); setSendStatus('') }
  }

  async function cancelDelivery() {
    const { id } = scheduled
    const update = (next) => setScheduled((job) => job?.id === id ? { ...job, ...next } : job)
    if (await cancelScheduled(id).catch(() => false)) return update({ status: 'cancelled' })
    // Refused: already sending or done, so show where it got to.
    scheduledStatus(id).then(update).catch(() => {})
  }

  const rankings = useMemo(() => {
    if (!comparison) return []
    const bridge = isBridge ? { chainId: bridgeChainId, token: bridgeToken } : null
    const amounts = receiverAmounts.map((value) => rawTokenAmount(value, asset))
    const shield = activeShield === 'off' ? null : { mode: activeShield, pools: shielded.pools, amounts: amounts.every((value) => value !== null && value > 0n) ? amounts : null }
    const normalized = (comparison.rankings || []).map((item) => normalizeEstimate(item, strategy, asset, destinationAsset, bridge, deadlineMinutes > 0, shield))
    if (strategy === 'multiple') {
      for (const id of SINGLE_RECIPIENT_IDS) {
        if (normalized.some((item) => item.protocol === id)) continue
        normalized.push(normalizeEstimate({ protocol: id, protocolName: PROTOCOLS[id].name, available: false, unavailableReason: 'Multiple-recipient withdrawal is not currently supported by this provider.', capabilities: PROVIDER_CAPABILITIES[id] }, strategy, asset, destinationAsset, bridge))
      }
    }
    return normalized
  }, [comparison, strategy, asset, destinationAsset, isBridge, bridgeChainId, bridgeToken, deadlineMinutes, activeShield, shielded.pools, receiverAmounts])
  const suggestedProtocol = rankings.find((item) => item.available)?.protocol
  const selectedIsAvailable = rankings.some((item) => item.available && item.protocol === selectedProtocol)
  const activeProtocol = selectedIsAvailable ? selectedProtocol : suggestedProtocol
  const resultTargetScore = pickNumber(comparison?.targetScore, selectedTarget.score) || selectedTarget.score
  const resultAsset = comparison?.asset || asset
  const resultAmount = pickNumber(comparison?.amount, total)
  const recommended = rankings.find((item) => item.available && item.protocol === activeProtocol)
  const alternatives = rankings.filter((item) => item.protocol !== activeProtocol)
  const browserExecutable = browserCanRun(recommended?.protocol, isBridge ? 'bridge' : isSwap ? 'swap' : 'send')
  // Any deposit consolidates the wallet's notes, including the one a queued proof
  // spends, and would replace the job whose Send now the user still needs. So the
  // same pool stays off limits until the delivery lands or is dismissed. A swap
  // deposits its output too.
  const scheduledBlocks = Boolean(scheduled) && scheduled.status !== 'sent' && scheduled.protocol === recommended?.protocol
    && (scheduled.asset === asset || (isSwap && scheduled.asset === destinationAsset))
  const actionVerb = isBridge ? 'Bridge' : isSwap ? 'Swap' : payingShielded ? 'Send from shielded' : 'Send'
  const actionProgress = isBridge ? 'Bridging...' : isSwap ? 'Swapping...' : 'Sending...'
  // A payment from the shielded balance has no deposit signature, only withdrawals.
  const submitted = Boolean(receipt?.depositSignature || receipt?.withdrawals?.length)
  // A shielded payment larger than two notes goes out as several withdrawals, each with the pool's fixed fee.
  const shieldedSplit = payingShielded && recommended && receiversValid ? shielded.pools[recommended.protocol]?.plan?.(asset, receiverRaws) : null
  // What the recipient should get after every fee on the recommended route.
  const swapOutput = isSwap ? recommended?.settlement?.output : null
  // Paying from shielded funds starts with the signature that reads the balance.
  const revealFirst = Boolean(wallet) && payingShielded && shieldedLocked && !shieldedReading
  const shieldLabel = payingShielded ? 'Paying from shielded funds' : keeping ? (keepRaw ? `Keeping ${rawTokenText(keepRaw, asset)} ${asset} shielded` : 'Keeping part shielded') : 'Shielding'
  const shieldOptions = [
    ['off', 'Send everything', 'Deposit and send the full amount'],
    ['keep', 'Keep part shielded', 'Send some, leave the rest in your private balance'],
    ['use', 'Use shielded funds', !wallet ? 'Pay from your private balance'
      : shieldedReading && payingShielded ? 'Reading your private balance…'
        : shieldedLocked || !FROM_SHIELDED_IDS.some((id) => shielded.pools[id]) ? 'Pay from your private balance · sign to read it'
          : `${rawTokenText(shieldedSpendable, asset)} ${asset} available`],
  ]

  return <div className="homePage">
    <header><h1>{isBridge ? 'Bridge privately' : isSwap ? 'Swap privately' : 'Send privately'}</h1></header>
    <section className="sendCard panel">
      <div className={`amountRow${payingShielded ? ' fromShielded' : ''}`}>
        <span className="amountUsd">{usdText(amount, prices[asset])}</span>
        <input aria-label="Amount" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(event) => { const nextAmount = sanitizeAmount(event.target.value); setAmount(nextAmount); if (receiverCount === 1) setReceiverAmounts([keeping ? minus(nextAmount, keepAmount) : nextAmount]); setDirty(true); setReceipt(null) }} />
        {wallet && (payingShielded
          ? <button type="button" className="walletMax shieldedMax" onClick={() => shieldedLocked ? shielded.reveal() : useMaximum(shieldedSpendable)} disabled={shieldedReading || (!shieldedLocked && !shieldedSpendable)}
            title={shieldedLocked ? 'Sign a message to read your shielded balance' : 'The most your shielded balance can pay'}>
            <ShieldCheck />{shieldedReading ? 'Shielded …' : shieldedLocked ? 'Reveal shielded' : `Shielded ${rawTokenText(shieldedSpendable, asset)}`}</button>
          : <button type="button" className="walletMax" onClick={() => useMaximum(walletBalance?.spendableRaw)} disabled={balanceLoading || !walletBalance?.spendableRaw} title={asset === 'SOL' ? 'Network fee reserve already deducted' : 'Use wallet balance'}>MAX {balanceLoading ? '…' : walletBalance ? rawTokenText(walletBalance.spendableRaw, asset) : '—'}</button>)}
        <div className="assetPicker">
          <button type="button" aria-haspopup="listbox" aria-expanded={assetMenuOpen} onClick={() => setAssetMenuOpen(!assetMenuOpen)}><AssetLogo asset={asset} /><b>{asset}</b><ChevronDown /></button>
          {assetMenuOpen && <div className="assetMenu" role="listbox">{ASSETS.map((item) => <button type="button" role="option" aria-selected={asset === item} onClick={() => { setAsset(item); setAssetMenuOpen(false); if (item !== destinationAsset && receiverCount > 1) { setReceiverAmounts([amount]); setRecipientAddresses([recipientAddresses[0] || '']) } setDirty(true); setReceipt(null) }} key={item}><AssetLogo asset={item} />{item}</button>)}</div>}
        </div>
      </div>
      <div className="swapDestination">
        <span>{isBridge ? 'Bridge to' : isSwap ? 'Swap to' : 'Receive'}</span><ArrowRight />
        <div className="assetPicker">
          <button type="button" aria-label="Destination asset" aria-haspopup="listbox" aria-expanded={destinationMenuOpen} onClick={() => setDestinationMenuOpen(!destinationMenuOpen)}>
            <AssetLogo asset={isBridge ? bridgeToken : destinationAsset} /><b>{isBridge ? bridgeToken : destinationAsset}</b>
            {isBridge && <small className="chainTag">{selectedBridgeChain?.label}</small>}<ChevronDown />
          </button>
          {destinationMenuOpen && <div className="assetMenu destinationAssetMenu" role="listbox">{DESTINATION_OPTIONS.map((item) => <button type="button" role="option" aria-selected={item === BRIDGE_OPTION ? isBridge : destinationAsset === item} onClick={() => { setDestinationAsset(item); setDestinationMenuOpen(false); if (item !== asset && receiverCount > 1) { setReceiverAmounts([amount]); setRecipientAddresses([recipientAddresses[0] || '']) } if (item === BRIDGE_OPTION || isBridge) { setReceiverAmounts([amount]); setRecipientAddresses(['']) } setDirty(true); setReceipt(null) }} key={item}>{item === BRIDGE_OPTION ? <><span className="assetLogo bridgeMark" aria-hidden="true"><ArrowUpRight /></span>Bridge</> : <><AssetLogo asset={item} />{item}</>}</button>)}</div>}
        </div>
        {!isBridge && <button type="button" className="flipAssets" aria-label="Reverse swap assets" onClick={() => { setAsset(destinationAsset); setDestinationAsset(asset); setAssetMenuOpen(false); setDestinationMenuOpen(false); setDirty(true); setReceipt(null) }}><ArrowLeftRight /></button>}
      </div>
      {isBridge && <div className="bridgePanel">
        <div className="bridgeChains" role="tablist" aria-label="Destination chain">
          {BRIDGE_CHAINS.map((chain) => <button type="button" role="tab" key={chain.id} aria-selected={chain.id === bridgeChainId} title={chain.name}
            onClick={() => { setBridgeChainId(chain.id); if (!chain.tokens.includes(bridgeToken)) setBridgeToken(chain.tokens[0]); setRecipientAddresses(['']); setDirty(true); setReceipt(null) }}>{chain.label}</button>)}
        </div>
        <div className="bridgeTokens" role="listbox" aria-label="Destination token">
          {(selectedBridgeChain?.tokens || []).map((token) => <button type="button" role="option" key={token} aria-selected={token === bridgeToken}
            onClick={() => { setBridgeToken(token); setDirty(true); setReceipt(null) }}><AssetLogo asset={token} />{token}</button>)}
        </div>
      </div>}
      <div className="recipientRows">
        {/* The header carries the recipient-level actions, so each row stays one line. */}
        <div className="recipientHead">
          <span>{receiverCount > 1 ? 'Recipients' : 'Recipient'}</span>
          {!isSwap && !isBridge && <>
            <button type="button" className={`shieldControl${activeShield !== 'off' ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={shieldMenuOpen} aria-label={shieldLabel} data-tooltip={shieldLabel}
              onClick={() => { setShieldMenuOpen(!shieldMenuOpen); setDelayMenuOpen(false) }}><Shield /></button>
            {shieldMenuOpen && <div className="shieldMenu" role="menu" aria-label="Shielding">{shieldOptions.map(([mode, label, detail]) =>
              <button type="button" role="menuitemradio" aria-checked={shieldMode === mode} key={mode} onClick={() => chooseShield(mode)}>
                <span><b>{label}</b><small>{detail}</small></span>{shieldMode === mode && <Check className="shieldOptionCheck" aria-hidden="true" />}
              </button>)}</div>}
            <button type="button" className={`delayControl ${deadlineMinutes ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={delayMenuOpen && receiverCount === 1 && !payingShielded} aria-disabled={receiverCount > 1 || payingShielded} aria-label={delayLabel} data-tooltip={delayLabel}
              onClick={() => { if (receiverCount === 1 && !payingShielded) { setDelayMenuOpen(!delayMenuOpen); setShieldMenuOpen(false) } }}>{deadlineMinutes ? `${deadlineMinutes}m` : <Clock3 />}</button>
            {delayMenuOpen && receiverCount === 1 && !payingShielded && <div className="delayMenu" role="menu">{[0, ...DELAY_MINUTES].map((minutes) => <button type="button" role="menuitemradio" aria-checked={delay === minutes} key={minutes} onClick={() => { setDelay(minutes); setDelayMenuOpen(false); setReceipt(null) }}>{minutes ? `Within ${minutes} min` : 'Now'}</button>)}</div>}
            <button type="button" className="addReceiver" aria-label="Add receiver" data-tooltip="Add recipient" onClick={addReceiver}><Plus /></button>
          </>}
        </div>
        {receiverAmounts.map((value, index) => <div className={`recipientRow ${totalRaw > 0n && !(recipientAddresses[index] || '').trim() ? 'needsAddress' : ''}`} key={index}><span>{index + 1}</span><div className="recipientFields"><input className="recipientAddress" aria-label={`Receiver ${index + 1} address`} autoComplete="off" spellCheck="false" placeholder={isBridge ? `${selectedBridgeChain?.name} ${bridgeToken} address` : isSwap ? `${destinationAsset} recipient address` : 'Address'} value={recipientAddresses[index] || ''} onChange={(event) => { const next = [...recipientAddresses]; next[index] = isBridge ? sanitizeBridgeAddress(event.target.value) : sanitizeSolanaAddress(event.target.value); setRecipientAddresses(next); setReceipt(null) }} />{isBridge ? <div className="recipientSwapAsset"><small>{selectedBridgeChain?.name}</small><AssetLogo asset={bridgeToken} /><b>{bridgeToken}</b></div> : isSwap ? <div className="recipientSwapAsset"><small>Receives{swapOutput ? ` ≈ ${compact(swapOutput.amount, tokenDigits(swapOutput.amount, swapOutput.asset))}` : ''}</small><AssetLogo asset={destinationAsset} /><b>{destinationAsset}</b></div> : <div><input className="recipientAmount" aria-label={`Receiver ${index + 1} amount`} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={value} onChange={(event) => { const next = [...receiverAmounts]; next[index] = sanitizeAmount(event.target.value); setReceiverAmounts(next); setDirty(true); setReceipt(null) }} /><b>{asset}</b></div>}</div>{receiverCount > 1 && <button type="button" aria-label={`Remove receiver ${index + 1}`} onClick={() => removeReceiver(index)}><X /></button>}</div>)}
        {keeping && <div className="recipientRow keepRow">
          <span aria-hidden="true"><ShieldCheck /></span>
          <div className="recipientFields">
            <div className="keepLabel"><b>Keep shielded</b><small>Stays in your private balance</small></div>
            <div><input className="recipientAmount" aria-label="Amount to keep shielded" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={keepAmount} autoFocus
              onChange={(event) => { const next = sanitizeAmount(event.target.value); setKeepAmount(next); if (receiverCount === 1) setReceiverAmounts([minus(amount, next)]); setDirty(true); setReceipt(null) }} /><b>{asset}</b></div>
          </div>
          <button type="button" aria-label="Stop keeping part shielded" onClick={() => chooseShield('off')}><X /></button>
        </div>}
      </div>
      {(sendAttempted || amount) && (keepError || !activeValidation.valid) && <div className="splitStatus">{keepError || (!isBridge && !receiversValid && remaining !== null ? `${compact(Math.abs(remaining), 9)} ${asset} ${remaining > 0 ? 'left' : 'over'}` : activeValidation.error)}</div>}
      {keeping && !keepError && sentRaw > 0n && <div className="keepSummary"><span>Send <b>{rawTokenText(sentRaw, asset)} {asset}</b></span><span><ShieldCheck />Keep <b>{rawTokenText(keepRaw, asset)} {asset}</b> shielded</span></div>}
      {shieldedSplit && shieldedSplit.withdrawals > receiverCount && <div className="keepSummary">
        <span>Goes out as <b>{shieldedSplit.withdrawals}</b> private withdrawals{receiverCount === 1 ? ' to this address' : ''}, no extra approvals</span>
        <span>≈ <b>{rawTokenText(shieldedSplit.fee, asset)} {asset}</b> in pool fees</span></div>}
      <div className="sendAction">
        <div className="bestRoute">{recommended ? <ProtocolLogo protocol={recommended.protocol} name={recommended.protocolName} /> : <span className="routePlaceholder" />}</div>
        <div className="actionArea">{revealFirst
          ? <button type="button" onClick={shielded.reveal} disabled={sending}><ShieldCheck /> Reveal shielded balance</button>
          : <button type="button" onClick={sendTransfer} disabled={sending || connecting || Boolean(wallet && (submitted || scheduledBlocks || !formValid || !activeValidation.valid || loading || !recommended || recommended.band === 'NOT PRIVATE' || !browserExecutable))}>{connecting ? 'Connecting…' : sending ? sendStatus || actionProgress : !wallet ? <><Wallet /> Connect wallet</> : payingShielded && shieldedReading ? 'Reading shielded balance…' : loading ? 'Finding route...' : submitted ? 'Submitted' : scheduledBlocks ? 'Delivery pending' : recommended?.band === 'NOT PRIVATE' ? 'Not private' : !browserExecutable ? 'View route details' : actionVerb} {!sending && wallet && !submitted && !scheduledBlocks && recommended?.band !== 'NOT PRIVATE' && browserExecutable && <ArrowRight />}</button>}</div>
      </div>
    </section>
    {error && <section className="notice error"><CircleAlert /><span>{error}</span></section>}
    {recommended && <RouteDetails estimate={recommended} alternatives={alternatives} asset={resultAsset} amount={resultAmount} targetLabel={selectedTarget.label} open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} />}
    {(sendError || receipt) && <section className={`transferResult ${sendError ? 'error' : ''}`}>{sendError ? <CircleAlert /> : <Check />}<span>{sendError || (isBridge ? 'Bridge submitted' : isSwap ? 'Swap submitted' : receipt?.kept ? `Transfer complete · ${receipt.kept} kept shielded`
        : !receipt?.depositSignature && receipt?.withdrawals?.length > 1 ? `Transfer complete · sent in ${receipt.withdrawals.length} private withdrawals` : 'Transfer complete')}{!sendError && receipt?.gas && ` · ${receipt.gasText} for fees sent`}</span>{receipt && <a href={`https://solscan.io/tx/${receipt.withdrawals.at(-1)?.tx || receipt.depositSignature}`} target="_blank" rel="noreferrer">View transaction <ExternalLink /></a>}</section>}
    {receipt?.gasError && <section className="notice error"><CircleAlert /><span>The SOL for fees was not sent: {receipt.gasError}</span></section>}
    {scheduled && <section className="transferResult delivery">{scheduled.status === 'sent' ? <Check /> : <Clock3 />}<span>{scheduled.status === 'pending' ? `Deposit confirmed · arrives by ${new Date(scheduled.sendBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · you can close this page` : DELIVERY_TEXT[scheduled.status]}</span>
      <a href={`https://solscan.io/tx/${scheduled.signature || scheduled.depositSignature}`} target="_blank" rel="noreferrer">{scheduled.signature ? 'View transfer' : 'View deposit'} <ExternalLink /></a>
      {scheduled.status === 'pending' ? <button type="button" onClick={cancelDelivery}>Cancel</button> : scheduled.status !== 'sent' && <button type="button" onClick={deliverNow} disabled={sending}>Send now</button>}
      {scheduled.status !== 'pending' && <button type="button" aria-label="Dismiss" onClick={() => setScheduled(null)} disabled={sending}><X /></button>}</section>}
    <GasDialog offer={gasOffer} />
  </div>
}

const GAS_DEFAULT = '0.005'
const GAS_SOURCE = {
  shielded: 'Your shielded SOL · no approval',
  wallet: 'Your wallet · one more approval',
  swap: 'This swap’s deposit · no second deposit',
}

// Asked before paying a recipient that holds too little SOL to move what it gets.
// Cancel backs out of the payment; the offer's quote prices each amount.
function GasDialog({ offer }) {
  const dialog = useRef(null)
  const [amount, setAmount] = useState(GAS_DEFAULT)
  useEffect(() => {
    if (!offer) { dialog.current?.close(); return }
    setAmount(GAS_DEFAULT)
    dialog.current?.showModal()
  }, [offer])
  const net = rawTokenAmount(amount, 'SOL')
  const quote = offer && net > 0n ? offer.quote(net) : null
  const lacking = quote && quote.needs > offer.walletLamports
  const many = offer?.addresses.length > 1
  return <dialog className="paymentDialog gasDialog" ref={dialog} aria-labelledby="gasTitle" onClose={() => offer?.resolve(null)}>
    {offer && <>
      <h3 id="gasTitle">{many ? `${offer.addresses.length} addresses have no SOL` : 'This address has no SOL'}</h3>
      <p>{many ? 'They' : <code>{short(offer.addresses[0])}</code>} can receive {offer.asset} but can’t move or swap it without SOL for network fees. Send {many ? 'them' : 'it'} some SOL privately with this payment?</p>
      <label className="paymentFieldLabel" htmlFor="gasAmount">{many ? 'SOL each address gets' : 'SOL that arrives'}</label>
      <div className="gasAmount"><input id="gasAmount" type="text" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(sanitizeAmount(event.target.value))} autoFocus /><b>SOL</b></div>
      {quote && <dl className="gasQuote">
        <div><dt>You pay</dt><dd>{rawTokenText(quote.total, 'SOL')} SOL</dd></div>
        <div><dt>Pool fee</dt><dd>{rawTokenText(quote.fee, 'SOL')} SOL</dd></div>
        <div><dt>From</dt><dd>{GAS_SOURCE[quote.source]}</dd></div>
      </dl>}
      {lacking ? <p className="paymentError">Your wallet holds {rawTokenText(offer.walletLamports, 'SOL')} SOL; this needs about {rawTokenText(quote.needs, 'SOL')} SOL with network fees.</p>
        : quote?.source === 'wallet' && <p className="gasNote">A fresh SOL deposit withdrawn seconds later makes this payment easier to trace back to your wallet. Shielded SOL leaves no such trail.</p>}
      <div className="paymentDialogActions">
        <button className="ghost" type="button" onClick={() => offer.resolve({})}>{offer.verb} without SOL</button>
        <button className="paymentPrimary gasConfirm" type="button" disabled={!quote || lacking} onClick={() => offer.resolve({ ...quote, net })}>Add SOL</button>
      </div>
    </>}
  </dialog>
}

function EstimateAnalytics({ estimate }) {
  if (!estimate) return null
  const rawScores = estimate.subScores || {}
  const scoreEntries = [
    ['depth', pickNumber(rawScores.depth, rawScores.depthScore, estimate.depthScore)],
    ['cover', pickNumber(rawScores.cover, rawScores.coverScore, estimate.coverScore)],
    ['similarity', pickNumber(rawScores.similarity, rawScores.similarityScore, estimate.similarityScore)],
    ['temporal', pickNumber(rawScores.temporal, rawScores.temporalScore, estimate.temporalScore)],
    ['activity', pickNumber(rawScores.activity, rawScores.activityScore, estimate.activityScore)],
    ['uniqueness', pickNumber(rawScores.uniqueness, rawScores.uniquenessScore, estimate.uniquenessScore)],
  ].filter(([, value]) => value !== null)
  const plan = estimate._plan || {}
  return <section className="estimateAnalytics">
    <div className="sectionTitle"><h2>Why this transfer received its score</h2><span>{plan.amount !== null && plan.amount !== undefined ? `${compact(plan.amount, 6)} ${plan.asset}` : ''}</span></div>
    <div className="estimateOverview panel"><div className={`estimateScore ${bandClass(estimate.band)}`}><span>Estimated privacy</span><strong>{bandLabel(estimate.band)}</strong><b>{scoreText(estimate.score)}</b></div><div className="estimateFacts"><div><span>Pool share</span><b>{formatPercent(estimate.poolShare)}</b></div><div><span>Similar-size flows</span><b>{finite(estimate.similarFlowCount) === null ? 'Unavailable' : compact(estimate.similarFlowCount, 0)}</b></div><div><span>{plan.targetLabel || 'Target'} wait</span><b>{formatDuration(estimate.recommendedWait ?? estimate.estimatedTimeToTarget)}</b></div></div></div>
    <div className="explainGrid">
      <section className="panel subScores"><div className="panelHead"><div><h2>Score components</h2><p>Independent signals</p></div></div>{scoreEntries.length ? <div className="scoreBars">{scoreEntries.map(([key, value]) => <div key={key}><span>{SUB_SCORE_LABELS[key] || key}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></i><strong>{Math.round(value)}</strong></div>)}</div> : <div className="empty smallEmpty">Sub-scores unavailable</div>}</section>
      <section className="panel explanationPanel"><div className="panelHead"><div><h2>Explanation</h2><p>Evidence behind the estimate</p></div></div>{estimate.explanations?.length ? <ul>{estimate.explanations.map((entry, index) => { const text = explanationText(entry); const tone = explanationTone(entry, text); return <li className={tone} key={index}><i>{tone === 'negative' || tone === 'risk' ? '−' : '+'}</i><span>{text}</span></li> })}</ul> : <div className="empty smallEmpty">No explanation was returned for this estimate.</div>}</section>
    </div>
    {plan.strategy === 'multiple' && <section className="panel selectedReceivers"><ReceiverBreakdown receivers={estimate.receiverEstimates} asset={plan.asset} targetLabel={plan.targetLabel || 'Target'} /><div className="coordination"><span>Plan coordination risk</span><b className={bandClass(estimate.coordinationRisk)}>{bandLabel(estimate.coordinationRisk || 'Unavailable')}</b><small>{finite(estimate.coordinationPenalty) === null ? 'Penalty unavailable' : `−${compact(estimate.coordinationPenalty, 1)} score points`}</small></div></section>}
    <section className="panel selectedTimeline"><div><h2>Estimated privacy wait</h2><p>Expected score based on recent activity</p></div><EstimateTimeline timeline={estimate.timeline} targetScore={plan.targetScore || 75} /></section>
    <p className="estimateDisclaimer detailDisclaimer">This is an estimate, not a guarantee of anonymity. Historical activity does not guarantee future anonymity or unlinkability.</p>
  </section>
}

function FlowTooltip({ active, payload, label, token }) {
  if (!active || !payload?.length) return null
  return <div className="tip"><small>{label} UTC</small>{payload.map((entry) => <b key={entry.dataKey} style={{ color: entry.color }}>{entry.name}: {compact(entry.value)} {token}</b>)}</div>
}

// Deposits reach the pool along a few distinct paths, the pool mixes them, and
// withdrawals leave along unrelated paths that fade before they end: the
// diagram is the privacy claim itself. The pool's area follows the selected
// share of all-protocol TVL, and dots travel at the selected pools' inflow and
// outflow event rates, so an idle pool is visibly still.
function LiquidityFlow({ selectedTvl, totalTvl, inflowEvents, outflowEvents }) {
  const canvasRef = useRef(null)
  // The figures refresh every 30 seconds. Reading them through a ref retargets
  // the running drawing instead of tearing it down and starting again.
  const figures = useRef({ selectedTvl, totalTvl, inflowEvents, outflowEvents })
  figures.current = { selectedTvl, totalTvl, inflowEvents, outflowEvents }

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const accent = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#FFC53D'
    // Seeded, so the paths are identical on every visit.
    let seed = 20260925
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const inflows = Array.from({ length: 9 }, (_, index) => ({ y: (index + .5) / 9 + (random() - .5) * .05, bend: .4 + random() * .2 }))
    const outflows = Array.from({ length: 24 }, (_, index) => {
      const position = (index + .5) / 24 + (random() - .5) * .03
      return { angle: (position - .5) * 1.95, y: position, bend: .25 + random() * .4 }
    })
    const pointAlpha = Array.from({ length: 340 }, () => .1 + random() * .24)
    const particles = []
    let width = 1; let height = 1; let radius = null; let visible = true; let frame = 0; let timer = 0
    let last = performance.now(); let nextIn = last + 500; let nextOut = last + 1300

    const bezier = (c, t) => {
      const u = 1 - t
      return [u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
        u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7]]
    }
    // Inflows start past the left edge and arrive at the pool radially.
    const inflowPath = ({ y, bend }, cx, cy, r) => {
      const angle = Math.PI + (.5 - y) * 1.7
      const dx = Math.cos(angle); const dy = Math.sin(angle)
      const endX = cx + dx * r; const endY = cy + dy * r
      const startX = -16; const startY = height * (.06 + y * .88)
      return [startX, startY, startX + (endX - startX) * bend, startY, endX + dx * r * .9, endY + dy * r * .9, endX, endY]
    }
    // Withdrawals leave the right side radially and fan out past the right edge.
    const outflowPath = ({ angle, y, bend }, cx, cy, r) => {
      const dx = Math.cos(angle); const dy = Math.sin(angle)
      const startX = cx + dx * r; const startY = cy + dy * r
      const endX = width + 16; const endY = height * (-.12 + y * 1.24)
      return [startX, startY, startX + dx * r * .8, startY + dy * r * .8, endX - (endX - startX) * bend, endY, endX, endY]
    }
    const line = (c, rgb, stops) => {
      const gradient = context.createLinearGradient(c[0], c[1], c[6], c[7])
      for (const [offset, alpha] of stops) gradient.addColorStop(offset, `rgba(${rgb},${alpha})`)
      context.strokeStyle = gradient
      context.beginPath(); context.moveTo(c[0], c[1]); context.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]); context.stroke()
    }
    const maxRadius = () => Math.min(height * .34, width * .2)
    const targetRadius = () => {
      const { selectedTvl: selected, totalTvl: total } = figures.current
      const share = total > 0 ? Math.min(1, Math.max(0, selected / total)) : 0
      // Area encodes TVL, so the radius follows the square root of the share.
      return maxRadius() * (selected > 0 ? .16 + .84 * Math.sqrt(share) : .16)
    }

    const draw = (now) => {
      const delta = Math.min(.05, (now - last) / 1000)
      last = now
      const target = targetRadius()
      radius = radius === null || reducedMotion ? target : radius + (target - radius) * Math.min(1, delta * 3)
      if (Math.abs(target - radius) < .05) radius = target
      const cx = width / 2; const cy = height / 2; const r = radius
      const inPaths = inflows.map((flow) => inflowPath(flow, cx, cy, r))
      const outPaths = outflows.map((flow) => outflowPath(flow, cx, cy, r))
      context.clearRect(0, 0, width, height)
      context.lineWidth = 1
      inPaths.forEach((c) => line(c, '237,237,237', [[0, 0], [.55, .1], [1, .22]]))
      context.lineWidth = .8
      outPaths.forEach((c) => line(c, '150,150,150', [[0, .17], [.5, .055], [1, 0]]))
      // The pool keeps a constant point density, so a smaller pool holds fewer points.
      const count = Math.max(48, Math.round(pointAlpha.length * Math.min(1, (r / maxRadius()) ** 2)))
      for (let index = 0; index < count; index += 1) {
        const distance = r * (.62 + .35 * Math.sqrt((index + .5) / count))
        const angle = index * 2.39996
        context.fillStyle = `rgba(237,237,237,${pointAlpha[index]})`
        context.fillRect(cx + Math.cos(angle) * distance - .6, cy + Math.sin(angle) * distance - .6, 1.2, 1.2)
      }
      context.globalAlpha = .5
      context.strokeStyle = accent
      context.lineWidth = 1
      context.beginPath(); context.arc(cx, cy, r, 0, Math.PI * 2); context.stroke()
      context.globalAlpha = 1
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index]
        const progress = (now - particle.born) / particle.life
        if (progress >= 1) { particles.splice(index, 1); continue }
        const inbound = particle.kind === 'in'
        const eased = inbound ? progress * progress * (3 - 2 * progress) : 1 - (1 - progress) ** 2
        const [x, y] = bezier(inbound ? inPaths[particle.path] : outPaths[particle.path], eased)
        const alpha = inbound ? Math.min(1, progress * 6, (1 - progress) * 8) : (1 - progress) ** 1.4
        context.fillStyle = inbound ? `rgba(237,237,237,${alpha * .95})` : `rgba(165,165,165,${alpha * .9})`
        context.beginPath(); context.arc(x, y, inbound ? 1.6 : 1.4, 0, Math.PI * 2); context.fill()
      }
    }

    const spawn = (now) => {
      const { inflowEvents: inbound, outflowEvents: outbound } = figures.current
      // More events, shorter gaps: a busy pool streams, an idle one stays still.
      const gap = (events) => Math.min(5200, Math.max(420, 5200 / Math.sqrt(1 + events))) * (.65 + Math.random() * .7)
      if (inbound > 0 && now >= nextIn) {
        particles.push({ kind: 'in', path: Math.floor(Math.random() * inflows.length), born: now, life: 2600 + Math.random() * 1000 })
        nextIn = now + gap(inbound)
      }
      if (outbound > 0 && now >= nextOut) {
        particles.push({ kind: 'out', path: Math.floor(Math.random() * outflows.length), born: now, life: 3600 + Math.random() * 1400 })
        nextOut = now + gap(outbound)
      }
    }
    const loop = (now) => {
      if (visible && !document.hidden) { spawn(now); draw(now) } else last = now
      frame = requestAnimationFrame(loop)
    }
    const resize = () => {
      const bounds = canvas.getBoundingClientRect()
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, bounds.width); height = Math.max(1, bounds.height)
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      draw(performance.now())
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    // Nothing is drawn while the hero is scrolled out of view.
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting })
    intersection.observe(canvas)
    // Reduced motion keeps the diagram and drops the moving dots; a slow redraw
    // still picks up each data refresh.
    if (reducedMotion) timer = setInterval(() => draw(performance.now()), 1000)
    else frame = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(frame); clearInterval(timer); resizeObserver.disconnect(); intersection.disconnect() }
    // Built once. Every figure the drawing reads comes from `figures`.
  }, [])

  return <canvas ref={canvasRef} className="flowCanvas" role="img" aria-label={`${money(selectedTvl)} selected TVL, normalized against ${money(totalTvl)} across all protocols`} />
}

// Module scope, not component state. App swaps whole trees when the route
// changes, so PrivacyHome unmounts the moment /analytics opens and anything it
// held in useState is discarded - which is why returning home used to show
// "Loading" again for numbers the browser had already fetched. Keeping the
// summary out here means a remount renders what is already known, and however
// many components subscribe, they share one request and one poll.
const POOL_SUMMARY_TTL = 30_000
const poolSummary = { state: { loading: true, pools: [], error: '' }, listeners: new Set(), fetchedAt: 0, timer: null, inflight: null }

function loadPoolSummary() {
  if (poolSummary.inflight) return poolSummary.inflight
  const publish = (state) => {
    poolSummary.state = state
    poolSummary.fetchedAt = Date.now()
    for (const listener of poolSummary.listeners) listener()
  }
  poolSummary.inflight = fetch('/api/summary')
    .then(async (response) => {
      if (!response.ok) throw new Error('Pool summary request failed')
      const result = await response.json()
      publish({ loading: false, pools: result.pools || [], error: '' })
    })
    // A refresh that fails keeps the figures already on screen; only the first
    // attempt has nothing better to show, and it shows zeroes rather than a
    // permanent "Loading".
    .catch((error) => publish({ ...poolSummary.state, loading: false, error: error.message }))
    .finally(() => { poolSummary.inflight = null })
  return poolSummary.inflight
}

function subscribePoolSummary(listener) {
  poolSummary.listeners.add(listener)
  if (!poolSummary.timer) poolSummary.timer = setInterval(loadPoolSummary, POOL_SUMMARY_TTL)
  return () => {
    poolSummary.listeners.delete(listener)
    // Nothing is watching, so stop polling until something is again.
    if (!poolSummary.listeners.size) { clearInterval(poolSummary.timer); poolSummary.timer = null }
  }
}

// Pool chips and protocol tabs both rank by live TVL, biggest first. Until the
// summary lands every pool reads 0 and the sort is stable, so the manifest
// order shows through instead of an empty row.
function sortByTvl(ids, pools) {
  const tvl = (id) => pools.find((pool) => pool.protocol === id)?.tvl || 0
  return [...ids].sort((first, second) => tvl(second) - tvl(first))
}

function usePoolSummary() {
  const state = useSyncExternalStore(subscribePoolSummary, () => poolSummary.state)
  useEffect(() => { if (Date.now() - poolSummary.fetchedAt > POOL_SUMMARY_TTL) loadPoolSummary() }, [])
  return state
}

function LiquidityUniverse() {
  // /api/summary already values every pool in USD, so nothing is derived here
  // beyond adding up the pools the visitor has selected.
  const summary = usePoolSummary()
  const [selectedPools, setSelectedPools] = useState(SOLANA_POOL_IDS)

  const included = summary.pools.filter((pool) => selectedPools.includes(pool.protocol))
  const totalTvl = summary.pools.reduce((sum, pool) => sum + pool.tvl, 0)
  const selectedTvl = included.reduce((sum, pool) => sum + pool.tvl, 0)
  const inflow = included.reduce((sum, pool) => sum + pool.inflow, 0); const outflow = included.reduce((sum, pool) => sum + pool.outflow, 0)
  const inflowEvents = included.reduce((sum, pool) => sum + pool.inflowEvents, 0); const outflowEvents = included.reduce((sum, pool) => sum + pool.outflowEvents, 0)
  const togglePool = (id) => setSelectedPools((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const poolButton = (id) => { const pool = summary.pools.find((item) => item.protocol === id); const active = selectedPools.includes(id); return <button type="button" className={active ? 'selected' : ''} aria-pressed={active} onClick={() => togglePool(id)} key={id}><ProtocolLogo protocol={id} name={PROTOCOLS[id].name} /><span>{PROTOCOLS[id].name}<small>{summary.loading ? 'Loading…' : money(pool?.tvl || 0)}</small></span><i /></button> }
  return <section className="liquidityUniverse" aria-label="Privacy pool liquidity and capital flow">
    <div className="universeCopy"><p className="eyebrow">Live private liquidity</p><h2>Funds enter publicly, and leave without a trace</h2><p>A deposit into a privacy pool is visible on-chain. What leaves it later is not linkable back to it.</p><div className="universeLegend"><span className="in"><i /> Inflow {money(inflow)}</span><span className="out"><i /> Withdrawals {money(outflow)}</span></div><div className="normalization">Pool area is scaled against all protocols <b>{money(totalTvl)}</b></div></div>
    <div className="liquidityVisual">
      <LiquidityFlow selectedTvl={selectedTvl} totalTvl={totalTvl} inflowEvents={inflowEvents} outflowEvents={outflowEvents} />
      <div className="tvlReadout"><span>TVL</span><strong>{summary.loading ? 'Loading…' : money(selectedTvl)}</strong><small>{included.length ? included.map((pool) => pool.name).join(' + ') : 'No pools selected'}</small></div>
    </div>
    <div className="poolSelector"><div className="poolGroup"><small>Solana native</small><div>{sortByTvl(SOLANA_POOL_IDS, summary.pools).map(poolButton)}</div></div><div className="poolGroup others"><small>Other chains</small><div>{sortByTvl(OTHER_POOL_IDS, summary.pools).map(poolButton)}</div></div></div>
  </section>
}

function ProtocolDashboard({ protocol, selectedEstimate, onSelectProtocol, onLaunchApp }) {
  const poolSizes = usePoolSummary()
  const [range, setRange] = useState('30D')
  const [token, setToken] = useState('USDC')
  const [analytics, setAnalytics] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      try {
        const response = await fetch(`/api/analytics?protocol=${protocol}&interval=${range.toLowerCase()}`, { signal: controller.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Analytics request failed')
        setAnalytics(result); setError('')
      } catch (requestError) { if (requestError.name !== 'AbortError') setError(requestError.message) }
      finally { setLoading(false) }
    }
    load(); const timer = setInterval(load, 30_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [protocol, range])

  const data = useMemo(() => analytics.buckets.map((bucket) => ({ ...bucket, name: bucketLabel(bucket.timestamp, range) })), [analytics.buckets, range])
  const state = analytics.poolState || EMPTY.poolState
  const activity = analytics.activity || EMPTY.activity
  const meta = PROTOCOLS[protocol]
  const isBackfilling = analytics.coverage && !analytics.coverage.complete
  const indexState = loading ? 'Loading' : error ? 'Error' : isBackfilling ? 'Partial' : 'Ready'
  // Muted amber marks one bar per histogram: the most common flow size, and the
  // hour it is now, so the current point in the daily cycle is readable.
  const amountBuckets = activity.amountDistribution || []
  const hourBuckets = activity.timeDistribution || []
  const peakCount = Math.max(0, ...amountBuckets.map((bucket) => bucket.count))
  const utcHour = new Date().getUTCHours()

  return <div className="protocolPage">
    <header className="analyticsHeader"><h1>Analytics database</h1><div className="analyticsActions"><a className="ghost launchApp" href="/" onClick={onLaunchApp}>Launch app <ArrowUpRight /></a></div></header>
    <LiquidityUniverse />
    <div className="analyticsProtocolTabs" aria-label="Analytics project">{sortByTvl(Object.keys(PROTOCOLS), poolSizes.pools).map((id) => <button type="button" className={protocol === id ? 'on' : ''} onClick={() => onSelectProtocol(id)} key={id}><ProtocolLogo protocol={id} name={PROTOCOLS[id].name} /><span>{PROTOCOLS[id].name}</span></button>)}</div>
    <section className={`notice ${error ? 'error' : ''}`}>{error && <CircleAlert />}<b className={`indexState ${indexState.toLowerCase()}`}>{indexState}</b><span>{error || `Reading ${meta.name} data from the analytics database`}</span><em>{analytics.indexedAt ? `Indexed ${new Date(analytics.indexedAt * 1000).toLocaleString()}` : 'Run the backend indexer to update'}</em></section>
    <EstimateAnalytics estimate={selectedEstimate} />

    <div className="sectionTitle"><h2>Current balances</h2><strong>{money(state.totalUsd)} TVL</strong></div>
    <section className="poolGrid">{ASSETS.map((asset) => <Metric key={asset} label={`${asset} balance`} value={`${compact(state.balances?.[asset], asset === 'SOL' ? 4 : 2)} ${asset}`} note={money(state.usd?.[asset])} />)}</section>

    <section className="panel chartPanel">
      <div className="panelHead"><div><h2>External flow</h2><p>{token} pool movements</p></div><div className="controls"><div className="tokenTabs">{ASSETS.map((item) => <button className={token === item ? 'on' : ''} onClick={() => setToken(item)} key={item}>{item}</button>)}</div><div className="ranges">{['90D','30D','1D','6H','1H'].map((item) => <button className={range === item ? 'on' : ''} onClick={() => setRange(item)} key={item}>{item}</button>)}</div></div></div>
      <div className="flowSummary">{FLOW_TYPES.map(([key, label, color]) => <div key={key}><i style={{ background: color }} /><span>{label}</span><b>{compact(analytics.externalFlows?.[key]?.[token], token === 'SOL' ? 4 : 2)} {token}</b></div>)}<small>{WINDOW_LABELS[range]}</small></div>
      <div className="chart"><ResponsiveContainer><AreaChart data={data}><CartesianGrid vertical={false} stroke="#1A1A1A" /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill:'#6E6E6E', fontSize:11 }} interval={range === '90D' ? 14 : range === '30D' ? 4 : 3} /><YAxis yAxisId="flow" axisLine={false} tickLine={false} tick={{ fill:'#6E6E6E', fontSize:11 }} tickFormatter={compact} width={64} /><YAxis yAxisId="pool" orientation="right" axisLine={false} tickLine={false} tick={{ fill:'var(--accent-muted)', fontSize:11 }} tickFormatter={compact} width={64} /><Tooltip content={<FlowTooltip token={token} />} />{FLOW_TYPES.map(([key, label, color, suffix, dash]) => <Area key={key} yAxisId="flow" type="monotone" dataKey={`${token}${suffix}`} name={label} stroke={color} strokeDasharray={dash} fill="transparent" strokeWidth={key === 'deposits' ? 1.75 : 1.4} />)}<Line yAxisId="pool" type="monotone" dataKey={`${token}Pool`} name="Pool balance" stroke="var(--accent)" strokeWidth={2} dot={false} /></AreaChart></ResponsiveContainer></div>
    </section>

    <div className="sectionTitle activityTitle"><h2>Behavior inside this window</h2><span>{analytics.flowMethod}</span></div>
    <section className="activityMetrics"><Metric label="Transactions" value={compact(activity.txCount, 0)} /><Metric label="Unique amounts" value={compact(activity.uniqueAmounts, 0)} /><Metric label="1h recent volume" value={formatMetricMoney(activity.recentVolume?.oneHourUsd)} /><Metric label="24h recent volume" value={formatMetricMoney(activity.recentVolume?.twentyFourHoursUsd)} /></section>
    <div className="analyticsRow">
      <section className="panel distribution"><div className="panelHead"><div><h2>Amount distribution</h2><p>External flows by USD size</p></div></div>{activity.usdValuationComplete === false ? <div className="empty smallEmpty">Stored USD prices are unavailable for part of this window.</div> : <div className="smallChart"><ResponsiveContainer><BarChart data={amountBuckets}><CartesianGrid vertical={false} stroke="#1A1A1A" /><XAxis dataKey="label" tick={{ fill:'#6E6E6E', fontSize:10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill:'#6E6E6E', fontSize:10 }} axisLine={false} tickLine={false} /><Bar dataKey="count" radius={[2,2,0,0]}>{amountBuckets.map((bucket) => <Cell key={bucket.label} fill={bucket.count === peakCount ? 'var(--accent-muted)' : '#4A4A4A'} />)}</Bar></BarChart></ResponsiveContainer></div>}</section>
      <section className="panel distribution"><div className="panelHead"><div><h2>Time distribution</h2><p>Transactions by UTC hour, current hour marked</p></div></div><div className="smallChart"><ResponsiveContainer><BarChart data={hourBuckets}><XAxis dataKey="hour" tick={{ fill:'#6E6E6E', fontSize:10 }} axisLine={false} tickLine={false} interval={3} /><YAxis hide /><Bar dataKey="count" radius={[2,2,0,0]}>{hourBuckets.map((bucket) => <Cell key={bucket.hour} fill={bucket.hour === utcHour ? 'var(--accent-muted)' : '#4A4A4A'} />)}</Bar></BarChart></ResponsiveContainer></div></section>
    </div>

    <section className="panel recent"><div className="panelHead"><div><h2>Recent activity</h2><p>Latest external flows</p></div><a className="ghost" href={analytics.explorerAccount || `https://solscan.io/account/${analytics.programId || ''}`} target="_blank" rel="noreferrer">{analytics.chain === 'arbitrum' ? 'Arbiscan' : 'Solscan'} <ArrowUpRight /></a></div><div className="table"><div className="tr th"><span>Time</span><span>Participant</span><span>Type</span><span>Amount</span><span>Transaction</span></div>{!analytics.recent.length && <div className="empty">{loading ? 'Loading stored data…' : 'No external flows in this window'}</div>}{analytics.recent.slice(0, 7).map((flow) => <div className="tr" key={flow.id}><span>{age(flow.timestamp)}</span><code>{short(flow.participant)}</code><span className={`direction ${flow.flowType}`}><i />{flow.flowType.replace('_', ' ')}</span><b>{compact(flow.amount, flow.asset === 'SOL' ? 4 : 2)} {flow.asset}{flow.counterAsset ? ` → ${flow.counterAsset}` : ''}</b><a className="tx" href={`${analytics.explorerTransaction || 'https://solscan.io/tx/'}${flow.signature}`} target="_blank" rel="noreferrer">{short(flow.signature)} <ExternalLink /></a></div>)}</div></section>
    <footer>SQLite analytics <span>•</span> Indexed by the separate {analytics.indexedVia === 'alchemy' ? 'Alchemy / Arbitrum' : 'Helius / Solana'} backend <span>•</span> {analytics.feePolicy?.label} ({analytics.feePolicy?.detail})</footer>
  </div>
}

function PaymentLinksPage({ walletSession }) {
  const summary = usePoolSummary()
  return <PaymentLinks summary={summary} walletSession={walletSession} />
}

// Opens when Connect finds more than one installed wallet.
function WalletPicker({ picker }) {
  const dialog = useRef(null)
  useEffect(() => { picker ? dialog.current?.showModal() : dialog.current?.close() }, [picker])
  return <dialog className="paymentDialog walletPicker" ref={dialog} aria-labelledby="walletPickerTitle" onClose={() => picker?.resolve(null)}>
    {picker && <>
      <h3 id="walletPickerTitle">Connect a wallet</h3>
      <div className="walletChoices">{picker.options.map((option) => <button key={option.name} className="ghost" type="button" onClick={() => picker.resolve(option)}>
        {option.icon && <img src={option.icon} alt="" />}{option.name}
      </button>)}</div>
      <div className="paymentDialogActions"><button className="ghost" type="button" onClick={() => dialog.current.close()}>Cancel</button></div>
    </>}
  </dialog>
}

// Mounted only while the drawer is open, so balances and prices load on demand.
function WalletPanel({ wallet, onClose, onDisconnect, onPaymentLinks }) {
  const prices = useUsdPrices(ASSETS)
  // A missing asset is still loading; null means its balance could not be read.
  const [balances, setBalances] = useState({})
  const [copied, setCopied] = useState(false)
  const { pools, status: scanStatus, reveal } = useShieldedPools(wallet)
  // Paid payment links not collected yet; locked without a saved merchant credential.
  const [links, setLinks] = useState({ state: 'loading' })

  useEffect(() => {
    let live = true
    import('./wallet-balance.js').then(({ getWalletAssetBalance }) => ASSETS.forEach((asset) => getWalletAssetBalance(wallet.address, asset)
      .then((balance) => Number(rawTokenText(balance.raw, asset)), () => null)
      .then((value) => { if (live) setBalances((current) => ({ ...current, [asset]: value })) })))
    return () => { live = false }
  }, [wallet.address])

  useEffect(() => {
    const controller = new AbortController()
    setLinks({ state: 'loading' })
    uncollectedTotals(wallet.address, controller.signal).then(
      (totals) => { if (!controller.signal.aborted) setLinks(totals ? { state: 'ready', balances: totals } : { state: 'locked' }) },
      () => { if (!controller.signal.aborted) setLinks({ state: 'error' }) })
    return () => controller.abort()
  }, [wallet.address])

  const shielded = { ...pools, links }
  const locked = SHIELDED_POOL_IDS.filter((id) => pools[id]?.state === 'locked')
  const failed = SHIELDED_POOL_IDS.filter((id) => pools[id]?.state === 'error')
  const retryable = [...locked, ...failed]
  const scanning = Object.values(shielded).some((entry) => entry.state === 'loading')
  const shieldedRows = ASSETS.map((asset) => {
    const sources = Object.entries(shielded).filter(([, entry]) => entry.balances?.[asset] > 0n)
    const raw = sources.reduce((sum, [, entry]) => sum + BigInt(entry.balances[asset]), 0n)
    return { asset, amount: Number(rawTokenText(raw, asset)), sources: sources.map(([source]) => source) }
  }).filter((row) => row.amount > 0)
  const uncollected = ASSETS.filter((asset) => shielded.links?.balances?.[asset] > 0n)
    .map((asset) => `${compact(Number(rawTokenText(BigInt(shielded.links.balances[asset]), asset)), 6)} ${asset}`)

  const usdOf = (asset, amount) => amount === 0 ? 0 : amount != null && prices[asset] ? amount * prices[asset] : null
  const loaded = ASSETS.every((asset) => balances[asset] !== undefined)
  const publicRows = ASSETS.filter((asset) => balances[asset] !== 0 && balances[asset] !== undefined)
  const publicValues = ASSETS.map((asset) => usdOf(asset, balances[asset]))
  const publicTotal = loaded && !publicValues.includes(null) ? publicValues.reduce((sum, value) => sum + value, 0) : null
  const shieldedValues = shieldedRows.map((row) => usdOf(row.asset, row.amount))
  const shieldedTotal = shieldedValues.includes(null) ? null : shieldedValues.reduce((sum, value) => sum + value, 0)

  async function copy() {
    try { await navigator.clipboard.writeText(wallet.address); setCopied(true); setTimeout(() => setCopied(false), 1500) }
    catch { /* The full address is in the title and on Solscan. */ }
  }

  return <div className="walletPanel">
    <div className="walletPanelHead">
      {wallet.icon ? <img src={wallet.icon} alt="" /> : <span className="walletIcon"><Wallet /></span>}
      <div><strong>{wallet.name || 'Wallet'}</strong>
        <span className="walletAddress"><code title={wallet.address}>{short(wallet.address)}</code>
          <button type="button" title="Copy address" aria-label={copied ? 'Address copied' : 'Copy address'} onClick={copy}>{copied ? <Check /> : <Copy />}</button>
          <a href={`https://solscan.io/account/${wallet.address}`} target="_blank" rel="noreferrer" title="View on Solscan" aria-label="View on Solscan"><ExternalLink /></a></span></div>
      <button type="button" className="walletPanelClose" aria-label="Close wallet" onClick={onClose}><X /></button>
    </div>

    <div className="walletTotal">
      <p className="eyebrow">Total balance</p>
      <strong>{publicTotal !== null ? money(publicTotal + (shieldedTotal ?? 0)) : loaded ? '—' : <span className="shimmerText">$0.00</span>}</strong>
      <div className="walletSplit">
        <span><i className="public" />Public {publicTotal !== null ? money(publicTotal) : loaded ? '—' : '…'}</span>
        <span><i className="shielded" />Shielded {scanning && !shieldedRows.length ? '…' : shieldedTotal === null ? '—' : money(shieldedTotal)}</span>
      </div>
    </div>

    <section className="walletSection">
      <h4>Wallet</h4>
      {!loaded && !publicRows.length ? <div className="walletSkeleton"><i /><i /></div>
        : publicRows.length ? <ul className="walletTokens">{publicRows.map((asset) => <li key={asset}><AssetLogo asset={asset} />
          <span>{asset}<small>{balances[asset] === null ? 'Unavailable' : compact(balances[asset], 6)}</small></span>
          <b>{usdOf(asset, balances[asset]) === null ? '—' : money(usdOf(asset, balances[asset]))}</b></li>)}</ul>
          : <p className="walletEmpty">No SOL, USDC or USDT in this wallet.</p>}
    </section>

    <section className="walletSection">
      <h4>Shielded{scanning && <span className="walletScanning" aria-label="Reading shielded balances" />}
        {retryable.length > 0 && !scanning && <button type="button" className="walletReveal" onClick={reveal}>
          {locked.length ? 'Reveal' : 'Retry'}</button>}</h4>
      {shieldedRows.length > 0 && <ul className="walletTokens">{shieldedRows.map((row) => <li key={row.asset}><AssetLogo asset={row.asset} />
        <span>{row.asset}<small>{compact(row.amount, 6)} · {row.sources.map(sourceName).join(', ')}</small></span>
        <b>{usdOf(row.asset, row.amount) === null ? '—' : money(usdOf(row.asset, row.amount))}</b></li>)}</ul>}
      {scanStatus && <p className="walletStatus">{scanStatus}</p>}
      {!scanning && locked.length > 0 && <p className="walletEmpty">Reveal signs a message to read your {locked.map(sourceName).join(' and ')} balance. Nothing is sent on-chain.</p>}
      {!scanning && failed.length > 0 && <p className="walletEmpty">Could not read your {failed.map(sourceName).join(' and ')} balance.</p>}
      {!scanning && !shieldedRows.length && !retryable.length && <p className="walletEmpty">No shielded funds.</p>}
      {uncollected.length > 0 && <a className="walletCollect" href="/payment-links" onClick={onPaymentLinks}>
        <span><b>{uncollected.join(' + ')}</b> from payment links is ready to collect</span><ArrowRight /></a>}
    </section>

    <button type="button" className="walletDisconnect" onClick={onDisconnect}><LogOut />Disconnect</button>
  </div>
}

// The wallet's one control on every page but analytics: connect, see balances, disconnect.
function WalletMenu({ walletSession, onPaymentLinks }) {
  const { wallet, connecting, connectWallet, disconnectWallet } = walletSession
  const drawer = useRef(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { open && wallet ? drawer.current?.showModal() : drawer.current?.close() }, [open, wallet])
  useEffect(() => {
    if (!error) return undefined
    const timer = setTimeout(() => setError(''), 6000)
    return () => clearTimeout(timer)
  }, [error])
  async function press() {
    setError('')
    if (wallet) return setOpen(true)
    try { await connectWallet() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  function disconnect() {
    // The merchant credential is kept in this browser until Disconnect.
    forgetAccess(wallet.address)
    setOpen(false)
    disconnectWallet()
  }
  return <div className="walletMenu">
    <button type="button" className={`walletButton${wallet ? ' connected' : ''}`} aria-haspopup={wallet ? 'dialog' : undefined} disabled={connecting} onClick={press}>
      {wallet ? <>{wallet.icon ? <img src={wallet.icon} alt="" /> : <Wallet />}<span>{short(wallet.address)}</span><ChevronDown /></>
        : <><Wallet /><span>{connecting ? 'Connecting…' : 'Connect wallet'}</span></>}
    </button>
    {error && <p className="walletMenuError" role="alert">{error}</p>}
    <dialog className="walletDrawer" ref={drawer} aria-label="Wallet" onClose={() => setOpen(false)}
      onClick={(event) => { if (event.target === event.currentTarget) drawer.current.close() }}>
      {open && wallet && <WalletPanel wallet={wallet} onClose={() => drawer.current.close()} onDisconnect={disconnect}
        onPaymentLinks={(event) => { drawer.current.close(); onPaymentLinks(event) }} />}
    </dialog>
  </div>
}

function App() {
  const walletSession = useWalletSession()
  const walletPicker = <WalletPicker picker={walletSession.picker} />
  const getPage = () => window.location.pathname.startsWith('/pay/') ? 'checkout' : ({ '/analytics': 'analytics', '/payment-links': 'payments' }[window.location.pathname.replace(/\/+$/, '')] || 'home')
  const [view, setView] = useState(getPage)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [protocol, setProtocol] = useState('privacycash')
  const [selectedEstimate, setSelectedEstimate] = useState(null)
  useEffect(() => {
    if (getPage() === 'analytics' && window.location.search) window.history.replaceState({}, '', '/analytics')
    const syncLocation = () => setView(getPage())
    window.addEventListener('popstate', syncLocation)
    return () => window.removeEventListener('popstate', syncLocation)
  }, [])
  useEffect(() => {
    const isAnalytics = view === 'analytics'
    if (view === 'checkout') {
      document.title = 'Private checkout - DarkSol'
      document.querySelector('meta[name="description"]')?.setAttribute('content', 'Pay a private DarkSol invoice on Solana.')
      return
    }
    document.title = isAnalytics ? 'Analytics – DarkSol' : view === 'payments' ? 'Payment links – DarkSol' : 'DarkSol'
    const description = isAnalytics
      ? 'On-chain privacy analytics for Solana and Arbitrum private routing protocols.'
      : view === 'payments' ? 'Create private payment links and track your invoices with DarkSol.' : 'DarkSol private routing and on-chain privacy analytics.'
    document.querySelector('meta[name="description"]')?.setAttribute('content', description)
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', `https://darksol.app${isAnalytics ? '/analytics' : view === 'payments' ? '/payment-links' : '/'}`)
  }, [view])
  useEffect(() => {
    if (!drawerOpen) return
    const closeOnEscape = (event) => { if (event.key === 'Escape') setDrawerOpen(false) }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', closeOnEscape) }
  }, [drawerOpen])
  function navigate(path) { window.history.pushState({}, '', path); setView(getPage()) }
  function openAnalytics(id = protocol) { setProtocol(id); setSelectedEstimate(null); if (view !== 'analytics') navigate('/analytics') }
  function closeDrawer() { setDrawerOpen(false) }
  function launchApp(event) { event.preventDefault(); closeDrawer(); navigate('/') }
  function openHome(event) { event.preventDefault(); closeDrawer(); navigate('/') }
  function openPaymentLinks(event) { event.preventDefault(); closeDrawer(); navigate('/payment-links') }
  function openAnalyticsPage(event) { event.preventDefault(); closeDrawer(); openAnalytics(protocol) }
  const walletMenu = <WalletMenu walletSession={walletSession} onPaymentLinks={openPaymentLinks} />
  const mobileNav = <>
    <MobileBar onOpen={() => setDrawerOpen(true)} />
    <Sidebar open={sidebarOpen} view={view} onToggle={() => setSidebarOpen(!sidebarOpen)} onHome={openHome} onPaymentLinks={openPaymentLinks} onAnalytics={openAnalyticsPage} onClose={closeDrawer} />
    {drawerOpen && <button className="drawerScrim" type="button" aria-label="Close navigation" onClick={closeDrawer} />}
  </>
  if (view === 'analytics') return <div className={`analyticsApp${drawerOpen ? ' drawerOpen' : ''}`}>{mobileNav}<main className="analyticsMain"><ProtocolDashboard protocol={protocol} selectedEstimate={selectedEstimate} onSelectProtocol={openAnalytics} onLaunchApp={launchApp} /><footer className="socialFoot">{xLink}</footer></main>{walletPicker}</div>
  if (view === 'checkout') return <div className={`app ${sidebarOpen ? 'sidebarOpen' : 'sidebarClosed'}${drawerOpen ? ' drawerOpen' : ''}`}>{mobileNav}<main><PaymentCheckout key={window.location.pathname} paymentId={window.location.pathname.split('/')[2] || ''} walletSession={walletSession} /></main>{walletMenu}{walletPicker}</div>
  return <div className={`app ${sidebarOpen ? 'sidebarOpen' : 'sidebarClosed'}${drawerOpen ? ' drawerOpen' : ''}`}>{mobileNav}<main>{view === 'payments' ? <PaymentLinksPage walletSession={walletSession} /> : <PrivacyHome walletSession={walletSession} />}</main>{walletMenu}{walletPicker}</div>
}

createRoot(document.getElementById('root')).render(<App />)
