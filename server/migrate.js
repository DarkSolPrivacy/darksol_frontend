import { db } from './db.js'

const applied = db.prepare('SELECT name, applied_at AS appliedAt FROM schema_migrations ORDER BY name').all()
console.log(`SQLite migrations ready: ${applied.length} applied`)
for (const migration of applied) console.log(`${migration.name} (${migration.appliedAt})`)
db.close()
