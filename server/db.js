import pg from 'pg'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// block_time, slot and indexed_at are bigint columns whose values stay well
// inside Number.MAX_SAFE_INTEGER, and every consumer treats them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, Number)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number)

function connectionString() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!url) {
    throw new Error('SUPABASE_DB_URL is not configured. Copy the direct connection string from Supabase > Connect > Direct connection into .env.local and the Vercel project environment.')
  }
  return url
}

// Built on first use rather than at import time: every entry point loads
// .env.local in its module body, which runs after this module is evaluated.
let poolInstance = null
function pool() {
  if (!poolInstance) {
    const url = connectionString()
    poolInstance = new pg.Pool({
      connectionString: url,
      // Supabase terminates TLS with its own CA, which Node does not ship. A
      // loopback URL is a local Postgres, which serves no certificate at all.
      ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false },
      max: Number(process.env.SUPABASE_POOL_MAX || 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    })
  }
  return poolInstance
}

// The statements below use @named parameters so they stay readable next to the
// object literals that fill them; this rewrites those into pg's $n placeholders.
const NAMED = /@([a-zA-Z_][a-zA-Z0-9_]*)/g
function bind(text, params) {
  if (params === undefined || Array.isArray(params)) return { text, values: params || [] }
  const values = []
  const order = new Map()
  const rewritten = text.replace(NAMED, (_match, name) => {
    if (!order.has(name)) {
      if (!Object.hasOwn(params, name)) throw new Error(`Missing bind parameter @${name}`)
      values.push(params[name])
      order.set(name, values.length)
    }
    return `$${order.get(name)}`
  })
  return { text: rewritten, values }
}

function run(executor, text, params) {
  const { text: sql, values } = bind(text, params)
  return executor().query(sql, values)
}

function scope(executor) {
  return {
    query: (text, params) => run(executor, text, params),
    all: async (text, params) => (await run(executor, text, params)).rows,
    get: async (text, params) => (await run(executor, text, params)).rows[0],
  }
}

export const db = {
  ...scope(pool),
  exec: (text) => pool().query(text),
  close: () => poolInstance ? poolInstance.end() : Promise.resolve(),
  // Runs `operation` against a single checked-out client inside one
  // transaction, passing that client through so interleaved reads and writes
  // never observe a half-applied batch from another connection.
  transaction: async (operation) => {
    const client = await pool().connect()
    try {
      await client.query('BEGIN')
      const result = await operation(scope(() => client))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  },
}

const migrationsPath = resolve(root, 'supabase/migrations')

export async function runMigrations({ verbose = false } = {}) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint)')
  if (!existsSync(migrationsPath)) return []
  const applied = []
  for (const name of readdirSync(migrationsPath).filter((file) => file.endsWith('.sql')).sort()) {
    if (await db.get('SELECT 1 FROM schema_migrations WHERE name = $1', [name])) continue
    const sql = readFileSync(resolve(migrationsPath, name), 'utf8')
    await db.transaction(async (tx) => {
      await tx.query(sql)
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
    })
    applied.push(name)
    if (verbose) console.log(`applied ${name}`)
  }
  return applied
}

export function readAppliedMigrations() {
  return db.all('SELECT name, applied_at AS "appliedAt" FROM schema_migrations ORDER BY name')
}

const UPSERT_TRANSACTION = `
  INSERT INTO source_transactions (signature, slot, block_time, status, payload_json, protocol)
  VALUES (@signature, @slot, @blockTime, 'succeeded', @payload, @protocol)
  ON CONFLICT(signature) DO UPDATE SET
    slot = excluded.slot,
    block_time = excluded.block_time,
    status = excluded.status,
    payload_json = excluded.payload_json,
    protocol = excluded.protocol,
    indexed_at = EXTRACT(EPOCH FROM now())::bigint
`

const UPSERT_DEPOSIT = `
  INSERT INTO deposits (id, signature, instruction_index, block_time, depositor, asset, amount_raw, decimals, amount)
  VALUES (@id, @signature, @instructionIndex, @timestamp, @depositor, @asset, @amountRaw, @decimals, @amount)
  ON CONFLICT(id) DO UPDATE SET
    block_time = excluded.block_time,
    depositor = excluded.depositor,
    asset = excluded.asset,
    amount_raw = excluded.amount_raw,
    decimals = excluded.decimals,
    amount = excluded.amount,
    indexed_at = EXTRACT(EPOCH FROM now())::bigint
`

const UPSERT_FLOW = `
  INSERT INTO pool_flows (id, signature, instruction_index, block_time, participant, direction, asset, amount_raw, decimals, amount, protocol, flow_type, counter_asset, linked_flow_id)
  VALUES (@id, @signature, @instructionIndex, @timestamp, @participant, @direction, @asset, @amountRaw, @decimals, @amount, @protocol, @flowType, @counterAsset, @linkedFlowId)
  ON CONFLICT(id) DO UPDATE SET
    block_time = excluded.block_time,
    participant = excluded.participant,
    direction = excluded.direction,
    asset = excluded.asset,
    amount_raw = excluded.amount_raw,
    decimals = excluded.decimals,
    amount = excluded.amount,
    protocol = excluded.protocol,
    flow_type = excluded.flow_type,
    counter_asset = excluded.counter_asset,
    linked_flow_id = excluded.linked_flow_id,
    indexed_at = EXTRACT(EPOCH FROM now())::bigint
`

// Shared by the live indexer and the one-time SQLite import so both write
// through exactly the same upsert and replacement rules.
export async function persistFlowBatch(tx, protocol, transactions, flows) {
  for (const transaction of transactions) {
    await tx.query(UPSERT_TRANSACTION, transaction)
    await tx.query('DELETE FROM pool_flows WHERE protocol = @protocol AND signature = @signature', {
      protocol, signature: transaction.signature,
    })
    if (protocol === 'cloakc') await tx.query('DELETE FROM deposits WHERE signature = $1', [transaction.signature])
  }
  for (const flow of flows) {
    await tx.query(UPSERT_FLOW, { ...flow, protocol })
    if (protocol === 'cloakc' && flow.direction === 'deposit') {
      await tx.query(UPSERT_DEPOSIT, {
        id: flow.id,
        signature: flow.signature,
        instructionIndex: flow.instructionIndex,
        timestamp: flow.timestamp,
        depositor: flow.participant,
        asset: flow.asset,
        amountRaw: flow.amountRaw,
        decimals: flow.decimals,
        amount: flow.amount,
      })
    }
  }
}

// The raw payloads are ~95% of this dataset's bytes and nothing in the
// dashboard reads them back, so they can be dropped to keep a hosted Postgres
// small. Off by default: the payloads are the only re-decodable record of a
// transaction, so discarding them means a decoder change needs a re-index.
export const skipPayloads = () => process.env.SUPABASE_SKIP_PAYLOADS === '1'

export async function storeIndexedData(protocol, transactions, flows) {
  const rows = transactions
    .map((transaction) => ({
      signature: transaction.transaction?.signatures?.[0] || transaction.hash,
      slot: transaction.slot ?? transaction.blockNumber,
      blockTime: transaction.blockTime,
      payload: skipPayloads() ? '' : JSON.stringify(transaction),
      protocol,
    }))
    .filter(({ signature, blockTime }) => signature && blockTime)
  if (!rows.length && !flows.length) return
  await db.transaction((tx) => persistFlowBatch(tx, protocol, rows, flows))
}

export function readDeposits(from, to) {
  return db.all(`
    SELECT id, signature, instruction_index AS "instructionIndex", block_time AS timestamp,
      depositor, asset, amount_raw AS "amountRaw", decimals, amount
    FROM deposits
    WHERE block_time >= $1 AND block_time <= $2
    ORDER BY block_time DESC
  `, [from, to])
}

export function readFlows(protocol, from, to) {
  return db.all(`
    SELECT id, signature, instruction_index AS "instructionIndex", block_time AS timestamp,
      participant, direction, COALESCE(flow_type, direction) AS "flowType",
      asset, counter_asset AS "counterAsset", linked_flow_id AS "linkedFlowId",
      amount_raw AS "amountRaw", decimals, amount
    FROM pool_flows
    WHERE protocol = $1 AND block_time >= $2 AND block_time <= $3
    ORDER BY block_time DESC
  `, [protocol, from, to])
}

export function readPlanningFlows(protocol, asset, from, to) {
  return db.all(`
    SELECT id, signature, block_time AS timestamp, participant, direction,
      COALESCE(flow_type, direction) AS "flowType", asset,
      counter_asset AS "counterAsset", linked_flow_id AS "linkedFlowId",
      amount_raw AS "amountRaw", decimals, amount
    FROM pool_flows
    WHERE protocol = $1 AND asset = $2 AND block_time BETWEEN $3 AND $4
    ORDER BY block_time DESC
  `, [protocol, asset, from, to])
}

export function readProtocolHistoryBounds(protocol) {
  return db.get(`
    SELECT MIN(block_time) AS earliest, MAX(block_time) AS latest,
      COUNT(*)::int AS "transactionCount"
    FROM source_transactions
    WHERE protocol = $1
  `, [protocol])
}

export async function readLinkedFlowLatencies(protocol, from, to) {
  const rows = await db.all(`
    SELECT incoming.block_time - outgoing.block_time AS seconds
    FROM pool_flows AS outgoing
    JOIN pool_flows AS incoming ON incoming.id = outgoing.linked_flow_id
    WHERE outgoing.protocol = $1 AND outgoing.flow_type = 'swap_out'
      AND outgoing.block_time BETWEEN $2 AND $3
      AND incoming.block_time >= outgoing.block_time
      AND incoming.block_time - outgoing.block_time <= 3600
    ORDER BY seconds
  `, [protocol, from, to])
  return rows.map(({ seconds }) => Number(seconds))
}

export function classifyPrivacyCashSwaps(from = 0, to = Number.MAX_SAFE_INTEGER, maxGapSeconds = 120, settledThrough = Math.floor(Date.now() / 1000)) {
  return db.transaction(async (tx) => {
    const affected = await tx.all(`
      SELECT id, linked_flow_id AS "linkedFlowId", block_time AS timestamp
      FROM pool_flows
      WHERE protocol = 'privacycash' AND block_time BETWEEN $1 AND $2
    `, [from, to])
    if (!affected.length) return 0

    const resetIds = new Set(affected.flatMap(({ id, linkedFlowId }) => linkedFlowId ? [id, linkedFlowId] : [id]))
    for (const { id } of await tx.all(`
      SELECT id FROM pool_flows
      WHERE protocol = 'privacycash' AND linked_flow_id = ANY($1)
    `, [[...resetIds]])) resetIds.add(id)

    const lower = Math.max(0, Math.min(...affected.map(({ timestamp }) => timestamp)) - maxGapSeconds)
    const upper = Math.max(...affected.map(({ timestamp }) => timestamp)) + maxGapSeconds
    const flows = await tx.all(`
      SELECT id, block_time AS timestamp, participant, direction, asset,
        linked_flow_id AS "linkedFlowId"
      FROM pool_flows
      WHERE protocol = 'privacycash' AND block_time BETWEEN $1 AND $2
      ORDER BY block_time ASC
    `, [lower, upper])
    // A withdrawal is only settled after its complete forward matching window
    // has elapsed, so a later deposit cannot change an already emitted result.
    const withdrawals = flows.filter(({ direction, timestamp }) => direction === 'withdraw' && timestamp <= settledThrough - maxGapSeconds)
    const depositsByParticipant = new Map()
    for (const flow of flows) {
      if (flow.direction !== 'deposit') continue
      if (!depositsByParticipant.has(flow.participant)) depositsByParticipant.set(flow.participant, [])
      depositsByParticipant.get(flow.participant).push(flow)
    }
    const candidates = []
    for (const outgoing of withdrawals) {
      for (const incoming of depositsByParticipant.get(outgoing.participant) || []) {
        const gap = incoming.timestamp - outgoing.timestamp
        if (gap < 0 || gap > maxGapSeconds || incoming.asset === outgoing.asset) continue
        if (!resetIds.has(outgoing.id) && !resetIds.has(incoming.id)) continue
        candidates.push({ outgoing, incoming, gap })
      }
    }
    candidates.sort((a, b) => a.gap - b.gap)
    const used = new Set(flows.filter(({ id, linkedFlowId }) => linkedFlowId && !resetIds.has(id)).map(({ id }) => id))
    const matches = candidates.filter(({ outgoing, incoming }) => {
      if (used.has(outgoing.id) || used.has(incoming.id)) return false
      used.add(outgoing.id); used.add(incoming.id); return true
    })
    await tx.query(`
      UPDATE pool_flows SET flow_type = direction, counter_asset = NULL, linked_flow_id = NULL
      WHERE protocol = 'privacycash' AND id = ANY($1)
    `, [[...resetIds]])
    for (const { outgoing, incoming } of matches) {
      await tx.query('UPDATE pool_flows SET flow_type = $1, counter_asset = $2, linked_flow_id = $3 WHERE id = $4', ['swap_out', incoming.asset, incoming.id, outgoing.id])
      await tx.query('UPDATE pool_flows SET flow_type = $1, counter_asset = $2, linked_flow_id = $3 WHERE id = $4', ['swap_in', outgoing.asset, outgoing.id, incoming.id])
    }
    return matches.length
  })
}

export async function readSourceTransactions(protocol, from, to) {
  const rows = await db.all(`
    SELECT payload_json AS payload
    FROM source_transactions
    WHERE protocol = $1 AND block_time >= $2 AND block_time <= $3
    ORDER BY block_time DESC
  `, [protocol, from, to])
  return rows.map(({ payload }) => JSON.parse(payload))
}

export async function databaseStats(protocol) {
  const [transactions, flows] = await Promise.all([
    db.get('SELECT COUNT(*)::int AS count FROM source_transactions WHERE protocol = $1', [protocol]),
    db.get(`
      SELECT
        COUNT(*)::int AS flows,
        COUNT(*) FILTER (WHERE direction = 'deposit')::int AS deposits,
        COUNT(*) FILTER (WHERE direction = 'withdraw')::int AS withdrawals,
        COUNT(*) FILTER (WHERE flow_type = 'swap_out')::int AS swaps
      FROM pool_flows WHERE protocol = $1
    `, [protocol]),
  ])
  return {
    transactions: transactions.count,
    deposits: flows.deposits,
    withdrawals: flows.withdrawals,
    flows: flows.flows,
    swaps: flows.swaps,
  }
}

export async function storeTokenPrices(prices, blockTime = Math.floor(Date.now() / 1000), source = 'helius_das') {
  const entries = Object.entries(prices).filter(([, price]) => Number.isFinite(price) && price > 0)
  if (!entries.length) return
  await db.transaction(async (tx) => {
    for (const [asset, price] of entries) {
      await tx.query(`
        INSERT INTO token_prices (asset, block_time, usd_price, source)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(asset, block_time) DO UPDATE SET usd_price = excluded.usd_price, source = excluded.source
      `, [asset, blockTime, price, source])
    }
  })
}

export async function readLatestTokenPrices() {
  const rows = await db.all(`
    SELECT DISTINCT ON (asset) asset, usd_price AS "usdPrice", block_time AS "blockTime", source
    FROM token_prices
    ORDER BY asset, block_time DESC
  `)
  return Object.fromEntries(rows.map((row) => [row.asset, row]))
}

const INSERT_POOL_SNAPSHOT = `
  INSERT INTO pool_snapshots (protocol, asset, block_time, amount_raw, decimals, amount)
  VALUES (@protocol, @asset, @blockTime, @amountRaw, @decimals, @amount)
  ON CONFLICT(protocol, asset, block_time) DO UPDATE SET
    amount_raw = excluded.amount_raw,
    decimals = excluded.decimals,
    amount = excluded.amount,
    indexed_at = EXTRACT(EPOCH FROM now())::bigint
`

export async function storePoolSnapshot(protocol, balances, blockTime = Math.floor(Date.now() / 1000)) {
  await db.transaction(async (tx) => {
    for (const asset of ['USDC', 'SOL', 'USDT']) {
      const decimals = asset === 'SOL' ? 9 : 6
      const amount = Number(balances[asset] || 0)
      const amountRaw = BigInt(Math.round(amount * (10 ** decimals))).toString()
      await tx.query(INSERT_POOL_SNAPSHOT, { protocol, asset, blockTime, amountRaw, decimals, amount })
    }
  })
}

export async function readLatestPoolSnapshot(protocol) {
  const rows = await db.all(`
    SELECT asset, amount, block_time AS "blockTime"
    FROM pool_snapshots
    WHERE protocol = $1 AND block_time = (
      SELECT MAX(block_time) FROM pool_snapshots WHERE protocol = $1
    )
  `, [protocol])
  if (!rows.length) return null
  return {
    blockTime: rows[0].blockTime,
    balances: Object.fromEntries(rows.map(({ asset, amount }) => [asset, amount])),
  }
}

export function getSyncState(source) {
  return db.get(`
    SELECT source, backfilled_from AS "backfilledFrom", synced_through AS "syncedThrough",
      history_complete AS "historyComplete", backfill_cursor AS "backfillCursor",
      backfill_upper_bound AS "backfillUpperBound", incremental_cursor AS "incrementalCursor",
      incremental_from AS "incrementalFrom", incremental_to AS "incrementalTo",
      chain_cursor AS "chainCursor", source_identity AS "sourceIdentity"
    FROM sync_state WHERE source = $1
  `, [source])
}

export async function saveSyncState(source, changes) {
  const current = (await getSyncState(source)) || {}
  const state = {
    source,
    backfilledFrom: changes.backfilledFrom ?? current.backfilledFrom ?? null,
    syncedThrough: changes.syncedThrough ?? current.syncedThrough ?? null,
    historyComplete: Boolean(changes.historyComplete ?? current.historyComplete),
    backfillCursor: Object.hasOwn(changes, 'backfillCursor') ? changes.backfillCursor : current.backfillCursor ?? null,
    backfillUpperBound: Object.hasOwn(changes, 'backfillUpperBound') ? changes.backfillUpperBound : current.backfillUpperBound ?? null,
    incrementalCursor: Object.hasOwn(changes, 'incrementalCursor') ? changes.incrementalCursor : current.incrementalCursor ?? null,
    incrementalFrom: Object.hasOwn(changes, 'incrementalFrom') ? changes.incrementalFrom : current.incrementalFrom ?? null,
    incrementalTo: Object.hasOwn(changes, 'incrementalTo') ? changes.incrementalTo : current.incrementalTo ?? null,
    chainCursor: Object.hasOwn(changes, 'chainCursor') ? changes.chainCursor : current.chainCursor ?? null,
    sourceIdentity: Object.hasOwn(changes, 'sourceIdentity') ? changes.sourceIdentity : current.sourceIdentity ?? null,
  }
  await db.query(`
    INSERT INTO sync_state (
      source, backfilled_from, synced_through, last_block_time, history_complete,
      backfill_cursor, backfill_upper_bound, incremental_cursor, incremental_from,
      incremental_to, chain_cursor, source_identity, updated_at
    ) VALUES (
      @source, @backfilledFrom, @syncedThrough, @syncedThrough, @historyComplete,
      @backfillCursor, @backfillUpperBound, @incrementalCursor, @incrementalFrom,
      @incrementalTo, @chainCursor, @sourceIdentity, EXTRACT(EPOCH FROM now())::bigint
    )
    ON CONFLICT(source) DO UPDATE SET
      backfilled_from = excluded.backfilled_from,
      synced_through = excluded.synced_through,
      last_block_time = excluded.last_block_time,
      history_complete = excluded.history_complete,
      backfill_cursor = excluded.backfill_cursor,
      backfill_upper_bound = excluded.backfill_upper_bound,
      incremental_cursor = excluded.incremental_cursor,
      incremental_from = excluded.incremental_from,
      incremental_to = excluded.incremental_to,
      chain_cursor = excluded.chain_cursor,
      source_identity = excluded.source_identity,
      updated_at = EXTRACT(EPOCH FROM now())::bigint
  `, state)
  return getSyncState(source)
}
