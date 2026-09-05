// Cloak instruction decoding.
//
// Moved verbatim out of server/index.js; the shared byte and account helpers
// now come from protocols/shared/solana-flows.js so every Solana-lane protocol
// uses one copy of them.
import bs58 from 'bs58'
import {
  ASSETS_BY_MINT, SOL_ASSET, TOKEN_PROGRAM_ID, encodedKnownAssets, flowRecord,
  programIdFor, readI64LE, tokenAccountOwner, tokenBalances,
} from '../shared/solana-flows.js'
import manifest from './manifest.js'

export const lane = 'solana'

const programId = manifest.addresses.program

function assetForInstruction(tx, instruction, keys) {
  const indexes = instruction.accounts || []
  const tokenProgram = indexes.length > 9 ? keys[indexes[9]] : undefined
  if (tokenProgram !== TOKEN_PROGRAM_ID) return SOL_ASSET
  const balances = tokenBalances(tx.meta)
  for (const index of indexes) {
    const balance = balances.get(index)
    if (balance && ASSETS_BY_MINT[balance.mint]) {
      return { ...ASSETS_BY_MINT[balance.mint], mint: balance.mint, decimals: balance.decimals }
    }
  }
  return null
}

function participantFor(tx, instruction, keys, direction) {
  const indexes = instruction.accounts || []
  if (direction === 'deposit') return Number.isInteger(indexes[0]) ? keys[indexes[0]] : 'unknown'
  const isSpl = indexes.length > 9 && keys[indexes[9]] === TOKEN_PROGRAM_ID
  if (isSpl && Number.isInteger(indexes[10])) return tokenAccountOwner(tx.meta, indexes[10]) || keys[indexes[10]] || 'unknown'
  return Number.isInteger(indexes[7]) ? keys[indexes[7]] : 'unknown'
}

export function decode(tx, instruction, keys, instructionIndex) {
  if (programIdFor(instruction, keys) !== programId || !instruction.data) return null
  let data
  try { data = bs58.decode(instruction.data) } catch { return null }
  if (data.length < 521 || (data[0] !== 0 && data[0] !== 1)) return null
  const publicAmount = readI64LE(data, 1 + 256 + 32)
  if (publicAmount === 0n) return null
  const isSwap = data[0] === 1
  const asset = isSwap ? SOL_ASSET : assetForInstruction(tx, instruction, keys)
  if (!asset) return null
  const direction = isSwap ? 'withdraw' : publicAmount > 0n ? 'deposit' : 'withdraw'
  const absoluteAmount = publicAmount > 0n ? publicAmount : -publicAmount
  const flow = flowRecord(tx, instructionIndex, participantFor(tx, instruction, keys, direction), direction, asset, absoluteAmount)
  if (isSwap) {
    flow.flowType = 'swap_out'
    flow.counterAsset = encodedKnownAssets(data, bs58.decode).find((symbol) => symbol !== 'SOL') || null
  }
  return flow
}
