import 'dotenv/config'
import dotenv from 'dotenv'
import { Keypair, PublicKey } from '@solana/web3.js'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(projectRoot, '.env.local'), override: true, quiet: true })

export const PROTOCOL_IDS = ['cloakc', 'privacycash', 'curvy'] as const
export type ProtocolId = typeof PROTOCOL_IDS[number]

export const PROGRAMS = Object.freeze({
  cloakc: 'zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW',
  privacycash: '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD',
  curvyVault: '0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00',
  curvyAggregator: '0xe51924cef003a654ec9735c4d97f5d4862cbcbb1',
})

export function walletsDir() {
  const configured = process.env.TEST_WALLETS_DIR || 'test-wallets'
  return isAbsolute(configured) ? configured : resolve(projectRoot, configured)
}

export function senderKeypairPath() {
  return resolve(walletsDir(), 'sender.json')
}

export function recipientKeypairPath() {
  return resolve(walletsDir(), 'recipient.json')
}

export function solanaRpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL
  return 'https://api.mainnet-beta.solana.com'
}

export function requireExecute(args: string[]) {
  if (!args.includes('--execute')) {
    throw new Error('Refusing to broadcast. Re-run with --execute after checking the addresses and lamports.')
  }
}

export function parseLamports(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new Error('lamports must be a positive base-10 integer')
  const lamports = BigInt(value)
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('lamports exceeds the SDK safe-integer limit')
  return lamports
}

export function parseRecipient(value: string | undefined) {
  if (!value) throw new Error('recipient Solana address is required')
  return new PublicKey(value)
}

export async function loadKeypair(path = senderKeypairPath()) {
  const bytes = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`Invalid Solana keypair: ${path}`)
  return Keypair.fromSecretKey(Uint8Array.from(bytes))
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error: any) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export async function writePrivateJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
}

export function json(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)
}

export function assertProtocol(value: string | undefined): ProtocolId {
  if (!PROTOCOL_IDS.includes(value as ProtocolId)) throw new Error(`protocol must be one of: ${PROTOCOL_IDS.join(', ')}`)
  return value as ProtocolId
}
