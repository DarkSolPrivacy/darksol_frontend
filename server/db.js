import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const databasePath = resolve(root, process.env.DATABASE_PATH || 'data/cloak-analytics.sqlite')
mkdirSync(dirname(databasePath), { recursive: true })

const sqlite = new DatabaseSync(databasePath)
export const db = {
  prepare: (...args) => sqlite.prepare(...args),
  exec: (...args) => sqlite.exec(...args),
  close: () => sqlite.close(),
  transaction: (operation) => (...args) => {
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = operation(...args)
      sqlite.exec('COMMIT')
      return result
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  },
}
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))')

const migrationsPath = resolve(root, 'migrations')
if (existsSync(migrationsPath)) {
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)')
  for (const name of readdirSync(migrationsPath).filter((file) => file.endsWith('.sql')).sort()) {
    if (applied.get(name)) continue
    const sql = readFileSync(resolve(migrationsPath, name), 'utf8')
    db.transaction(() => { db.exec(sql); record.run(name) })()
  }
}

const upsertTransaction = db.prepare(`
  INSERT INTO source_transactions (signature, slot, block_time, status, payload_json, protocol)
  VALUES (@signature, @slot, @blockTime, 'succeeded', @payload, @protocol)
  ON CONFLICT(signature) DO UPDATE SET
    slot = excluded.slot,
    block_time = excluded.block_time,
    status = excluded.status,
    payload_json = excluded.payload_json,
    protocol = excluded.protocol,
    indexed_at = unixepoch()
`)

const upsertDeposit = db.prepare(`
  INSERT INTO deposits (id, signature, instruction_index, block_time, depositor, asset, amount_raw, decimals, amount)
  VALUES (@id, @signature, @instructionIndex, @timestamp, @depositor, @asset, @amountRaw, @decimals, @amount)
  ON CONFLICT(id) DO UPDATE SET
    block_time = excluded.block_time,
    depositor = excluded.depositor,
    asset = excluded.asset,
    amount_raw = excluded.amount_raw,
    decimals = excluded.decimals,
    amount = excluded.amount,
    indexed_at = unixepoch()
`)

const upsertFlow = db.prepare(`
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
    indexed_at = unixepoch()
`)

const deleteFlowsForTransaction = db.prepare('DELETE FROM pool_flows WHERE protocol = ? AND signature = ?')
const deleteLegacyDepositsForTransaction = db.prepare('DELETE FROM deposits WHERE signature = ?')

const persistBatch = db.transaction((protocol, transactions, flows) => {
  for (const transaction of transactions) {
    const signature = transaction.transaction?.signatures?.[0] || transaction.hash
    if (!signature || !transaction.blockTime) continue
    upsertTransaction.run({ signature, slot: transaction.slot ?? transaction.blockNumber, blockTime: transaction.blockTime, payload: JSON.stringify(transaction), protocol })
    deleteFlowsForTransaction.run(protocol, signature)
    if (protocol === 'cloakc') deleteLegacyDepositsForTransaction.run(signature)
  }
  for (const flow of flows) {
    upsertFlow.run({ ...flow, protocol })
    if (protocol === 'cloakc' && flow.direction === 'deposit') upsertDeposit.run({
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
})

export function storeIndexedData(protocol, transactions, flows) {
  persistBatch(protocol, transactions, flows)
}

export function readDeposits(from, to) {
  return db.prepare(`
    SELECT id, signature, instruction_index AS instructionIndex, block_time AS timestamp,
      depositor, asset, amount_raw AS amountRaw, decimals, amount
    FROM deposits
    WHERE block_time >= ? AND block_time <= ?
    ORDER BY block_time DESC
  `).all(from, to)
}

export function readFlows(protocol, from, to) {
  return db.prepare(`
    SELECT id, signature, instruction_index AS instructionIndex, block_time AS timestamp,
      participant, direction, COALESCE(flow_type, direction) AS flowType,
      asset, counter_asset AS counterAsset, linked_flow_id AS linkedFlowId,
      amount_raw AS amountRaw, decimals, amount
    FROM pool_flows
    WHERE protocol = ? AND block_time >= ? AND block_time <= ?
    ORDER BY block_time DESC
  `).all(protocol, from, to)
}

export function readPlanningFlows(protocol, asset, from, to) {
  return db.prepare(`
    SELECT id, signature, block_time AS timestamp, participant, direction,
      COALESCE(flow_type, direction) AS flowType, asset,
      counter_asset AS counterAsset, linked_flow_id AS linkedFlowId,
      amount_raw AS amountRaw, decimals, amount
    FROM pool_flows
    WHERE protocol = ? AND asset = ? AND block_time BETWEEN ? AND ?
    ORDER BY block_time DESC
  `).all(protocol, asset, from, to)
}

export function readProtocolHistoryBounds(protocol) {
  return db.prepare(`
    SELECT MIN(block_time) AS earliest, MAX(block_time) AS latest,
      COUNT(*) AS transactionCount
    FROM source_transactions
    WHERE protocol = ?
  `).get(protocol)
}

export function readLinkedFlowLatencies(protocol, from, to) {
  return db.prepare(`
    SELECT incoming.block_time - outgoing.block_time AS seconds
    FROM pool_flows AS outgoing
    JOIN pool_flows AS incoming ON incoming.id = outgoing.linked_flow_id
    WHERE outgoing.protocol = ? AND outgoing.flow_type = 'swap_out'
      AND outgoing.block_time BETWEEN ? AND ?
      AND incoming.block_time >= outgoing.block_time
      AND incoming.block_time - outgoing.block_time <= 3600
    ORDER BY seconds
  `).all(protocol, from, to).map(({ seconds }) => seconds)
}

export function classifyPrivacyCashSwaps(from = 0, to = Number.MAX_SAFE_INTEGER, maxGapSeconds = 120, settledThrough = Math.floor(Date.now() / 1000)) {
  const affected = db.prepare(`
    SELECT id, linked_flow_id AS linkedFlowId, block_time AS timestamp
    FROM pool_flows
    WHERE protocol = 'privacycash' AND block_time BETWEEN ? AND ?
  `).all(from, to)
  if (!affected.length) return 0

  const resetIds = new Set(affected.flatMap(({ id, linkedFlowId }) => linkedFlowId ? [id, linkedFlowId] : [id]))
  const affectedIds = [...resetIds]
  const placeholders = affectedIds.map(() => '?').join(',')
  for (const { id } of db.prepare(`
    SELECT id FROM pool_flows
    WHERE protocol = 'privacycash' AND linked_flow_id IN (${placeholders})
  `).all(...affectedIds)) resetIds.add(id)

  const lower = Math.max(0, Math.min(...affected.map(({ timestamp }) => timestamp)) - maxGapSeconds)
  const upper = Math.max(...affected.map(({ timestamp }) => timestamp)) + maxGapSeconds
  const flows = db.prepare(`
    SELECT id, block_time AS timestamp, participant, direction, asset,
      linked_flow_id AS linkedFlowId
    FROM pool_flows
    WHERE protocol = 'privacycash' AND block_time BETWEEN ? AND ?
    ORDER BY block_time ASC
  `).all(lower, upper)
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
  const reset = db.prepare("UPDATE pool_flows SET flow_type = direction, counter_asset = NULL, linked_flow_id = NULL WHERE protocol = 'privacycash' AND id = ?")
  const update = db.prepare('UPDATE pool_flows SET flow_type = ?, counter_asset = ?, linked_flow_id = ? WHERE id = ?')
  db.transaction(() => {
    for (const id of resetIds) reset.run(id)
    for (const { outgoing, incoming } of matches) {
      update.run('swap_out', incoming.asset, incoming.id, outgoing.id)
      update.run('swap_in', outgoing.asset, outgoing.id, incoming.id)
    }
  })()
  return matches.length
}

export function readSourceTransactions(protocol, from, to) {
  return db.prepare(`
    SELECT payload_json AS payload
    FROM source_transactions
    WHERE protocol = ? AND block_time >= ? AND block_time <= ?
    ORDER BY block_time DESC
  `).all(protocol, from, to).map(({ payload }) => JSON.parse(payload))
}

export function databaseStats(protocol) {
  return {
    transactions: db.prepare('SELECT COUNT(*) AS count FROM source_transactions WHERE protocol = ?').get(protocol).count,
    deposits: db.prepare("SELECT COUNT(*) AS count FROM pool_flows WHERE protocol = ? AND direction = 'deposit'").get(protocol).count,
    withdrawals: db.prepare("SELECT COUNT(*) AS count FROM pool_flows WHERE protocol = ? AND direction = 'withdraw'").get(protocol).count,
    flows: db.prepare('SELECT COUNT(*) AS count FROM pool_flows WHERE protocol = ?').get(protocol).count,
    swaps: db.prepare("SELECT COUNT(*) AS count FROM pool_flows WHERE protocol = ? AND flow_type = 'swap_out'").get(protocol).count,
  }
}

const insertTokenPrice = db.prepare(`
  INSERT INTO token_prices (asset, block_time, usd_price, source)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(asset, block_time) DO UPDATE SET usd_price = excluded.usd_price, source = excluded.source
`)

export function storeTokenPrices(prices, blockTime = Math.floor(Date.now() / 1000), source = 'helius_das') {
  db.transaction(() => {
    for (const [asset, price] of Object.entries(prices)) {
      if (Number.isFinite(price) && price > 0) insertTokenPrice.run(asset, blockTime, price, source)
    }
  })()
}

export function readLatestTokenPrices() {
  const rows = db.prepare(`
    SELECT asset, usd_price AS usdPrice, block_time AS blockTime, source
    FROM token_prices AS price
    WHERE block_time = (SELECT MAX(block_time) FROM token_prices WHERE asset = price.asset)
  `).all()
  return Object.fromEntries(rows.map((row) => [row.asset, row]))
}

const insertPoolSnapshot = db.prepare(`
  INSERT INTO pool_snapshots (protocol, asset, block_time, amount_raw, decimals, amount)
  VALUES (@protocol, @asset, @blockTime, @amountRaw, @decimals, @amount)
  ON CONFLICT(protocol, asset, block_time) DO UPDATE SET
    amount_raw = excluded.amount_raw,
    decimals = excluded.decimals,
    amount = excluded.amount,
    indexed_at = unixepoch()
`)

const persistPoolSnapshot = db.transaction((protocol, balances, blockTime) => {
  for (const asset of ['USDC', 'SOL', 'USDT']) {
    const decimals = asset === 'SOL' ? 9 : 6
    const amount = Number(balances[asset] || 0)
    const amountRaw = BigInt(Math.round(amount * (10 ** decimals))).toString()
    insertPoolSnapshot.run({ protocol, asset, blockTime, amountRaw, decimals, amount })
  }
})

export function storePoolSnapshot(protocol, balances, blockTime = Math.floor(Date.now() / 1000)) {
  persistPoolSnapshot(protocol, balances, blockTime)
}

export function readLatestPoolSnapshot(protocol) {
  const rows = db.prepare(`
    SELECT asset, amount, block_time AS blockTime
    FROM pool_snapshots
    WHERE protocol = ? AND block_time = (
      SELECT MAX(block_time) FROM pool_snapshots WHERE protocol = ?
    )
  `).all(protocol, protocol)
  if (!rows.length) return null
  return {
    blockTime: rows[0].blockTime,
    balances: Object.fromEntries(rows.map(({ asset, amount }) => [asset, amount])),
  }
}

export function getSyncState(source) {
  return db.prepare(`
    SELECT source, backfilled_from AS backfilledFrom, synced_through AS syncedThrough,
      history_complete AS historyComplete, backfill_cursor AS backfillCursor,
      backfill_upper_bound AS backfillUpperBound, incremental_cursor AS incrementalCursor,
      incremental_from AS incrementalFrom, incremental_to AS incrementalTo,
      chain_cursor AS chainCursor, source_identity AS sourceIdentity
    FROM sync_state WHERE source = ?
  `).get(source)
}

export function saveSyncState(source, changes) {
  const current = getSyncState(source) || {}
  const state = {
    source,
    backfilledFrom: changes.backfilledFrom ?? current.backfilledFrom ?? null,
    syncedThrough: changes.syncedThrough ?? current.syncedThrough ?? null,
    historyComplete: changes.historyComplete ?? Boolean(current.historyComplete),
    backfillCursor: Object.hasOwn(changes, 'backfillCursor') ? changes.backfillCursor : current.backfillCursor ?? null,
    backfillUpperBound: Object.hasOwn(changes, 'backfillUpperBound') ? changes.backfillUpperBound : current.backfillUpperBound ?? null,
    incrementalCursor: Object.hasOwn(changes, 'incrementalCursor') ? changes.incrementalCursor : current.incrementalCursor ?? null,
    incrementalFrom: Object.hasOwn(changes, 'incrementalFrom') ? changes.incrementalFrom : current.incrementalFrom ?? null,
    incrementalTo: Object.hasOwn(changes, 'incrementalTo') ? changes.incrementalTo : current.incrementalTo ?? null,
    chainCursor: Object.hasOwn(changes, 'chainCursor') ? changes.chainCursor : current.chainCursor ?? null,
    sourceIdentity: Object.hasOwn(changes, 'sourceIdentity') ? changes.sourceIdentity : current.sourceIdentity ?? null,
  }
  db.prepare(`
    INSERT INTO sync_state (
      source, backfilled_from, synced_through, last_block_time, history_complete,
      backfill_cursor, backfill_upper_bound, incremental_cursor, incremental_from,
      incremental_to, chain_cursor, source_identity, updated_at
    ) VALUES (
      @source, @backfilledFrom, @syncedThrough, @syncedThrough, @historyComplete,
      @backfillCursor, @backfillUpperBound, @incrementalCursor, @incrementalFrom,
      @incrementalTo, @chainCursor, @sourceIdentity, unixepoch()
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
      updated_at = unixepoch()
  `).run({ ...state, historyComplete: state.historyComplete ? 1 : 0 })
  return getSyncState(source)
}
