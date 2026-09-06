// Lazy loader for the capability modules, for Node and the tsx CLI.
//
// Dynamic rather than static on purpose: only the protocol actually invoked
// pays to import its SDK, so the CLI no longer loads the Cloak, PrivacyCash and
// Curvy SDKs on every command. new URL() keeps bundlers from trying to follow
// these, which is what we want here -- but it is also exactly why the manifest
// barrel is static instead. See protocols/manifests.js.
//
// Only reach for this from the CLI and the indexer. Anything running inside the
// Vercel function must import statically or it will not be bundled.
import { PROTOCOLS } from './registry.js'

const cache = new Map()

export async function loadCapability(protocolId, file) {
  const manifest = PROTOCOLS[protocolId]
  if (!manifest) throw new Error(`Unknown protocol: ${protocolId}`)
  const key = `${protocolId}/${file}`
  if (!cache.has(key)) cache.set(key, import(new URL(`./${key}`, import.meta.url).href))
  return cache.get(key)
}

export const loadCli = (protocolId) => loadCapability(protocolId, 'cli.ts')
export const loadCommands = (protocolId) => loadCapability(protocolId, 'commands.ts')
export const loadIndexer = (protocolId) => loadCapability(protocolId, 'indexer.js')
