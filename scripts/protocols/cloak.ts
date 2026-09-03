import { Connection, PublicKey } from '@solana/web3.js'
import {
  CLOAK_PRODUCTION_RELAY_URL,
  CLOAK_PROGRAM_ID,
  NATIVE_SOL_MINT,
  createUtxo,
  createZeroUtxo,
  deserializeUtxo,
  fullWithdraw,
  generateUtxoKeypair,
  getShieldPoolPDAs,
  partialWithdraw,
  serializeUtxo,
  swapWithChange,
  transact,
  type Utxo,
} from '@cloak.dev/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { resolve } from 'node:path'
import { loadKeypair, parseRecipient, readJson, solanaRpcUrl, walletsDir, writePrivateJson } from '../runtime.js'

type CloakState = { version: 1, utxos: string[], signatures: string[] }
const emptyState: CloakState = { version: 1, utxos: [], signatures: [] }
const OUTPUT_MINTS: Record<string, PublicKey> = {
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
}

function statePath() { return resolve(walletsDir(), 'state', 'cloak.json') }
function swapRefundsPath() { return resolve(walletsDir(), 'state', 'cloak-swap-refunds.json') }

async function loadState() {
  const state = await readJson(statePath(), emptyState)
  const utxos = await Promise.all(state.utxos.map((item) => deserializeUtxo(Buffer.from(item, 'base64'))))
  return { state, utxos: utxos.filter((utxo) => utxo.amount > 0n) }
}

async function saveState(utxos: Utxo[], signatures: string[]) {
  await writePrivateJson(statePath(), {
    version: 1,
    utxos: utxos.filter((utxo) => utxo.amount > 0n).map((utxo) => Buffer.from(serializeUtxo(utxo)).toString('base64')),
    signatures,
  } satisfies CloakState)
}

function options(connection: Connection, signer: Awaited<ReturnType<typeof loadKeypair>>) {
  return {
    connection,
    programId: CLOAK_PROGRAM_ID,
    relayUrl: CLOAK_PRODUCTION_RELAY_URL,
    depositorKeypair: signer,
    walletPublicKey: signer.publicKey,
    onProgress: (status: string) => console.error(`[cloakc] ${status}`),
  }
}

export async function cloakSnapshot() {
  const connection = new Connection(solanaRpcUrl(), 'confirmed')
  const program = await connection.getAccountInfo(CLOAK_PROGRAM_ID)
  const pdas = getShieldPoolPDAs(CLOAK_PROGRAM_ID, NATIVE_SOL_MINT)
  const [poolConfigAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_config'), NATIVE_SOL_MINT.toBuffer()],
    CLOAK_PROGRAM_ID,
  )
  const [poolLamports, vaultLamports, poolConfigAccount] = await Promise.all([
    connection.getBalance(pdas.pool, 'confirmed'),
    connection.getBalance(pdas.vaultAuthority, 'confirmed'),
    connection.getAccountInfo(poolConfigAddress, 'confirmed'),
  ])
  if (!poolConfigAccount || !poolConfigAccount.owner.equals(CLOAK_PROGRAM_ID) || poolConfigAccount.data.length !== 27) {
    throw new Error(`Invalid Cloak SOL PoolConfig account: ${poolConfigAddress.toBase58()}`)
  }
  const poolConfig = {
    version: poolConfigAccount.data[0],
    fixedFeeLamports: poolConfigAccount.data.readBigUInt64LE(2),
    variableFeeNumerator: poolConfigAccount.data.readBigUInt64LE(10),
    variableFeeDenominator: poolConfigAccount.data.readBigUInt64LE(18),
    swapsPaused: poolConfigAccount.data[26] === 1,
  }
  return {
    protocol: 'cloakc', programId: CLOAK_PROGRAM_ID.toBase58(), executable: Boolean(program?.executable),
    poolAddress: pdas.pool.toBase58(), poolLamports,
    vaultAuthority: pdas.vaultAuthority.toBase58(), vaultLamports,
    poolConfigAddress: poolConfigAddress.toBase58(), poolConfig,
  }
}

export async function cloakBalance() {
  const { utxos } = await loadState()
  return { protocol: 'cloakc', privateLamports: utxos.reduce((sum, utxo) => sum + utxo.amount, 0n), utxoCount: utxos.length }
}

export async function cloakDeposit(lamports: bigint) {
  const signer = await loadKeypair()
  const connection = new Connection(solanaRpcUrl(), 'confirmed')
  const owner = await generateUtxoKeypair()
  const output = await createUtxo(lamports, owner, NATIVE_SOL_MINT)
  const result = await transact({
    inputUtxos: [await createZeroUtxo(NATIVE_SOL_MINT)],
    outputUtxos: [output], externalAmount: lamports, depositor: signer.publicKey,
  }, options(connection, signer))
  const { state, utxos } = await loadState()
  await saveState([...utxos, ...result.outputUtxos], [...state.signatures, result.signature])
  return { protocol: 'cloakc', action: 'deposit', signature: result.signature, lamports, privateLamports: lamports }
}

export async function cloakSend(recipientAddress: string, lamports: bigint) {
  const recipient = parseRecipient(recipientAddress)
  const signer = await loadKeypair()
  const connection = new Connection(solanaRpcUrl(), 'confirmed')
  const { state, utxos } = await loadState()
  const available = utxos.reduce((sum, utxo) => sum + utxo.amount, 0n)
  if (lamports > available) throw new Error(`Cloak private balance is ${available} lamports, requested ${lamports}`)
  const result = lamports === available
    ? await fullWithdraw(utxos, recipient, options(connection, signer))
    : await partialWithdraw(utxos, recipient, lamports, options(connection, signer))
  await saveState(result.outputUtxos, [...state.signatures, result.signature])
  return { protocol: 'cloakc', action: 'send', signature: result.signature, recipient: recipient.toBase58(), grossLamports: lamports }
}

export async function cloakSwapSolToToken(recipientAddress: string, lamports: bigint, outputSymbol = 'USDC') {
  const recipient = parseRecipient(recipientAddress)
  const symbol = outputSymbol.toUpperCase()
  const outputMint = OUTPUT_MINTS[symbol]
  if (!outputMint) throw new Error('Cloak swap output must be USDC or USDT')
  const signer = await loadKeypair()
  const connection = new Connection(solanaRpcUrl(), 'confirmed')
  const { state, utxos } = await loadState()
  const available = utxos.reduce((sum, utxo) => sum + utxo.amount, 0n)
  if (lamports > available) throw new Error(`Cloak private balance is ${available} lamports, requested ${lamports}`)

  // The deployed SOL PoolConfig was checked by cloakSnapshot. Quote the amount
  // Jupiter actually receives after Cloak's fixed + variable protocol fee.
  const feeLamports = 5_000_000n + lamports * 3n / 1000n
  const quotedInputLamports = lamports - feeLamports
  if (quotedInputLamports <= 0n) throw new Error('Cloak swap amount does not exceed its protocol fee')
  const quoteUrl = new URL('https://lite-api.jup.ag/swap/v1/quote')
  quoteUrl.search = new URLSearchParams({
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: outputMint.toBase58(),
    amount: quotedInputLamports.toString(),
    slippageBps: '100',
    restrictIntermediateTokens: 'true',
  }).toString()
  const quoteResponse = await fetch(quoteUrl)
  if (!quoteResponse.ok) throw new Error(`Jupiter quote failed: HTTP ${quoteResponse.status}`)
  const quote: any = await quoteResponse.json()
  if (quote.inputMint !== 'So11111111111111111111111111111111111111112'
    || quote.outputMint !== outputMint.toBase58()
    || quote.inAmount !== quotedInputLamports.toString()
    || !/^\d+$/.test(quote.otherAmountThreshold || '')) {
    throw new Error('Jupiter returned a quote for an unexpected route or amount')
  }
  const recipientAta = getAssociatedTokenAddressSync(outputMint, recipient)
  const result = await swapWithChange(
    utxos, lamports, outputMint, recipientAta, BigInt(quote.otherAmountThreshold),
    { ...options(connection, signer), swapSlippageBps: 100 }, recipient,
  )
  await saveState(result.outputUtxos, [...state.signatures, result.signature])
  const savedRefunds = await readJson<{ version: 1, swaps: unknown[] }>(swapRefundsPath(), { version: 1, swaps: [] })
  await writePrivateJson(swapRefundsPath(), {
    version: 1,
    swaps: [...savedRefunds.swaps, {
      signature: result.signature, requestId: result.requestId,
      swapStatePda: result.swapStatePda, refund: result.refund,
    }],
  })
  return {
    protocol: 'cloakc', action: `swap-sol-to-${symbol.toLowerCase()}`, signature: result.signature,
    requestId: result.requestId, swapStatePda: result.swapStatePda,
    recipient: recipient.toBase58(), recipientAta: recipientAta.toBase58(),
    grossLamports: lamports, feeLamports, quotedInputLamports,
    outputSymbol: symbol, expectedOutputBaseUnits: quote.outAmount,
    minimumOutputBaseUnits: quote.otherAmountThreshold,
    priceImpactPct: quote.priceImpactPct,
    route: quote.routePlan?.map((leg: any) => ({
      ammKey: leg.swapInfo?.ammKey, label: leg.swapInfo?.label,
      inputMint: leg.swapInfo?.inputMint, outputMint: leg.swapInfo?.outputMint,
      inAmount: leg.swapInfo?.inAmount, outAmount: leg.swapInfo?.outAmount,
      percent: leg.percent,
    })),
  }
}
