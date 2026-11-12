import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { MINTS } from '../addresses.js'
import { pollingConnection } from '../shared/http-confirm.js'
import { NO_TIMINGS, withTimings } from '../shared/stage-timings.js'
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
// Confirms over HTTP: the RPC proxy has no websocket (shared/http-confirm.js).
const rpcConnection = () => pollingConnection(import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString(), 'confirmed')
const byAmount = (a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0)

// Every note this browser saved for `wallet`, any mint, spent ones included
// until saveUtxos sees them spent.
async function savedNotes(sdk, wallet) {
  let saved = []
  try { saved = JSON.parse(localStorage.getItem(`cloak-utxos-${wallet}`) || '[]') } catch { saved = [] }
  return Promise.all(saved.map((entry) => sdk.deserializeUtxo(base64ToBytes(entry))))
}

// The SDK's progress lines that start a stage of a transaction (transact in
// @cloak.dev/sdk 0.2.1). Reading the pool's tree comes first and has several
// lines of its own, so the adapter enters it before each call; the wallet's
// signatures are timed where they are asked for.
const PROGRESS_STAGES = [
  [/^(re)?generating ZK proof/i, 'proof'],
  [/^converting proof to bytes/i, 'other'],
  [/^(sending transaction|signing and sending transaction|submitting to relay)/i, 'relay request'],
  [/^(confirming transaction|verifying the transaction against chain state|relay reported)/i, 'settlement wait'],
]
// The proving files, which the SDK fetches once per page inside its first proof.
const circuitDownload = (url) => (/\/cloak-circuits\//.test(url) ? 'circuit download' : null)

// The SDK's progress hook: the status line, and where a stage starts.
function progressHook(onStatus, timings) {
  return (message) => {
    const stage = typeof message === 'string' && PROGRESS_STAGES.find(([line]) => line.test(message))?.[1]
    if (stage) timings.enter(stage)
    onStatus(message)
  }
}

// Loads what a payment would otherwise load after the click: the SDK and its
// proving files, through the SDK's own loadVerifiedCircuitArtifacts, which
// checks them against the digests it pins and keeps them for its proofs. It
// asks the wallet for nothing and proves nothing. Not started while a payment
// runs. Resolves to whether both loaded, never rejects.
let payments = 0
let preloading = null
export function preload() {
  if (payments) return Promise.resolve(false)
  preloading ??= import('@cloak.dev/sdk')
    .then((sdk) => sdk.loadVerifiedCircuitArtifacts(sdk.getCircuitsPath()))
    .then(() => true, () => { preloading = null; return false })
  return preloading
}

// The SDK for a payment. A preload still downloading the proving files is
// waited for, so the proof finds them held instead of downloading them again.
async function loadSdk() {
  const sdk = await import('@cloak.dev/sdk')
  await preloading
  return sdk
}

// What a private send or withdrawal needs: the relay authenticates the wallet
// with one message signature per request. Deposits add their own fields.
function relayOptions(sdk, provider, connection, onStatus, timings = NO_TIMINGS) {
  const publicKey = new PublicKey(String(provider.publicKey))
  return {
    connection,
    programId: sdk.CLOAK_PROGRAM_ID,
    relayUrl: sdk.CLOAK_PRODUCTION_RELAY_URL,
    walletPublicKey: publicKey,
    signMessage: (message) => timings.during('wallet approval', async () => walletSignature(await provider.signMessage(message, 'utf8'))),
    onProgress: progressHook(onStatus, timings),
  }
}

// Brings `notes` (same mint) down to the two a transaction can spend: merged two
// at a time, the smallest first, by a private send to a new note of the same
// owner, free of pool fees, one wallet message each. The SDK's partialWithdraw
// merges too, but keeps each merged note only in memory, so a failure after a
// merge would lose it; here each is saved before the next step. Returns the
// notes to spend and the Merkle tree to spend them with.
async function mergeNotes({ sdk, options, wallet, notes, onStatus }) {
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
  return { inputs, tree }
}

// Pays `amount` from `notes` (same mint) to `recipient`, keeping the rest as a
// change note, after merging them down to two (mergeNotes).
export async function withdrawNotes({ sdk, options, wallet, notes, amount, recipient, onStatus = () => {}, timings = NO_TIMINGS }) {
  const { inputs, tree } = await mergeNotes({ sdk, options, wallet, notes, onStatus })
  onStatus('Sending privately...')
  timings.leg('withdrawal'); timings.enter('note scan')
  const withdrawal = await sdk.partialWithdraw(inputs, recipient, amount, { ...options, cachedMerkleTree: tree })
  saveUtxos(wallet, sdk, withdrawal.outputUtxos, inputs)
  return withdrawal
}

// The unspent notes of `asset` this browser saved that cover `amount`, fewest
// and largest first, or an error saying what there is.
async function pickSaved(sdk, connection, wallet, asset, amount) {
  const mint = asset === 'SOL' ? sdk.NATIVE_SOL_MINT : new PublicKey(MINTS[asset])
  const { unspent } = await sdk.verifyUtxos(await savedNotes(sdk, wallet), connection, sdk.CLOAK_PROGRAM_ID)
  const notes = unspent.filter((utxo) => utxo.mintAddress.equals(mint) && utxo.amount > 0n)
  const picked = sdk.selectUtxos(notes, amount)
  if (picked) return picked
  const held = sdk.sumUtxoAmounts(notes)
  throw new Error(held ? `Your shielded Cloak ${asset} in this browser is ${Number(held) / 10 ** TOKEN_DECIMALS[asset]} ${asset}, less than this payment`
    : `No shielded Cloak ${asset} is saved in this browser`)
}

// Pays one recipient from the notes this browser saved, with no deposit.
async function sendFromSaved({ provider, asset, amount, recipient, onStatus, timings = NO_TIMINGS }) {
  if (!provider?.publicKey || typeof provider.signMessage !== 'function') throw new Error('Connect a Solana wallet that supports message signing')
  if (asset !== 'SOL' && !MINTS[asset]) throw new Error(`CLOAKC does not support ${asset}`)
  onStatus('Reading your Cloak notes...')
  timings.enter('sdk load')
  const sdk = await loadSdk()
  timings.leg('withdrawal'); timings.enter('note scan')
  const connection = rpcConnection()
  const wallet = String(provider.publicKey)
  const notes = await pickSaved(sdk, connection, wallet, asset, amount)
  const withdrawal = await withdrawNotes({ sdk, options: relayOptions(sdk, provider, connection, onStatus, timings), wallet, notes, amount, recipient, onStatus, timings })
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
async function depositNote({ provider, asset, totalBaseUnits, onStatus, timings = NO_TIMINGS }) {
  if (!provider?.publicKey || typeof provider.signTransaction !== 'function' || typeof provider.signMessage !== 'function') {
    throw new Error('Connect a Solana wallet that supports transaction and message signing')
  }
  if (asset !== 'SOL' && !MINTS[asset]) throw new Error(`CLOAKC does not support ${asset}`)
  if (asset === 'SOL' && totalBaseUnits < 10_000_000n) throw new Error('CLOAKC requires at least 0.01 SOL for the deposit')
  const publicKey = new PublicKey(String(provider.publicKey))
  const connection = rpcConnection()
  if (asset === 'SOL' && BigInt(await connection.getBalance(publicKey, 'confirmed')) < totalBaseUnits) {
    throw new Error('Not enough SOL in the connected wallet')
  }

  onStatus('Preparing CLOAKC deposit...')
  timings.enter('sdk load')
  const sdk = await loadSdk()
  timings.leg('deposit'); timings.enter('other')
  const mint = asset === 'SOL' ? sdk.NATIVE_SOL_MINT : new PublicKey(MINTS[asset])
  const owner = await sdk.generateUtxoKeypair()
  const output = await sdk.createUtxo(totalBaseUnits, owner, mint)
  const options = {
    connection,
    programId: sdk.CLOAK_PROGRAM_ID,
    relayUrl: sdk.CLOAK_PRODUCTION_RELAY_URL,
    depositorPublicKey: publicKey,
    walletPublicKey: publicKey,
    signTransaction: (transaction) => timings.during('wallet approval', () => provider.signTransaction(transaction)),
    signMessage: (message) => timings.during('wallet approval', async () => walletSignature(await provider.signMessage(message, 'utf8'))),
    // An SPL deposit carrying chain notes can overflow the 1232-byte transaction,
    // which is why payment-deposit.js drops them too.
    ...(asset === 'SOL' ? { chainNoteViewingKeyNk: sdk.getNkFromUtxoPrivateKey(owner.privateKey) } : { disableChainNotes: true }),
    onProgress: progressHook(onStatus, timings),
  }

  onStatus(`Approve the private ${asset} deposit...`)
  timings.enter('note scan')
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
export async function executeCloakSend({ provider, asset, totalBaseUnits, recipient, recipients, source = 'wallet', onStatus = () => {}, timings = NO_TIMINGS }) {
  if (recipients?.length > 1) throw new Error('CLOAKC sends to one recipient')
  const payout = recipients ? recipients.reduce((sum, item) => sum + BigInt(item.baseUnits), 0n) : BigInt(totalBaseUnits)
  if (source === 'shielded') {
    if (!payout) throw new Error('Nothing to pay')
    return sendFromSaved({ provider, asset, amount: payout, recipient: new PublicKey(String(recipient)), onStatus, timings })
  }
  if (payout > BigInt(totalBaseUnits)) throw new Error('The recipient gets more than the deposit')
  const recipientWallet = payout ? new PublicKey(String(recipient)) : null
  const { sdk, options, deposit, wallet } = await depositNote({ provider, asset, totalBaseUnits, onStatus, timings })
  const receipt = { provider: 'cloakc', asset, depositSignature: deposit.signature, withdrawals: [] }
  if (!payout) return receipt
  try {
    // The relay rejects a withdrawal without exactly one compact chain note.
    const notes = deposit.outputUtxos.filter((utxo) => utxo.amount > 0n)
    const withdrawal = await withdrawNotes({ sdk, options: { ...options, disableChainNotes: false, cachedMerkleTree: deposit.merkleTree }, wallet, notes, amount: payout, recipient: recipientWallet, onStatus, timings })
    receipt.withdrawals.push({ tx: withdrawal.signature })
    return receipt
  } catch (error) {
    const wrapped = new Error(`Deposit succeeded, but the private send failed: ${error instanceof Error ? error.message : String(error)}. Your private CLOAKC note was saved in this browser: pay from it with Use shielded funds.`)
    wrapped.receipt = receipt
    throw wrapped
  }
}

// Swaps what the recipient is paid for (`recipients`' total, else all of
// `totalBaseUnits`) to a public token account. From the wallet it first
// deposits `totalBaseUnits` plus `gasBaseUnits`; `source: 'shielded'` spends the
// SOL notes saved in this browser instead (merged down to two first). The swap
// leaves the rest as its change note: `gasBaseUnits` of it then go to the
// recipient as SOL for network fees, and anything beyond stays shielded.
export async function executeCloakSwap({ provider, inputAsset, outputAsset, totalBaseUnits, gasBaseUnits = 0n, recipient, recipients, source = 'wallet', onStatus = () => {} }) {
  if (inputAsset !== 'SOL' || !OUTPUT_MINTS[outputAsset]) throw new Error('CLOAKC supports SOL to USDC or USDT swaps only')
  const recipientWallet = new PublicKey(String(recipient))
  const outputMint = new PublicKey(OUTPUT_MINTS[outputAsset])
  const recipientAta = getAssociatedTokenAddressSync(outputMint, recipientWallet)
  const gas = BigInt(gasBaseUnits)
  const swapUnits = recipients ? recipients.reduce((sum, item) => sum + BigInt(item.baseUnits), 0n) : BigInt(totalBaseUnits)
  const fromShielded = source === 'shielded'
  if (!fromShielded && swapUnits > BigInt(totalBaseUnits)) throw new Error('The swap takes more than the deposit')

  let sdk, options, wallet, inputs, tree, depositSignature = null
  if (fromShielded) {
    if (!provider?.publicKey || typeof provider.signMessage !== 'function') throw new Error('Connect a Solana wallet that supports message signing')
    onStatus('Reading your Cloak notes...')
    sdk = await loadSdk()
    const connection = rpcConnection()
    wallet = String(provider.publicKey)
    options = relayOptions(sdk, provider, connection, onStatus)
    const notes = await pickSaved(sdk, connection, wallet, 'SOL', swapUnits + gas)
    ;({ inputs, tree } = await mergeNotes({ sdk, options, wallet, notes, onStatus }))
  } else {
    let deposit
    ;({ sdk, options, deposit, wallet } = await depositNote({ provider, asset: 'SOL', totalBaseUnits: BigInt(totalBaseUnits) + gas, onStatus }))
    inputs = deposit.outputUtxos
    tree = deposit.merkleTree
    depositSignature = deposit.signature
  }

  let swap
  let receipt
  try {
    const fee = 5_000_000n + swapUnits * 3n / 1000n
    const quotedInput = swapUnits - fee
    if (quotedInput <= 0n) throw new Error('Swap amount does not exceed the CLOAKC protocol fee')
    onStatus('Getting a fresh Jupiter quote...')
    const quote = await quoteSwap(quotedInput, outputAsset)
    onStatus('Approve the private swap...')
    swap = await sdk.swapWithChange(
      inputs,
      swapUnits,
      outputMint,
      recipientAta,
      BigInt(quote.minimumOutputBaseUnits),
      { ...options, cachedMerkleTree: tree, swapSlippageBps: 100, maxWalletApprovals: 3 },
      recipientWallet,
    )
    saveRecovery(wallet, swap)
    saveUtxos(wallet, sdk, swap.outputUtxos, inputs)
    receipt = {
      provider: 'cloakc', inputAsset, outputAsset,
      depositSignature,
      swapSignature: swap.signature,
      requestId: swap.requestId,
      swapStatePda: swap.swapStatePda,
      recipientAta: recipientAta.toBase58(),
      expectedOutputBaseUnits: quote.expectedOutputBaseUnits,
      minimumOutputBaseUnits: quote.minimumOutputBaseUnits,
      withdrawals: [{ tx: swap.signature }],
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (fromShielded) throw new Error(`The swap failed: ${reason}. Your Cloak notes stay saved in this browser.`)
    const wrapped = new Error(`Deposit succeeded, but swap failed: ${reason}. Your private CLOAKC note was saved in this browser: pay from it with Use shielded funds.`)
    wrapped.receipt = { provider: 'cloakc', inputAsset, outputAsset, depositSignature, withdrawals: [] }
    throw wrapped
  }
  // After the swap, so this SOL failing never undoes it. Only the gas leaves;
  // the rest of the change stays shielded.
  if (gas) {
    const change = swap.outputUtxos.filter((utxo) => utxo.amount > 0n)
    try {
      onStatus('Sending SOL for fees...')
      const withdrawal = await sdk.partialWithdraw(change, recipientWallet, gas, { ...options, cachedMerkleTree: swap.merkleTree })
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
  payments += 1
  try {
    if (kind === 'send') return await withTimings('cloakc', { downloads: circuitDownload }, (timings) => { timings.enter('other'); return executeCloakSend({ ...options, timings }) })
    if (kind === 'swap') return await executeCloakSwap(options)
    throw new Error(`CLOAKC has no browser ${kind} flow`)
  } finally { payments -= 1 }
}
