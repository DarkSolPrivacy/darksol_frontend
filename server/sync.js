// Standalone entry point for the local SQLite -> Supabase copy. The indexer
// runs the same routine before its first cycle; this exists for a deliberate
// one-off import, or for a full `--resync` after rebuilding the local database.
import 'dotenv/config'
import dotenv from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, runMigrations } from './db.js'
import { importLocalSqlite } from './import-sqlite.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(root, '.env.local'), override: true, quiet: true })

await runMigrations({ verbose: true })
const result = await importLocalSqlite({ resync: process.argv.includes('--resync') })
console.log(JSON.stringify({ phase: 'import_complete', ...result }, null, 2))
await db.close()
