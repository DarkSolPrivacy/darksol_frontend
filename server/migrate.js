import 'dotenv/config'
import dotenv from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, readAppliedMigrations, runMigrations } from './db.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(root, '.env.local'), override: true, quiet: true })

const applied = await runMigrations({ verbose: true })
const all = await readAppliedMigrations()
console.log(`Supabase migrations ready: ${all.length} applied${applied.length ? ` (${applied.length} in this run)` : ''}`)
for (const migration of all) console.log(`${migration.name} (${migration.appliedAt})`)
await db.close()
