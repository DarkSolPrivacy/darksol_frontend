import { Connection, PublicKey } from '@solana/web3.js'
import { MINTS as REGISTRY_MINTS } from '../addresses.js'
import { TOKEN_DECIMALS } from '../shared/units.js'

// Re-exported so bridge.js and the older call sites keep one source.
export const MINTS = Object.freeze({ USDC: REGISTRY_MINTS.USDC, USDT: REGISTRY_MINTS.USDT })
const SIGN_IN_MESSAGE = new TextEncoder().encode('Privacy Money account sign in')
const CIRCUIT_BASE_PATH = '/circuit2/transaction2'

function signatureBytes(value) {
  const signature = value?.signature ?? value
  if (!(signature instanceof Uint8Array)) throw new Error('Wallet returned an invalid message signature')
  return signature
}

function encodeSignature(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeSignature(value) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

// The SDK keeps its note-scan progress in module state and in shared localStorage
// offsets, so two scans at once (a balance read beside a send) can skip notes.
// Everything that reads or spends notes runs through this queue, one at a time.
let queue = Promise.resolve()
export function exclusive(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

const signatureKey = (publicKey) => `privacycash-signature-${publicKey.toBase58()}`
const rpcConnection = () => new Connection(import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString(), 'confirmed')

async function encryptionForWallet(provider, publicKey, EncryptionService) {
  if (typeof provider.signMessage !== 'function') throw new Error('This wallet does not support message signing')
  const cacheKey = signatureKey(publicKey)
  let signature
  const cached = localStorage.getItem(cacheKey)
  if (cached) {
    try { signature = decodeSignature(cached) } catch { localStorage.removeItem(cacheKey) }
  }
  if (!signature) {
    signature = signatureBytes(await provider.signMessage(SIGN_IN_MESSAGE, 'utf8'))
    if (String(provider.publicKey) !== publicKey.toBase58()) throw new Error('Wallet account changed while signing')
    localStorage.setItem(cacheKey, encodeSignature(signature))
  }
  const encryptionService = new EncryptionService()
  encryptionService.deriveEncryptionKeyFromSignature(signature)
  return encryptionService
}

async function assertWalletCanFund(connection, publicKey, asset, totalBaseUnits) {
  if (asset === 'SOL') {
    const balance = BigInt(await connection.getBalance(publicKey, 'confirmed'))
    if (balance < totalBaseUnits) throw new Error('Not enough SOL in the connected wallet')
    return
  }
  const mintAddress = MINTS[asset]
  if (!mintAddress) throw new Error('Unsupported asset')
  const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(mintAddress) }, 'confirmed')
  const balance = accounts.value.reduce((sum, account) => {
    const raw = account.account.data.parsed?.info?.tokenAmount?.amount
    return sum + (typeof raw === 'string' ? BigInt(raw) : 0n)
  }, 0n)
  if (balance < totalBaseUnits) throw new Error(`Not enough ${asset} in the connected wallet`)
  if (await connection.getBalance(publicKey, 'confirmed') === 0) throw new Error('A small SOL balance is required for network fees')
}

// The SDK exposes no progress callback, but it logs every UTXO page it scans and
// every proof/relayer stage, so its logger is the only live progress there is.
export function reportProgress(privacyCash, onStatus) {
  privacyCash.setLogger?.((level, message) => {
    if (level === 'warn' || level === 'error') console.log(`[${level}]`, message)
    const page = /####fetch_utxo_offset\s+(\d+)/.exec(message)
    if (page) return onStatus(`Scanning notes ${page[1]}…`)
    const found = /Found (\d+) total UTXOs/.exec(message)
    if (found) return onStatus(`Loaded ${found[1]} notes…`)
    if (level === 'info') onStatus(message.replace(/\.*$/, '…').replace(/^./, (c) => c.toUpperCase()))
  })
}

// Wallet check, circuit/WASM load and encryption-key derivation are identical for a
// private transfer and a private bridge, so both entry points share this setup.
// `fund: false` skips the wallet balance check, for a session that only withdraws.
export async function openPrivacyCashSession({ provider, asset, totalBaseUnits, fund = true, onStatus = () => {} }) {
  if (!provider?.publicKey || typeof provider.signTransaction !== 'function') throw new Error('Connect a compatible Solana wallet')
  const publicKey = new PublicKey(String(provider.publicKey))
  const connection = rpcConnection()
  if (fund) {
    onStatus('Checking balance…')
    await assertWalletCanFund(connection, publicKey, asset, totalBaseUnits)
  }
  onStatus('Preparing privacy tools…')
  const [{ WasmFactory }, privacyCash] = await Promise.all([
    import('@lightprotocol/hasher.rs'),
    import('privacycash/utils'),
  ])
  reportProgress(privacyCash, onStatus)
  const lightWasm = await WasmFactory.getInstance()
  const encryptionService = await encryptionForWallet(provider, publicKey, privacyCash.EncryptionService)
  const common = { lightWasm, storage: localStorage, keyBasePath: CIRCUIT_BASE_PATH, publicKey, connection, encryptionService, referrer: '' }
  return {
    privacyCash,
    common,
    publicKey,
    connection,
    transactionSigner: (transaction) => provider.signTransaction(transaction),
  }
}

function withdrawTo(privacyCash, common, asset, recipient) {
  return asset === 'SOL'
    ? privacyCash.withdraw({ ...common, recipient: recipient.publicKey, amount_in_lamports: Number(recipient.baseUnits) })
    : privacyCash.withdrawSPL({ ...common, recipient: recipient.publicKey, mintAddress: new PublicKey(MINTS[asset]), base_units: Number(recipient.baseUnits) })
}

// Runs the SDK's own withdraw up to its relayer POST and returns that body
// unsent. The proof binds recipient, amount and fee, so whoever relays it later
// can deliver it or drop it, never redirect it. Stopping there also skips the
// SDK's confirmation polling and leaves its note cache alone: getUtxos re-reads
// spent-ness from the nullifier accounts on chain, so a retry still finds the note.
export async function captureWithdrawal(run) {
  const realFetch = globalThis.fetch
  const captured = new Error('Withdrawal captured')
  let body = null
  globalThis.fetch = async (input, init) => {
    if (init?.method !== 'POST' || !/\/withdraw(\/spl)?$/.test(String(input?.url ?? input))) return realFetch(input, init)
    body = JSON.parse(init.body)
    throw captured
  }
  try { await run() } catch (error) { if (error !== captured) throw error } finally { globalThis.fetch = realFetch }
  if (!body) throw new Error('PrivacyCash built no withdrawal to schedule')
  return body
}

// The wallet's unspent notes of one asset, largest first, in base units.
async function noteAmounts(privacyCash, common, asset) {
  const utxos = asset === 'SOL' ? await privacyCash.getUtxos(common) : await privacyCash.getUtxosSPL({ ...common, mintAddress: MINTS[asset] })
  return utxos.map((utxo) => BigInt(utxo.amount.toString())).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

// A withdrawal spends only the two largest notes, and when they fall short the
// SDK quietly pays out what they hold instead of failing, so this is the most
// one withdrawal can send.
export const withdrawalCapacity = (amounts) => (amounts[0] ?? 0n) + (amounts[1] ?? 0n)
const unitsText = (units, asset) => `${Number(units) / 10 ** TOKEN_DECIMALS[asset]} ${asset}`

// Pays each recipient from the wallet's shielded balance, with no deposit. The
// relayer pays the network fee, so the wallet signs only its sign-in message.
async function sendFromShielded({ provider, asset, recipients, onStatus }) {
  const { privacyCash, common } = await openPrivacyCashSession({ provider, asset, totalBaseUnits: 0n, fund: false, onStatus })
  const receipt = { provider: 'privacycash', asset, depositSignature: null, withdrawals: [] }
  const fail = (message) => Object.assign(new Error(receipt.withdrawals.length ? `Sent ${receipt.withdrawals.length} of ${recipients.length}, then: ${message}` : message),
    receipt.withdrawals.length ? { receipt } : {})
  for (const [index, recipient] of recipients.entries()) {
    onStatus(recipients.length > 1 ? `Sending ${index + 1} of ${recipients.length} from your shielded balance…` : 'Sending from your shielded balance…')
    let result
    try {
      const available = withdrawalCapacity(await noteAmounts(privacyCash, common, asset))
      if (available < BigInt(recipient.baseUnits)) {
        throw new Error(available ? `Your shielded ${asset} can send at most ${unitsText(available, asset)} at once` : `No shielded ${asset} left in PrivacyCash`)
      }
      result = await withdrawTo(privacyCash, common, asset, recipient)
    } catch (error) { throw fail(error instanceof Error ? error.message : String(error)) }
    receipt.withdrawals.push(result)
    if (result.isPartial) throw fail(`PrivacyCash sent less than asked to recipient ${index + 1}`)
  }
  return receipt
}

// Deposits `totalBaseUnits` and pays the recipients from it. Whatever the
// recipients do not take stays in the wallet's shielded balance as change.
// `source: 'shielded'` pays from that balance instead, with no deposit.
export async function executePrivacyCashTransfer({ provider, asset, totalBaseUnits, recipients, delayMinutes = 0, source = 'wallet', onStatus = () => {} }) {
  if (delayMinutes && recipients.length !== 1) throw new Error('A delivery deadline supports one recipient')
  if (source === 'shielded') {
    if (delayMinutes) throw new Error('A delivery deadline needs a fresh deposit')
    return sendFromShielded({ provider, asset, recipients, onStatus })
  }
  if (recipients.reduce((sum, recipient) => sum + BigInt(recipient.baseUnits), 0n) > BigInt(totalBaseUnits)) throw new Error('Recipients add up to more than the deposit')
  const { privacyCash, common, transactionSigner } = await openPrivacyCashSession({ provider, asset, totalBaseUnits, onStatus })

  onStatus('Approve deposit in your wallet…')
  const deposit = asset === 'SOL'
    ? await privacyCash.deposit({ ...common, amount_in_lamports: Number(totalBaseUnits), transactionSigner })
    : await privacyCash.depositSPL({ ...common, mintAddress: new PublicKey(MINTS[asset]), base_units: Number(totalBaseUnits), transactionSigner })

  const receipt = { provider: 'privacycash', asset, depositSignature: deposit.tx, withdrawals: [] }
  if (delayMinutes) {
    onStatus('Preparing delayed delivery…')
    // A failed proof leaves the funds shielded, and the page offers Send now.
    try { receipt.withdrawal = await captureWithdrawal(() => withdrawTo(privacyCash, common, asset, recipients[0])) } catch {}
    return receipt
  }
  try {
    for (let index = 0; index < recipients.length; index += 1) {
      onStatus(`Sending ${index + 1} of ${recipients.length}…`)
      receipt.withdrawals.push(await withdrawTo(privacyCash, common, asset, recipients[index]))
    }
  } catch (error) {
    const partialError = new Error(`Deposit succeeded, but withdrawal ${receipt.withdrawals.length + 1} failed: ${error instanceof Error ? error.message : String(error)}`)
    partialError.receipt = receipt
    throw partialError
  }
  return receipt
}

// Send now, for a delayed delivery that failed, expired, was cancelled or that
// the server forgot. Both of the proof's nullifier accounts existing means it
// landed after all (a relay that timed out, a purged status), and a second
// withdrawal would pay the recipient twice.
export function sendScheduledNow(options) {
  return exclusive(() => deliverScheduled(options))
}

async function deliverScheduled({ provider, job, onStatus = () => {} }) {
  const { privacyCash, common, connection } = await openPrivacyCashSession({ provider, asset: job.asset, totalBaseUnits: 0n, onStatus })
  if (job.nullifiers) {
    const accounts = await connection.getMultipleAccountsInfo(job.nullifiers.map((key) => new PublicKey(key)), 'confirmed')
    if (accounts.every(Boolean)) return { tx: null }
  }
  onStatus('Sending…')
  return withdrawTo(privacyCash, common, job.asset, { publicKey: new PublicKey(job.recipient), baseUnits: BigInt(job.baseUnits) })
}

// The wallet's own unspent notes per asset, in base units: `balances` is the
// total and `spendable` the most one withdrawal can send (see withdrawalCapacity).
// Payment-link notes are sealed under keys of their own, so they are not among
// them. The SDK caches its scan position in localStorage: the first scan reads
// the whole pool, later ones only what is new. With `prompt: false` nothing asks
// the wallet to sign, and a browser that holds no signature yet gets null.
export async function shieldedBalances({ provider, prompt = true, signal, onStatus = () => {} }) {
  const publicKey = new PublicKey(String(provider.publicKey))
  if (!prompt && !localStorage.getItem(signatureKey(publicKey))) return null
  return exclusive(() => { signal?.throwIfAborted(); return readShielded({ provider, publicKey, signal, onStatus }) })
}

async function readShielded({ provider, publicKey, signal, onStatus }) {
  const privacyCash = await import('privacycash/utils')
  reportProgress(privacyCash, onStatus)
  const common = { publicKey, connection: rpcConnection(), storage: localStorage, abortSignal: signal,
    encryptionService: await encryptionForWallet(provider, publicKey, privacyCash.EncryptionService) }
  const result = { balances: {}, spendable: {} }
  // One tree at a time: the SDK keeps its scan progress in module state.
  for (const asset of ['SOL', ...Object.keys(MINTS)]) {
    const amounts = await noteAmounts(privacyCash, common, asset)
    result.balances[asset] = amounts.reduce((sum, amount) => sum + amount, 0n)
    result.spendable[asset] = withdrawalCapacity(amounts)
  }
  return result
}

// The one entry point the UI calls. Bridging lives in bridge.js and is loaded
// only when asked for, so its relayer code stays out of the transfer path.
export async function execute({ kind, ...options }) {
  if (kind === 'send') return exclusive(() => executePrivacyCashTransfer(options))
  if (kind === 'bridge') {
    const { executePrivacyCashBridge } = await import('./bridge.js')
    return exclusive(() => executePrivacyCashBridge(options))
  }
  throw new Error(`PrivacyCash has no browser ${kind} flow`)
}
