// PrivacyCash instruction decoding, plus the two protocol-specific hooks the
// generic indexer used to special-case: on-chain pool balances and the
// ephemeral-wallet swap classification.
//
// Moved verbatim out of server/index.js.
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { classifyPrivacyCashSwaps } from '../../server/db.js'
import {
  ASSETS_BY_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_SOL_MINT, TOKEN_PROGRAM_ID,
  flowRecord, matchesDiscriminator, programIdFor, readI64LE, readU64LE, tokenAccountOwner,
} from '../shared/solana-flows.js'
import { MINTS } from '../addresses.js'
import manifest from './manifest.js'

export const lane = 'solana'

const programId = manifest.addresses.program
const SOL_DISCRIMINATOR = [217, 149, 130, 143, 221, 52, 252, 119]
const SPL_DISCRIMINATOR = [154, 66, 244, 204, 78, 225, 163, 151]

export function decode(tx, instruction, keys, instructionIndex) {
  if (programIdFor(instruction, keys) !== programId || !instruction.data) return null
  let data
  try { data = bs58.decode(instruction.data) } catch { return null }
  const isSol = matchesDiscriminator(data, SOL_DISCRIMINATOR)
  const isSpl = matchesDiscriminator(data, SPL_DISCRIMINATOR)
  if ((!isSol && !isSpl) || data.length < 504) return null
  // discriminator[8] + proof A/B/C[256] + seven 32-byte public fields.
  // The signed extAmount is the actual amount entering/leaving the public pool.
  const extAmount = readI64LE(data, 8 + 256 + (7 * 32))
  if (extAmount === 0n) return null
  const chargedFee = readU64LE(data, 8 + 256 + (7 * 32) + 8)
  const indexes = instruction.accounts || []
  const asset = isSol ? ASSETS_BY_MINT[NATIVE_SOL_MINT] : ASSETS_BY_MINT[keys[indexes[7]]]
  if (!asset) return null
  const direction = extAmount > 0n ? 'deposit' : 'withdraw'
  let participant
  if (direction === 'deposit') participant = keys[indexes[isSol ? 9 : 6]]
  else if (isSol) participant = keys[indexes[7]]
  else participant = tokenAccountOwner(tx.meta, indexes[10]) || keys[indexes[9]] || keys[indexes[10]]
  const recipientAmount = extAmount > 0n ? extAmount : -extAmount
  const poolAmount = direction === 'withdraw' ? recipientAmount + chargedFee : recipientAmount
  return flowRecord(tx, instructionIndex, participant, direction, asset, poolAmount)
}

function associatedTokenAddress(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0]
}

// PrivacyCash holds its liquidity in real accounts, so its pool balance is read
// directly rather than reconstructed from indexed flows. Note the SPL balances
// hang off the global_config PDA, not the SOL tree_token pool.
export async function poolBalances(rpc) {
  const program = new PublicKey(programId)
  const [solPool] = PublicKey.findProgramAddressSync([Buffer.from('tree_token')], program)
  const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from('global_config')], program)
  const usdcAta = associatedTokenAddress(globalConfig, new PublicKey(MINTS.USDC))
  const usdtAta = associatedTokenAddress(globalConfig, new PublicKey(MINTS.USDT))
  const [sol, usdc, usdt] = await Promise.all([
    rpc('getBalance', [solPool.toBase58(), { commitment: 'finalized' }]),
    rpc('getTokenAccountBalance', [usdcAta.toBase58(), { commitment: 'finalized' }]),
    rpc('getTokenAccountBalance', [usdtAta.toBase58(), { commitment: 'finalized' }]),
  ])
  return {
    SOL: Number(sol?.value || 0) / 1e9,
    USDC: Number(usdc?.value?.amount || 0) / 1e6,
    USDT: Number(usdt?.value?.amount || 0) / 1e6,
  }
}

// Pairs a differing-asset withdrawal and deposit that share an ephemeral
// participant within 120 seconds. An analytics heuristic, not proven linkage.
export async function postProcess({ earliest, latest }) {
  return classifyPrivacyCashSwaps(earliest, latest)
}
