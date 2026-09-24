import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowLeftRight, ArrowRight, ArrowUpRight, CheckCircle2, ChevronDown, Clock3, Database, ExternalLink, Home, Link2, LogOut, Menu, Plus, ShieldCheck, ShieldX, Wallet, X } from 'lucide-react'
import './styles.css'
import PaymentLinks from './payment-links.jsx'
import PaymentCheckout from './payment-checkout.jsx'
import { useWalletSession } from './wallet-session.js'
import { sanitizeAmount, sanitizeSolanaAddress, validateTransfer } from './transfer-validation.js'
import { swapEligibility } from './swap-routes.js'
import { usdText, useUsdPrices } from './token-price.js'
import { BRIDGE_CHAINS, bridgeChain, bridgeEligibility, sanitizeBridgeAddress, validateBridgeAddress } from './bridge-routes.js'
import {
  LOGOS as PROTOCOL_LOGOS, PROTOCOLS, PROVIDER_CAPABILITIES, listProtocols, resolveProtocolId,
} from '../protocols/registry.js'
import { TOKEN_DECIMALS } from '../protocols/shared/units.js'
import { loadBrowserAdapter } from '../protocols/browser.js'
import { DELAY_MINUTES, cancelScheduled, loadScheduled, saveScheduled, scheduleWithdrawal, scheduledStatus } from './scheduled-send.js'

// The pool selector used to hardcode which ids sit under which heading, and the
// bridge picker named privacycash directly. Both follow the manifests now.
const SOLANA_POOL_IDS = listProtocols({ chain: 'solana' }).map(({ id }) => id)
const OTHER_POOL_IDS = listProtocols().filter(({ chain }) => chain !== 'solana').map(({ id }) => id)
const BRIDGE_PROTOCOL_ID = listProtocols({ capability: 'bridge' })[0]?.id || null
const SINGLE_RECIPIENT_IDS = listProtocols().filter(({ recipients }) => !recipients.multi).map(({ id }) => id)

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
const short = (value) => value?.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value || 'unknown'
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const pickNumber = (...values) => values.map(finite).find((value) => value !== null) ?? null
const scoreText = (value) => finite(value) === null ? '—' : `${Math.round(Number(value))}/100`
const bandClass = (value) => String(value || '').toLowerCase().replace(/\s+/g, '-')
const displayBand = (value) => value ? String(value).replaceAll('_', ' ').toUpperCase() : 'UNAVAILABLE'
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

function normalizeEstimate(item, strategy, inputAsset, outputAsset, bridge, delayed = false) {
  const protocol = providerKey(item)
  const configured = PROVIDER_CAPABILITIES[protocol] || {}
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
    available: item?.available !== false && item?.eligible !== false && !capabilityBlocked && !routeBlocked && !deadlineBlocked,
    unavailableReason: capabilityBlocked
      ? 'Multiple-recipient withdrawal is not currently supported by this provider.'
      : deadlineBlocked ? 'A delivery deadline is not supported by this provider.'
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
  return <div className="receiverResults"><p>RECEIVER PRIVACY</p>{receivers.map((receiver, index) => {
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

function EclipseLogo() {
  return <div className="brandLockup" aria-label="DarkSol">
    <svg className="eclipseMark" viewBox="0 0 48 48" aria-hidden="true">
      <defs><radialGradient id="eclipseCorona"><stop offset="52%" stopColor="#0A0A0A" /><stop offset="66%" stopColor="var(--accent)" stopOpacity=".95" /><stop offset="78%" stopColor="var(--accent)" stopOpacity=".16" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></radialGradient></defs>
      <circle cx="24" cy="24" r="22" fill="url(#eclipseCorona)" />
      <circle cx="24" cy="24" r="14.5" fill="#080808" stroke="#F0F0F0" strokeWidth=".8" />
    </svg>
    <span>DARKSOL<small>PRIVATE ROUTING</small></span>
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
        <div><p className="eyebrow">WHY THIS ROUTE</p><h3>{estimate.protocolName} ranks first{planAmount === null ? '' : ` for ${compact(planAmount, 6)} ${asset}`}</h3></div>
        <div className={`privacy ${bandClass(estimate.band)}`}><span>ESTIMATED PRIVACY</span><strong>{displayBand(estimate.band)}</strong><em>{scoreText(estimate.score)}</em></div>
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
      {alternatives.length > 0 && <div className="routeAlternatives"><p>COMPARED AGAINST</p>{alternatives.map((item) => <div key={item.protocol}><ProtocolLogo protocol={item.protocol} name={item.protocolName} /><span>{item.protocolName}</span>{item.available ? <b>{scoreText(item.score)} <small>{displayBand(item.band)}</small></b> : <small className="routeUnavailable">{item.unavailableReason || 'Unavailable for this transfer'}</small>}</div>)}</div>}
      <p className="estimateDisclaimer">This is an estimate, not a guarantee of anonymity.</p>
    </div>}
  </section>
}

function PrivacyHome({ walletSession }) {
  const { wallet, connecting, connectWallet: connectSession, disconnectWallet: disconnectSession } = walletSession
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
  // A delayed delivery outlives this page: it is reloaded from localStorage.
  const [scheduled, setScheduled] = useState(loadScheduled)
  const requestSequence = useRef(0)
  const balanceSequence = useRef(0)
  const receiverCount = receiverAmounts.length
  const strategy = receiverCount > 1 ? 'multiple' : 'single'
  const isBridge = destinationAsset === BRIDGE_OPTION
  const isSwap = !isBridge && asset !== destinationAsset
  const selectedBridgeChain = bridgeChain(bridgeChainId)
  const bridgeRoute = isBridge ? bridgeEligibility(BRIDGE_PROTOCOL_ID, asset, bridgeChainId, bridgeToken) : null
  // Only a plain send to one recipient can be proved ahead and delivered later.
  const deadlineMinutes = !isSwap && !isBridge && receiverCount === 1 ? delay : 0
  const delayLabel = receiverCount > 1 ? 'Delay supports one recipient' : deadlineMinutes ? `Arrives within ${deadlineMinutes} min` : 'Delay'

  const total = finite(amount)
  const totalRaw = rawTokenAmount(amount, asset)
  const receiverRaws = receiverAmounts.map((value) => rawTokenAmount(value, asset))
  const receiverTotalRaw = receiverRaws.every((value) => value !== null) ? receiverRaws.reduce((sum, value) => sum + value, 0n) : null
  const receiverTotal = receiverTotalRaw === null ? null : Number(rawTokenText(receiverTotalRaw, asset))
  const remainingRaw = totalRaw === null || receiverTotalRaw === null ? null : totalRaw - receiverTotalRaw
  const remaining = remainingRaw === null ? null : Number(rawTokenText(remainingRaw < 0n ? -remainingRaw : remainingRaw, asset)) * (remainingRaw < 0n ? -1 : 1)
  const amountsMatch = totalRaw !== null && receiverTotalRaw === totalRaw
  const receiversValid = receiverRaws.every((value) => value !== null && value > 0n) && amountsMatch
  const formValid = totalRaw !== null && totalRaw > 0n && receiversValid
  const selectedTarget = PRIVACY_TARGETS.find((target) => target.value === privacyTarget) || PRIVACY_TARGETS[0]
  const transferValidation = validateTransfer({
    asset,
    amount,
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
      amount,
      strategy,
      receiverAmounts: strategy === 'multiple' ? receiverAmounts : [amount],
      privacyTarget,
    })
  }

  useEffect(() => {
    requestSequence.current += 1
    setError('')
    if (!formValid) { setLoading(false); return undefined }
    const controller = new AbortController()
    setLoading(true)
    const timeout = setTimeout(() => requestPlan({
      asset,
      destinationAsset: plannedDestinationAsset,
      amount,
      strategy,
      receiverAmounts: strategy === 'multiple' ? receiverAmounts : [amount],
      privacyTarget,
    }, controller.signal), 350)
    return () => { clearTimeout(timeout); controller.abort() }
  }, [asset, plannedDestinationAsset, amount, strategy, receiverAmounts, privacyTarget, formValid])

  function splitEvenly(count = receiverCount) {
    if (totalRaw === null || totalRaw <= 0n) return setReceiverAmounts(Array.from({ length: count }, () => ''))
    const shareRaw = totalRaw / BigInt(count)
    const next = Array.from({ length: count }, (_, index) => rawTokenText(index === count - 1 ? totalRaw - shareRaw * BigInt(count - 1) : shareRaw, asset))
    setReceiverAmounts(next); setDirty(true)
  }

  function useMaximumBalance() {
    const raw = walletBalance?.spendableRaw
    if (raw === undefined || raw <= 0n) return
    const nextAmount = rawTokenText(raw, asset)
    const shareRaw = raw / BigInt(receiverCount)
    const nextReceivers = Array.from({ length: receiverCount }, (_, index) => rawTokenText(index === receiverCount - 1 ? raw - shareRaw * BigInt(receiverCount - 1) : shareRaw, asset))
    setAmount(nextAmount); setReceiverAmounts(nextReceivers); setDirty(true); setReceipt(null)
  }

  function addReceiver() {
    splitEvenly(receiverCount + 1)
    setRecipientAddresses((current) => [...current, ''])
  }

  function removeReceiver(index) {
    if (receiverCount === 1) return
    const next = receiverAmounts.filter((_, receiverIndex) => receiverIndex !== index)
    const nextRaws = next.map((value) => rawTokenAmount(value, asset))
    if (totalRaw !== null && nextRaws.every((value) => value !== null)) {
      const nextTotal = nextRaws.reduce((sum, value) => sum + value, 0n)
      if (totalRaw >= nextTotal) next[next.length - 1] = rawTokenText(nextRaws[nextRaws.length - 1] + totalRaw - nextTotal, asset)
    }
    setReceiverAmounts(next); setDirty(true)
    setRecipientAddresses((current) => current.filter((_, receiverIndex) => receiverIndex !== index))
  }

  async function connectWallet() {
    setSendError('')
    try { await connectSession() }
    catch (error) { setSendError(error instanceof Error ? error.message : String(error)) }
  }

  async function disconnectWallet() {
    setReceipt(null); setSendError(''); setSendStatus(''); setSendAttempted(false)
    await disconnectSession()
  }

  async function sendTransfer() {
    setSendAttempted(true); setSendError('')
    if (receipt?.depositSignature) return setSendError('This deposit was already submitted. Do not send it again.')
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
        totalBaseUnits: activeValidation.total.baseUnits,
        delayMinutes: kind === 'send' ? deadlineMinutes : 0,
        onStatus: setSendStatus,
      })
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
      setReceipt(result); setSendStatus('Sent')
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
    const normalized = (comparison.rankings || []).map((item) => normalizeEstimate(item, strategy, asset, destinationAsset, bridge, deadlineMinutes > 0))
    if (strategy === 'multiple') {
      for (const id of SINGLE_RECIPIENT_IDS) {
        if (normalized.some((item) => item.protocol === id)) continue
        normalized.push(normalizeEstimate({ protocol: id, protocolName: PROTOCOLS[id].name, available: false, unavailableReason: 'Multiple-recipient withdrawal is not currently supported by this provider.', capabilities: PROVIDER_CAPABILITIES[id] }, strategy, asset, destinationAsset, bridge))
      }
    }
    return normalized
  }, [comparison, strategy, asset, destinationAsset, isBridge, bridgeChainId, bridgeToken, deadlineMinutes])
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
  // same pool stays off limits until the delivery lands or is dismissed.
  const scheduledBlocks = Boolean(scheduled) && scheduled.status !== 'sent' && scheduled.protocol === recommended?.protocol && scheduled.asset === asset
  const actionVerb = isBridge ? 'Bridge' : isSwap ? 'Swap' : 'Send'
  const actionProgress = isBridge ? 'Bridging...' : isSwap ? 'Swapping...' : 'Sending...'

  return <div className="homePage">
    <header><h1>{isBridge ? 'Bridge privately' : isSwap ? 'Swap privately' : 'Send privately'}</h1></header>
    <section className="sendCard panel">
      <div className="amountRow">
        <span className="amountUsd">{usdText(amount, prices[asset])}</span>
        <input aria-label="Amount" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(event) => { const nextAmount = sanitizeAmount(event.target.value); setAmount(nextAmount); if (receiverCount === 1) setReceiverAmounts([nextAmount]); setDirty(true); setReceipt(null) }} />
        {wallet && <button type="button" className="walletMax" onClick={useMaximumBalance} disabled={balanceLoading || !walletBalance?.spendableRaw} title={asset === 'SOL' ? 'Network fee reserve already deducted' : 'Use wallet balance'}>MAX {balanceLoading ? '…' : walletBalance ? rawTokenText(walletBalance.spendableRaw, asset) : '—'}</button>}
        <div className="assetPicker">
          <button type="button" aria-haspopup="listbox" aria-expanded={assetMenuOpen} onClick={() => setAssetMenuOpen(!assetMenuOpen)}><AssetLogo asset={asset} /><b>{asset}</b><ChevronDown /></button>
          {assetMenuOpen && <div className="assetMenu" role="listbox">{ASSETS.map((item) => <button type="button" role="option" aria-selected={asset === item} onClick={() => { setAsset(item); setAssetMenuOpen(false); if (item !== destinationAsset && receiverCount > 1) { setReceiverAmounts([amount]); setRecipientAddresses([recipientAddresses[0] || '']) } setDirty(true); setReceipt(null) }} key={item}><AssetLogo asset={item} />{item}</button>)}</div>}
        </div>
      </div>
      <div className="swapDestination">
        <span>{isBridge ? 'BRIDGE TO' : isSwap ? 'SWAP TO' : 'RECEIVE'}</span><ArrowRight />
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
        {receiverAmounts.map((value, index) => <div className={`recipientRow ${totalRaw > 0n && !(recipientAddresses[index] || '').trim() ? 'needsAddress' : ''}`} key={index}><span>{index + 1}</span><div className="recipientFields"><input className="recipientAddress" aria-label={`Receiver ${index + 1} address`} autoComplete="off" spellCheck="false" placeholder={isBridge ? `${selectedBridgeChain?.name} ${bridgeToken} address` : isSwap ? `${destinationAsset} recipient address` : 'Address'} value={recipientAddresses[index] || ''} onChange={(event) => { const next = [...recipientAddresses]; next[index] = isBridge ? sanitizeBridgeAddress(event.target.value) : sanitizeSolanaAddress(event.target.value); setRecipientAddresses(next); setReceipt(null) }} />{isBridge ? <div className="recipientSwapAsset"><small>{selectedBridgeChain?.name?.toUpperCase()}</small><AssetLogo asset={bridgeToken} /><b>{bridgeToken}</b></div> : isSwap ? <div className="recipientSwapAsset"><small>OUTPUT</small><AssetLogo asset={destinationAsset} /><b>{destinationAsset}</b></div> : <div><input className="recipientAmount" aria-label={`Receiver ${index + 1} amount`} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={value} onChange={(event) => { const next = [...receiverAmounts]; next[index] = sanitizeAmount(event.target.value); setReceiverAmounts(next); setDirty(true); setReceipt(null) }} /><b>{asset}</b></div>}</div>{receiverCount > 1 && <button type="button" aria-label={`Remove receiver ${index + 1}`} onClick={() => removeReceiver(index)}><X /></button>}</div>)}
        {!isSwap && !isBridge && <>
          <button type="button" className={`delayControl ${deadlineMinutes ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={delayMenuOpen && receiverCount === 1} aria-disabled={receiverCount > 1} aria-label={delayLabel} data-tooltip={delayLabel} onClick={() => receiverCount === 1 && setDelayMenuOpen(!delayMenuOpen)}>{deadlineMinutes ? `${deadlineMinutes}m` : <Clock3 />}</button>
          {delayMenuOpen && receiverCount === 1 && <div className="delayMenu" role="menu">{[0, ...DELAY_MINUTES].map((minutes) => <button type="button" role="menuitemradio" aria-checked={delay === minutes} key={minutes} onClick={() => { setDelay(minutes); setDelayMenuOpen(false); setReceipt(null) }}>{minutes ? `Within ${minutes} min` : 'Now'}</button>)}</div>}
          <button type="button" className="addReceiver" aria-label="Add receiver" onClick={addReceiver}><Plus /></button>
        </>}
      </div>
      {(sendAttempted || amount) && !activeValidation.valid && <div className="splitStatus">{!isBridge && !receiversValid && remaining !== null ? `${compact(Math.abs(remaining), 9)} ${asset} ${remaining > 0 ? 'left' : 'over'}` : activeValidation.error}</div>}
    </section>
    {error && <section className="notice error"><ShieldX /><span>{error}</span></section>}
    <section className="sendAction panel">
      <div className="bestRoute">{recommended ? <ProtocolLogo protocol={recommended.protocol} name={recommended.protocolName} /> : <span className="routePlaceholder" />}</div>
      <div className="actionArea"><button type="button" onClick={sendTransfer} disabled={sending || connecting || Boolean(wallet && (receipt?.depositSignature || scheduledBlocks || !activeValidation.valid || loading || !recommended || recommended.band === 'NOT PRIVATE' || !browserExecutable))}>{connecting ? 'Connecting…' : sending ? sendStatus || actionProgress : !wallet ? <><Wallet /> Connect wallet</> : loading ? 'Finding route...' : receipt?.depositSignature ? 'Submitted' : scheduledBlocks ? 'Delivery pending' : recommended?.band === 'NOT PRIVATE' ? 'Not private' : !browserExecutable ? 'View route details' : actionVerb} {!sending && wallet && !receipt?.depositSignature && !scheduledBlocks && recommended?.band !== 'NOT PRIVATE' && browserExecutable && <ArrowRight />}</button>{wallet && <div className="walletSession"><small>{short(wallet.address)}</small><button type="button" aria-label="Disconnect wallet" title="Disconnect wallet" onClick={disconnectWallet} disabled={sending}><LogOut /></button></div>}</div>
    </section>
    {recommended && <RouteDetails estimate={recommended} alternatives={alternatives} asset={resultAsset} amount={resultAmount} targetLabel={selectedTarget.label} open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} />}
    {(sendError || receipt) && <section className={`transferResult ${sendError ? 'error' : ''}`}>{sendError ? <ShieldX /> : <CheckCircle2 />}<span>{sendError || (isBridge ? 'Bridge submitted' : isSwap ? 'Swap submitted' : 'Transfer complete')}</span>{receipt && <a href={`https://solscan.io/tx/${receipt.withdrawals.at(-1)?.tx || receipt.depositSignature}`} target="_blank" rel="noreferrer">View transaction <ExternalLink /></a>}</section>}
    {scheduled && <section className="transferResult delivery">{scheduled.status === 'sent' ? <CheckCircle2 /> : <Clock3 />}<span>{scheduled.status === 'pending' ? `Deposit confirmed · arrives by ${new Date(scheduled.sendBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · you can close this page` : DELIVERY_TEXT[scheduled.status]}</span>
      <a href={`https://solscan.io/tx/${scheduled.signature || scheduled.depositSignature}`} target="_blank" rel="noreferrer">{scheduled.signature ? 'View transfer' : 'View deposit'} <ExternalLink /></a>
      {scheduled.status === 'pending' ? <button type="button" onClick={cancelDelivery}>Cancel</button> : scheduled.status !== 'sent' && <button type="button" onClick={deliverNow} disabled={sending}>Send now</button>}
      {scheduled.status !== 'pending' && <button type="button" aria-label="Dismiss" onClick={() => setScheduled(null)} disabled={sending}><X /></button>}</section>}
  </div>
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
    <div className="sectionTitle"><div><p className="eyebrow">PLANNING ESTIMATE</p><h2>Why this transfer received its score</h2></div><span>{plan.amount !== null && plan.amount !== undefined ? `${compact(plan.amount, 6)} ${plan.asset}` : ''}</span></div>
    <div className="estimateOverview panel"><div className={`estimateScore ${bandClass(estimate.band)}`}><span>ESTIMATED PRIVACY</span><strong>{displayBand(estimate.band)}</strong><b>{scoreText(estimate.score)}</b></div><div className="estimateFacts"><div><span>POOL SHARE</span><b>{formatPercent(estimate.poolShare)}</b></div><div><span>SIMILAR-SIZE FLOWS</span><b>{finite(estimate.similarFlowCount) === null ? 'Unavailable' : compact(estimate.similarFlowCount, 0)}</b></div><div><span>{plan.targetLabel || 'TARGET'} WAIT</span><b>{formatDuration(estimate.recommendedWait ?? estimate.estimatedTimeToTarget)}</b></div></div></div>
    <div className="explainGrid">
      <section className="panel subScores"><div className="panelHead"><div><p>SCORE COMPONENTS</p><h2>Independent signals</h2></div></div>{scoreEntries.length ? <div className="scoreBars">{scoreEntries.map(([key, value]) => <div key={key}><span>{SUB_SCORE_LABELS[key] || key}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></i><strong>{Math.round(value)}</strong></div>)}</div> : <div className="empty smallEmpty">Sub-scores unavailable</div>}</section>
      <section className="panel explanationPanel"><div className="panelHead"><div><p>EXPLANATION</p><h2>Evidence behind the estimate</h2></div></div>{estimate.explanations?.length ? <ul>{estimate.explanations.map((entry, index) => { const text = explanationText(entry); const tone = explanationTone(entry, text); return <li className={tone} key={index}><i>{tone === 'negative' || tone === 'risk' ? '−' : '+'}</i><span>{text}</span></li> })}</ul> : <div className="empty smallEmpty">No explanation was returned for this estimate.</div>}</section>
    </div>
    {plan.strategy === 'multiple' && <section className="panel selectedReceivers"><ReceiverBreakdown receivers={estimate.receiverEstimates} asset={plan.asset} targetLabel={plan.targetLabel || 'Target'} /><div className="coordination"><span>PLAN COORDINATION RISK</span><b className={bandClass(estimate.coordinationRisk)}>{displayBand(estimate.coordinationRisk || 'Unavailable')}</b><small>{finite(estimate.coordinationPenalty) === null ? 'Penalty unavailable' : `−${compact(estimate.coordinationPenalty, 1)} score points`}</small></div></section>}
    <section className="panel selectedTimeline"><div><p className="eyebrow">ESTIMATED PRIVACY WAIT</p><h2>Expected score based on recent activity</h2></div><EstimateTimeline timeline={estimate.timeline} targetScore={plan.targetScore || 75} /></section>
    <p className="estimateDisclaimer detailDisclaimer">This is an estimate, not a guarantee of anonymity. Historical activity does not guarantee future anonymity or unlinkability.</p>
  </section>
}

function FlowTooltip({ active, payload, label, token }) {
  if (!active || !payload?.length) return null
  return <div className="tip"><small>{label} UTC</small>{payload.map((entry) => <b key={entry.dataKey} style={{ color: entry.color }}>{entry.name}: {compact(entry.value)} {token}</b>)}</div>
}

function ObsidianLiquidity({ selectedTvl, totalTvl, inflowEvents, outflowEvents }) {
  const mountRef = useRef(null)
  // The scene is expensive to build - a WebGL context, a PMREM environment
  // map, and a shader compile - and the figures it visualises refresh every 30
  // seconds. Passing them through a ref rather than the effect's dependencies
  // means a refresh retargets the running animation instead of tearing the
  // whole renderer down and starting again.
  const figures = useRef({ selectedTvl, totalTvl, inflowEvents, outflowEvents })
  figures.current = { selectedTvl, totalTvl, inflowEvents, outflowEvents }

  useEffect(() => {
    const mount = mountRef.current
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(31, 1, .1, 100)
    camera.position.set(0, 0, 4.25)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.14
    mount.appendChild(renderer.domElement)

    const pmrem = new THREE.PMREMGenerator(renderer)
    const roomEnvironment = new RoomEnvironment()
    const environment = pmrem.fromScene(roomEnvironment, .035).texture
    roomEnvironment.dispose()
    scene.environment = environment

    const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, 5))
    const positions = geometry.attributes.position
    const noise = new ImprovedNoise()
    const direction = new THREE.Vector3()
    const surfaceFields = new Float32Array(positions.count * 5)
    for (let index = 0; index < positions.count; index += 1) {
      direction.fromBufferAttribute(positions, index).normalize()
      const { x, y, z } = direction
      const broad = noise.noise(x * 2.05 + 4.1, y * 2.05 - 2.7, z * 2.05 + .8)
      const middle = noise.noise(x * 4.65 - 7.4, y * 4.65 + 1.9, z * 4.65 - 3.2)
      const fine = noise.noise(x * 9.2 + 2.3, y * 9.2 - 5.6, z * 9.2 + 6.1)
      const foldNoise = noise.noise(x * 5.7 - 1.4, y * 5.7 + 8.2, z * 5.7 - 4.7)
      const secondFoldNoise = noise.noise(x * 3.8 + 7.3, y * 3.8 - 2.1, z * 3.8 + 1.6)
      const fold = Math.pow(Math.max(0, 1 - Math.abs(foldNoise) * 2.55), 4)
      const secondFold = Math.pow(Math.max(0, 1 - Math.abs(secondFoldNoise) * 2.8), 5)
      const radius = 1 + broad * .058 + middle * .082 + fine * .033 - fold * .07 - secondFold * .045
      positions.setXYZ(index, x * radius, y * radius, z * radius)
      const fieldOffset = index * 5
      surfaceFields[fieldOffset] = broad
      surfaceFields[fieldOffset + 1] = middle
      surfaceFields[fieldOffset + 2] = fine
      surfaceFields[fieldOffset + 3] = fold
      surfaceFields[fieldOffset + 4] = secondFold
    }
    positions.needsUpdate = true
    positions.setUsage(THREE.DynamicDrawUsage)
    geometry.computeVertexNormals()
    const morphDirections = new Float32Array(positions.count * 3)
    for (let index = 0; index < positions.count; index += 1) {
      direction.fromBufferAttribute(positions, index).normalize()
      morphDirections[index * 3] = direction.x
      morphDirections[index * 3 + 1] = direction.y
      morphDirections[index * 3 + 2] = direction.z
    }

    const material = new THREE.MeshPhysicalMaterial({
      color: 0x010202,
      metalness: .82,
      roughness: .19,
      clearcoat: 1,
      clearcoatRoughness: .075,
      envMapIntensity: 2.05,
    })
    const shaderState = { value: null }
    material.onBeforeCompile = (shader) => {
      shader.uniforms.liquidTime = { value: 0 }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float liquidTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float liquidWave = sin(position.y * 8.0 + liquidTime * 0.72) * cos(position.x * 6.0 - liquidTime * 0.48);
          transformed += normal * liquidWave * 0.006;`)
      shaderState.value = shader
    }
    material.customProgramCacheKey = () => 'obsidian-liquid-v2'

    const blob = new THREE.Mesh(geometry, material)
    blob.rotation.set(-.16, -.38, .08)
    scene.add(blob)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x030504, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 3.6)
    key.position.set(-4.5, 5.5, 5)
    scene.add(key)
    const rim = new THREE.PointLight(0xb9d0c9, 24, 9, 1.7)
    rim.position.set(3.7, -.7, 3.2)
    scene.add(rim)
    const lower = new THREE.PointLight(0x65736f, 10, 7, 2)
    lower.position.set(-2.4, -3.2, 2)
    scene.add(lower)

    const particleGeometry = new THREE.SphereGeometry(1, 14, 10)
    const inflowMaterial = new THREE.MeshPhysicalMaterial({ color: 0xeaf0ed, metalness: .7, roughness: .08, clearcoat: 1, envMapIntensity: 2 })
    const outflowMaterial = new THREE.MeshPhysicalMaterial({ color: 0x020303, metalness: .92, roughness: .12, clearcoat: 1, envMapIntensity: 2.2 })
    const particles = []
    let nextIn = performance.now() + 450
    let nextOut = performance.now() + 1050
    const spawnParticle = (type, now) => {
      const angle = Math.random() * Math.PI * 2
      const mesh = new THREE.Mesh(particleGeometry, type === 'in' ? inflowMaterial : outflowMaterial)
      const radial = type === 'in' ? 2.25 + Math.random() * .45 : 1.02
      mesh.position.set(Math.cos(angle) * radial, Math.sin(angle) * radial * .75, (Math.random() - .5) * .45)
      const size = .018 + Math.random() * .025
      mesh.scale.setScalar(size)
      scene.add(mesh)
      particles.push({ mesh, type, born: now, angle, life: type === 'in' ? 3000 : 4300, size })
    }

    let pointerX = 0; let pointerY = 0
    const onPointerMove = (event) => {
      const bounds = mount.getBoundingClientRect()
      pointerX = ((event.clientX - bounds.left) / bounds.width - .5) * .34
      pointerY = ((event.clientY - bounds.top) / bounds.height - .5) * .22
    }
    const onPointerLeave = () => { pointerX = 0; pointerY = 0 }
    mount.addEventListener('pointermove', onPointerMove)
    mount.addEventListener('pointerleave', onPointerLeave)

    const resize = () => {
      const bounds = mount.getBoundingClientRect()
      const width = Math.max(1, bounds.width); const height = Math.max(1, bounds.height)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount); resize()

    // Radius follows the cube root of TVL because the blob represents volume.
    // Keep only a tiny visual floor so pools around $500 remain dramatically
    // smaller than million-dollar pools while still being discoverable.
    const scaleFor = ({ selectedTvl: selected, totalTvl: total }) => {
      const ratio = total > 0 ? Math.max(0, Math.min(1, selected / total)) : 0
      return selected > 0 ? .07 + Math.cbrt(ratio) * .95 : 0
    }
    // Starts at the figures the first frame knows about, then eases toward
    // whatever the 30-second refresh reports, so selecting a pool or a change
    // in TVL reads as the blob growing rather than as a reload.
    let currentScale = scaleFor(figures.current)
    blob.scale.setScalar(currentScale)
    const clock = new THREE.Clock()
    const motionSpeed = 10
    let frame
    const animate = (now) => {
      const delta = Math.min(.05, clock.getDelta())
      const { inflowEvents: inflowRate, outflowEvents: outflowRate } = figures.current
      const targetScale = scaleFor(figures.current)
      if (currentScale !== targetScale) {
        // Time-based easing so the approach looks the same regardless of frame
        // rate, and snap once the remaining difference stops being visible.
        // Anyone who asked for reduced motion gets the new size outright.
        if (reducedMotion) currentScale = targetScale
        else {
          currentScale += (targetScale - currentScale) * Math.min(1, delta * 2.4)
          if (Math.abs(targetScale - currentScale) < .0005) currentScale = targetScale
        }
        blob.scale.setScalar(currentScale)
      }
      if (shaderState.value) shaderState.value.uniforms.liquidTime.value = now / 1000 * motionSpeed
      if (!reducedMotion) {
        // Rebuild the radius field continuously. Multiple travelling waves
        // interfere with roaming bulges and dents to create obvious surface
        // flow instead of merely rotating a fixed object;
        // recalculating normals makes those perturbations move in the light.
        const time = now * .001 * motionSpeed
        let bulgeX = Math.cos(time * .53) + pointerX; let bulgeY = Math.sin(time * .41) * .72 - pointerY; let bulgeZ = Math.sin(time * .53)
        let dentX = Math.cos(time * -.37 + 2.1); let dentY = Math.sin(time * .61 + .8) * .78; let dentZ = Math.sin(time * -.37 + 2.1)
        const bulgeLength = Math.hypot(bulgeX, bulgeY, bulgeZ) || 1
        const dentLength = Math.hypot(dentX, dentY, dentZ) || 1
        bulgeX /= bulgeLength; bulgeY /= bulgeLength; bulgeZ /= bulgeLength
        dentX /= dentLength; dentY /= dentLength; dentZ /= dentLength
        for (let index = 0; index < positions.count; index += 1) {
          const offset = index * 3
          const fieldOffset = index * 5
          const x = morphDirections[offset]; const y = morphDirections[offset + 1]; const z = morphDirections[offset + 2]
          const broad = surfaceFields[fieldOffset]; const middle = surfaceFields[fieldOffset + 1]; const fine = surfaceFields[fieldOffset + 2]
          const fold = surfaceFields[fieldOffset + 3]; const secondFold = surfaceFields[fieldOffset + 4]
          // Each noise band breathes with a different phase. Peaks therefore
          // emerge from the base sphere, crest, and melt away instead of
          // remaining as permanent mountains.
          const broadGrowth = .18 + .82 * (.5 + .5 * Math.sin(time * .14 + broad * 3.4))
          const middleGrowth = .12 + .88 * (.5 + .5 * Math.sin(time * .22 + middle * 4.8 + 1.7))
          const fineGrowth = .2 + .8 * (.5 + .5 * Math.sin(time * .31 + fine * 5.6 + 3.1))
          const foldGrowth = .1 + .9 * (.5 + .5 * Math.sin(time * .18 + broad * 2.1 - middle * 2.7))
          const surfaceRadius = 1 + broad * .064 * broadGrowth + middle * .09 * middleGrowth + fine * .04 * fineGrowth - fold * .075 * foldGrowth - secondFold * .05 * (1 - middleGrowth)
          const waveA = Math.sin(x * 7.2 + y * 2.8 + time * 1.18) * Math.cos(z * 5.4 - time * .86)
          const waveB = Math.sin(y * 9.1 - z * 3.7 - time * .94) * Math.cos(x * 4.3 + time * .71)
          const travellingFold = Math.pow(Math.max(0, Math.sin(x * 5.6 - y * 4.1 + z * 3.2 + time * 1.05)), 7)
          const bulge = Math.pow(Math.max(0, x * bulgeX + y * bulgeY + z * bulgeZ), 11) * .105
          const dent = Math.pow(Math.max(0, x * dentX + y * dentY + z * dentZ), 13) * .09
          const displacement = waveA * .042 + waveB * .028 - travellingFold * .058 + bulge - dent
          const lateralFlow = (waveB - waveA) * .014
          positions.setXYZ(
            index,
            x * (surfaceRadius + displacement) - y * lateralFlow,
            y * (surfaceRadius + displacement) + x * lateralFlow,
            z * (surfaceRadius + displacement) + (x - y) * lateralFlow * .45,
          )
        }
        positions.needsUpdate = true
        geometry.computeVertexNormals()
      }
      if (now >= nextIn && inflowRate > 0) {
        spawnParticle('in', now)
        nextIn = now + Math.max(2100, 7200 / (1 + inflowRate * .06)) + Math.random() * 1400
      }
      if (now >= nextOut && outflowRate > 0) {
        spawnParticle('out', now)
        nextOut = now + Math.max(2700, 9000 / (1 + outflowRate * .06)) + Math.random() * 1700
      }
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index]
        const progress = Math.min(1, (now - particle.born) / particle.life)
        const eased = progress * progress * (3 - 2 * progress)
        const radial = particle.type === 'in' ? THREE.MathUtils.lerp(2.4, .82, eased) : THREE.MathUtils.lerp(1.02, 2.65, eased)
        particle.mesh.position.x = Math.cos(particle.angle) * radial
        particle.mesh.position.y = Math.sin(particle.angle) * radial * .75 - (particle.type === 'out' ? progress * progress * .14 : 0)
        particle.mesh.position.z = Math.sin(progress * Math.PI) * .34
        particle.mesh.scale.setScalar(particle.size * (particle.type === 'in' ? 1 - eased * .45 : 1 - eased * .7))
        if (progress >= 1) { scene.remove(particle.mesh); particles.splice(index, 1) }
      }
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(frame); observer.disconnect()
      mount.removeEventListener('pointermove', onPointerMove); mount.removeEventListener('pointerleave', onPointerLeave)
      particles.forEach(({ mesh }) => scene.remove(mesh))
      geometry.dispose(); particleGeometry.dispose(); material.dispose(); inflowMaterial.dispose(); outflowMaterial.dispose()
      environment.dispose(); pmrem.dispose(); renderer.dispose(); renderer.domElement.remove()
    }
    // Built once. Every figure the scene reads comes from `figures`, so a data
    // refresh must not re-run this.
  }, [])

  return <div ref={mountRef} className="obsidianCanvas" role="img" aria-label={`${money(selectedTvl)} selected TVL, normalized against ${money(totalTvl)} across all protocols`} />
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
    <div className="universeCopy"><p className="eyebrow">LIVE PRIVATE LIQUIDITY</p><h2>Funds enter publicly, and leave without a trace</h2><p>A deposit into a privacy pool is visible on-chain. What leaves it later is not linkable back to it.</p><div className="universeLegend"><span className="in"><i /> Inflow {money(inflow)}</span><span className="out"><i /> Withdrawals {money(outflow)}</span></div><div className="normalization">MAX SIZE · ALL PROTOCOLS <b>{money(totalTvl)}</b></div></div>
    <div className="liquidityVisual">
      <ObsidianLiquidity selectedTvl={selectedTvl} totalTvl={totalTvl} inflowEvents={inflowEvents} outflowEvents={outflowEvents} />
      <div className="tvlReadout"><span>TVL</span><strong>{summary.loading ? 'Loading…' : money(selectedTvl)}</strong><small>{included.length ? included.map((pool) => pool.name).join(' + ') : 'No pools selected'}</small></div>
    </div>
    <div className="poolSelector"><div className="poolGroup"><small>SOLANA NATIVE</small><div>{sortByTvl(SOLANA_POOL_IDS, summary.pools).map(poolButton)}</div></div><div className="poolGroup others"><small>OTHERS</small><div>{sortByTvl(OTHER_POOL_IDS, summary.pools).map(poolButton)}</div></div></div>
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

  return <div className="protocolPage">
    <header className="analyticsHeader"><div><p className="eyebrow">PROJECT STATS</p><h1>Analytics database</h1></div><div className="analyticsActions"><a className="ghost launchApp" href="/" onClick={onLaunchApp}>Launch APP <ArrowUpRight /></a><a className="ghost" href={analytics.docs || meta.docs} target="_blank" rel="noreferrer">Protocol docs <ExternalLink /></a></div></header>
    <LiquidityUniverse />
    <div className="analyticsProtocolTabs" aria-label="Analytics project">{sortByTvl(Object.keys(PROTOCOLS), poolSizes.pools).map((id) => <button type="button" className={protocol === id ? 'on' : ''} onClick={() => onSelectProtocol(id)} key={id}><ProtocolLogo protocol={id} name={PROTOCOLS[id].name} /><span>{PROTOCOLS[id].name}</span></button>)}</div>
    <section className={`notice ${error ? 'error' : ''}`}>{error ? <ShieldX /> : <ShieldCheck />}<span>{error || `Reading ${meta.name} data from the analytics database`}</span><b>{loading ? 'Loading' : error ? 'Error' : isBackfilling ? 'Partial' : 'Ready'}</b><em>{analytics.indexedAt ? `Indexed ${new Date(analytics.indexedAt * 1000).toLocaleString()}` : 'Run the backend indexer to update'}</em></section>
    {meta.swap.routeBanner && <section className="route panel"><span>{meta.swap.routeBanner.from}</span><ArrowRight /><b>{meta.swap.routeBanner.via}</b><ArrowRight /><span>{meta.swap.routeBanner.to}</span><small>{meta.swap.routeBanner.note}</small></section>}
    <EstimateAnalytics estimate={selectedEstimate} />

    <div className="sectionTitle"><div><p className="eyebrow">POOL STATE</p><h2>Current balances</h2></div><strong>{money(state.totalUsd)} TVL</strong></div>
    <section className="poolGrid">{ASSETS.map((asset) => <Metric key={asset} label={`${asset} BALANCE`} value={`${compact(state.balances?.[asset], asset === 'SOL' ? 4 : 2)} ${asset}`} note={money(state.usd?.[asset])} />)}</section>

    <section className="panel chartPanel">
      <div className="panelHead"><div><p>EXTERNAL FLOW</p><h2>{token} pool movements</h2></div><div className="controls"><div className="tokenTabs">{ASSETS.map((item) => <button className={token === item ? 'on' : ''} onClick={() => setToken(item)} key={item}>{item}</button>)}</div><div className="ranges">{['90D','30D','1D','6H','1H'].map((item) => <button className={range === item ? 'on' : ''} onClick={() => setRange(item)} key={item}>{item}</button>)}</div></div></div>
      <div className="flowSummary">{FLOW_TYPES.map(([key, label, color]) => <div key={key}><i style={{ background: color }} /><span>{label}</span><b>{compact(analytics.externalFlows?.[key]?.[token], token === 'SOL' ? 4 : 2)} {token}</b></div>)}<small>{WINDOW_LABELS[range]}</small></div>
      <div className="chart"><ResponsiveContainer><AreaChart data={data}><CartesianGrid vertical={false} stroke="#1E1E1E" /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill:'#666666', fontSize:11 }} interval={range === '90D' ? 14 : range === '30D' ? 4 : 3} /><YAxis yAxisId="flow" axisLine={false} tickLine={false} tick={{ fill:'#666666', fontSize:11 }} tickFormatter={compact} width={64} /><YAxis yAxisId="pool" orientation="right" axisLine={false} tickLine={false} tick={{ fill:'var(--accent)', fontSize:11 }} tickFormatter={compact} width={64} /><Tooltip content={<FlowTooltip token={token} />} />{FLOW_TYPES.map(([key, label, color, suffix, dash]) => <Area key={key} yAxisId="flow" type="monotone" dataKey={`${token}${suffix}`} name={label} stroke={color} strokeDasharray={dash} fill="transparent" strokeWidth={key === 'deposits' ? 2.4 : 1.8} />)}<Line yAxisId="pool" type="monotone" dataKey={`${token}Pool`} name="Pool balance" stroke="var(--accent)" strokeWidth={2.75} dot={false} /></AreaChart></ResponsiveContainer></div>
    </section>

    <div className="sectionTitle activityTitle"><div><p className="eyebrow">ACTIVITY</p><h2>Behavior inside this window</h2></div><span>{analytics.flowMethod}</span></div>
    <section className="activityMetrics"><Metric label="TX COUNT" value={compact(activity.txCount, 0)} /><Metric label="UNIQUE AMOUNTS" value={compact(activity.uniqueAmounts, 0)} /><Metric label="1H RECENT VOLUME" value={formatMetricMoney(activity.recentVolume?.oneHourUsd)} /><Metric label="24H RECENT VOLUME" value={formatMetricMoney(activity.recentVolume?.twentyFourHoursUsd)} /></section>
    <div className="analyticsRow">
      <section className="panel distribution"><div className="panelHead"><div><p>AMOUNT DISTRIBUTION</p><h2>External flows by USD size</h2></div></div>{activity.usdValuationComplete === false ? <div className="empty smallEmpty">Stored USD prices are unavailable for part of this window.</div> : <div className="smallChart"><ResponsiveContainer><BarChart data={activity.amountDistribution}><CartesianGrid vertical={false} stroke="#1E1E1E" /><XAxis dataKey="label" tick={{ fill:'#666666', fontSize:9 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill:'#666666', fontSize:9 }} axisLine={false} tickLine={false} /><Bar dataKey="count" fill="var(--accent)" radius={[1,1,0,0]} /></BarChart></ResponsiveContainer></div>}</section>
      <section className="panel distribution"><div className="panelHead"><div><p>TIME DISTRIBUTION</p><h2>Transactions by UTC hour</h2></div></div><div className="smallChart"><ResponsiveContainer><BarChart data={activity.timeDistribution}><XAxis dataKey="hour" tick={{ fill:'#666666', fontSize:9 }} axisLine={false} tickLine={false} interval={3} /><YAxis hide /><Bar dataKey="count" fill="#8A8A8A" /></BarChart></ResponsiveContainer></div></section>
    </div>

    <section className="panel recent"><div className="panelHead"><div><p>RECENT ACTIVITY</p><h2>Latest external flows</h2></div><a className="ghost" href={analytics.explorerAccount || `https://solscan.io/account/${analytics.programId || ''}`} target="_blank" rel="noreferrer">{analytics.chain === 'arbitrum' ? 'Arbiscan' : 'Solscan'} <ArrowUpRight /></a></div><div className="table"><div className="tr th"><span>TIME</span><span>PARTICIPANT</span><span>TYPE</span><span>AMOUNT</span><span>TRANSACTION</span></div>{!analytics.recent.length && <div className="empty">{loading ? 'Loading stored data…' : 'No external flows in this window'}</div>}{analytics.recent.slice(0, 7).map((flow) => <div className="tr" key={flow.id}><span><Clock3 />{age(flow.timestamp)}</span><code>{short(flow.participant)}</code><span className={`direction ${flow.flowType}`}><i />{flow.flowType.replace('_', ' ')}</span><b>{compact(flow.amount, flow.asset === 'SOL' ? 4 : 2)} {flow.asset}{flow.counterAsset ? ` → ${flow.counterAsset}` : ''}</b><a className="tx" href={`${analytics.explorerTransaction || 'https://solscan.io/tx/'}${flow.signature}`} target="_blank" rel="noreferrer">{short(flow.signature)} <ExternalLink /></a></div>)}</div></section>
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
  const mobileNav = <>
    <MobileBar onOpen={() => setDrawerOpen(true)} />
    <Sidebar open={sidebarOpen} view={view} onToggle={() => setSidebarOpen(!sidebarOpen)} onHome={openHome} onPaymentLinks={openPaymentLinks} onAnalytics={openAnalyticsPage} onClose={closeDrawer} />
    {drawerOpen && <button className="drawerScrim" type="button" aria-label="Close navigation" onClick={closeDrawer} />}
  </>
  if (view === 'analytics') return <div className={`analyticsApp${drawerOpen ? ' drawerOpen' : ''}`}>{mobileNav}<main className="analyticsMain"><ProtocolDashboard protocol={protocol} selectedEstimate={selectedEstimate} onSelectProtocol={openAnalytics} onLaunchApp={launchApp} /><footer className="socialFoot">{xLink}</footer></main>{walletPicker}</div>
  if (view === 'checkout') return <div className={`app ${sidebarOpen ? 'sidebarOpen' : 'sidebarClosed'}${drawerOpen ? ' drawerOpen' : ''}`}>{mobileNav}<main><PaymentCheckout key={window.location.pathname} paymentId={window.location.pathname.split('/')[2] || ''} walletSession={walletSession} /></main>{walletPicker}</div>
  return <div className={`app ${sidebarOpen ? 'sidebarOpen' : 'sidebarClosed'}${drawerOpen ? ' drawerOpen' : ''}`}>{mobileNav}<main>{view === 'payments' ? <PaymentLinksPage walletSession={walletSession} /> : <PrivacyHome walletSession={walletSession} />}</main>{walletPicker}</div>
}

createRoot(document.getElementById('root')).render(<App />)
