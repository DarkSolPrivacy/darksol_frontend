// Decode helpers shared by every Solana-lane protocol.
//
// These lived inside server/index.js beside the two decoders that used them.
// They are protocol-agnostic -- account-key flattening, little-endian reads,
// token-balance lookups and the flow record shape -- so they belong here now
// that each protocol owns its own decoder.
import { MINTS, MINT_SYMBOLS, NATIVE_SOL_MINT } from '../addresses.js'
import { TOKEN_DECIMALS } from './units.js'

export { NATIVE_SOL_MINT }

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

// Mint address -> { symbol, decimals }, the lookup the decoders index by.
export const ASSETS_BY_MINT = Object.freeze(Object.fromEntries(
  Object.entries(MINTS).map(([symbol, mint]) => [mint, Object.freeze({ symbol, decimals: TOKEN_DECIMALS[symbol] })]),
))

export const SOL_ASSET = Object.freeze({ ...ASSETS_BY_MINT[NATIVE_SOL_MINT], mint: NATIVE_SOL_MINT })

export function accountKeysFor(tx) {
  const messageKeys = tx.transaction?.message?.accountKeys || []
  const staticKeys = messageKeys.map((key) => typeof key === 'string' ? key : key.pubkey)
  const loaded = tx.meta?.loadedAddresses || {}
  return [...staticKeys, ...(loaded.writable || []), ...(loaded.readonly || [])]
}

export function readI64LE(bytes, offset) {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index])
  return value >= (1n << 63n) ? value - (1n << 64n) : value
}

export function readU64LE(bytes, offset) {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index])
  return value
}

export function matchesDiscriminator(data, discriminator) {
  return data.length >= discriminator.length && discriminator.every((byte, index) => data[index] === byte)
}

export function tokenBalances(meta) {
  const balances = new Map()
  for (const entry of [...(meta?.preTokenBalances || []), ...(meta?.postTokenBalances || [])]) {
    if (!balances.has(entry.accountIndex)) balances.set(entry.accountIndex, {
      mint: entry.mint,
      decimals: entry.uiTokenAmount?.decimals ?? 0,
    })
  }
  return balances
}

export function tokenAccountOwner(meta, accountIndex) {
  const balances = [...(meta?.postTokenBalances || []), ...(meta?.preTokenBalances || [])]
  return balances.find((entry) => entry.accountIndex === accountIndex)?.owner
}

export function flowRecord(tx, instructionIndex, participant, direction, asset, absoluteAmount) {
  const signature = tx.transaction?.signatures?.[0] || 'unknown'
  return {
    id: `${signature}:${instructionIndex}`, signature, instructionIndex, timestamp: tx.blockTime,
    participant: participant || 'unknown', direction, asset: asset.symbol,
    amountRaw: absoluteAmount.toString(), decimals: asset.decimals,
    amount: Number(absoluteAmount) / (10 ** asset.decimals),
    flowType: direction, counterAsset: null, linkedFlowId: null,
  }
}

// Which known mints appear verbatim in an instruction payload. Cloak reads the
// swap's output mint this way, since it is embedded in the proof inputs.
export function encodedKnownAssets(data, decodeBase58) {
  const buffer = Buffer.from(data)
  return Object.entries(MINT_SYMBOLS)
    .filter(([mint]) => buffer.includes(Buffer.from(decodeBase58(mint))))
    .map(([, symbol]) => symbol)
}

export function programIdFor(instruction, keys) {
  return instruction.programId || keys[instruction.programIdIndex]
}
