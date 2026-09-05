import 'dotenv/config'
import dotenv from 'dotenv'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { databaseStats, getSyncState, pruneFlows, readFlowBaseline, readFlows, runMigrations, saveSyncState, storeIndexedData, storePoolSnapshot, storeTokenPrices } from './db.js'
import { importLocalSqlite } from './import-sqlite.js'
import { PROTOCOLS, PROTOCOL_IDS, listProtocols } from '../protocols/registry.js'
import { loadIndexer } from '../protocols/load.js'
import { ASSETS_BY_MINT, accountKeysFor } from '../protocols/shared/solana-flows.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(root, '.env.local'), override: true, quiet: true })

// Which lane a protocol belongs to is declared in its manifest, so the indexer
// no longer names curvy to tell the two apart.
const SOLANA_PROTOCOL_IDS = listProtocols({ lane: 'solana' }).map(({ id }) => id)
const EVM_PROTOCOL_IDS = listProtocols({ lane: 'evm' }).map(({ id }) => id)

const PAGE_SIZE = 100
const SYNC_OVERLAP_SECONDS = 300
// The dashboard's longest range is 90 days; the extra days keep the oldest
// bucket whole and leave room for a late-arriving backfill page.
const RETENTION_DAYS = Number(process.env.FLOW_RETENTION_DAYS || 100)

const HELIUS_ONLY_METHODS = new Set(['getAsset', 'getTransactionsForAddress'])

function rpcUrl(method) {
  if (!HELIUS_ONLY_METHODS.has(method)) {
    return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
  }
  if (!process.env.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is not configured')
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY)}`
}

async function rpc(method, params) {
  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(rpcUrl(method), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
        signal: AbortSignal.timeout(25_000),
      })
      if (!response.ok) {
        const provider = HELIUS_ONLY_METHODS.has(method) ? 'Helius' : 'Solana RPC'
        const error = new Error(`${provider} returned HTTP ${response.status}`)
        error.retryable = response.status === 429 || response.status >= 500
        throw error
      }
      const payload = await response.json()
      if (payload.error) {
        const error = new Error(payload.error.message || 'Helius RPC error')
        error.retryable = /rate|limit|busy|timeout|temporar/i.test(error.message)
        throw error
      }
      return payload.result
    } catch (error) {
      lastError = error
      if (attempt === 4 || error.retryable === false) break
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(8000, 500 * (2 ** attempt))))
    }
  }
  throw lastError
}

async function getTransactionPage(programId, from, to, paginationToken) {
  const options = {
    transactionDetails: 'full', encoding: 'json', maxSupportedTransactionVersion: 0,
    sortOrder: 'desc', limit: PAGE_SIZE, commitment: 'finalized',
    filters: { blockTime: { gte: from, lte: to }, status: 'succeeded' },
  }
  if (paginationToken) options.paginationToken = paginationToken
  const result = await rpc('getTransactionsForAddress', [programId, options])
  return { transactions: result?.data || [], paginationToken: result?.paginationToken || null }
}

// Each protocol owns its decoder; this only walks the instruction tree.
async function flowsFromTransaction(protocol, tx) {
  if (!tx?.blockTime || tx.meta?.err) return []
  const keys = accountKeysFor(tx)
  const { decode: parse } = await loadIndexer(protocol)
  const outer = tx.transaction?.message?.instructions || []
  const flows = outer.map((ix, index) => parse(tx, ix, keys, `o${index}`)).filter(Boolean)
  for (const group of tx.meta?.innerInstructions || []) {
    group.instructions?.forEach((ix, index) => {
      const flow = parse(tx, ix, keys, `i${group.index}-${index}`)
      if (flow) flows.push(flow)
    })
  }
  return flows
}

async function persistTransactionPage(protocol, transactions) {
  if (!transactions.length) return { transactions: 0, flows: 0, earliest: null, latest: null, matchedSwaps: 0 }
  const perTransaction = await Promise.all(transactions.map((transaction) => flowsFromTransaction(protocol, transaction)))
  const decodedFlows = perTransaction.flat()
  await storeIndexedData(protocol, transactions, decodedFlows)
  const times = transactions.map(({ blockTime }) => blockTime).filter(Number.isFinite)
  const earliest = times.length ? Math.min(...times) : null
  const latest = times.length ? Math.max(...times) : null
  const { postProcess } = await loadIndexer(protocol)
  const matchedSwaps = postProcess && earliest !== null ? await postProcess({ earliest, latest }) : 0
  return { transactions: transactions.length, flows: decodedFlows.length, earliest, latest, matchedSwaps }
}

async function ensureCompleteHistory(protocol, now, verbose = false, maxPages = Infinity) {
  const config = PROTOCOLS[protocol]
  let state = await getSyncState(protocol)
  if (state?.historyComplete && (await databaseStats(protocol)).transactions > 0) {
    return { pages: 0, transactions: 0, flows: 0, resumed: false, complete: true }
  }

  const resumed = Boolean(state?.backfillCursor || state?.backfilledFrom)
  const upperBound = state?.backfillUpperBound
    // Keep the legacy boundary inclusive. Re-reading that second is cheap and
    // avoids missing another transaction with the same block timestamp.
    ?? (state?.backfilledFrom ? state.backfilledFrom : now)
  let paginationToken = state?.backfillCursor || null
  let earliest = state?.backfilledFrom ?? upperBound
  let pages = 0
  let transactions = 0
  let flows = 0

  do {
    const page = await getTransactionPage(config.programId, 0, upperBound, paginationToken)
    const stored = await persistTransactionPage(protocol, page.transactions)
    pages += 1
    transactions += stored.transactions
    flows += stored.flows
    if (stored.earliest !== null) earliest = Math.min(earliest, stored.earliest)
    paginationToken = page.paginationToken
    state = await saveSyncState(protocol, {
      backfilledFrom: paginationToken ? earliest : 0,
      syncedThrough: state?.syncedThrough ?? now,
      historyComplete: !paginationToken,
      backfillCursor: paginationToken,
      backfillUpperBound: paginationToken ? upperBound : null,
    })
    if (verbose || pages % 10 === 0 || !paginationToken) {
      console.log(JSON.stringify({ phase: 'backfill', protocol, pages, transactions, historyComplete: !paginationToken }))
    }
    if (pages >= maxPages && paginationToken) break
  } while (paginationToken)

  return { pages, transactions, flows, resumed, complete: !paginationToken }
}

async function catchUp(protocol, now) {
  const config = PROTOCOLS[protocol]
  const state = await getSyncState(protocol)
  const resuming = Boolean(state?.incrementalCursor && state?.incrementalFrom !== null && state?.incrementalTo !== null)
  const from = resuming ? state.incrementalFrom : Math.max(0, (state?.syncedThrough ?? now) - SYNC_OVERLAP_SECONDS)
  const to = resuming ? state.incrementalTo : now
  let paginationToken = resuming ? state.incrementalCursor : null
  let pages = 0
  let transactions = 0
  let flows = 0
  do {
    const page = await getTransactionPage(config.programId, from, to, paginationToken)
    const stored = await persistTransactionPage(protocol, page.transactions)
    pages += 1
    transactions += stored.transactions
    flows += stored.flows
    paginationToken = page.paginationToken
    await saveSyncState(protocol, paginationToken ? {
      incrementalCursor: paginationToken, incrementalFrom: from, incrementalTo: to,
    } : {
      syncedThrough: to, incrementalCursor: null, incrementalFrom: null, incrementalTo: null,
    })
  } while (paginationToken)
  return { from, to, pages, transactions, flows, resumed: resuming }
}

// Retained flows only cover the recent window, so the running balance starts
// from the baseline holding everything already pruned.
async function indexedPoolBalances(protocol, now) {
  const baseline = await readFlowBaseline(protocol)
  const balances = Object.fromEntries(['USDC', 'SOL', 'USDT'].map((asset) => [asset, baseline[asset]?.net || 0]))
  for (const flow of await readFlows(protocol, 0, now)) {
    balances[flow.asset] += (flow.direction === 'deposit' ? 1 : -1) * flow.amount
  }
  return balances
}

async function indexProtocol(protocol, verbose = false, maxBackfillPages = Infinity) {
  if (PROTOCOLS[protocol]?.indexer.lane !== 'solana') throw new Error(`protocol must be one of: ${SOLANA_PROTOCOL_IDS.join(', ')}`)
  const now = Math.floor(Date.now() / 1000)
  const backfill = await ensureCompleteHistory(protocol, now, verbose, maxBackfillPages)
  const stateAfterBackfill = await getSyncState(protocol)
  const incremental = stateAfterBackfill?.historyComplete
    ? await catchUp(protocol, Math.floor(Date.now() / 1000))
    : { skipped: true, reason: 'historical backfill is incomplete' }
  const { poolBalances } = await loadIndexer(protocol)
  const balances = poolBalances ? await poolBalances(rpc) : await indexedPoolBalances(protocol, now)
  await storePoolSnapshot(protocol, balances, now)
  // Pruning follows the snapshot so the balance is banked before the rows
  // behind it move into the baseline.
  const pruned = await pruneFlows(protocol, now - RETENTION_DAYS * 86400)
  const state = await getSyncState(protocol)
  const storage = await databaseStats(protocol)
  return {
    protocol, mode: backfill.pages
      ? (state?.historyComplete ? 'backfill+incremental' : 'backfill')
      : 'incremental',
    backfill, incremental, historyComplete: Boolean(state?.historyComplete),
    syncedThrough: state?.syncedThrough, snapshot: balances,
    retentionDays: RETENTION_DAYS, pruned: pruned.pruned,
    classifiedSwaps: storage.swaps, storage,
  }
}

async function updateTokenPrices() {
  const prices = {}
  for (const [mint, asset] of Object.entries(ASSETS_BY_MINT)) {
    try {
      const result = await rpc('getAsset', { id: mint, displayOptions: { showFungible: true } })
      const price = Number(result?.token_info?.price_info?.price_per_token)
      if (Number.isFinite(price) && price > 0) prices[asset.symbol] = price
    } catch (error) {
      console.warn(`Price unavailable for ${asset.symbol}: ${error.message}`)
    }
  }
  await storeTokenPrices(prices)
  return prices
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return !value || value.startsWith('--') ? fallback : value
}

const selectedProtocol = argument('protocol', 'all').toLowerCase()
const devMode = process.argv.includes('--dev') || process.env.NODE_ENV === 'development'
const maxBackfillPages = Number(argument('max-backfill-pages', Infinity))
const watchIndex = process.argv.indexOf('--watch')
const watchArgument = process.argv[watchIndex + 1]
const defaultWatchSeconds = devMode ? 30 : 300
const watchSeconds = watchIndex === -1 ? 0 : Number(!watchArgument || watchArgument.startsWith('--') ? defaultWatchSeconds : watchArgument)
const selectedProtocols = selectedProtocol === 'all' ? [...PROTOCOL_IDS] : [selectedProtocol]
if (!selectedProtocols.every((protocol) => PROTOCOLS[protocol])) throw new Error(`protocol must be one of: ${PROTOCOL_IDS.join(', ')}, or all`)
if (!Number.isFinite(watchSeconds) || watchSeconds < 0) throw new Error('watch interval must be a positive number of seconds')
if (!(maxBackfillPages === Infinity || (Number.isInteger(maxBackfillPages) && maxBackfillPages > 0))) throw new Error('max-backfill-pages must be a positive integer')

async function runCycle() {
  const solanaProtocols = selectedProtocols.filter((protocol) => SOLANA_PROTOCOL_IDS.includes(protocol))
  const solanaLane = (async () => {
    const prices = await updateTokenPrices()
    console.log(JSON.stringify({ indexedAt: new Date().toISOString(), lane: 'solana', tokenPrices: prices }))
    for (const protocol of solanaProtocols) {
      const result = await indexProtocol(protocol, devMode, maxBackfillPages)
      console.log(JSON.stringify({ indexedAt: new Date().toISOString(), lane: 'solana', ...result }))
    }
  })()
  // Each EVM-lane protocol runs its own indexer; the loop replaces what used to
  // be a hardcoded call to Curvy's.
  const evmLanes = selectedProtocols
    .filter((protocol) => EVM_PROTOCOL_IDS.includes(protocol))
    .map(async (protocol) => {
      const { run } = await loadIndexer(protocol)
      const result = await run()
      console.log(JSON.stringify({ indexedAt: new Date().toISOString(), lane: PROTOCOLS[protocol].chain, ...result }))
    })
  await Promise.all([solanaLane, ...evmLanes])
}

console.log(JSON.stringify({ indexerMode: devMode ? 'development' : 'production', watchSeconds, protocols: selectedProtocols }))

// Bring Supabase up to date before the first cycle: apply any pending schema
// change, then copy across whatever the local SQLite database still holds that
// Supabase does not. Both steps are no-ops once the two are level, so the watch
// loop starts streaming immediately on every later run.
const migrated = await runMigrations({ verbose: devMode })
if (migrated.length) console.log(JSON.stringify({ phase: 'migrate', applied: migrated }))
const imported = await importLocalSqlite({ resync: process.argv.includes('--resync'), verbose: true })
console.log(JSON.stringify({ phase: 'local_sync', ...imported }))

do {
  try {
    await runCycle()
  } catch (error) {
    if (!watchSeconds) throw error
    console.error(JSON.stringify({
      indexedAt: new Date().toISOString(), phase: 'cycle_error',
      retryable: error?.retryable !== false,
      error: error instanceof Error ? error.message : String(error),
      retryInSeconds: watchSeconds,
    }))
  }
  if (!watchSeconds) break
  const periodMs = watchSeconds * 1000
  const waitMs = periodMs - (Date.now() % periodMs)
  await new Promise((resolveWait) => setTimeout(resolveWait, waitMs))
} while (true)
