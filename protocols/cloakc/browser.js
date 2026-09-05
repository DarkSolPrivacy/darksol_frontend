import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import { MINTS } from '../addresses.js'

// Cloak settles into a public SPL recipient; the mints come from the registry.
const OUTPUT_MINTS = Object.freeze({ USDC: MINTS.USDC, USDT: MINTS.USDT })

const bytesToBase64 = (bytes) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function walletSignature(value) {
  const signature = value?.signature ?? value
  if (!(signature instanceof Uint8Array)) throw new Error('Wallet returned an invalid message signature')
  return signature
}

function saveRecovery(wallet, result) {
  const key = `cloak-swap-recovery-${wallet}`
  let previous = []
  try { previous = JSON.parse(localStorage.getItem(key) || '[]') } catch { previous = [] }
  localStorage.setItem(key, JSON.stringify([...previous, {
    createdAt: new Date().toISOString(),
    signature: result.signature,
    requestId: result.requestId,
    swapStatePda: result.swapStatePda,
    refund: result.refund,
  }]))
}

function saveUtxos(wallet, sdk, utxos) {
  const encoded = utxos.filter((utxo) => utxo.amount > 0n)
    .map((utxo) => bytesToBase64(sdk.serializeUtxo(utxo)))
  localStorage.setItem(`cloak-utxos-${wallet}`, JSON.stringify(encoded))
}

async function quoteSwap(inputBaseUnits, outputMint) {
  const response = await fetch(`/api/swap-quote?inputAsset=SOL&outputAsset=${encodeURIComponent(outputMint)}&amount=${inputBaseUnits}`)
  const quote = await response.json()
  if (!response.ok) throw new Error(quote.detail || quote.error || 'Swap quote failed')
  return quote
}

export async function executeCloakSwap({ provider, inputAsset, outputAsset, totalBaseUnits, recipient, onStatus = () => {} }) {
  if (inputAsset !== 'SOL' || !OUTPUT_MINTS[outputAsset]) throw new Error('CLOAKC supports SOL to USDC or USDT swaps only')
  if (!provider?.publicKey || typeof provider.signTransaction !== 'function' || typeof provider.signMessage !== 'function') {
    throw new Error('Connect a Solana wallet that supports transaction and message signing')
  }
  if (totalBaseUnits < 10_000_000n) throw new Error('CLOAKC requires at least 0.01 SOL for the deposit')
  const publicKey = new PublicKey(String(provider.publicKey))
  const recipientWallet = new PublicKey(String(recipient))
  const outputMint = new PublicKey(OUTPUT_MINTS[outputAsset])
  const recipientAta = getAssociatedTokenAddressSync(outputMint, recipientWallet)
  const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString()
  const connection = new Connection(rpcUrl, 'confirmed')
  const balance = BigInt(await connection.getBalance(publicKey, 'confirmed'))
  if (balance < totalBaseUnits) throw new Error('Not enough SOL in the connected wallet')

  onStatus('Preparing CLOAKC deposit...')
  const sdk = await import('@cloak.dev/sdk')
  const owner = await sdk.generateUtxoKeypair()
  const output = await sdk.createUtxo(totalBaseUnits, owner, sdk.NATIVE_SOL_MINT)
  const baseOptions = {
    connection,
    programId: sdk.CLOAK_PROGRAM_ID,
    relayUrl: sdk.CLOAK_PRODUCTION_RELAY_URL,
    depositorPublicKey: publicKey,
    walletPublicKey: publicKey,
    signTransaction: (transaction) => provider.signTransaction(transaction),
    signMessage: async (message) => walletSignature(await provider.signMessage(message, 'utf8')),
    chainNoteViewingKeyNk: sdk.getNkFromUtxoPrivateKey(owner.privateKey),
    onProgress: onStatus,
  }

  onStatus('Approve the private SOL deposit...')
  const deposit = await sdk.transact({
    inputUtxos: [await sdk.createZeroUtxo(sdk.NATIVE_SOL_MINT)],
    outputUtxos: [output],
    externalAmount: totalBaseUnits,
    depositor: publicKey,
  }, baseOptions)
  saveUtxos(publicKey.toBase58(), sdk, deposit.outputUtxos)

  try {
    const fee = 5_000_000n + totalBaseUnits * 3n / 1000n
    const quotedInput = totalBaseUnits - fee
    if (quotedInput <= 0n) throw new Error('Swap amount does not exceed the CLOAKC protocol fee')
    onStatus('Getting a fresh Jupiter quote...')
    const quote = await quoteSwap(quotedInput, outputAsset)
    onStatus('Approve the private swap...')
    const swap = await sdk.swapWithChange(
      deposit.outputUtxos,
      totalBaseUnits,
      outputMint,
      recipientAta,
      BigInt(quote.minimumOutputBaseUnits),
      { ...baseOptions, cachedMerkleTree: deposit.merkleTree, swapSlippageBps: 100, maxWalletApprovals: 3 },
      recipientWallet,
    )
    saveRecovery(publicKey.toBase58(), swap)
    saveUtxos(publicKey.toBase58(), sdk, swap.outputUtxos)
    return {
      provider: 'cloakc', inputAsset, outputAsset,
      depositSignature: deposit.signature,
      swapSignature: swap.signature,
      requestId: swap.requestId,
      swapStatePda: swap.swapStatePda,
      recipientAta: recipientAta.toBase58(),
      expectedOutputBaseUnits: quote.expectedOutputBaseUnits,
      minimumOutputBaseUnits: quote.minimumOutputBaseUnits,
      withdrawals: [{ tx: swap.signature }],
    }
  } catch (error) {
    const wrapped = new Error(`Deposit succeeded, but swap failed: ${error instanceof Error ? error.message : String(error)}. Your private CLOAKC note was saved in this browser for recovery.`)
    wrapped.receipt = { provider: 'cloakc', inputAsset, outputAsset, depositSignature: deposit.signature, withdrawals: [] }
    throw wrapped
  }
}

// The one entry point the UI calls, so it branches on neither protocol nor
// capability. Cloak only executes swaps in the browser today; anything else is
// refused here rather than silently doing the wrong thing.
export async function execute({ kind, ...options }) {
  if (kind !== 'swap') throw new Error(`CLOAKC has no browser ${kind} flow`)
  return executeCloakSwap(options)
}
