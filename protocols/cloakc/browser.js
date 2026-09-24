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

// Merged, never overwritten: this is the only copy of a note's key, so a note
// stranded by an earlier failed attempt must survive the next deposit.
function saveUtxos(wallet, sdk, created, spent = []) {
  const key = `cloak-utxos-${wallet}`
  const encode = (utxo) => bytesToBase64(sdk.serializeUtxo(utxo))
  let saved = []
  try { saved = JSON.parse(localStorage.getItem(key) || '[]') } catch { saved = [] }
  const gone = new Set(spent.map(encode))
  const kept = saved.filter((entry) => !gone.has(entry))
  localStorage.setItem(key, JSON.stringify([...new Set([...kept, ...created.filter((utxo) => utxo.amount > 0n).map(encode)])]))
}

async function quoteSwap(inputBaseUnits, outputMint) {
  const response = await fetch(`/api/swap-quote?inputAsset=SOL&outputAsset=${encodeURIComponent(outputMint)}&amount=${inputBaseUnits}`)
  const quote = await response.json()
  if (!response.ok) throw new Error(quote.detail || quote.error || 'Swap quote failed')
  return quote
}

// The deposit a send and a swap both start with: one fresh note holding the
// whole amount, saved locally the moment it exists.
async function depositNote({ provider, asset, totalBaseUnits, onStatus }) {
  if (!provider?.publicKey || typeof provider.signTransaction !== 'function' || typeof provider.signMessage !== 'function') {
    throw new Error('Connect a Solana wallet that supports transaction and message signing')
  }
  if (asset !== 'SOL' && !MINTS[asset]) throw new Error(`CLOAKC does not support ${asset}`)
  if (asset === 'SOL' && totalBaseUnits < 10_000_000n) throw new Error('CLOAKC requires at least 0.01 SOL for the deposit')
  const publicKey = new PublicKey(String(provider.publicKey))
  const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString()
  const connection = new Connection(rpcUrl, 'confirmed')
  if (asset === 'SOL' && BigInt(await connection.getBalance(publicKey, 'confirmed')) < totalBaseUnits) {
    throw new Error('Not enough SOL in the connected wallet')
  }

  onStatus('Preparing CLOAKC deposit...')
  const sdk = await import('@cloak.dev/sdk')
  const mint = asset === 'SOL' ? sdk.NATIVE_SOL_MINT : new PublicKey(MINTS[asset])
  const owner = await sdk.generateUtxoKeypair()
  const output = await sdk.createUtxo(totalBaseUnits, owner, mint)
  const options = {
    connection,
    programId: sdk.CLOAK_PROGRAM_ID,
    relayUrl: sdk.CLOAK_PRODUCTION_RELAY_URL,
    depositorPublicKey: publicKey,
    walletPublicKey: publicKey,
    signTransaction: (transaction) => provider.signTransaction(transaction),
    signMessage: async (message) => walletSignature(await provider.signMessage(message, 'utf8')),
    // An SPL deposit carrying chain notes can overflow the 1232-byte transaction,
    // which is why payment-deposit.js drops them too.
    ...(asset === 'SOL' ? { chainNoteViewingKeyNk: sdk.getNkFromUtxoPrivateKey(owner.privateKey) } : { disableChainNotes: true }),
    onProgress: onStatus,
  }

  onStatus(`Approve the private ${asset} deposit...`)
  const deposit = await sdk.transact({
    inputUtxos: [await sdk.createZeroUtxo(mint)],
    outputUtxos: [output],
    externalAmount: totalBaseUnits,
    depositor: publicKey,
  }, options)
  const wallet = publicKey.toBase58()
  saveUtxos(wallet, sdk, deposit.outputUtxos)
  return { sdk, options, deposit, wallet }
}

// Deposits, then withdraws the whole note to one public address. The manifest
// keeps Cloak single-recipient, so there is no change note to carry forward.
export async function executeCloakSend({ provider, asset, totalBaseUnits, recipient, recipients = [], onStatus = () => {} }) {
  if (recipients.length > 1) throw new Error('CLOAKC sends to one recipient')
  const recipientWallet = new PublicKey(String(recipient))
  const { sdk, options, deposit, wallet } = await depositNote({ provider, asset, totalBaseUnits, onStatus })
  try {
    onStatus('Sending privately...')
    const withdrawal = await sdk.fullWithdraw(deposit.outputUtxos, recipientWallet, { ...options, cachedMerkleTree: deposit.merkleTree })
    saveUtxos(wallet, sdk, withdrawal.outputUtxos, deposit.outputUtxos)
    return { provider: 'cloakc', asset, depositSignature: deposit.signature, withdrawals: [{ tx: withdrawal.signature }] }
  } catch (error) {
    const wrapped = new Error(`Deposit succeeded, but the private send failed: ${error instanceof Error ? error.message : String(error)}. Your private CLOAKC note was saved in this browser for recovery.`)
    wrapped.receipt = { provider: 'cloakc', asset, depositSignature: deposit.signature, withdrawals: [] }
    throw wrapped
  }
}

export async function executeCloakSwap({ provider, inputAsset, outputAsset, totalBaseUnits, recipient, onStatus = () => {} }) {
  if (inputAsset !== 'SOL' || !OUTPUT_MINTS[outputAsset]) throw new Error('CLOAKC supports SOL to USDC or USDT swaps only')
  const recipientWallet = new PublicKey(String(recipient))
  const outputMint = new PublicKey(OUTPUT_MINTS[outputAsset])
  const recipientAta = getAssociatedTokenAddressSync(outputMint, recipientWallet)
  const { sdk, options, deposit, wallet } = await depositNote({ provider, asset: 'SOL', totalBaseUnits, onStatus })

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
      { ...options, cachedMerkleTree: deposit.merkleTree, swapSlippageBps: 100, maxWalletApprovals: 3 },
      recipientWallet,
    )
    saveRecovery(wallet, swap)
    saveUtxos(wallet, sdk, swap.outputUtxos, deposit.outputUtxos)
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
// capability. Anything the manifest does not run is refused here rather than
// silently doing the wrong thing.
export async function execute({ kind, ...options }) {
  if (kind === 'send') return executeCloakSend(options)
  if (kind === 'swap') return executeCloakSwap(options)
  throw new Error(`CLOAKC has no browser ${kind} flow`)
}
