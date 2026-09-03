// One-time (and repeatable) copy of the local SQLite analytics database into
// Supabase. Every table is upserted on its primary key, so running this twice
// converges instead of duplicating, and a partially finished run resumes safely.
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addFlowBaseline, db } from './db.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function localDatabasePath() {
  return resolve(root, process.env.DATABASE_PATH || 'data/cloak-analytics.sqlite')
}

// Only the tables the Postgres schema still has. source_transactions and
// deposits are deliberately absent: neither has a reader, and every amount they
// held is already decoded into pool_flows.
const TABLES = [
  {
    name: 'pool_flows',
    conflict: ['id'],
    columns: ['id', 'signature', 'block_time', 'participant', 'direction', 'asset', 'amount_raw', 'amount', 'protocol', 'flow_type', 'counter_asset', 'linked_flow_id'],
    retained: true,
  },
  {
    name: 'pool_snapshots',
    conflict: ['protocol', 'asset', 'block_time'],
    columns: ['protocol', 'asset', 'block_time', 'amount'],
  },
  {
    name: 'token_prices',
    conflict: ['asset', 'block_time'],
    columns: ['asset', 'block_time', 'usd_price', 'source'],
  },
  {
    name: 'sync_state',
    conflict: ['source'],
    columns: ['source', 'backfilled_from', 'synced_through', 'history_complete', 'backfill_cursor', 'backfill_upper_bound', 'incremental_cursor', 'incremental_from', 'incremental_to', 'chain_cursor', 'source_identity', 'updated_at'],
    // SQLite stores this flag as 0/1 against a Postgres boolean column.
    cast: { history_complete: (value) => Boolean(value) },
  },
]

const DEFAULT_CHUNK = 500
const RETENTION_DAYS = Number(process.env.FLOW_RETENTION_DAYS || 100)

function upsertStatement(table) {
  const updates = table.columns
    .filter((column) => !table.conflict.includes(column))
    .map((column) => `${column} = excluded.${column}`)
  return (rowCount) => {
    const values = Array.from({ length: rowCount }, (_row, rowIndex) =>
      `(${table.columns.map((_column, columnIndex) => `$${rowIndex * table.columns.length + columnIndex + 1}`).join(', ')})`)
    const conflictAction = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING'
    return `INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES ${values.join(', ')}
      ON CONFLICT (${table.conflict.join(', ')}) ${conflictAction}`
  }
}

// jsonb does not preserve key order, so the recorded counts are compared field
// by field rather than by serialising both sides.
function sameCounts(recorded, current) {
  const keys = new Set([...Object.keys(recorded || {}), ...Object.keys(current)])
  return [...keys].every((key) => recorded?.[key] === current[key])
}

function sqliteColumns(sqlite, table) {
  return new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name))
}

export async function importLocalSqlite({ resync = false, verbose = true, path = localDatabasePath() } = {}) {
  if (!existsSync(path)) {
    return { skipped: true, reason: 'no local SQLite database found', path }
  }

  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400
  const sqlite = new DatabaseSync(path, { readOnly: true })
  try {
    const plan = []
    for (const table of TABLES) {
      const available = sqliteColumns(sqlite, table.name)
      if (!available.size) continue
      // A column added by a later SQLite migration may be absent from an older
      // local file; import what is there and let Postgres defaults cover the rest.
      const columns = table.columns.filter((column) => available.has(column))
      // The marker is keyed on the file's total row count, which does not move
      // as the retention cutoff advances over a static local database.
      const local = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table.name}`).get().count
      const where = table.retained ? `WHERE block_time >= ${cutoff}` : ''
      const selected = table.retained
        ? sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table.name} ${where}`).get().count
        : local
      plan.push({ ...table, columns, local, selected, where })
    }
    const counts = Object.fromEntries(plan.map(({ name, local }) => [name, local]))

    // Everything older than the retention window is summarised into
    // flow_baselines rather than copied, so the reconstructed pool balance stays
    // exact while only the recent rows cross the wire.
    const seedBaselines = async () => {
      const totals = sqlite.prepare(`
        SELECT protocol, asset,
          SUM(CASE WHEN direction = 'deposit' THEN amount ELSE -amount END) AS net,
          SUM(CASE WHEN direction = 'deposit' THEN amount ELSE 0 END) AS deposits,
          SUM(CASE WHEN direction = 'withdraw' THEN amount ELSE 0 END) AS withdrawals,
          COUNT(*) AS count,
          MAX(block_time) AS latest
        FROM pool_flows WHERE block_time < ?
        GROUP BY protocol, asset
      `).all(cutoff)
      for (const { protocol, asset, ...row } of totals) await addFlowBaseline(protocol, asset, row)
      return totals
    }

    const marker = await db.get('SELECT row_counts AS "rowCounts", imported_at AS "importedAt" FROM local_import_state WHERE path = $1', [path])
    if (!resync && marker && sameCounts(marker.rowCounts, counts)) {
      return { skipped: true, reason: 'this local database has already been imported', path, importedAt: marker.importedAt, counts }
    }

    const baselines = await seedBaselines()
    const imported = {}
    for (const table of plan) {
      if (!table.selected) { imported[table.name] = 0
        continue }
      const build = upsertStatement(table)
      const size = table.chunk || DEFAULT_CHUNK
      // Streamed a chunk at a time: pool_flows runs to hundreds of thousands
      // of rows.
      const cursor = sqlite.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name} ${table.where}`).iterate()
      let written = 0
      let chunk = []
      const flush = async () => {
        if (!chunk.length) return
        const values = chunk.flatMap((row) => table.columns.map((column) => {
          const value = row[column] ?? null
          return table.cast?.[column] && value !== null ? table.cast[column](value) : value
        }))
        await db.query(build(chunk.length), values)
        written += chunk.length
        chunk = []
        if (verbose && written % (size * 20) === 0) {
          console.log(JSON.stringify({ phase: 'import', table: table.name, written, of: table.selected }))
        }
      }
      for (const row of cursor) {
        chunk.push(row)
        if (chunk.length >= size) await flush()
      }
      await flush()
      imported[table.name] = written
      if (verbose) console.log(JSON.stringify({ phase: 'import', table: table.name, imported: written }))
    }
    // Written only after every table has landed, so an interrupted run repeats
    // rather than reporting itself as done.
    await db.query(`
      INSERT INTO local_import_state (path, row_counts, imported_at)
      VALUES ($1, $2, EXTRACT(EPOCH FROM now())::bigint)
      ON CONFLICT (path) DO UPDATE SET row_counts = excluded.row_counts, imported_at = excluded.imported_at
    `, [path, JSON.stringify(counts)])
    return {
      skipped: false, path, imported, retentionDays: RETENTION_DAYS, cutoff,
      baselines: Object.fromEntries(baselines.map(({ protocol, asset, net, count }) => [`${protocol}:${asset}`, { net, prunedFlows: count }])),
    }
  } finally {
    sqlite.close()
  }
}
