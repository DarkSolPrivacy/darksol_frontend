import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hasherDist = resolve(root, 'node_modules/@lightprotocol/hasher.rs/dist')
const targets = ['browser-fat/es', 'browser-slim/es']
const files = ['light_wasm_hasher_bg.wasm', 'hasher_wasm_simd_bg.wasm']

for (const target of targets) {
  const targetDirectory = resolve(hasherDist, target)
  mkdirSync(targetDirectory, { recursive: true })
  for (const file of files) {
    const source = resolve(hasherDist, file)
    if (!existsSync(source)) throw new Error(`Missing PrivacyCash WASM asset: ${source}`)
    copyFileSync(source, resolve(targetDirectory, file))
  }
}
