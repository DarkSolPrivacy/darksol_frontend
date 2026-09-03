import 'dotenv/config'
import dotenv from 'dotenv'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyPrivacyCashSwaps, databaseStats, getSyncState, readFlows, runMigrations, saveSyncState, storeIndexedData, storePoolSnapshot, storeTokenPrices } from './db.js'
import { importLocalSqlite } from './import-sqlite.js'
import { indexCurvy } from './curvy-indexer.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(root, '.env.local'), override: true, quiet: true })

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112'
const MINTS = {
  [NATIVE_SOL_MINT]: { symbol: 'SOL', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
}
const PRIVACY_CASH_SOL_DISCRIMINATOR = [217, 149, 130, 143, 221, 52, 252, 119]
const PRIVACY_CASH_SPL_DISCRIMINATOR = [154, 66, 244, 204, 78, 225, 163, 151]
const PROTOCOLS = {
  cloakc: {
    id: 'cloakc', name: 'CLOAKC', programId: 'zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW',
    docs: 'https://docs.cloak.ag/sdk/introduction',
  },
  privacycash: {
    id: 'privacycash', name: 'PrivacyCash', programId: '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD',
    docs: 'https://privacycash.mintlify.app/',
  },
  curvy: {
    id: 'curvy', name: 'Curvy', chain: 'arbitrum',
    docs: 'https://docs.curvy.box/',
  },
}
const PAGE_SIZE = 100
const SYNC_OVERLAP_SECONDS = 300

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

function accountKeysFor(tx) {
  const messageKeys = tx.transaction?.message?.accountKeys || []
  const staticKeys = messageKeys.map((key) => typeof key === 'string' ? key : key.pubkey)
  const loaded = tx.meta?.loadedAddresses || {}
  return [...staticKeys, ...(loaded.writable || []), ...(loaded.readonly || [])]
}

function readI64LE(bytes, offset) {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index])
  return value >= (1n << 63n) ? value - (1n << 64n) : value
}

function readU64LE(bytes, offset) {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index])
  return value
}

function matchesDiscriminator(data, discriminator) {
  return data.length >= discriminator.length && discriminator.every((byte, index) => data[index] === byte)
}

function tokenBalances(meta) {
  const balances = new Map()
  for (const entry of [...(meta?.preTokenBalances || []), ...(meta?.postTokenBalances || [])]) {
    if (!balances.has(entry.accountIndex)) balances.set(entry.accountIndex, {
      mint: entry.mint,
      decimals: entry.uiTokenAmount?.decimals ?? 0,
    })
  }
  return balances
}

function cloakAssetForInstruction(tx, instruction, keys) {
  const indexes = instruction.accounts || []
  const tokenProgram = indexes.length > 9 ? keys[indexes[9]] : undefined
  if (tokenProgram !== TOKEN_PROGRAM_ID) return { ...MINTS[NATIVE_SOL_MINT], mint: NATIVE_SOL_MINT }
  const balances = tokenBalances(tx.meta)
  for (const index of indexes) {
    const balance = balances.get(index)
    if (balance && MINTS[balance.mint]) return { ...MINTS[balance.mint], mint: balance.mint, decimals: balance.decimals }
  }
  return null
}

function tokenAccountOwner(meta, accountIndex) {
  const balances = [...(meta?.postTokenBalances || []), ...(meta?.preTokenBalances || [])]
  return balances.find((entry) => entry.accountIndex === accountIndex)?.owner
}

function cloakParticipant(tx, instruction, keys, direction) {
  const indexes = instruction.accounts || []
  if (direction === 'deposit') return Number.isInteger(indexes[0]) ? keys[indexes[0]] : 'unknown'
  const isSpl = indexes.length > 9 && keys[indexes[9]] === TOKEN_PROGRAM_ID
  if (isSpl && Number.isInteger(indexes[10])) return tokenAccountOwner(tx.meta, indexes[10]) || keys[indexes[10]] || 'unknown'
  return Number.isInteger(indexes[7]) ? keys[indexes[7]] : 'unknown'
}

function flowRecord(tx, instructionIndex, participant, direction, asset, absoluteAmount) {
  const signature = tx.transaction?.signatures?.[0] || 'unknown'
  return {
    id: `${signature}:${instructionIndex}`, signature, instructionIndex, timestamp: tx.blockTime,
    participant: participant || 'unknown', direction, asset: asset.symbol,
    amountRaw: absoluteAmount.toString(), decimals: asset.decimals,
    amount: Number(absoluteAmount) / (10 ** asset.decimals),
    flowType: direction, counterAsset: null, linkedFlowId: null,
  }
}

function encodedKnownAssets(data) {
  const buffer = Buffer.from(data)
  return Object.entries(MINTS)
    .filter(([mint]) => buffer.includes(Buffer.from(bs58.decode(mint))))
    .map(([, asset]) => asset.symbol)
}

function parseCloakInstruction(tx, instruction, keys, instructionIndex) {
  const programId = instruction.programId || keys[instruction.programIdIndex]
  if (programId !== PROTOCOLS.cloakc.programId || !instruction.data) return null
  let data
  try { data = bs58.decode(instruction.data) } catch { return null }
  if (data.length < 521 || (data[0] !== 0 && data[0] !== 1)) return null
  const publicAmount = readI64LE(data, 1 + 256 + 32)
  if (publicAmount === 0n) return null
  const isSwap = data[0] === 1
  const asset = isSwap ? { ...MINTS[NATIVE_SOL_MINT], mint: NATIVE_SOL_MINT } : cloakAssetForInstruction(tx, instruction, keys)
  if (!asset) return null
  const direction = isSwap ? 'withdraw' : publicAmount > 0n ? 'deposit' : 'withdraw'
  const absoluteAmount = publicAmount > 0n ? publicAmount : -publicAmount
  const flow = flowRecord(tx, instructionIndex, cloakParticipant(tx, instruction, keys, direction), direction, asset, absoluteAmount)
  if (isSwap) {
    flow.flowType = 'swap_out'
    flow.counterAsset = encodedKnownAssets(data).find((symbol) => symbol !== 'SOL') || null
  }
  return flow
}

function parsePrivacyCashInstruction(tx, instruction, keys, instructionIndex) {
  const programId = instruction.programId || keys[instruction.programIdIndex]
  if (programId !== PROTOCOLS.privacycash.programId || !instruction.data) return null
  let data
  try { data = bs58.decode(instruction.data) } catch { return null }
  const isSol = matchesDiscriminator(data, PRIVACY_CASH_SOL_DISCRIMINATOR)
  const isSpl = matchesDiscriminator(data, PRIVACY_CASH_SPL_DISCRIMINATOR)
  if ((!isSol && !isSpl) || data.length < 504) return null
  // discriminator[8] + proof A/B/C[256] + seven 32-byte public fields.
  // The signed extAmount is the actual amount entering/leaving the public pool.
  const extAmount = readI64LE(data, 8 + 256 + (7 * 32))
  if (extAmount === 0n) return null
  const chargedFee = readU64LE(data, 8 + 256 + (7 * 32) + 8)
  const indexes = instruction.accounts || []
  const asset = isSol ? MINTS[NATIVE_SOL_MINT] : MINTS[keys[indexes[7]]]
  if (!asset) return null
  const direction = extAmount > 0n ? 'deposit' : 'withdraw'
  let participant
  if (direction === 'deposit') participant = keys[indexes[isSol ? 9 : 6]]
  else if (isSol) participant = keys[indexes[7]]
  else participant = tokenAccountOwner(tx.meta, indexes[10]) || keys[indexes[9]] || keys[indexes[10]]
  const recipientAmount = extAmount > 0n ? extAmount : -extAmount
  const poolAmount = direction === 'withdraw' ? recipientAmount + chargedFee : recipientAmount
  return flowRecord(tx, instructionIndex, participant, direction, asset, poolAmount)
}

function flowsFromTransaction(protocol, tx) {
  if (!tx?.blockTime || tx.meta?.err) return []
  const keys = accountKeysFor(tx)
  const parse = protocol === 'privacycash' ? parsePrivacyCashInstruction : parseCloakInstruction
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
  const decodedFlows = transactions.flatMap((transaction) => flowsFromTransaction(protocol, transaction))
  await storeIndexedData(protocol, transactions, decodedFlows)
  const times = transactions.map(({ blockTime }) => blockTime).filter(Number.isFinite)
  const earliest = times.length ? Math.min(...times) : null
  const latest = times.length ? Math.max(...times) : null
  const matchedSwaps = protocol === 'privacycash' && earliest !== null
    ? await classifyPrivacyCashSwaps(earliest, latest)
    : 0
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

function associatedTokenAddress(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0]
}

async function privacyCashPoolBalances() {
  const program = new PublicKey(PROTOCOLS.privacycash.programId)
  const [solPool] = PublicKey.findProgramAddressSync([Buffer.from('tree_token')], program)
  const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from('global_config')], program)
  const mintFor = (symbol) => new PublicKey(Object.keys(MINTS).find((mint) => MINTS[mint].symbol === symbol))
  const usdcAta = associatedTokenAddress(globalConfig, mintFor('USDC'))
  const usdtAta = associatedTokenAddress(globalConfig, mintFor('USDT'))
  const [sol, usdc, usdt] = await Promise.all([
    rpc('getBalance', [solPool.toBase58(), { commitment: 'finalized' }]),
    rpc('getTokenAccountBalance', [usdcAta.toBase58(), { commitment: 'finalized' }]),
    rpc('getTokenAccountBalance', [usdtAta.toBase58(), { commitment: 'finalized' }]),
  ])
  return {
    SOL: Number(sol?.value || 0) / 1e9,
    USDC: Number(usdc?.value?.amount || 0) / 1e6,
    USDT: Number(usdt?.value?.amount || 0) / 1e6,
  }
}

async function indexedPoolBalances(protocol, now) {
  const balances = { USDC: 0, SOL: 0, USDT: 0 }
  for (const flow of await readFlows(protocol, 0, now)) {
    balances[flow.asset] += (flow.direction === 'deposit' ? 1 : -1) * flow.amount
  }
  return balances
}

async function indexProtocol(protocol, verbose = false, maxBackfillPages = Infinity) {
  if (!PROTOCOLS[protocol]) throw new Error('protocol must be cloakc or privacycash')
  const now = Math.floor(Date.now() / 1000)
  const backfill = await ensureCompleteHistory(protocol, now, verbose, maxBackfillPages)
  const stateAfterBackfill = await getSyncState(protocol)
  const incremental = stateAfterBackfill?.historyComplete
    ? await catchUp(protocol, Math.floor(Date.now() / 1000))
    : { skipped: true, reason: 'historical backfill is incomplete' }
  const balances = protocol === 'privacycash' ? await privacyCashPoolBalances() : await indexedPoolBalances(protocol, now)
  await storePoolSnapshot(protocol, balances, now)
  const state = await getSyncState(protocol)
  const storage = await databaseStats(protocol)
  return {
    protocol, mode: backfill.pages
      ? (state?.historyComplete ? 'backfill+incremental' : 'backfill')
      : 'incremental',
    backfill, incremental, historyComplete: Boolean(state?.historyComplete),
    syncedThrough: state?.syncedThrough, snapshot: balances,
    classifiedSwaps: storage.swaps, storage,
  }
}

async function updateTokenPrices() {
  const prices = {}
  for (const [mint, asset] of Object.entries(MINTS)) {
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
const selectedProtocols = selectedProtocol === 'all' ? Object.keys(PROTOCOLS) : [selectedProtocol]
if (!selectedProtocols.every((protocol) => PROTOCOLS[protocol])) throw new Error('protocol must be cloakc, privacycash, curvy, or all')
if (!Number.isFinite(watchSeconds) || watchSeconds < 0) throw new Error('watch interval must be a positive number of seconds')
if (!(maxBackfillPages === Infinity || (Number.isInteger(maxBackfillPages) && maxBackfillPages > 0))) throw new Error('max-backfill-pages must be a positive integer')

async function runCycle() {
  const solanaProtocols = selectedProtocols.filter((protocol) => protocol !== 'curvy')
  const solanaLane = (async () => {
    const prices = await updateTokenPrices()
    console.log(JSON.stringify({ indexedAt: new Date().toISOString(), lane: 'solana', tokenPrices: prices }))
    for (const protocol of solanaProtocols) {
      const result = await indexProtocol(protocol, devMode, maxBackfillPages)
      console.log(JSON.stringify({ indexedAt: new Date().toISOString(), lane: 'solana', ...result }))
    }
  })()
  const arbitrumLane = selectedProtocols.includes('curvy')
    ? indexCurvy().then((result) => {
      console.log(JSON.stringify({ indexedAt: new Date().toISOString(), lane: 'arbitrum', ...result }))
    })
    : Promise.resolve()
  await Promise.all([solanaLane, arbitrumLane])
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
