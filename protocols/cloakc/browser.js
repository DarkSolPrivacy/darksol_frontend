import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import { MINTS } from '../addresses.js'
import { TOKEN_DECIMALS } from '../shared/units.js'

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

const base64ToBytes = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const rpcConnection = () => new Connection(import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString(), 'confirmed')
const byAmount = (a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0)

// Every note this browser saved for `wallet`, any mint, spent ones included
// until saveUtxos sees them spent.
async function savedNotes(sdk, wallet) {
  let saved = []
  try { saved = JSON.parse(localStorage.getItem(`cloak-utxos-${wallet}`) || '[]') } catch { saved = [] }
  return Promise.all(saved.map((entry) => sdk.deserializeUtxo(base64ToBytes(entry))))
}

// What a private send or withdrawal needs: the relay authenticates the wallet
// with one message signature per request. Deposits add their own fields.
function relayOptions(sdk, provider, connection, onStatus) {
  const publicKey = new PublicKey(String(provider.publicKey))
  return {
    connection,
    programId: sdk.CLOAK_PROGRAM_ID,
    relayUrl: sdk.CLOAK_PRODUCTION_RELAY_URL,
    walletPublicKey: publicKey,
    signMessage: async (message) => walletSignature(await provider.signMessage(message, 'utf8')),
    onProgress: onStatus,
  }
}

// Pays `amount` from `notes` (same mint) to `recipient`, keeping the rest as a
// change note. A transaction spends at most two notes, so more are merged two
// at a time first: a private send to a new note of the same owner, free of
// pool fees, one wallet message each. The SDK's partialWithdraw merges too, but
// keeps each merged note only in memory, so a failure after a merge would lose
// it; here each is saved before the next step.
export async function withdrawNotes({ sdk, options, wallet, notes, amount, recipient, onStatus = () => {} }) {
  let inputs = [...notes]
  let tree = options.cachedMerkleTree
  for (let merge = 1, merges = inputs.length - 2; inputs.length > 2; merge++) {
    onStatus(`Merging your Cloak notes (${merge} of ${merges})...`)
    const [first, second, ...rest] = inputs.sort(byAmount)
    const output = await sdk.createUtxo(first.amount + second.amount, first.keypair, first.mintAddress)
    const result = await sdk.transact({ inputUtxos: [first, second], outputUtxos: [output], externalAmount: 0n }, { ...options, cachedMerkleTree: tree })
    const merged = result.outputUtxos?.find((utxo) => utxo.amount > 0n) ?? output
    if (merged.index === undefined && result.commitmentIndices?.[0] >= 0) merged.index = result.commitmentIndices[0]
    saveUtxos(wallet, sdk, [merged], [first, second])
    tree = result.merkleTree
    inputs = [merged, ...rest]
  }
  onStatus('Sending privately...')
  const withdrawal = await sdk.partialWithdraw(inputs, recipient, amount, { ...options, cachedMerkleTree: tree })
  saveUtxos(wallet, sdk, withdrawal.outputUtxos, inputs)
  return withdrawal
}

// Pays one recipient from the notes this browser saved, with no deposit.
async function sendFromSaved({ provider, asset, amount, recipient, onStatus }) {
  if (!provider?.publicKey || typeof provider.signMessage !== 'function') throw new Error('Connect a Solana wallet that supports message signing')
  if (asset !== 'SOL' && !MINTS[asset]) throw new Error(`CLOAKC does not support ${asset}`)
  onStatus('Reading your Cloak notes...')
  const sdk = await import('@cloak.dev/sdk')
  const connection = rpcConnection()
  const wallet = String(provider.publicKey)
  const mint = asset === 'SOL' ? sdk.NATIVE_SOL_MINT : new PublicKey(MINTS[asset])
  const { unspent } = await sdk.verifyUtxos(await savedNotes(sdk, wallet), connection, sdk.CLOAK_PROGRAM_ID)
  const notes = unspent.filter((utxo) => utxo.mintAddress.equals(mint) && utxo.amount > 0n)
  // The fewest, largest notes that cover it, so as few merges as possible.
  const picked = sdk.selectUtxos(notes, amount)
  if (!picked) {
    const held = sdk.sumUtxoAmounts(notes)
    throw new Error(held ? `Your shielded Cloak ${asset} in this browser is ${Number(held) / 10 ** TOKEN_DECIMALS[asset]} ${asset}, less than this payment`
      : `No shielded Cloak ${asset} is saved in this browser`)
  }
  const withdrawal = await withdrawNotes({ sdk, options: relayOptions(sdk, provider, connection, onStatus), wallet, notes: picked, amount, recipient, onStatus })
  return { provider: 'cloakc', asset, depositSignature: null, withdrawals: [{ tx: withdrawal.signature }] }
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

// Deposits `totalBaseUnits`, then withdraws what the recipient is paid to one
// public address: all of it, less when part stays shielded (the change note,
// saved in this browser), nothing when shielding only. `source: 'shielded'`
// pays from the notes saved here instead, with no deposit.
export async function executeCloakSend({ provider, asset, totalBaseUnits, recipient, recipients, source = 'wallet', onStatus = () => {} }) {
  if (recipients?.length > 1) throw new Error('CLOAKC sends to one recipient')
  const payout = recipients ? recipients.reduce((sum, item) => sum + BigInt(item.baseUnits), 0n) : BigInt(totalBaseUnits)
  if (source === 'shielded') {
    if (!payout) throw new Error('Nothing to pay')
    return sendFromSaved({ provider, asset, amount: payout, recipient: new PublicKey(String(recipient)), onStatus })
  }
  if (payout > BigInt(totalBaseUnits)) throw new Error('The recipient gets more than the deposit')
  const recipientWallet = payout ? new PublicKey(String(recipient)) : null
  const { sdk, options, deposit, wallet } = await depositNote({ provider, asset, totalBaseUnits, onStatus })
  const receipt = { provider: 'cloakc', asset, depositSignature: deposit.signature, withdrawals: [] }
  if (!payout) return receipt
  try {
    // The relay rejects a withdrawal without exactly one compact chain note.
    const notes = deposit.outputUtxos.filter((utxo) => utxo.amount > 0n)
    const withdrawal = await withdrawNotes({ sdk, options: { ...options, disableChainNotes: false, cachedMerkleTree: deposit.merkleTree }, wallet, notes, amount: payout, recipient: recipientWallet, onStatus })
    receipt.withdrawals.push({ tx: withdrawal.signature })
    return receipt
  } catch (error) {
    const wrapped = new Error(`Deposit succeeded, but the private send failed: ${error instanceof Error ? error.message : String(error)}. Your private CLOAKC note was saved in this browser: pay from it with Use shielded funds.`)
    wrapped.receipt = receipt
    throw wrapped
  }
}

// `gasBaseUnits` ride the same deposit: the swap leaves them as its change note,
// which then goes to the recipient as SOL for network fees.
export async function executeCloakSwap({ provider, inputAsset, outputAsset, totalBaseUnits, gasBaseUnits = 0n, recipient, onStatus = () => {} }) {
  if (inputAsset !== 'SOL' || !OUTPUT_MINTS[outputAsset]) throw new Error('CLOAKC supports SOL to USDC or USDT swaps only')
  const recipientWallet = new PublicKey(String(recipient))
  const outputMint = new PublicKey(OUTPUT_MINTS[outputAsset])
  const recipientAta = getAssociatedTokenAddressSync(outputMint, recipientWallet)
  const gas = BigInt(gasBaseUnits)
  const { sdk, options, deposit, wallet } = await depositNote({ provider, asset: 'SOL', totalBaseUnits: totalBaseUnits + gas, onStatus })

  let swap
  let receipt
  try {
    const fee = 5_000_000n + totalBaseUnits * 3n / 1000n
    const quotedInput = totalBaseUnits - fee
    if (quotedInput <= 0n) throw new Error('Swap amount does not exceed the CLOAKC protocol fee')
    onStatus('Getting a fresh Jupiter quote...')
    const quote = await quoteSwap(quotedInput, outputAsset)
    onStatus('Approve the private swap...')
    swap = await sdk.swapWithChange(
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
    receipt = {
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
  // After the swap, so this SOL failing never undoes it.
  if (gas) {
    const change = swap.outputUtxos.filter((utxo) => utxo.amount > 0n)
    try {
      onStatus('Sending SOL for fees...')
      const withdrawal = await sdk.fullWithdraw(change, recipientWallet, { ...options, cachedMerkleTree: swap.merkleTree })
      saveUtxos(wallet, sdk, withdrawal.outputUtxos, change)
      receipt.gas = { tx: withdrawal.signature }
    } catch (error) {
      receipt.gasError = `${error instanceof Error ? error.message : String(error)}. The SOL stays in a private CLOAKC note saved in this browser`
    }
  }
  return receipt
}

// A SOL withdrawal's fee and minimum, in lamports: what sending a recipient SOL
// for network fees costs (see withdrawalFor in shared/units.js).
export async function solWithdrawalFee() {
  const { calculateFeeBigint } = await import('@cloak.dev/sdk')
  return { fee: calculateFeeBigint, minimum: 0n }
}

// Unspent notes this browser saved, per asset, in base units: change kept
// shielded, shield-only deposits, and sends or swaps that did not finish. Cloak
// has no scan by wallet, so a note saved in another browser is not counted.
// `balances` also counts a note the SDK cannot check (no leaf index yet), since
// saveUtxos drops every note it saw spent; `spendable` only the checked ones,
// which a payment from shielded funds spends (merged first when more than two).
export async function shieldedBalances({ provider }) {
  const wallet = String(provider.publicKey)
  const balances = { SOL: 0n, USDC: 0n, USDT: 0n }
  const spendable = { SOL: 0n, USDC: 0n, USDT: 0n }
  let saved = []
  try { saved = JSON.parse(localStorage.getItem(`cloak-utxos-${wallet}`) || '[]') } catch { saved = [] }
  if (!saved.length) return { balances, spendable }
  const sdk = await import('@cloak.dev/sdk')
  const { unspent, skipped } = await sdk.verifyUtxos(await savedNotes(sdk, wallet), rpcConnection(), sdk.CLOAK_PROGRAM_ID)
  const assets = { [sdk.NATIVE_SOL_MINT.toBase58()]: 'SOL', [MINTS.USDC]: 'USDC', [MINTS.USDT]: 'USDT' }
  for (const utxo of [...unspent, ...skipped]) {
    const asset = assets[utxo.mintAddress.toBase58()]
    if (!asset) continue
    balances[asset] += utxo.amount
    if (unspent.includes(utxo)) spendable[asset] += utxo.amount
  }
  return { balances, spendable }
}

// The one entry point the UI calls, so it branches on neither protocol nor
// capability. Anything the manifest does not run is refused here rather than
// silently doing the wrong thing.
export async function execute({ kind, ...options }) {
  if (kind === 'send') return executeCloakSend(options)
  if (kind === 'swap') return executeCloakSwap(options)
  throw new Error(`CLOAKC has no browser ${kind} flow`)
}
