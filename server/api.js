// Local entry point: serves the built dashboard alongside the API on one port.
// Vercel hosts the same app through api/index.js and serves dist itself.
import express from 'express'
import dotenv from 'dotenv'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import app from './app.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(root, '.env.local'), override: true, quiet: true })

const dist = resolve(root, 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*path', (_request, response) => response.sendFile(resolve(dist, 'index.html')))
}
const port = Number(process.env.PORT || 8787)
app.listen(port, '127.0.0.1', () => console.log(`Dashboard API reading Supabase on http://127.0.0.1:${port}`))
