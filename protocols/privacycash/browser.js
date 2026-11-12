import { Connection, PublicKey } from '@solana/web3.js'
import { ENDPOINTS, MINTS as REGISTRY_MINTS } from '../addresses.js'
import { isNoAnswer } from '../shared/network.js'
import { NO_TIMINGS, withTimings } from '../shared/stage-timings.js'
import { createCircuitFiles } from './circuit-files.js'
import { coversRecentOnly, scanKeys, scanOlderNotes, scanRecentFirst, treeSize } from './recent-scan.js'
import { TOKEN_DECIMALS, withdrawalFor } from '../shared/units.js'

// Re-exported so bridge.js and the older call sites keep one source.
export const MINTS = Object.freeze({ USDC: REGISTRY_MINTS.USDC, USDT: REGISTRY_MINTS.USDT })
const SIGN_IN_MESSAGE = new TextEncoder().encode('Privacy Money account sign in')
const CIRCUIT_BASE_PATH = '/circuit2/transaction2'
const RELAYER = new URL(ENDPOINTS.privacycashConfig).origin
const SUBMITS = { deposit: 'your deposit', withdraw: 'the withdrawal', swap: 'the swap', bridge: 'the bridge transfer' }

// What a relayer request that got no answer means for the payer: a submission
// may still have landed, a confirmation poll means it was accepted, and a read
// sent nothing.
export function relayerFailure(url, method = 'GET') {
  const submit = method === 'POST' && /^\/(deposit|withdraw|swap|bridge)(?:\/spl)?$/.exec(url.pathname)?.[1]
  if (submit) return `The connection to the Privacy Cash relayer dropped while it submitted ${SUBMITS[submit]}. It may still have gone through: check your balances before trying again.`
  if (url.pathname.startsWith('/utxos/check/')) return 'Privacy Cash accepted the transaction, but the connection dropped while confirming it. It most likely went through: check your balances before trying again.'
  const step = url.pathname.startsWith('/utxos') ? 'reading your shielded notes' : url.pathname.startsWith('/merkle') ? 'reading the pool state' : url.pathname === '/config' ? 'reading its fees' : 'contacting it'
  return `Could not reach the Privacy Cash relayer (${url.host}) while ${step}, so nothing was sent at that step.`
}

// The SDK calls the relayer with bare fetches, so a dropped connection reaches
// the page as the browser's "Failed to fetch". Installed once when this adapter
// loads, under captureWithdrawal's own swap of fetch, which restores it.
//
// The same wrapper answers the proving files from memory (circuit-files.js):
// snarkjs fetches both by URL inside every proof, and they are downloaded and
// checked once per page instead, ahead of the click when preload() ran. A file
// that cannot be loaded and checked is fetched from the network as before.
// Returns the files' holder, for preload().
export function labelRelayerFailures(target = globalThis) {
  const fetch = target.fetch
  if (typeof fetch !== 'function') return null
  if (fetch.labelsRelayer) return fetch.circuitFiles ?? null
  const circuitFiles = createCircuitFiles({ fetch: (input, init) => fetch(input, init), base: target.location?.href, subtle: target.crypto?.subtle })
  const labelled = async (input, init) => {
    const held = await circuitFiles.respond(input, init)
    if (held) return held
    try { return await fetch(input, init) } catch (error) {
      if (!isNoAnswer(error)) throw error
      let url
      try { url = new URL(String(input?.url ?? input), target.location?.href) } catch { throw error }
      if (url.origin !== RELAYER) throw error
      throw new Error(relayerFailure(url, String(init?.method ?? input?.method ?? 'GET').toUpperCase()), { cause: error })
    }
  }
  labelled.labelsRelayer = true
  labelled.circuitFiles = circuitFiles
  target.fetch = labelled
  return circuitFiles
}
const circuitFiles = labelRelayerFailures()

function signatureBytes(value) {
  const signature = value?.signature ?? value
  if (!(signature instanceof Uint8Array)) throw new Error('Wallet returned an invalid message signature')
  return signature
}

export function bytesToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(value) {
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

// The sign-in signature, kept in this browser: the note keys and the swap
// wallet derive from it, so the wallet is asked once.
async function signIn(provider, publicKey) {
  if (typeof provider.signMessage !== 'function') throw new Error('This wallet does not support message signing')
  const cacheKey = signatureKey(publicKey)
  const cached = localStorage.getItem(cacheKey)
  if (cached) {
    try { return base64ToBytes(cached) } catch { localStorage.removeItem(cacheKey) }
  }
  const signature = signatureBytes(await provider.signMessage(SIGN_IN_MESSAGE, 'utf8'))
  if (String(provider.publicKey) !== publicKey.toBase58()) throw new Error('Wallet account changed while signing')
  localStorage.setItem(cacheKey, bytesToBase64(signature))
  return signature
}

// The sign-in signature is also returned: the swap wallet is derived from it.
async function encryptionForWallet(provider, publicKey, EncryptionService) {
  const signature = await signIn(provider, publicKey)
  const encryptionService = new EncryptionService()
  encryptionService.deriveEncryptionKeyFromSignature(signature)
  return { encryptionService, signature }
}

// Asks for the sign-in signature alone, so a balance read after it, which can
// scan for minutes the first time, asks nothing and can run beside other pools'.
export async function unlockShielded({ provider }) {
  await signIn(provider, new PublicKey(String(provider.publicKey)))
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

// The SDK's log lines that start a stage of a deposit or a withdrawal
// (deposit.ts, withdraw.ts and their SPL twins in privacycash 1.2.2). The scan
// before them has no line of its own: the adapter enters it before the call.
const LOG_STAGES = [[/^generating ZK proof/i, 'proof'], [/^submitting transaction to relayer/i, 'relay request'], [/^waiting for transaction confirmation/i, 'settlement wait']]
// The proving files snarkjs fetches inside the proof (stage-timings.js takes them out of it).
const circuitDownload = (url) => (url.includes(`${CIRCUIT_BASE_PATH}.`) ? 'circuit download' : null)

// The SDK exposes no progress callback, but it logs every UTXO page it scans and
// every proof/relayer stage, so its logger is the only live progress there is,
// and the only sign of where a stage starts.
export function reportProgress(privacyCash, onStatus, timings = NO_TIMINGS) {
  privacyCash.setLogger?.((level, message) => {
    if (level === 'warn' || level === 'error') console.log(`[${level}]`, message)
    const stage = level === 'info' && LOG_STAGES.find(([line]) => line.test(message))?.[1]
    if (stage) timings.enter(stage)
    const page = /####fetch_utxo_offset\s+(\d+)/.exec(message)
    if (page) return onStatus(`Scanning notes ${page[1]}…`)
    const found = /Found (\d+) total UTXOs/.exec(message)
    if (found) return onStatus(`Loaded ${found[1]} notes…`)
    if (level === 'info') onStatus(message.replace(/\.*$/, '…').replace(/^./, (c) => c.toUpperCase()))
  })
}

// The SDK's scan for the wallet's notes of one asset: `extra` adds its `offset` or swaps its storage.
const scanNotes = (privacyCash, common, asset, extra) => (asset === 'SOL'
  ? privacyCash.getUtxos({ ...common, ...extra })
  : privacyCash.getUtxosSPL({ ...common, mintAddress: MINTS[asset], ...extra }))

// Before anything scans a wallet's notes of `asset` for the first time in this
// browser, reads the tree's recent notes only (recent-scan.js), so the SDK's
// own scans in deposit, withdraw and getUtxos start from there. Does nothing
// once the browser holds a position. Inside the queue, like every scan.
export function recentFirst(privacyCash, common, asset) {
  return scanRecentFirst({
    keys: scanKeys(privacyCash.localstorageKey, common.publicKey, asset),
    storage: common.storage,
    size: () => treeSize(asset),
    scan: (offset) => scanNotes(privacyCash, common, asset, { offset }),
  })
}

// Wallet check, circuit/WASM load and encryption-key derivation are identical for a
// private transfer and a private bridge, so both entry points share this setup.
// `fund: false` skips the wallet balance check, for a session that only withdraws.
export async function openPrivacyCashSession({ provider, asset, totalBaseUnits, fund = true, onStatus = () => {}, timings = NO_TIMINGS }) {
  if (!provider?.publicKey || typeof provider.signTransaction !== 'function') throw new Error('Connect a compatible Solana wallet')
  const publicKey = new PublicKey(String(provider.publicKey))
  const connection = rpcConnection()
  if (fund) {
    onStatus('Checking balance…')
    await assertWalletCanFund(connection, publicKey, asset, totalBaseUnits)
  }
  onStatus('Preparing privacy tools…')
  timings.enter('sdk load')
  const [{ WasmFactory }, privacyCash] = await Promise.all([
    import('@lightprotocol/hasher.rs'),
    import('privacycash/utils'),
  ])
  reportProgress(privacyCash, onStatus, timings)
  const lightWasm = await WasmFactory.getInstance()
  timings.enter('sign-in')
  const { encryptionService, signature } = await encryptionForWallet(provider, publicKey, privacyCash.EncryptionService)
  const common = { lightWasm, storage: localStorage, keyBasePath: CIRCUIT_BASE_PATH, publicKey, connection, encryptionService, referrer: '' }
  // The SDK's deposit and withdrawal scan from the saved position; a browser
  // without one gets it here, at the recent notes, instead of note 0.
  timings.enter('note scan')
  await recentFirst(privacyCash, common, asset)
  timings.enter('other')
  return {
    privacyCash,
    common,
    publicKey,
    connection,
    signature,
    transactionSigner: (transaction) => timings.during('wallet approval', () => provider.signTransaction(transaction)),
  }
}

export function withdrawTo(privacyCash, common, asset, recipient) {
  return asset === 'SOL'
    ? privacyCash.withdraw({ ...common, recipient: recipient.publicKey, amount_in_lamports: Number(recipient.baseUnits) })
    : privacyCash.withdrawSPL({ ...common, recipient: recipient.publicKey, mintAddress: new PublicKey(MINTS[asset]), base_units: Number(recipient.baseUnits) })
}

// Shields `units` into the wallet's own balance. `signer` is who pays and signs
// (the connected wallet unless given); the note always belongs to the wallet.
export function depositTo(privacyCash, common, asset, units, transactionSigner, signer) {
  return asset === 'SOL'
    ? privacyCash.deposit({ ...common, amount_in_lamports: Number(units), transactionSigner, signer })
    : privacyCash.depositSPL({ ...common, mintAddress: new PublicKey(MINTS[asset]), base_units: Number(units), transactionSigner, signer })
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
export async function noteAmounts(privacyCash, common, asset) {
  const utxos = await scanNotes(privacyCash, common, asset)
  return utxos.map((utxo) => BigInt(utxo.amount.toString())).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

// A withdrawal spends only the two largest notes, and when they fall short the
// SDK quietly pays out what they hold instead of failing, so this is the most
// one withdrawal can send.
export const withdrawalCapacity = (amounts) => (amounts[0] ?? 0n) + (amounts[1] ?? 0n)
export const unitsText = (units, asset) => `${Number(units) / 10 ** TOKEN_DECIMALS[asset]} ${asset}`
const descending = (a, b) => (a < b ? 1 : a > b ? -1 : 0)

// How the SDK would pay `amounts` (base units, one per recipient, in order) from
// `notes`: each withdrawal spends the two largest notes and returns its change
// as a new note, so an amount above them goes out as several withdrawals.
// Returns the withdrawal amounts per recipient, or null when the notes cannot
// cover them with every withdrawal at least `minimum`. A withdrawal that would
// leave less than `minimum` for the next one is shrunk to leave exactly that.
export function planWithdrawals(notes, amounts, minimum) {
  const floor = minimum > 0n ? minimum : 1n
  const pool = [...notes].sort(descending)
  const plan = []
  for (const amount of amounts) {
    const withdrawals = []
    for (let left = amount; left > 0n;) {
      if (!pool.length) return null
      const capacity = pool.shift() + (pool.shift() ?? 0n)
      let units = left < capacity ? left : capacity
      if (left > units && left - units < floor) units = left - floor
      if (units < floor) return null
      withdrawals.push(units)
      left -= units
      if (capacity > units) {
        const change = capacity - units
        const at = pool.findIndex((note) => note < change)
        pool.splice(at < 0 ? pool.length : at, 0, change)
      }
    }
    plan.push(withdrawals)
  }
  return plan
}

// The most `notes` can pay one recipient: all of it, unless the smallest notes
// cannot reach the minimum withdrawal, in which case they are left out.
export function maxPayable(notes, minimum) {
  const sorted = [...notes].sort(descending)
  for (let count = sorted.length; count > 0; count--) {
    const total = sorted.slice(0, count).reduce((sum, note) => sum + note, 0n)
    if (planWithdrawals(sorted, [total], minimum)) return total
  }
  return 0n
}

// The relayer's current terms for one asset, in base units: a withdrawal pays
// `rate` of its amount plus `fixed`, and must be at least `minimum`, which is
// never below what that fee alone would take.
export async function withdrawalTerms(privacyCash, asset) {
  const scale = 10 ** TOKEN_DECIMALS[asset]
  const name = asset.toLowerCase()
  // Sequential: getConfig caches the relayer config after its first fetch.
  const rate = await privacyCash.getConfig('withdraw_fee_rate')
  const fixedTokens = asset === 'SOL' ? await privacyCash.getConfig('withdraw_rent_fee') : (await privacyCash.getConfig('rent_fees'))[name]
  const configured = BigInt(Math.round(scale * ((await privacyCash.getConfig('minimum_withdrawal'))[name] ?? 0)))
  const fixed = BigInt(Math.floor(scale * fixedTokens))
  const floor = BigInt(Math.ceil(Number(fixed) / (1 - rate))) + 1n
  return { rate, fixed, minimum: configured > floor ? configured : floor }
}

export const withdrawalFee = (terms, units) => BigInt(Math.floor(Number(units) * terms.rate)) + terms.fixed

// A recipient marked `net` gets exactly its baseUnits: the withdrawal adds the
// relayer's current fee, which a suggested top-up pays from what stays shielded.
export async function withNetPayouts(asset, recipients) {
  if (!recipients?.some((item) => item.net)) return recipients
  const terms = await withdrawalTerms(await import('privacycash/utils'), asset)
  return recipients.map((item) => item.net ? { ...item, net: false, baseUnits: withdrawalFor(BigInt(item.baseUnits), (units) => withdrawalFee(terms, units), terms.minimum) } : item)
}

// A SOL withdrawal's fee and minimum, in lamports: what sending a recipient SOL
// for network fees costs (see withdrawalFor in shared/units.js).
export async function solWithdrawalFee() {
  const terms = await withdrawalTerms(await import('privacycash/utils'), 'SOL')
  return { fee: (units) => withdrawalFee(terms, units), minimum: terms.minimum }
}

// What paying `amounts` of `asset` (base units, one per recipient) from a
// shieldedBalances reading would take: { withdrawals, fee, minimum }, or null
// when the notes cannot cover it. Lets the UI say before sending that a payment
// will split, and what the extra fixed fees cost.
export function planShieldedSend(reading, asset, amounts) {
  const terms = reading.terms?.[asset]
  const plan = terms && planWithdrawals(reading.notes[asset] ?? [], amounts, terms.minimum)
  if (!plan) return null
  const withdrawals = plan.flat()
  return { withdrawals: withdrawals.length, fee: withdrawals.reduce((sum, units) => sum + withdrawalFee(terms, units), 0n), minimum: terms.minimum }
}

// A change note can reach the relayer's index a few seconds after its withdrawal
// confirms. Until it does, the SDK would see less and quietly send less, so wait.
export async function awaitCapacity(privacyCash, common, asset, units, onStatus) {
  for (let attempt = 0; ; attempt++) {
    if (withdrawalCapacity(await noteAmounts(privacyCash, common, asset)) >= units) return
    if (attempt === 10) throw new Error('Your shielded balance changed while sending')
    onStatus('Waiting for the pool to index your change…')
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

// Pays each recipient from the wallet's shielded balance, with no deposit. An
// amount above the two largest notes goes out as consecutive withdrawals to the
// same address (see planWithdrawals). The relayer submits each and pays its
// network fee, so the wallet signs nothing beyond its sign-in message, but the
// pool's fee applies to every withdrawal.
async function sendFromShielded({ provider, asset, recipients, onStatus, timings = NO_TIMINGS }) {
  const { privacyCash, common } = await openPrivacyCashSession({ provider, asset, totalBaseUnits: 0n, fund: false, onStatus, timings })
  onStatus('Reading your shielded balance…')
  timings.leg('withdrawal'); timings.enter('note scan')
  const notes = await noteAmounts(privacyCash, common, asset)
  const terms = await withdrawalTerms(privacyCash, asset)
  const plan = planWithdrawals(notes, recipients.map((recipient) => BigInt(recipient.baseUnits)), terms.minimum)
  if (!plan) {
    const most = maxPayable(notes, terms.minimum)
    throw new Error(most ? `Your shielded ${asset} can pay at most ${unitsText(most, asset)}, in withdrawals of at least ${unitsText(terms.minimum, asset)}`
      : `Not enough shielded ${asset} for a withdrawal of at least ${unitsText(terms.minimum, asset)}`)
  }
  const total = plan.flat().length
  const receipt = { provider: 'privacycash', asset, depositSignature: null, withdrawals: [] }
  let sent = 0n
  const fail = (message) => Object.assign(new Error(receipt.withdrawals.length
    ? `Sent ${receipt.withdrawals.length} of ${total} withdrawals (${unitsText(sent, asset)}), then: ${message}` : message), receipt.withdrawals.length ? { receipt } : {})
  for (const [index, recipient] of recipients.entries()) {
    for (const units of plan[index]) {
      onStatus(total > 1 ? `Sending withdrawal ${receipt.withdrawals.length + 1} of ${total}…` : 'Sending from your shielded balance…')
      let result
      try {
        timings.leg(total > 1 ? `withdrawal ${receipt.withdrawals.length + 1}` : 'withdrawal'); timings.enter('note scan')
        await awaitCapacity(privacyCash, common, asset, units, onStatus)
        result = await withdrawTo(privacyCash, common, asset, { publicKey: recipient.publicKey, baseUnits: units })
      } catch (error) { throw fail(error instanceof Error ? error.message : String(error)) }
      receipt.withdrawals.push(result)
      sent += units
      if (result.isPartial) throw fail(`PrivacyCash sent less than asked in withdrawal ${receipt.withdrawals.length}`)
    }
  }
  return receipt
}

// Deposits `totalBaseUnits` and pays the recipients from it. Whatever the
// recipients do not take stays in the wallet's shielded balance as change.
// `source: 'shielded'` pays from that balance instead, with no deposit.
export async function executePrivacyCashTransfer({ provider, asset, totalBaseUnits, recipients, delayMinutes = 0, source = 'wallet', onStatus = () => {}, timings = NO_TIMINGS }) {
  if (delayMinutes && recipients.length !== 1) throw new Error('A delivery deadline supports one recipient')
  recipients = await withNetPayouts(asset, recipients)
  if (source === 'shielded') {
    if (delayMinutes) throw new Error('A delivery deadline needs a fresh deposit')
    return sendFromShielded({ provider, asset, recipients, onStatus, timings })
  }
  if (recipients.reduce((sum, recipient) => sum + BigInt(recipient.baseUnits), 0n) > BigInt(totalBaseUnits)) throw new Error('Recipients add up to more than the deposit')
  const { privacyCash, common, transactionSigner } = await openPrivacyCashSession({ provider, asset, totalBaseUnits, onStatus, timings })

  onStatus('Approve deposit in your wallet…')
  // The SDK's deposit scans for the wallet's notes first, then proves.
  timings.leg('deposit'); timings.enter('note scan')
  const deposit = await depositTo(privacyCash, common, asset, totalBaseUnits, transactionSigner)

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
      timings.leg(recipients.length > 1 ? `withdrawal ${index + 1}` : 'withdrawal'); timings.enter('note scan')
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
// total, `spendable` the most a shielded payment can send (see maxPayable), and
// `notes` with `terms` feed planShieldedSend.
// Payment-link notes are sealed under keys of their own, so they are not among
// them. The SDK caches its scan position in localStorage: the first scan reads
// the pool's recent notes (recent-scan.js), later ones only what is new, and
// `recent` lists the assets whose balance therefore leaves out older notes
// until rescanShielded has read them. With `prompt: false` nothing asks
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
    encryptionService: (await encryptionForWallet(provider, publicKey, privacyCash.EncryptionService)).encryptionService }
  const result = { balances: {}, spendable: {}, notes: {}, terms: {}, recent: [] }
  // One tree at a time: the SDK keeps its scan progress in module state.
  for (const asset of ['SOL', ...Object.keys(MINTS)]) {
    await recentFirst(privacyCash, common, asset)
    const notes = await noteAmounts(privacyCash, common, asset)
    if (coversRecentOnly(scanKeys(privacyCash.localstorageKey, publicKey, asset), localStorage)) result.recent.push(asset)
    const terms = await withdrawalTerms(privacyCash, asset)
    result.notes[asset] = notes
    result.terms[asset] = terms
    result.balances[asset] = notes.reduce((sum, note) => sum + note, 0n)
    result.spendable[asset] = maxPayable(notes, terms.minimum)
  }
  return result
}

// The full rescan: reads every tree whose balance covers recent notes only from
// note 0, minutes for the SOL tree, and adds what it finds to the balance. It
// runs in the queue like any scan and gives way to a payment: execute() stops
// it, and it starts over when asked again. Resolves to whether it found notes.
let rescan = null
export function rescanShielded({ provider, onStatus = () => {} }) {
  rescan?.abort()
  const controller = new AbortController()
  rescan = controller
  return exclusive(async () => {
    controller.signal.throwIfAborted()
    const publicKey = new PublicKey(String(provider.publicKey))
    const privacyCash = await import('privacycash/utils')
    reportProgress(privacyCash, onStatus)
    const common = { publicKey, connection: rpcConnection(), abortSignal: controller.signal,
      encryptionService: (await encryptionForWallet(provider, publicKey, privacyCash.EncryptionService)).encryptionService }
    let found = false
    for (const asset of ['SOL', ...Object.keys(MINTS)]) {
      const keys = scanKeys(privacyCash.localstorageKey, publicKey, asset)
      if (await scanOlderNotes({ keys, storage: localStorage, scan: (storage) => scanNotes(privacyCash, { ...common, storage }, asset) })) found = true
    }
    return found
  }).finally(() => { if (rescan === controller) rescan = null })
}

// Loads what a payment would otherwise load after the click: the SDK, the
// hasher's WebAssembly and the two proving files (19.7 MB, checked against
// their digests, then held in memory for every proof on this page). It asks the
// wallet for nothing and proves nothing. Not started while a payment runs or
// waits; a preload still downloading when one starts is shared with it, not
// repeated. Resolves to whether everything loaded, never rejects.
let payments = 0
let preloading = null
export function preload() {
  if (payments || !circuitFiles) return Promise.resolve(false)
  preloading ??= Promise.all([
    import('@lightprotocol/hasher.rs').then(({ WasmFactory }) => WasmFactory.getInstance()),
    import('privacycash/utils'),
    ...circuitFiles.paths.map((path) => circuitFiles.load(path)),
  ]).then(() => true, () => { preloading = null; return false })
  return preloading
}

// The one entry point the UI calls. Bridging and swapping live in bridge.js and
// swap.js and are loaded only when asked for, so their relayer code stays out of
// the transfer path.
export async function execute({ kind, ...options }) {
  // A payment never waits behind a full rescan.
  rescan?.abort()
  payments += 1
  try {
    // Timed from the click: a send behind a balance read shows the wait as queued.
    if (kind === 'send') {
      return await withTimings('privacycash', { downloads: circuitDownload }, (timings) => exclusive(() => { timings.enter('other'); return executePrivacyCashTransfer({ ...options, timings }) }))
    }
    if (kind === 'bridge') {
      const { executePrivacyCashBridge } = await import('./bridge.js')
      return await exclusive(() => executePrivacyCashBridge(options))
    }
    if (kind === 'swap') {
      const { executePrivacyCashSwap } = await import('./swap.js')
      return await exclusive(() => executePrivacyCashSwap(options))
    }
    throw new Error(`PrivacyCash has no browser ${kind} flow`)
  } finally { payments -= 1 }
}
