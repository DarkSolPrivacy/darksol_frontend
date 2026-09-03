import pg from 'pg'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// block_time, slot and indexed_at are bigint columns whose values stay well
// inside Number.MAX_SAFE_INTEGER, and every consumer treats them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, Number)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number)

// A Supabase database password is generated with punctuation, and pasting it
// into the connection URI unencoded is the common way to get an unhelpful
// "Invalid URL" out of pg: '#' opens a fragment and '^' is not legal in a URI
// at all. If the string does not parse, percent-encode the credentials and try
// again rather than making the reader work that out.
function repairCredentials(url) {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)
  if (!scheme) return null
  const rest = url.slice(scheme[0].length)
  const authorityEnd = rest.search(/[/?]/)
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd)
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd)
  const at = authority.lastIndexOf('@')
  if (at === -1) return null
  const credentials = authority.slice(0, at)
  const host = authority.slice(at + 1)
  const separator = credentials.indexOf(':')
  const user = separator === -1 ? credentials : credentials.slice(0, separator)
  const password = separator === -1 ? null : credentials.slice(separator + 1)
  const encoded = password === null
    ? encodeURIComponent(decodeURIComponent(user))
    : `${encodeURIComponent(decodeURIComponent(user))}:${encodeURIComponent(password)}`
  return `${scheme[0]}${encoded}@${host}${tail}`
}

export function resolveConnectionString() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!url) {
    throw new Error('SUPABASE_DB_URL is not configured. Copy the connection string from Supabase > Connect into .env.local and the Vercel project environment.')
  }
  try {
    new URL(url)
    return url
  } catch {}
  const repaired = repairCredentials(url)
  try {
    new URL(repaired)
    return repaired
  } catch {}
  throw new Error('SUPABASE_DB_URL is not a valid connection URI. If the password contains "/" or "@", percent-encode it (encodeURIComponent) before putting it in the URL.')
}

// Built on first use rather than at import time: every entry point loads
// .env.local in its module body, which runs after this module is evaluated.
let poolInstance = null
function pool() {
  if (!poolInstance) {
    const url = resolveConnectionString()
    poolInstance = new pg.Pool({
      connectionString: url,
      // Supabase terminates TLS with its own CA, which Node does not ship. A
      // loopback URL is a local Postgres, which serves no certificate at all.
      ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false },
      // Every warm serverless instance holds its own pool, so a generous max
      // there multiplies into Supabase's connection limit rather than adding
      // throughput. One connection per instance is what the pooler expects.
      max: Number(process.env.SUPABASE_POOL_MAX || (process.env.VERCEL ? 1 : 8)),
      idleTimeoutMillis: process.env.VERCEL ? 10_000 : 30_000,
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

const UPSERT_FLOW = `
  INSERT INTO pool_flows (id, signature, block_time, participant, direction, asset, amount_raw, amount, protocol, flow_type, counter_asset, linked_flow_id)
  VALUES (@id, @signature, @timestamp, @participant, @direction, @asset, @amountRaw, @amount, @protocol, @flowType, @counterAsset, @linkedFlowId)
  ON CONFLICT(id) DO UPDATE SET
    block_time = excluded.block_time,
    participant = excluded.participant,
    direction = excluded.direction,
    asset = excluded.asset,
    amount_raw = excluded.amount_raw,
    amount = excluded.amount,
    protocol = excluded.protocol,
    flow_type = excluded.flow_type,
    counter_asset = excluded.counter_asset,
    linked_flow_id = excluded.linked_flow_id
`

// Re-decoding a transaction must first clear the flows a previous decode
// produced for it, hence the delete pass before the upserts.
async function persistFlowBatch(tx, protocol, signatures, flows) {
  for (const signature of signatures) {
    await tx.query('DELETE FROM pool_flows WHERE protocol = @protocol AND signature = @signature', { protocol, signature })
  }
  for (const flow of flows) await tx.query(UPSERT_FLOW, { ...flow, protocol })
}

export async function storeIndexedData(protocol, transactions, flows) {
  const signatures = transactions
    .filter(({ blockTime }) => blockTime)
    .map((transaction) => transaction.transaction?.signatures?.[0] || transaction.hash)
    .filter(Boolean)
  if (!signatures.length && !flows.length) return
  await db.transaction((tx) => persistFlowBatch(tx, protocol, signatures, flows))
}

// Flows older than the retention window are folded into flow_baselines and
// then deleted, both inside one transaction so a balance reconstructed from
// baseline + remaining flows is never missing a row nor counting one twice.
export async function pruneFlows(protocol, cutoff) {
  return db.transaction(async (tx) => {
    const totals = await tx.all(`
      SELECT asset,
        SUM(CASE WHEN direction = 'deposit' THEN amount ELSE -amount END) AS net,
        SUM(CASE WHEN direction = 'deposit' THEN amount ELSE 0 END) AS deposits,
        SUM(CASE WHEN direction = 'withdraw' THEN amount ELSE 0 END) AS withdrawals,
        COUNT(*)::int AS count,
        MAX(block_time) AS latest
      FROM pool_flows
      WHERE protocol = $1 AND block_time < $2
      GROUP BY asset
    `, [protocol, cutoff])
    if (!totals.length) return { pruned: 0, assets: {} }
    for (const row of totals) {
      await tx.query(`
        INSERT INTO flow_baselines (protocol, asset, net_amount, deposit_amount, withdraw_amount, flow_count, through_block_time)
        VALUES (@protocol, @asset, @net, @deposits, @withdrawals, @count, @latest)
        ON CONFLICT(protocol, asset) DO UPDATE SET
          net_amount = flow_baselines.net_amount + excluded.net_amount,
          deposit_amount = flow_baselines.deposit_amount + excluded.deposit_amount,
          withdraw_amount = flow_baselines.withdraw_amount + excluded.withdraw_amount,
          flow_count = flow_baselines.flow_count + excluded.flow_count,
          through_block_time = GREATEST(flow_baselines.through_block_time, excluded.through_block_time)
      `, { protocol, ...row })
    }
    const { rowCount } = await tx.query('DELETE FROM pool_flows WHERE protocol = $1 AND block_time < $2', [protocol, cutoff])
    return {
      pruned: rowCount,
      assets: Object.fromEntries(totals.map(({ asset, net, count }) => [asset, { net, count }])),
    }
  })
}

// Seeds a baseline directly, for the import that never sends the old rows over
// the wire in the first place. Additive, so a re-import after --resync of a
// larger local database tops it up rather than double counting.
export async function addFlowBaseline(protocol, asset, totals) {
  await db.query(`
    INSERT INTO flow_baselines (protocol, asset, net_amount, deposit_amount, withdraw_amount, flow_count, through_block_time)
    VALUES (@protocol, @asset, @net, @deposits, @withdrawals, @count, @latest)
    ON CONFLICT(protocol, asset) DO UPDATE SET
      net_amount = excluded.net_amount,
      deposit_amount = excluded.deposit_amount,
      withdraw_amount = excluded.withdraw_amount,
      flow_count = excluded.flow_count,
      through_block_time = excluded.through_block_time
  `, { protocol, asset, ...totals })
}

export async function readFlowBaseline(protocol) {
  const rows = await db.all(`
    SELECT asset, net_amount AS net, deposit_amount AS deposits,
      withdraw_amount AS withdrawals, flow_count AS count,
      through_block_time AS "throughBlockTime"
    FROM flow_baselines WHERE protocol = $1
  `, [protocol])
  return Object.fromEntries(rows.map((row) => [row.asset, row]))
}

export function readFlows(protocol, from, to) {
  return db.all(`
    SELECT id, signature, block_time AS timestamp,
      participant, direction, COALESCE(flow_type, direction) AS "flowType",
      asset, counter_asset AS "counterAsset", linked_flow_id AS "linkedFlowId",
      amount_raw AS "amountRaw", amount
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
      amount_raw AS "amountRaw", amount
    FROM pool_flows
    WHERE protocol = $1 AND asset = $2 AND block_time BETWEEN $3 AND $4
    ORDER BY block_time DESC
  `, [protocol, asset, from, to])
}

// Derived from pool_flows now that source_transactions is gone. A transaction
// that decoded no flow is not represented, so these bounds describe the indexed
// analytics rather than every transaction that touched the program.
export function readProtocolHistoryBounds(protocol) {
  return db.get(`
    SELECT MIN(block_time) AS earliest, MAX(block_time) AS latest,
      COUNT(DISTINCT signature)::int AS "transactionCount"
    FROM pool_flows
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

export async function databaseStats(protocol) {
  const flows = await db.get(`
    SELECT
      COUNT(DISTINCT signature)::int AS transactions,
      COUNT(*)::int AS flows,
      COUNT(*) FILTER (WHERE direction = 'deposit')::int AS deposits,
      COUNT(*) FILTER (WHERE direction = 'withdraw')::int AS withdrawals,
      COUNT(*) FILTER (WHERE flow_type = 'swap_out')::int AS swaps
    FROM pool_flows WHERE protocol = $1
  `, [protocol])
  return {
    transactions: flows.transactions,
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
  INSERT INTO pool_snapshots (protocol, asset, block_time, amount)
  VALUES (@protocol, @asset, @blockTime, @amount)
  ON CONFLICT(protocol, asset, block_time) DO UPDATE SET amount = excluded.amount
`

export async function storePoolSnapshot(protocol, balances, blockTime = Math.floor(Date.now() / 1000)) {
  await db.transaction(async (tx) => {
    for (const asset of ['USDC', 'SOL', 'USDT']) {
      await tx.query(INSERT_POOL_SNAPSHOT, { protocol, asset, blockTime, amount: Number(balances[asset] || 0) })
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
      source, backfilled_from, synced_through, history_complete,
      backfill_cursor, backfill_upper_bound, incremental_cursor, incremental_from,
      incremental_to, chain_cursor, source_identity, updated_at
    ) VALUES (
      @source, @backfilledFrom, @syncedThrough, @historyComplete,
      @backfillCursor, @backfillUpperBound, @incrementalCursor, @incrementalFrom,
      @incrementalTo, @chainCursor, @sourceIdentity, EXTRACT(EPOCH FROM now())::bigint
    )
    ON CONFLICT(source) DO UPDATE SET
      backfilled_from = excluded.backfilled_from,
      synced_through = excluded.synced_through,
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
