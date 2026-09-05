// Umbra instruction decoding.
//
// Unlike Cloak and PrivacyCash, no byte offsets are hand-rolled here: Umbra
// publishes a codama-generated client, so instructions are identified by name.
// The amount is read from the custody account's token-balance delta rather than
// from the instruction payload, because the payload is encrypted.
//
// THE RULE, established by watching custody balances rather than by reading the
// instruction list (see docs/PROJECT_MEMORY.md):
//
//   deposits  settle in the transaction carrying the INITIATING instruction
//   withdrawals settle in a LATER transaction carrying only the ...Callback
//
// Umbra runs on Arcium MPC, so a withdrawal request only queues a computation;
// the tokens move when the callback lands. Treating callbacks as noise -- which
// is the natural instinct -- drops every withdrawal and reports a pool that only
// ever grows.
import bs58 from 'bs58'
import { identifyUmbraInstruction, UmbraInstruction } from '@umbra-privacy/umbra-codama'
import { findTokenPoolPda } from '@umbra-privacy/sdk/pda'
import { MINTS } from '../addresses.js'
import { ASSETS_BY_MINT, flowRecord, programIdFor } from '../shared/solana-flows.js'
import manifest from './manifest.js'

export const lane = 'solana'

const programId = manifest.addresses.program
const INSTRUCTION_NAMES = Object.fromEntries(Object.entries(UmbraInstruction).map(([name, id]) => [id, name]))

// Derived, not hardcoded, so a redeployed pool cannot silently diverge from what
// the dashboard reads. PDA derivation is pure -- no network call.
const POOL_OWNERS = new Map(await Promise.all(
  Object.entries(MINTS).map(async ([symbol, mintAddress]) => [
    String(await findTokenPoolPda({ mintAddress, umbraProgram: programId })), symbol,
  ]),
))

export const custodyOwners = () => Object.fromEntries([...POOL_OWNERS].map(([pda, symbol]) => [symbol, pda]))

function instructionName(instruction) {
  if (!instruction.data) return null
  try { return INSTRUCTION_NAMES[identifyUmbraInstruction({ data: bs58.decode(instruction.data) })] || null } catch { return null }
}

// Public -> shielded, in the initiating instruction.
const isShieldIn = (name) => !name.endsWith('Callback')
  && (name.startsWith('DepositFromPublicBalanceInto') || name === 'DepositIntoStealthPoolFromPublicBalance')

// Shielded -> public, only ever in the callback.
const isShieldOut = (name) => name.endsWith('Callback') && name.includes('IntoPublicBalance')

// The custody delta for this transaction. Umbra's own pool PDA owns the token
// account, so the pool side of the movement is the entry owned by that PDA.
function custodyDelta(tx) {
  const pre = new Map((tx.meta?.preTokenBalances || []).map((entry) => [entry.accountIndex, entry]))
  for (const post of tx.meta?.postTokenBalances || []) {
    const symbol = POOL_OWNERS.get(post.owner)
    if (!symbol) continue
    const before = BigInt(pre.get(post.accountIndex)?.uiTokenAmount?.amount ?? '0')
    const after = BigInt(post.uiTokenAmount?.amount ?? '0')
    if (after === before) continue
    const delta = after - before
    return {
      delta,
      asset: { symbol, decimals: post.uiTokenAmount?.decimals ?? ASSETS_BY_MINT[post.mint]?.decimals ?? 0 },
    }
  }
  return null
}

// The wallet on the other side of the movement: the non-custody token account
// that moved in the opposite direction.
function counterparty(tx, poolDelta) {
  const pre = new Map((tx.meta?.preTokenBalances || []).map((entry) => [entry.accountIndex, entry]))
  for (const post of tx.meta?.postTokenBalances || []) {
    if (POOL_OWNERS.has(post.owner)) continue
    const before = BigInt(pre.get(post.accountIndex)?.uiTokenAmount?.amount ?? '0')
    const after = BigInt(post.uiTokenAmount?.amount ?? '0')
    const delta = after - before
    if (delta !== 0n && (delta > 0n) !== (poolDelta > 0n)) return post.owner
  }
  return undefined
}

export function decode(tx, instruction, keys, instructionIndex) {
  if (programIdFor(instruction, keys) !== programId) return null
  const name = instructionName(instruction)
  if (!name) return null

  const shieldIn = isShieldIn(name)
  const shieldOut = isShieldOut(name)
  if (!shieldIn && !shieldOut) return null

  const moved = custodyDelta(tx)
  if (!moved || moved.delta === 0n) return null

  // The balance is the authority on direction; the instruction name only says
  // which transaction settles. If they disagree, something is understood wrong,
  // and a wrong flow is worse than a missing one.
  const direction = moved.delta > 0n ? 'deposit' : 'withdraw'
  if ((direction === 'deposit') !== shieldIn) return null

  const amount = moved.delta > 0n ? moved.delta : -moved.delta
  return flowRecord(tx, instructionIndex, counterparty(tx, moved.delta), direction, moved.asset, amount)
}

// How many notes exist in the Stealth Pool -- the set a recipient hides among.
//
// Umbra's own indexer answers this in one unauthenticated call, and it is the
// one number their API has that the chain does not surface cheaply. It carries
// no amounts (those live encrypted inside each note), so it supplements the
// pool balance rather than replacing it.
//
// Cached because it moves slowly and this must never sit in a request path
// unbounded. A failure returns null: a missing signal is fine, a wrong one is not.
const ANONYMITY_TTL_MS = 5 * 60_000
let anonymityCache = { value: null, fetchedAt: 0 }

export async function anonymitySet() {
  if (anonymityCache.value !== null && Date.now() - anonymityCache.fetchedAt < ANONYMITY_TTL_MS) {
    return anonymityCache.value
  }
  try {
    const { ReadServiceClient } = await import('@umbra-privacy/sdk/indexer')
    const client = new ReadServiceClient({ endpoint: manifest.services.indexerApi })
    const stats = await client.getStats()
    const size = Number(stats?.total_utxos ?? stats?.totalUtxos)
    if (!Number.isFinite(size) || size < 0) return null
    anonymityCache = { value: { size, source: 'umbra indexer /v1/stats' }, fetchedAt: Date.now() }
    return anonymityCache.value
  } catch {
    return null
  }
}

// Umbra's custody is held in plain SPL accounts owned by its pool PDAs, so the
// pool is read directly rather than reconstructed from net flows.
export async function poolBalances(rpc) {
  const balances = { SOL: 0, USDC: 0, USDT: 0 }
  for (const [pda, symbol] of POOL_OWNERS) {
    const result = await rpc('getTokenAccountsByOwner', [
      pda, { mint: MINTS[symbol] }, { encoding: 'jsonParsed', commitment: 'finalized' },
    ]).catch(() => null)
    for (const account of result?.value || []) {
      balances[symbol] += Number(account.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0)
    }
  }
  return balances
}
