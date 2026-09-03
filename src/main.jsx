import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowLeftRight, ArrowRight, ArrowUpRight, CheckCircle2, ChevronDown, Clock3, Database, ExternalLink, Home, LogOut, Menu, Plus, ShieldCheck, ShieldX, Wallet, X } from 'lucide-react'
import './styles.css'
import { sanitizeAmount, sanitizeSolanaAddress, validateTransfer } from './transfer-validation.js'
import { swapEligibility } from './swap-routes.js'

const ASSETS = ['USDC', 'SOL', 'USDT']
const LOGOS = {
  assets: {
    USDC: { src: '/logos/usdc.svg', source: 'https://www.circle.com/pressroom' },
    SOL: { src: '/logos/sol.svg', source: 'https://solana.com/branding' },
    USDT: { src: '/logos/usdt.svg', source: 'https://tether.to/en/media/' },
  },
  protocols: {
    cloakc: { src: '/logos/cloak.png', source: 'https://www.cloak.ag/brand' },
    privacycash: { src: '/logos/privacycash-icon.png', source: 'https://privacycash.mintlify.app/' },
    curvy: { src: '/logos/curvy.svg', source: 'https://www.curvy.box/' },
  },
}
const TOKEN_DECIMALS = { SOL: 9, USDC: 6, USDT: 6 }
const EMPTY_ASSETS = { USDC: 0, SOL: 0, USDT: 0 }
const EMPTY = { buckets: [], totals: { deposits: EMPTY_ASSETS, withdrawals: EMPTY_ASSETS, swapIn: EMPTY_ASSETS, swapOut: EMPTY_ASSETS, poolSize: EMPTY_ASSETS, count: 0, counts: { byAsset: EMPTY_ASSETS } }, poolState: { balances: EMPTY_ASSETS, usd: EMPTY_ASSETS, totalUsd: 0 }, externalFlows: {}, activity: { txCount: 0, uniqueAmounts: 0, amountDistribution: [], recentVolume: {}, timeDistribution: [] }, recent: [] }
const PROTOCOLS = {
  cloakc: { name: 'CLOAKC', shortProgram: 'zh1e…RkW', docs: 'https://docs.cloak.ag/sdk/introduction', chain: 'solana' },
  privacycash: { name: 'PrivacyCash', shortProgram: '9fhQ…QyQD', docs: 'https://privacycash.mintlify.app/', chain: 'solana' },
  curvy: { name: 'Curvy', shortProgram: '0xB4BA…B6d5', docs: 'https://docs.curvy.box/', chain: 'arbitrum' },
}
const PROVIDER_CAPABILITIES = {
  privacycash: { supportsMultiRecipient: true, supportsPrivateSwap: false, documentsPrivateSwap: true, maxRecipients: null, swapAggregator: 'Jupiter', network: 'Solana' },
  cloakc: { supportsMultiRecipient: false, supportsPrivateSwap: true, maxRecipients: 1, swapAggregator: 'Jupiter', network: 'Solana' },
  curvy: { supportsMultiRecipient: false, supportsPrivateSwap: true, maxRecipients: 1, swapAggregator: 'LiFi', network: 'Arbitrum One' },
}
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
  const key = String(item?.provider || item?.protocol || '').toLowerCase().replace(/[^a-z]/g, '')
  if (key.includes('privacycash')) return 'privacycash'
  if (key.includes('cloak')) return 'cloakc'
  return key
}

function normalizeEstimate(item, strategy, inputAsset, outputAsset) {
  const protocol = providerKey(item)
  const configured = PROVIDER_CAPABILITIES[protocol] || {}
  const poolMetrics = item?.poolMetrics || {}
  const capabilities = { ...configured, ...(item?.capabilities || {}) }
  if (protocol === 'cloakc') capabilities.supportsMultiRecipient = false
  const route = inputAsset && outputAsset ? swapEligibility(protocol, inputAsset, outputAsset) : { available: true }
  const capabilityBlocked = strategy === 'multiple' && !capabilities.supportsMultiRecipient
  const routeBlocked = inputAsset !== outputAsset && !route.available
  const subScores = item?.subScores || item?.subscores || {
    depth: item?.depthScore, cover: item?.coverScore, similarity: item?.similarityScore,
    temporal: item?.temporalScore, activity: item?.activityScore, uniqueness: item?.uniquenessScore,
  }
  return {
    ...item,
    protocol,
    protocolName: item?.protocolName || item?.providerName || PROTOCOLS[protocol]?.name || item?.provider || item?.protocol || 'Unknown pool',
    available: item?.available !== false && item?.eligible !== false && !capabilityBlocked && !routeBlocked,
    unavailableReason: capabilityBlocked
      ? 'Multiple-recipient withdrawal is not currently supported by this provider.'
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

function Sidebar({ open, view, onToggle, onHome, onAnalytics, onClose }) {
  return <aside id="primaryNav"><div className="sideTop"><EclipseLogo /><button className="sidebarToggle" type="button" aria-label={open ? 'Collapse navigation' : 'Expand navigation'} onClick={onToggle}><Menu /></button><button className="drawerClose" type="button" aria-label="Close navigation" onClick={onClose}><X /></button></div><nav><a className={view === 'home' ? 'active' : ''} href="/" onClick={onHome}><Home /><span>Private transfer</span></a><a className={view === 'analytics' ? 'analyticsNav active' : 'analyticsNav'} href="/analytics" onClick={onAnalytics}><Database /><span>Analytics</span><ArrowUpRight className="navArrow" /></a></nav><div className="sideBottom"><p>DarkSol private routing</p><code>v1.0 / MAINNET</code></div></aside>
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

function PrivacyHome() {
  const [asset, setAsset] = useState('USDC')
  const [destinationAsset, setDestinationAsset] = useState('USDC')
  const [amount, setAmount] = useState('')
  const [receiverAmounts, setReceiverAmounts] = useState([''])
  const [recipientAddresses, setRecipientAddresses] = useState([''])
  const [assetMenuOpen, setAssetMenuOpen] = useState(false)
  const [destinationMenuOpen, setDestinationMenuOpen] = useState(false)
  const [privacyTarget, setPrivacyTarget] = useState('balanced')
  const [comparison, setComparison] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [wallet, setWallet] = useState(null)
  const [sending, setSending] = useState(false)
  const [sendStatus, setSendStatus] = useState('')
  const [sendError, setSendError] = useState('')
  const [receipt, setReceipt] = useState(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [sendAttempted, setSendAttempted] = useState(false)
  const [selectedProtocol, setSelectedProtocol] = useState(null)
  const [walletBalance, setWalletBalance] = useState(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const requestSequence = useRef(0)
  const balanceSequence = useRef(0)
  const receiverCount = receiverAmounts.length
  const strategy = receiverCount > 1 ? 'multiple' : 'single'
  const isSwap = asset !== destinationAsset

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

  useEffect(() => {
    const provider = window.phantom?.solana || window.solana
    if (!provider?.on) return undefined
    const accountChanged = (publicKey) => {
      setWallet(publicKey ? { provider, address: String(publicKey) } : null)
      setReceipt(null); setSendError('')
    }
    const disconnected = () => { setWallet(null); setReceipt(null); setSendStatus('') }
    provider.on('accountChanged', accountChanged)
    provider.on('disconnect', disconnected)
    return () => {
      provider.off?.('accountChanged', accountChanged)
      provider.off?.('disconnect', disconnected)
    }
  }, [])

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
      destinationAsset,
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
      destinationAsset,
      amount,
      strategy,
      receiverAmounts: strategy === 'multiple' ? receiverAmounts : [amount],
      privacyTarget,
    }, controller.signal), 350)
    return () => { clearTimeout(timeout); controller.abort() }
  }, [asset, destinationAsset, amount, strategy, receiverAmounts, privacyTarget, formValid])

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
    setSendError(''); setSendStatus('Connecting…')
    try {
      const provider = window.phantom?.solana || window.solana
      if (!provider?.connect) throw new Error('Install Phantom or another compatible Solana wallet')
      const connected = await provider.connect()
      const publicKey = String(connected.publicKey || provider.publicKey || '')
      if (!publicKey) throw new Error('Wallet did not provide an address')
      setWallet({ provider, address: publicKey }); setSendStatus('')
    } catch (connectError) {
      setSendError(connectError instanceof Error ? connectError.message : String(connectError)); setSendStatus('')
    }
  }

  async function disconnectWallet() {
    const provider = wallet?.provider
    setWallet(null); setReceipt(null); setSendError(''); setSendStatus(''); setSendAttempted(false)
    try {
      await provider?.disconnect?.()
    } catch {
      // The local session is already cleared even if the wallet extension rejects.
    }
  }

  async function sendTransfer() {
    setSendAttempted(true); setSendError('')
    if (receipt?.depositSignature) return setSendError('This deposit was already submitted. Do not send it again.')
    setReceipt(null)
    if (!wallet) return connectWallet()
    if (!transferValidation.valid) return setSendError(transferValidation.error)
    const canExecute = isSwap ? recommended?.protocol === 'cloakc' : recommended?.protocol === 'privacycash'
    if (!canExecute) return setSendError('This recommended route is not enabled for browser execution yet')
    setSending(true)
    try {
      const result = isSwap
        ? await import('./cloak-client.js').then(({ executeCloakSwap }) => executeCloakSwap({
          provider: wallet.provider, inputAsset: asset, outputAsset: destinationAsset,
          totalBaseUnits: transferValidation.total.baseUnits,
          recipient: transferValidation.rows[0].address.publicKey,
          onStatus: setSendStatus,
        }))
        : await import('./privacycash-client.js').then(({ executePrivacyCashTransfer }) => executePrivacyCashTransfer({
          provider: wallet.provider,
          asset,
          totalBaseUnits: transferValidation.total.baseUnits,
          recipients: transferValidation.rows.map((row) => ({ publicKey: row.address.publicKey, baseUnits: row.amount.baseUnits })),
          onStatus: setSendStatus,
        }))
      setReceipt(result); setSendStatus('Sent')
    } catch (transferError) {
      if (transferError?.receipt) setReceipt(transferError.receipt)
      const message = transferError instanceof Error ? transferError.message : String(transferError)
      setSendError(/403|access forbidden/i.test(message) ? 'Solana RPC access was denied. Check the server RPC configuration.' : message); setSendStatus('')
    } finally { setSending(false) }
  }

  const rankings = useMemo(() => {
    if (!comparison) return []
    const normalized = (comparison.rankings || []).map((item) => normalizeEstimate(item, strategy, asset, destinationAsset))
    if (strategy === 'multiple' && !normalized.some((item) => item.protocol === 'cloakc')) {
      normalized.push(normalizeEstimate({ protocol: 'cloakc', protocolName: 'CLOAKC', available: false, unavailableReason: 'Multiple-recipient withdrawal is not currently supported by this provider.', capabilities: PROVIDER_CAPABILITIES.cloakc }, strategy, asset, destinationAsset))
    }
    return normalized
  }, [comparison, strategy, asset, destinationAsset])
  const suggestedProtocol = rankings.find((item) => item.available)?.protocol
  const selectedIsAvailable = rankings.some((item) => item.available && item.protocol === selectedProtocol)
  const activeProtocol = selectedIsAvailable ? selectedProtocol : suggestedProtocol
  const resultTargetScore = pickNumber(comparison?.targetScore, selectedTarget.score) || selectedTarget.score
  const resultAsset = comparison?.asset || asset
  const resultAmount = pickNumber(comparison?.amount, total)
  const recommended = rankings.find((item) => item.available && item.protocol === activeProtocol)
  const alternatives = rankings.filter((item) => item.protocol !== activeProtocol)
  const browserExecutable = isSwap ? recommended?.protocol === 'cloakc' : recommended?.protocol === 'privacycash'

  return <div className="homePage">
    <header><h1>{isSwap ? 'Swap privately' : 'Send privately'}</h1></header>
    <section className="sendCard panel">
      <div className="amountRow">
        <input aria-label="Amount" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(event) => { const nextAmount = sanitizeAmount(event.target.value); setAmount(nextAmount); if (receiverCount === 1) setReceiverAmounts([nextAmount]); setDirty(true); setReceipt(null) }} />
        {wallet && <button type="button" className="walletMax" onClick={useMaximumBalance} disabled={balanceLoading || !walletBalance?.spendableRaw} title={asset === 'SOL' ? 'Network fee reserve already deducted' : 'Use wallet balance'}>MAX {balanceLoading ? '…' : walletBalance ? rawTokenText(walletBalance.spendableRaw, asset) : '—'}</button>}
        <div className="assetPicker">
          <button type="button" aria-haspopup="listbox" aria-expanded={assetMenuOpen} onClick={() => setAssetMenuOpen(!assetMenuOpen)}><AssetLogo asset={asset} /><b>{asset}</b><ChevronDown /></button>
          {assetMenuOpen && <div className="assetMenu" role="listbox">{ASSETS.map((item) => <button type="button" role="option" aria-selected={asset === item} onClick={() => { setAsset(item); setAssetMenuOpen(false); if (item !== destinationAsset && receiverCount > 1) { setReceiverAmounts([amount]); setRecipientAddresses([recipientAddresses[0] || '']) } setDirty(true); setReceipt(null) }} key={item}><AssetLogo asset={item} />{item}</button>)}</div>}
        </div>
      </div>
      <div className="swapDestination">
        <span>{isSwap ? 'SWAP TO' : 'RECEIVE'}</span><ArrowRight />
        <div className="assetPicker">
          <button type="button" aria-label="Destination asset" aria-haspopup="listbox" aria-expanded={destinationMenuOpen} onClick={() => setDestinationMenuOpen(!destinationMenuOpen)}><AssetLogo asset={destinationAsset} /><b>{destinationAsset}</b><ChevronDown /></button>
          {destinationMenuOpen && <div className="assetMenu destinationAssetMenu" role="listbox">{ASSETS.map((item) => <button type="button" role="option" aria-selected={destinationAsset === item} onClick={() => { setDestinationAsset(item); setDestinationMenuOpen(false); if (item !== asset && receiverCount > 1) { setReceiverAmounts([amount]); setRecipientAddresses([recipientAddresses[0] || '']) } setDirty(true); setReceipt(null) }} key={item}><AssetLogo asset={item} />{item}</button>)}</div>}
        </div>
        <button type="button" className="flipAssets" aria-label="Reverse swap assets" onClick={() => { setAsset(destinationAsset); setDestinationAsset(asset); setAssetMenuOpen(false); setDestinationMenuOpen(false); setDirty(true); setReceipt(null) }}><ArrowLeftRight /></button>
      </div>
      <div className="recipientRows">
        {receiverAmounts.map((value, index) => <div className="recipientRow" key={index}><span>{index + 1}</span><div className="recipientFields"><input className="recipientAddress" aria-label={`Receiver ${index + 1} address`} autoComplete="off" spellCheck="false" placeholder={isSwap ? `${destinationAsset} recipient address` : 'Address'} value={recipientAddresses[index] || ''} onChange={(event) => { const next = [...recipientAddresses]; next[index] = sanitizeSolanaAddress(event.target.value); setRecipientAddresses(next); setReceipt(null) }} />{isSwap ? <div className="recipientSwapAsset"><small>OUTPUT</small><AssetLogo asset={destinationAsset} /><b>{destinationAsset}</b></div> : <div><input className="recipientAmount" aria-label={`Receiver ${index + 1} amount`} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={value} onChange={(event) => { const next = [...receiverAmounts]; next[index] = sanitizeAmount(event.target.value); setReceiverAmounts(next); setDirty(true); setReceipt(null) }} /><b>{asset}</b></div>}</div>{receiverCount > 1 && <button type="button" aria-label={`Remove receiver ${index + 1}`} onClick={() => removeReceiver(index)}><X /></button>}</div>)}
        <button type="button" className={`delayControl ${isSwap ? 'solo' : ''}`} aria-disabled="true" aria-label="Delay, coming soon" data-tooltip="Delay [SOON]"><Clock3 /></button>
        {!isSwap && <button type="button" className="addReceiver" aria-label="Add receiver" onClick={addReceiver}><Plus /></button>}
      </div>
      {(sendAttempted || amount) && !transferValidation.valid && <div className="splitStatus">{!receiversValid && remaining !== null ? `${compact(Math.abs(remaining), 9)} ${asset} ${remaining > 0 ? 'left' : 'over'}` : transferValidation.error}</div>}
    </section>
    {error && <section className="notice error"><ShieldX /><span>{error}</span></section>}
    <section className="sendAction panel">
      <div className="bestRoute">{recommended ? <ProtocolLogo protocol={recommended.protocol} name={recommended.protocolName} /> : <span className="routePlaceholder" />}</div>
      <div className="actionArea"><button type="button" onClick={sendTransfer} disabled={sending || Boolean(wallet && (receipt?.depositSignature || !transferValidation.valid || loading || !recommended || recommended.band === 'NOT PRIVATE' || !browserExecutable))}>{sending ? sendStatus || (isSwap ? 'Swapping...' : 'Sending...') : !wallet ? <><Wallet /> Connect wallet</> : loading ? 'Finding route...' : receipt?.depositSignature ? 'Submitted' : recommended?.band === 'NOT PRIVATE' ? 'Not private' : !browserExecutable ? 'View route details' : isSwap ? 'Swap' : 'Send'} {!sending && wallet && !receipt?.depositSignature && recommended?.band !== 'NOT PRIVATE' && browserExecutable && <ArrowRight />}</button>{wallet && <div className="walletSession"><small>{short(wallet.address)}</small><button type="button" aria-label="Disconnect wallet" title="Disconnect wallet" onClick={disconnectWallet} disabled={sending}><LogOut /></button></div>}</div>
    </section>
    {recommended && <RouteDetails estimate={recommended} alternatives={alternatives} asset={resultAsset} amount={resultAmount} targetLabel={selectedTarget.label} open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} />}
    {(sendError || receipt) && <section className={`transferResult ${sendError ? 'error' : ''}`}>{sendError ? <ShieldX /> : <CheckCircle2 />}<span>{sendError || (isSwap ? 'Swap submitted' : 'Transfer complete')}</span>{receipt && <a href={`https://solscan.io/tx/${receipt.withdrawals.at(-1)?.tx || receipt.depositSignature}`} target="_blank" rel="noreferrer">View transaction <ExternalLink /></a>}</section>}
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

function ObsidianLiquidityCanvas({ selectedTvl, totalTvl, inflowEvents, outflowEvents }) {
  const canvasRef = useRef(null)
  const radiusRef = useRef(70)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    let width = 0; let height = 0; let frame; let lastTime = performance.now(); let nextIn = lastTime; let nextOut = lastTime + 600
    let particles = []; let ripples = []
    const resize = () => {
      const bounds = canvas.getBoundingClientRect()
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(320, bounds.width); height = Math.max(260, bounds.height)
      canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale)
      context.setTransform(scale, 0, 0, scale, 0, 0)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas); resize()

    // A fixed, seeded relief map keeps the object organic without making its
    // surface flicker from frame to frame. The features rotate very slowly so
    // the liquidity mass feels dimensional rather than like a wavy disc.
    let seed = 0x51f15e
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
      value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
      return ((value ^ value >>> 14) >>> 0) / 4294967296
    }
    const surfacePockets = Array.from({ length: 28 }, () => {
      const angle = random() * Math.PI * 2
      const distance = Math.sqrt(random()) * .78
      return {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        size: .075 + random() * .14,
        stretch: .58 + random() * 1.35,
        tilt: random() * Math.PI,
        depth: .45 + random() * .55,
        phase: random() * Math.PI * 2,
      }
    }).sort((a, b) => a.y - b.y)
    const surfaceRidges = Array.from({ length: 17 }, () => ({
      angle: random() * Math.PI * 2,
      reach: .28 + random() * .58,
      bend: (random() - .5) * .62,
      phase: random() * Math.PI * 2,
      width: .45 + random() * 1.1,
    }))

    const spawn = (type, radius, centerX, centerY) => {
      const angle = Math.random() * Math.PI * 2
      if (type === 'in') {
        const side = Math.floor(Math.random() * 4)
        const margin = 18
        const positions = [[margin, Math.random() * height], [width - margin, Math.random() * height], [Math.random() * width, margin], [Math.random() * width, height - margin]]
        const [x, y] = positions[side]
        const distance = Math.max(1, Math.hypot(centerX - x, centerY - y))
        particles.push({ type, x, y, vx: (centerX - x) / distance * .02375, vy: (centerY - y) / distance * .02375, size: 1 + Math.random() * 1.4, trail: [], born: performance.now() })
      } else {
        const speed = .13125 + Math.random() * .1375
        const size = .5 + Math.random() * .9
        particles.push({ type, x: centerX + Math.cos(angle) * radius * .91, y: centerY + Math.sin(angle) * radius * .91, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size, trail: [], born: performance.now() })
        ripples.push({ angle, born: performance.now(), type: 'out', strength: 4 + size * 1.2 })
      }
    }

    const drawDroplet = (particle) => {
      if (particle.trail.length > 1) {
        context.beginPath(); context.moveTo(particle.trail[0].x, particle.trail[0].y)
        particle.trail.slice(1).forEach((point) => context.lineTo(point.x, point.y))
        context.strokeStyle = particle.type === 'in' ? '#f4f7f55c' : '#05060666'; context.lineWidth = particle.size * .52; context.lineCap = 'round'; context.stroke()
      }
      const shine = context.createRadialGradient(particle.x - particle.size * .35, particle.y - particle.size * .4, .5, particle.x, particle.y, particle.size)
      if (particle.type === 'in') { shine.addColorStop(0, '#ffffff'); shine.addColorStop(.2, '#e8edeb'); shine.addColorStop(.62, '#aeb7b4'); shine.addColorStop(1, '#626a68') }
      else { shine.addColorStop(0, '#6e7774'); shine.addColorStop(.14, '#202423'); shine.addColorStop(.46, '#070909'); shine.addColorStop(1, '#000') }
      context.beginPath(); context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2); context.fillStyle = shine; context.shadowColor = particle.type === 'in' ? '#ffffffb0' : '#aab3b070'; context.shadowBlur = 14; context.fill(); context.shadowBlur = 0
      context.strokeStyle = particle.type === 'in' ? '#ffffffb8' : '#89918f9c'; context.lineWidth = particle.type === 'in' ? .45 : .7; context.stroke()
    }

    const drawSphere = (centerX, centerY, radius, now) => {
      const time = now / 1000
      const ratio = totalTvl > 0 ? Math.max(0, Math.min(1, selectedTvl / totalTvl)) : 0
      const turbulence = radius * (.046 + (1 - ratio) * .055)
      const bodyPath = new Path2D()
      for (let index = 0; index <= 180; index += 1) {
        const angle = index / 180 * Math.PI * 2
        let deformation = Math.sin(angle * 3 + time * .34) * turbulence * .5 + Math.sin(angle * 7 - time * .27) * turbulence * .42 + Math.sin(angle * 11 + time * .19) * turbulence * .29 + Math.sin(angle * 17 - time * .23) * turbulence * .18
        // Localized knots create the pinched, almost geological silhouette.
        deformation += Math.pow(Math.max(0, Math.sin(angle * 5 - time * .16)), 5) * turbulence * .72
        for (const ripple of ripples) {
          const age = (now - ripple.born) / 760
          if (age >= 1) continue
          const delta = Math.atan2(Math.sin(angle - ripple.angle), Math.cos(angle - ripple.angle))
          const local = Math.exp(-(delta * delta) / .13) * Math.sin(age * Math.PI)
          deformation += local * ripple.strength * (ripple.type === 'in' ? 1 : -.7)
        }
        const pointRadius = radius + deformation
        const x = centerX + Math.cos(angle) * pointRadius; const y = centerY + Math.sin(angle) * pointRadius
        if (index === 0) bodyPath.moveTo(x, y); else bodyPath.lineTo(x, y)
      }
      bodyPath.closePath()

      context.save()
      context.translate(0, radius * .06)
      context.scale(1.04, .94)
      context.filter = `blur(${Math.max(8, radius * .09)}px)`
      context.fillStyle = '#00000082'
      context.fill(bodyPath)
      context.restore()

      context.save()
      context.shadowColor = '#000000b8'; context.shadowBlur = 28; context.shadowOffsetY = 12
      const body = context.createRadialGradient(centerX - radius * .28, centerY - radius * .34, radius * .02, centerX + radius * .08, centerY + radius * .12, radius * 1.14)
      body.addColorStop(0, '#6d7270'); body.addColorStop(.045, '#252827'); body.addColorStop(.19, '#0b0d0c'); body.addColorStop(.56, '#020303'); body.addColorStop(.82, '#101312'); body.addColorStop(1, '#010202')
      context.fillStyle = body; context.fill(bodyPath)
      context.shadowBlur = 0; context.shadowOffsetY = 0
      context.clip(bodyPath)

      // Dimples are built from a bright lip and an offset black core. Together
      // they read as deep folds in a reflective, viscous surface.
      const rotation = time * .018
      surfacePockets.forEach((pocket) => {
        const cosine = Math.cos(rotation); const sine = Math.sin(rotation)
        const px = pocket.x * cosine - pocket.y * sine
        const py = pocket.x * sine + pocket.y * cosine
        const pulse = 1 + Math.sin(time * .31 + pocket.phase) * .055
        const x = centerX + px * radius; const y = centerY + py * radius
        const size = pocket.size * radius * pulse
        context.save(); context.translate(x, y); context.rotate(pocket.tilt + rotation * .7); context.scale(pocket.stretch, 1)
        const lip = context.createRadialGradient(-size * .3, -size * .42, size * .03, 0, 0, size * 1.3)
        lip.addColorStop(0, `rgba(196,202,199,${.27 * pocket.depth})`)
        lip.addColorStop(.17, `rgba(57,62,60,${.7 * pocket.depth})`)
        lip.addColorStop(.48, `rgba(1,2,2,${.96 * pocket.depth})`)
        lip.addColorStop(.76, `rgba(3,4,4,${.7 * pocket.depth})`)
        lip.addColorStop(1, 'rgba(107,113,110,.08)')
        context.fillStyle = lip; context.beginPath(); context.arc(0, 0, size * 1.3, 0, Math.PI * 2); context.fill()
        context.strokeStyle = `rgba(190,196,193,${.08 + pocket.depth * .1})`; context.lineWidth = Math.max(.35, radius * .006)
        context.beginPath(); context.arc(-size * .05, -size * .08, size * .78, Math.PI * 1.02, Math.PI * 1.82); context.stroke()
        context.restore()
      })

      // Hairline ridges catch the key light and give the black material the
      // sharp, wet specular response visible in the reference.
      surfaceRidges.forEach((ridge) => {
        const angle = ridge.angle + rotation
        const inner = radius * (.08 + .1 * Math.sin(time * .22 + ridge.phase))
        const end = radius * ridge.reach
        const x1 = centerX + Math.cos(angle) * inner; const y1 = centerY + Math.sin(angle) * inner
        const x2 = centerX + Math.cos(angle + ridge.bend) * end; const y2 = centerY + Math.sin(angle + ridge.bend) * end
        const controlX = centerX + Math.cos(angle - ridge.bend * .7) * end * .62
        const controlY = centerY + Math.sin(angle - ridge.bend * .7) * end * .62
        context.lineCap = 'round'
        context.strokeStyle = '#000000d9'; context.lineWidth = radius * .028 * ridge.width
        context.beginPath(); context.moveTo(x1, y1); context.quadraticCurveTo(controlX, controlY, x2, y2); context.stroke()
        context.strokeStyle = '#d9dedb40'; context.lineWidth = Math.max(.45, radius * .005 * ridge.width)
        context.shadowColor = '#ffffff4d'; context.shadowBlur = radius * .025
        context.beginPath(); context.moveTo(x1 - radius * .008, y1 - radius * .01); context.quadraticCurveTo(controlX - radius * .008, controlY - radius * .01, x2 - radius * .006, y2 - radius * .009); context.stroke(); context.shadowBlur = 0
      })

      const reflection = context.createRadialGradient(centerX - radius * .43, centerY - radius * .48, 0, centerX - radius * .3, centerY - radius * .35, radius * .48)
      reflection.addColorStop(0, '#ffffff8f'); reflection.addColorStop(.08, '#dce1df4d'); reflection.addColorStop(.28, '#70767318'); reflection.addColorStop(1, '#0000')
      context.fillStyle = reflection; context.fillRect(centerX - radius * 1.2, centerY - radius * 1.2, radius * 2.4, radius * 2.4)
      context.restore()

      context.save(); context.strokeStyle = '#bbc1be38'; context.lineWidth = Math.max(.55, radius * .008); context.shadowColor = '#ffffff42'; context.shadowBlur = 5; context.stroke(bodyPath); context.restore()
    }

    const animate = (now) => {
      const delta = Math.min(2.3, (now - lastTime) / 16.67); lastTime = now
      context.clearRect(0, 0, width, height)
      const centerX = width * .53; const centerY = height * .49
      const maxRadius = Math.min(width, height) * .31
      const ratio = totalTvl > 0 ? Math.sqrt(Math.max(0, Math.min(1, selectedTvl / totalTvl))) : 0
      const targetRadius = maxRadius * (.42 + ratio * .58)
      radiusRef.current += (targetRadius - radiusRef.current) * .035 * delta
      const radius = radiusRef.current
      if (now >= nextIn) { spawn('in', radius, centerX, centerY); nextIn = now + Math.max(2400, 6240 / (1 + inflowEvents * .05)) + Math.random() * 1600 }
      if (now >= nextOut) { spawn('out', radius, centerX, centerY); nextOut = now + Math.max(3040, 8320 / (1 + outflowEvents * .05)) + Math.random() * 2080 }
      particles.forEach((particle) => {
        particle.trail.push({ x: particle.x, y: particle.y }); if (particle.trail.length > 7) particle.trail.shift()
        if (particle.type === 'in') {
          const xDistance = centerX - particle.x; const yDistance = centerY - particle.y; const distance = Math.max(1, Math.hypot(xDistance, yDistance))
          const force = .0034375 + Math.min(.015, 26.25 / (distance * distance))
          particle.vx = (particle.vx + xDistance / distance * force * delta) * .997; particle.vy = (particle.vy + yDistance / distance * force * delta) * .997
          particle.x += particle.vx * delta; particle.y += particle.vy * delta
          if (distance < radius * .88) { particle.dead = true; ripples.push({ angle: Math.atan2(particle.y - centerY, particle.x - centerX), born: now, type: 'in', strength: particle.size * 1.7 }) }
        } else {
          particle.vx *= Math.pow(.998, delta); particle.vy = particle.vy * Math.pow(.998, delta) + .00009375 * delta
          particle.x += particle.vx * delta; particle.y += particle.vy * delta
          if (particle.x < -30 || particle.x > width + 30 || particle.y < -30 || particle.y > height + 30) particle.dead = true
        }
        if (now - particle.born > 12000) particle.dead = true
      })
      particles = particles.filter((particle) => !particle.dead); ripples = ripples.filter((ripple) => now - ripple.born < 760)
      particles.filter((particle) => particle.type === 'in').forEach(drawDroplet)
      drawSphere(centerX, centerY, radius, now)
      particles.filter((particle) => particle.type === 'out').forEach(drawDroplet)
      frame = requestAnimationFrame(animate)
    }
    const initialCenterX = width * .53; const initialCenterY = height * .49; const initialRadius = radiusRef.current
    spawn('in', initialRadius, initialCenterX, initialCenterY)
    spawn('out', initialRadius, initialCenterX, initialCenterY)
    frame = requestAnimationFrame(animate)
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [selectedTvl, totalTvl, inflowEvents, outflowEvents])

  return <canvas ref={canvasRef} className="obsidianCanvas" role="img" aria-label={`${money(selectedTvl)} selected TVL, normalized against ${money(totalTvl)} across all protocols`} />
}

function ObsidianLiquidity({ selectedTvl, totalTvl, inflowEvents, outflowEvents }) {
  const mountRef = useRef(null)

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

    const ratio = totalTvl > 0 ? Math.max(0, Math.min(1, selectedTvl / totalTvl)) : 0
    // Radius follows the cube root of TVL because the blob represents volume.
    // Keep only a tiny visual floor so pools around $500 remain dramatically
    // smaller than million-dollar pools while still being discoverable.
    const targetScale = selectedTvl > 0 ? .07 + Math.cbrt(ratio) * .95 : 0
    blob.scale.setScalar(targetScale)
    const clock = new THREE.Clock()
    const motionSpeed = 10
    let frame
    const animate = (now) => {
      const delta = Math.min(.05, clock.getDelta())
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
      if (now >= nextIn && inflowEvents > 0) {
        spawnParticle('in', now)
        nextIn = now + Math.max(2100, 7200 / (1 + inflowEvents * .06)) + Math.random() * 1400
      }
      if (now >= nextOut && outflowEvents > 0) {
        spawnParticle('out', now)
        nextOut = now + Math.max(2700, 9000 / (1 + outflowEvents * .06)) + Math.random() * 1700
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
  }, [selectedTvl, totalTvl, inflowEvents, outflowEvents])

  return <div ref={mountRef} className="obsidianCanvas" role="img" aria-label={`${money(selectedTvl)} selected TVL, normalized against ${money(totalTvl)} across all protocols`} />
}

function LiquidityUniverse() {
  const [summary, setSummary] = useState({ loading: true, pools: [] })
  const [selectedPools, setSelectedPools] = useState(['privacycash', 'cloakc'])

  useEffect(() => {
    const controller = new AbortController()
    const load = () => Promise.allSettled(Object.keys(PROTOCOLS).map(async (protocol) => {
      const response = await fetch(`/api/analytics?protocol=${protocol}&interval=1d`, { signal: controller.signal }); if (!response.ok) throw new Error('Analytics request failed')
      return { protocol, data: await response.json() }
    })).then((results) => {
      if (controller.signal.aborted) return
      setSummary({ loading: false, pools: results.filter((result) => result.status === 'fulfilled').map((result) => {
        const { protocol, data } = result.value
        const state = data.poolState || EMPTY.poolState
        const price = (asset) => state.balances?.[asset] ? Number(state.usd?.[asset] || 0) / Number(state.balances[asset]) : 0
        const valueFlows = (groups) => groups.reduce((total, group) => total + ASSETS.reduce((assetTotal, asset) => assetTotal + Number(data.externalFlows?.[group]?.[asset] || 0) * price(asset), 0), 0)
        const inflow = valueFlows(['deposits', 'swapIn'])
        const outflow = valueFlows(['withdrawals', 'swapOut'])
        let inflowEvents = 0; let outflowEvents = 0
        for (const flow of data.recent || []) {
          if (flow.direction === 'deposit' || flow.flowType === 'deposit' || flow.flowType === 'swap_in') inflowEvents += 1
          if (flow.direction === 'withdraw' || flow.flowType === 'withdraw' || flow.flowType === 'swap_out') outflowEvents += 1
        }
        const tvl = Object.values(state.usd || {}).reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0)
        return { protocol, name: PROTOCOLS[protocol].name, tvl, inflow, outflow, inflowEvents, outflowEvents }
      }) })
    })
    load(); const timer = setInterval(load, 30_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [])

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
    <div className="poolSelector"><div className="poolGroup"><small>SOLANA NATIVE</small><div>{['privacycash', 'cloakc'].map(poolButton)}</div></div><div className="poolGroup others"><small>OTHERS</small><div>{['curvy'].map(poolButton)}</div></div></div>
  </section>
}

function ProtocolDashboard({ protocol, selectedEstimate, onSelectProtocol, onLaunchApp }) {
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
    <div className="analyticsProtocolTabs" aria-label="Analytics project">{Object.entries(PROTOCOLS).map(([id, item]) => <button type="button" className={protocol === id ? 'on' : ''} onClick={() => onSelectProtocol(id)} key={id}><ProtocolLogo protocol={id} name={item.name} /><span>{item.name}</span></button>)}</div>
    <section className={`notice ${error ? 'error' : ''}`}>{error ? <ShieldX /> : <ShieldCheck />}<span>{error || `Reading ${meta.name} data from the analytics database`}</span><b>{loading ? 'Loading' : error ? 'Error' : isBackfilling ? 'Partial' : 'Ready'}</b><em>{analytics.indexedAt ? `Indexed ${new Date(analytics.indexedAt * 1000).toLocaleString()}` : 'Run the backend indexer to update'}</em></section>
    {protocol === 'cloakc' && <section className="route panel"><span>PRIVATE SOL</span><ArrowRight /><b>JUPITER</b><ArrowRight /><span>PUBLIC USDC / USDT RECIPIENT</span><small>Two-stage Cloak TransactSwap flow</small></section>}
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

function App() {
  const getPage = () => window.location.pathname.replace(/\/+$/, '') === '/analytics' ? 'analytics' : 'home'
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
    if (!drawerOpen) return
    const closeOnEscape = (event) => { if (event.key === 'Escape') setDrawerOpen(false) }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', closeOnEscape) }
  }, [drawerOpen])
  function navigate(path) { window.history.pushState({}, '', path); setView(path.startsWith('/analytics') ? 'analytics' : 'home') }
  function openAnalytics(id = protocol) { setProtocol(id); setSelectedEstimate(null); if (view !== 'analytics') navigate('/analytics') }
  function closeDrawer() { setDrawerOpen(false) }
  function launchApp(event) { event.preventDefault(); closeDrawer(); navigate('/') }
  function openHome(event) { event.preventDefault(); closeDrawer(); navigate('/') }
  function openAnalyticsPage(event) { event.preventDefault(); closeDrawer(); openAnalytics(protocol) }
  const mobileNav = <>
    <MobileBar onOpen={() => setDrawerOpen(true)} />
    <Sidebar open={sidebarOpen} view={view} onToggle={() => setSidebarOpen(!sidebarOpen)} onHome={openHome} onAnalytics={openAnalyticsPage} onClose={closeDrawer} />
    {drawerOpen && <button className="drawerScrim" type="button" aria-label="Close navigation" onClick={closeDrawer} />}
  </>
  if (view === 'analytics') return <div className={`analyticsApp${drawerOpen ? ' drawerOpen' : ''}`}>{mobileNav}<main className="analyticsMain"><ProtocolDashboard protocol={protocol} selectedEstimate={selectedEstimate} onSelectProtocol={openAnalytics} onLaunchApp={launchApp} /></main></div>
  return <div className={`app ${sidebarOpen ? 'sidebarOpen' : 'sidebarClosed'}${drawerOpen ? ' drawerOpen' : ''}`}>{mobileNav}<main><PrivacyHome /></main></div>
}

createRoot(document.getElementById('root')).render(<App />)
