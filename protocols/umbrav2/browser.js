// Umbra v2 (Nimbus) browser adapter.
//
// Three things set it apart from the other adapters:
//
// 1. Its prover uses shared memory, which a browser only allows on a
//    cross-origin isolated page, so vercel.json and vite.config.js send
//    Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy with every page.
// 2. Its WebAssembly and prover worker are served from /nimbus/, which
//    postinstall copies out of the package. The SDK checks each file's SHA-256
//    against the digest the package pins before running it.
// 3. Umbra's gateway wants an API key, so every gateway service goes through the
//    backend's /api/umbra-gateway, which adds it. The RPC stays on this origin
//    as well: the SDK only treats an endpoint as the gateway when its origin
//    differs from the RPC's, so with both here it asks for no token of its own.
//
// A send is a deposit into the sender's own private balance, then a withdrawal
// to the recipient, or only the withdrawal when it pays from that balance. The
// wallet signs the unlock message (once per tab), the one-time registration and
// the deposit; Umbra's relayer submits the withdrawal.
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { MINTS } from '../addresses.js'
import { TOKEN_DECIMALS } from '../shared/units.js'
import { SWAP_MINIMUM, finishSwap, ultraSwap } from '../shared/swap-wallet.js'
import { swapEligibility } from '../../src/swap-routes.js'
import manifest from './manifest.js'
import { createReceipt, throwWithReceipt } from '../shared/receipts.js'
import { NO_TIMINGS, withTimings } from '../shared/stage-timings.js'
import { createProvingKeyFetch, heldArtifacts, wantedFiles, warmProvingKeys } from './proving-keys.js'
import { PAGES_PER_ROUND, STEP_SECONDS, createProgress, expectedPages, planSteps, readLines } from './progress-plan.js'

// How long to wait for the indexer to see a registration or a deposit: three minutes.
const POLL_MS = 4000
const POLLS = 45

// The priority fee, in lamports for the whole transaction, on the registration,
// the deposit's funding (the wallet signs both) and the deposit. The SDK's default
// is none, and Solflare then appends a SetComputeUnitPrice of its own, which
// pushes the transaction past the compute limit the SDK measured: Solflare's
// simulation fails ("Simulation failed") and the SDK refuses the changed
// message. With a price already set Solflare keeps it; the guards it still adds
// are accepted by wallet-additions.js. The SDK spreads this total over the
// compute limit, so it stays small: Solflare's guards raise the limit, and the
// fee with it.
const PRIORITY_FEE_LAMPORTS = 100n

let loading = null

// Whether this browser has read a wallet's notes before, and how many notes the
// pool held then: written after each full read, so the next payment knows its
// read is a quick one, or how far it has to catch up (progress-plan.js).
const readMarkKey = (address) => `umbrav2-read-${address}`
function readMark(address) {
  try { return JSON.parse(localStorage.getItem(readMarkKey(address))) } catch { return null }
}
function saveReadMark(address, leaf) {
  try { localStorage.setItem(readMarkKey(address), JSON.stringify({ leaf, at: Date.now() })) } catch {}
}

// The note stores this browser holds, before a session opens (opening one
// creates it). Null where the browser cannot list them.
async function storeNames() {
  try { return new Set((await indexedDB.databases()).map((db) => db.name)) } catch { return null }
}

// How many notes the pool holds: the count the indexer's CDN manifest names,
// the same public file every wallet's read fetches first. Null when unreachable.
let poolCount = null
function poolNoteCount(sdk) {
  if (poolCount && Date.now() - poolCount.at < 5 * 60_000) return poolCount.value
  const base = sdk?.settings?.endpoints?.indexerCdn
  if (!base) return Promise.resolve(null)
  const value = fetch(`${String(base).replace(/\/$/, '')}/manifest/utxo-1-p0.json`, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    .then((response) => response.ok ? response.json() : null)
    .then((manifest) => (Number.isSafeInteger(manifest?.next_leaf) ? manifest.next_leaf : null))
    .catch(() => null)
  poolCount = { at: Date.now(), value }
  return value
}

// What a session's read will take: whether this browser knows the wallet's
// notes (its store existed before the session and a full read was recorded),
// and the pages to read.
async function plannedRead(sdk, session, before, counting) {
  const mark = readMark(session.walletAddress)
  let existed = Boolean(mark)
  if (before) {
    try {
      const { buildNoteStoreBackendName } = await import('@umbra-privacy/nimbus-storage-solana/note-store')
      existed = existed && before.has(buildNoteStoreBackendName({ deployment: sdk.deployment, identityCommitment: session.identity.commitmentBytes }))
    } catch {}
  }
  const reading = { known: existed, savedLeaf: mark?.leaf, nextLeaf: await counting }
  return { ...reading, pages: expectedPages(reading) }
}

function loadSdk() {
  loading ??= (async () => {
    if (!window.crossOriginIsolated) throw new Error('Umbra v2 needs the page reloaded before it can send. Reload DarkSol and try again.')
    const nimbus = await import('@umbra-privacy/nimbus-solana-web')
    const gateway = new URL('/api/umbra-gateway', window.location.origin).toString()
    // No `proving` and no worker starter of our own: the SDK (0.5.0) then proves
    // in shared memory and, because the workers are the ones it starts itself,
    // keeps them and one loaded proving key for 120 s after a proof, so a
    // withdrawal that follows its deposit proves without starting over. A
    // custom starter or `threading: 'workers'` would give that up.
    const sdk = await nimbus.loadNimbusSdk({ cluster: 'mainnet' }, {
      assetsBaseUrl: '/nimbus/',
      // The SDK's own fetch, except that a proving file preload() downloaded
      // ahead is handed over instead of fetched again (proving-keys.js).
      platform: { fetch: createProvingKeyFetch() },
      endpoints: {
        rpc: new URL('/api/solana-rpc', window.location.origin).toString(),
        // The preset's gateway slugs, the ones server/umbra-gateway.js forwards.
        relayer: `${gateway}/relayer`,
        feeEnclave: `${gateway}/fee-enclave`,
        screeners: [{ nodeIndex: 0, endpoint: `${gateway}/screener` }],
        dataEndorsers: [{ nodeIndex: 0, endpoint: `${gateway}/data-endorser` }],
        guardians: [1, 2, 3].map((nodeIndex) => ({ nodeIndex, endpoint: `${gateway}/guardian-share-node-relay-${nodeIndex}` })),
      },
    })
    return { nimbus, sdk }
  })().catch((error) => { loading = null; throw error })
  return loading
}

// Deletes an unregistered identity's note store and opens the session again on a
// fresh one. The unlock secret is kept, so the wallet is not asked to sign again.
async function restartNoteStore(nimbus, sdk, session, signer) {
  const { buildNoteStoreBackendName } = await import('@umbra-privacy/nimbus-storage-solana/note-store')
  const name = buildNoteStoreBackendName({ deployment: sdk.deployment, identityCommitment: session.identity.commitmentBytes })
  nimbus.closeNimbusSession(session)
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = request.onblocked = () => resolve()
    request.onerror = () => reject(request.error)
  })
  const reopened = await nimbus.openNimbusSession(sdk, { connectedWallet: signer })
  if (reopened.kind === 'declined') throw new Error('The Umbra v2 unlock message was declined.')
  return reopened.session
}

// Polls until `check` holds. A failed read counts as not yet: the deposit has
// already landed by the time this runs, so one network error must not end it.
async function waitFor(what, check) {
  for (let poll = 0; poll < POLLS; poll += 1) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`Umbra v2 did not see the ${what} within three minutes`)
}

const landed = (outcome) => outcome?.kind === 'submitted' && outcome.submission.submission.kind === 'landed'
const outcomeName = (outcome) => outcome?.kind === 'submitted' ? outcome.submission.submission.kind : outcome?.kind
const spendFailure = (outcome) => outcome.kind === 'refused' ? outcome.refusal.kind
  : outcome.kind === 'relay-refused' ? outcome.code || outcome.detail : outcome.kind
const unitsText = (units, asset) => `${Number(units) / 10 ** TOKEN_DECIMALS[asset]} ${asset}`

// One session at a time: two opening at once would each ask the wallet for the
// unlock message, and a balance read beside a send could see it half done.
let queue = Promise.resolve()
function exclusive(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

// Where openNimbusSession's default tab store keeps the unlock secret
// (signature-secret-store.js in @umbra-privacy/nimbus-solana-web 0.5.0, a key
// it keeps fixed). Read directly, so asking whether the tab is unlocked loads
// none of the SDK.
const secretKey = (address) => `umbra/nimbus-solana-web/account-secret/mainnet/solana:mainnet/${address}`
function unlocked(address) {
  try { return Boolean(address && sessionStorage.getItem(secretKey(address))) } catch { return false }
}

// Connects the wallet-standard account and opens its session. The wallet signs
// the unlock message only when this tab has not kept its secret.
async function openSession(provider, progress = createProgress(() => {}, []), timings = NO_TIMINGS) {
  const standard = provider?.walletStandard
  if (!standard?.wallet) throw new Error('Umbra v2 needs a wallet-standard account. Reconnect the wallet and try again.')
  progress.step('open', 'Preparing Umbra v2…', { part: 0.6 })
  timings.enter('sdk load')
  const { nimbus, sdk } = await loadSdk()
  timings.enter('other')
  // The page is already connected, so this asks the wallet for nothing.
  const connection = await nimbus.openWalletConnection(sdk, { wallet: standard.wallet })
  if (connection.kind !== 'connected') throw new Error('The wallet did not connect to Umbra v2.')
  const { signer, transactionVersion } = connection.connected
  if (signer.account.address !== standard.account.address) throw new Error('Switch the wallet back to the connected account and try again.')
  const wasUnlocked = unlocked(signer.account.address)
  if (wasUnlocked) progress.step('open', 'Opening your Umbra v2 balance…')
  else progress.step('unlock', 'Approve the Umbra v2 unlock message…')
  const [before, counting] = [await storeNames(), poolNoteCount(sdk)]
  // The unlock message when this tab has not kept its secret, and the session's first reads.
  timings.enter('sign-in')
  const opened = await nimbus.openNimbusSession(sdk, { connectedWallet: signer }).finally(() => timings.enter('other'))
  if (opened.kind === 'declined') throw new Error('The Umbra v2 unlock message was declined.')
  const reading = await plannedRead(sdk, opened.session, before, counting)
  return { nimbus, sdk, signer, transactionVersion, session: opened.session, wasUnlocked, reading }
}

// Syncs the note store to the chain's tip. A step it could not finish (the
// store busy, a service down) leaves what it read and the next call goes on,
// so it is tried again; a partial sync must never read as a smaller balance.
// The first read on a device checks the pool's notes from the wallet's
// registration on, in this browser: one page per 1,000 notes. With `reading` (from
// openSession) a long read reports its pages against the plan, says why it
// takes long, and a full read is recorded for next time.
const LONG_READ_PAGES = 3
async function syncNotes(nimbus, session, { signal, progress, reading } = {}) {
  let long = (reading?.pages ?? 1) > 1
  const report = (page) => {
    if (!progress) return
    if (page >= LONG_READ_PAGES && !long) long = true
    if (!long) return progress.step('read', 'Reading your Umbra v2 balance…')
    const pages = Math.max(reading?.pages ?? page, page)
    const { text, note } = readLines({ known: Boolean(reading?.known), page, pages })
    progress.step('read', text, { part: page / pages, seconds: STEP_SECONDS.page, note })
  }
  report(1)
  for (let attempt = 1; ; attempt++) {
    // A round reads up to PAGES_PER_ROUND pages of each stream; `round` counts from 1.
    const result = await nimbus.syncNoteStore(session, {}, { signal, onProgress: ({ round }) => report(round * PAGES_PER_ROUND + 1) })
    if (result?.kind === 'ingested' && result.caughtUp && reading && Number.isSafeInteger(reading.nextLeaf)) saveReadMark(session.walletAddress, reading.nextLeaf)
    if (result?.kind !== 'unavailable') return result
    if (attempt === 3) throw new Error(`Umbra v2 could not finish reading your notes (${result.step})`)
  }
}

// What the session holds of `mint`: spendable now, and whether a note is still settling.
async function mintBalance(nimbus, session, mint) {
  const rows = (await nimbus.readBalances(session)).filter((row) => row.mint === mint)
  return {
    available: rows.filter((row) => row.state === 'available').reduce((sum, row) => sum + row.total, 0n),
    pending: rows.some((row) => row.state === 'pending'),
  }
}

function isFeeRemainderRefusal(error) {
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (/fee is not the ceiling of its numerator/.test(String(cause.message ?? cause))) return true
  }
  return false
}

// The proving keys, which the SDK downloads inside a device's first proofs.
const provingKeyDownload = (url) => (/umbraprivacy\.com\/zk\//.test(url) ? 'circuit download' : null)

// Status lines for a payout's stages, which are also where its timed stages start:
// the SDK syncs, then prepares and proves, then relays, then follows the settlement.
function withdrawalProgress(progress, timings = NO_TIMINGS) {
  return ({ stage }) => {
    if (stage === 'synced') { timings.enter('proof'); progress.step('payoutProve', 'Proving the private transfer…') }
    else if (stage === 'proved') { timings.enter('relay request'); progress.step('payoutSend', 'Sending privately…', { part: 0.5 }) }
    else if (stage === 'relayed') { timings.enter('settlement wait'); progress.step('payoutSend', 'Confirming the transfer…') }
  }
}

// Withdraws `amount` to `recipient` through Umbra's relayer, the fees coming out
// of it, and records the payout on `receipt`. A pending settlement (the relayer
// took it but stopped reporting before it landed) still lands, so it counts as
// sent: the page must not offer to pay it again.
async function withdrawTo(nimbus, session, { asset, mint, amount, recipient, progress = createProgress(() => {}, []), timings = NO_TIMINGS }, receipt) {
  timings.leg('withdrawal')
  // Native SOL is paid to the wallet itself. Left to the SDK, it names the wallet's
  // wrapped-SOL token account, which the payout refuses: no key signs for lamports there.
  const withdraw = async (units) => {
    // The withdrawal syncs the note store before it starts.
    timings.enter('note scan')
    return nimbus.withdraw(await nimbus.createWithdrawalContext(session),
      { mint, amount: units, recipient: String(recipient) },
      { onProgress: withdrawalProgress(progress, timings), ...(asset === 'SOL' ? { recipientTokenAccount: String(recipient) } : {}) })
  }
  // The SDK (nimbus-solana 0.4.0, nimbus-statement 0.1.1) refuses an amount that no payout plus its fee
  // adds up to: at 10 bps, every amount ≡ 1 mod 1001, 1 USDC and 1 USDT among
  // them. It puts the unit left over on the fee, and its own statement check,
  // which wants each fee to be exactly its ceiling, rejects that before anything
  // is proved or relayed, and frees the notes. A unit less adds up (a fee split
  // over several receipts can skip a few units, hence the retries), pays the
  // recipient the same, and leaves the unit in the private balance.
  let withdrawn
  for (let less = 0n; ; less++) {
    try {
      withdrawn = await withdraw(amount - less)
      break
    } catch (error) {
      if (!isFeeRemainderRefusal(error) || less === 4n || amount - less <= 1n) throw error
    }
  }
  if (withdrawn.kind !== 'relayed') throw new Error(`the relayer did not take the withdrawal (${spendFailure(withdrawn)})`)
  const { settlement } = withdrawn
  if (settlement.kind === 'failed') throw new Error(`the withdrawal ${settlement.state}${settlement.failureCode ? ` (${settlement.failureCode})` : ''}`)
  receipt.withdrawals = [{ tx: settlement.kind === 'landed' ? bs58.encode(settlement.signature) : null }]
  return receipt
}

// Pays the recipient from the wallet's private balance, with no deposit.
export async function sendFromBalance({ nimbus, session, asset, mint, payout, recipient, onStatus = () => {}, progress = createProgress(onStatus, []), reading, timings = NO_TIMINGS }) {
  if (session.registration.kind === 'unregistered') throw new Error('This wallet has no Umbra v2 private balance yet')
  timings.leg('withdrawal'); timings.enter('note scan')
  await syncNotes(nimbus, session, { progress, reading })
  timings.enter('other')
  const { available } = await mintBalance(nimbus, session, mint)
  if (available < payout) throw new Error(`Your Umbra v2 private balance can pay ${unitsText(available, asset)}, less than ${unitsText(payout, asset)}`)
  progress.step('payoutProve', 'Sending from your private balance…', { part: 0.1 })
  return withdrawTo(nimbus, session, { asset, mint, amount: payout, recipient, progress, timings }, createReceipt({ provider: 'umbrav2', asset }))
}

// Status lines for the deposit's stages. The wallet is asked only once the
// deposit is endorsed and proved, up to a minute in: until then "Approve" would
// send the user looking for a wallet prompt that is not there. At transaction
// version 0 (every wallet today) the wallet signs one funding transaction, and
// the SDK's platform wallet alone signs the deposit that follows it.
// The same stages are where the deposit's timed stages start; the endorsement
// runs beside the proof and counts with it.
function depositProgress(progress, timings = NO_TIMINGS) {
  const done = new Set()
  return ({ stage }) => {
    done.add(stage)
    if (stage === 'synced') { timings.enter('other'); progress.step('prepare', 'Preparing the Umbra v2 deposit…') }
    else if (stage === 'prepared') { timings.enter('proof'); progress.step('prove', 'Proving the Umbra v2 deposit, up to a minute…') }
    else if ((stage === 'endorsed' || stage === 'proved') && done.has('endorsed') && done.has('proved')) { timings.enter('wallet approval'); progress.step('approve', 'Approve the Umbra v2 deposit in your wallet…') }
    else if (stage === 'funding-signed' || stage === 'signed') { timings.enter('relay request'); progress.step('deposit', 'Sending the Umbra v2 deposit…') }
    else if (stage === 'sent') timings.enter('settlement wait')
  }
}

// Registers the wallet the first time, then deposits `amount` of `mint` into
// its own private balance and returns the deposit's receipt. Registering may
// open a new session, which replaces `state.session`.
async function depositToSelf(opened, state, { asset, mint, amount, progress, receipt = {}, timings = NO_TIMINGS }) {
  const { nimbus, sdk, signer, transactionVersion } = opened
  if (state.session.registration.kind === 'unregistered') {
    timings.enter('registration')
    progress.step('register', 'Approve the one-time Umbra v2 registration…', { part: 0.4 })
    const register = async () => nimbus.register(await nimbus.createRegistrationContext(state.session), {}, { transactionVersion, priorityFeeLamports: PRIORITY_FEE_LAMPORTS })
    let registration = await register()
    // A registration that stopped after preparing (a failed request, a rejected
    // signature) left the note store a birthday, and the next one, from a later
    // slot, is refused for good. The identity is not registered, so its store
    // holds nothing: start it over and try once more.
    if (registration.kind === 'store-refused' && registration.refusal?.kind === 'refused-later-birthday') {
      state.session = await restartNoteStore(nimbus, sdk, state.session, signer)
      registration = await register()
    }
    if (registration.kind !== 'complete' && !landed(registration)) throw new Error(`Umbra v2 registration did not land (${outcomeName(registration)}${registration.refusal?.kind ? `: ${registration.refusal.kind}` : ''})`)
    // A deposit is refused until the context API has indexed the registration.
    progress.step('register', 'Waiting for Umbra v2 to confirm the registration…')
    await waitFor('registration', async () => (await nimbus.readRegistration(state.session)).kind === 'registered')
  }
  // The deposit reads the pool before it starts. Read it here instead, so a first
  // read on this device (minutes) shows its pages; the deposit's own is then quick.
  timings.leg('deposit'); timings.enter('note scan')
  await syncNotes(nimbus, state.session, { progress, reading: opened.reading })
  const deposited = await nimbus.deposit(await nimbus.createDepositContext(state.session),
    { mint, amount, recipient: state.session.walletAddress },
    { transactionVersion, priorityFeeLamports: PRIORITY_FEE_LAMPORTS, onProgress: depositProgress(progress, timings) })
  if (!landed(deposited)) throw new Error(`The Umbra v2 deposit did not land (${outcomeName(deposited)})`)
  return createReceipt({ provider: 'umbrav2', asset, ...receipt, depositSignature: bs58.encode(deposited.submission.submission.signature) })
}

// Waits until the deposit just made is spendable and returns what the balance
// can spend of `mint`. The deposit synced the store before it ran, so what is
// available at first was already there; the new note reads as pending until it
// is final.
async function settledBalance(nimbus, session, mint, progress) {
  const before = (await mintBalance(nimbus, session, mint)).available
  progress.step('settle', 'Waiting for the deposit to settle…')
  let available = 0n
  await waitFor('deposit', async () => {
    await syncNotes(nimbus, session)
    const now = await mintBalance(nimbus, session, mint)
    available = now.available
    return available > before && !now.pending
  })
  return available
}

// A payment's steps for the bar. Before the session, from what this browser
// remembers: whether the tab is unlocked and whether it has read this wallet's
// notes before. After it, from the session itself.
function planFor(provider, { deposit, payout, swap = false }, opened) {
  const address = provider?.walletStandard?.account?.address
  if (!opened) {
    const known = Boolean(address && readMark(address))
    return planSteps({ unlocked: unlocked(address), pages: expectedPages({ known }), deposit, payout, swap })
  }
  return planSteps({
    unlocked: opened.wasUnlocked,
    register: deposit && opened.session.registration.kind === 'unregistered',
    pages: opened.reading.pages,
    deposit, payout, swap,
  })
}

// `source: 'shielded'` pays from the private balance; otherwise a deposit of
// `totalBaseUnits` goes in first and the recipient is paid from it: all of it,
// less when part stays shielded, nothing when shielding only.
async function send({ provider, asset, totalBaseUnits, recipient, recipients, source = 'wallet', onStatus, timings = NO_TIMINGS }) {
  const mint = MINTS[String(asset).toUpperCase()]
  if (!mint) throw new Error(`Umbra v2 does not support ${asset}`)
  if (recipients?.length > 1) throw new Error('Umbra v2 sends to one recipient')
  const amount = BigInt(totalBaseUnits)
  const payout = recipients ? recipients.reduce((sum, item) => sum + BigInt(item.baseUnits), 0n) : amount
  if (source === 'shielded' ? !payout : payout > amount) throw new Error(source === 'shielded' ? 'Nothing to pay' : 'The recipient gets more than the deposit')

  // The bar's plan: guessed from what this browser remembers, then fixed once
  // the session says whether the wallet is registered and how long its read is.
  const deposit = source !== 'shielded'
  const progress = createProgress(onStatus, planFor(provider, { deposit, payout: payout > 0n }))
  const opened = await openSession(provider, progress, timings)
  progress.replan(planFor(provider, { deposit, payout: payout > 0n }, opened))
  const { nimbus } = opened
  const state = { session: opened.session }
  try {
    if (!deposit) return await sendFromBalance({ nimbus, session: state.session, asset, mint, payout, recipient, progress, reading: opened.reading, timings })
    const receipt = await depositToSelf(opened, state, { asset, mint, amount, progress, timings })
    if (!payout) return receipt
    try {
      timings.enter('settlement wait')
      const available = await settledBalance(nimbus, state.session, mint, progress)
      progress.step('payoutProve', 'Sending privately…', { part: 0.1 })
      // Never more than this send, even when an earlier balance sits beside it.
      return await withdrawTo(nimbus, state.session, { asset, mint, amount: available < payout ? available : payout, recipient, progress, timings }, receipt)
    } catch (error) {
      return throwWithReceipt(receipt, 'The deposit landed, but the private send failed. The funds stay in your Umbra v2 private balance: pay from it with Use shielded funds', error)
    }
  } finally {
    nimbus.closeNimbusSession(state.session)
  }
}

// SOL held back from the input for the swap's and the payout's network fees and
// the recipient's token account; what is left reaches the recipient as SOL.
const INPUT_RESERVE = BigInt(Math.round(manifest.swap.swapWallet.inputReserveSol * 1e9))
const swapTaskKey = (address) => `umbrav2-swap-${address}`
const toBase64 = (bytes) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary) }
const fromBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const rpcConnection = () => new Connection(import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString(), 'confirmed')

// Umbra v2 publishes no swap, so this runs one in a one-time wallet
// (shared/swap-wallet.js): the SOL is withdrawn privately from the wallet's
// Umbra v2 balance to it, swapped there through Jupiter Ultra, and the one-time
// wallet pays the recipient everything it holds. From the wallet,
// `totalBaseUnits` is deposited first and what is not swapped (`recipients`'
// total) stays shielded; `source: 'shielded'` pays from the balance. SOL input
// only: Jupiter covers a token-only wallet's fees for some fills but not all,
// and a one-time wallet holding a token and no SOL could not move it. The
// one-time wallet's key stays in this browser until the payout, so a swap cut
// short is finished by the next Umbra v2 swap here.
async function swap({ provider, inputAsset, outputAsset, totalBaseUnits, recipient, recipients, source = 'wallet', onStatus }) {
  const route = swapEligibility('umbrav2', inputAsset, outputAsset)
  if (!route.available || route.kind !== 'swap') throw new Error(route.reason || `Umbra v2 cannot swap ${inputAsset} to ${outputAsset}`)
  const fromShielded = source === 'shielded'
  const deposited = BigInt(totalBaseUnits)
  const units = recipients ? recipients.reduce((sum, item) => sum + BigInt(item.baseUnits), 0n) : deposited
  if (!fromShielded && units > deposited) throw new Error('The swap takes more than the deposit')
  if (units <= INPUT_RESERVE + SWAP_MINIMUM) throw new Error(`Swap more than ${unitsText(INPUT_RESERVE + SWAP_MINIMUM, inputAsset)}: ${unitsText(INPUT_RESERVE, inputAsset)} of it pays the swap's network fees`)
  const recipientKey = new PublicKey(String(recipient))
  const owner = provider?.walletStandard?.account?.address
  const connection = rpcConnection()
  const forget = () => localStorage.removeItem(swapTaskKey(owner))

  // Finished alone, never followed by this new swap: the user retrying a swap
  // that stopped means that swap, not a second one.
  let pending = null
  try { pending = JSON.parse(localStorage.getItem(swapTaskKey(owner))) } catch {}
  if (pending?.secret) {
    onStatus('Finishing your earlier swap…')
    const paid = await finishSwap({ connection, burner: Keypair.fromSecretKey(fromBase64(pending.secret)), task: pending, swap: ultraSwap, forget, onStatus })
    if (paid) throw new Error(`Finished your earlier interrupted swap: ${paid.tokens ? unitsText(paid.tokens, pending.outputAsset) : unitsText(paid.lamports, 'SOL')} went to ${pending.recipient}. Nothing new was sent; swap again to start this one.`)
  }

  const mint = MINTS[inputAsset]
  const progress = createProgress(onStatus, planFor(provider, { deposit: !fromShielded, payout: false, swap: true }))
  const opened = await openSession(provider, progress)
  progress.replan(planFor(provider, { deposit: !fromShielded, payout: false, swap: true }, opened))
  const { nimbus } = opened
  const state = { session: opened.session }
  let receipt = createReceipt({ provider: 'umbrav2', asset: inputAsset, inputAsset, outputAsset })
  // Where the input is when something stops: still in the wallet, shielded, or in the one-time wallet.
  let stage = 'wallet'
  try {
    if (fromShielded) {
      if (state.session.registration.kind === 'unregistered') throw new Error('This wallet has no Umbra v2 private balance yet')
      await syncNotes(nimbus, state.session, { progress, reading: opened.reading })
      const { available } = await mintBalance(nimbus, state.session, mint)
      if (available < units) throw new Error(`Your Umbra v2 private balance can pay ${unitsText(available, inputAsset)}, less than ${unitsText(units, inputAsset)}`)
    } else {
      receipt = await depositToSelf(opened, state, { asset: inputAsset, mint, amount: deposited, progress, receipt: { inputAsset, outputAsset } })
      stage = 'shielded'
      await settledBalance(nimbus, state.session, mint, progress)
    }
    stage = 'shielded'
    const burner = Keypair.generate()
    const task = { secret: toBase64(burner.secretKey), inputAsset, outputAsset, recipient: recipientKey.toBase58(), keep: String(INPUT_RESERVE) }
    // Saved before the withdrawal, so a swap cut short anywhere after it is found again.
    localStorage.setItem(swapTaskKey(owner), JSON.stringify(task))
    progress.step('payoutProve', `Moving the ${inputAsset} to a one-time swap wallet…`, { part: 0.1 })
    await withdrawTo(nimbus, state.session, { asset: inputAsset, mint, amount: units, recipient: burner.publicKey.toBase58(), progress }, {})
    stage = 'swap'
    const paid = await finishSwap({ connection, burner, task, wait: true, swap: ultraSwap, forget, onStatus: (text) => progress.step('swap', text) })
    if (!paid) throw new Error('the swap wallet received nothing to swap')
    receipt.swapSignature = paid.swapSignature
    receipt.withdrawals = [{ tx: paid.signature }]
    return receipt
  } catch (error) {
    if (stage === 'wallet') throw error
    const where = stage === 'shielded' ? `the ${inputAsset} is in your Umbra v2 private balance`
      : 'what reached it waits in a one-time swap wallet whose key is saved in this browser, and your next Umbra v2 swap here pays it to the recipient'
    const reason = error instanceof Error ? error.message : String(error)
    throw Object.assign(new Error(`${fromShielded ? 'The swap stopped' : 'Deposit succeeded, but the swap stopped'}: ${reason}. Nothing is lost: ${where}.`),
      receipt.depositSignature ? { receipt } : {})
  } finally {
    nimbus.closeNimbusSession(state.session)
  }
}

// Asks for the unlock message alone, which this tab then keeps, so a balance
// read after it asks nothing and can run beside other pools'.
export async function unlockShielded({ provider }) {
  if (unlocked(provider?.walletStandard?.account?.address)) return
  await exclusive(async () => {
    const { nimbus, session } = await openSession(provider)
    nimbus.closeNimbusSession(session)
  })
}

// The wallet's private balance per asset, in base units: `balances` what its
// notes hold (settling ones too), `spendable` what a payment can withdraw now.
// With `prompt: false` nothing asks the wallet to sign, and a tab that has not
// unlocked Umbra v2 yet gets null.
export async function shieldedBalances({ provider, prompt = true, signal, onStatus = () => {} }) {
  if (!prompt && !unlocked(provider?.walletStandard?.account?.address)) return null
  return exclusive(async () => {
    signal?.throwIfAborted()
    const progress = createProgress(onStatus, [])
    const { nimbus, session, reading } = await openSession(provider, progress)
    try {
      const result = { balances: { SOL: 0n, USDC: 0n, USDT: 0n }, spendable: { SOL: 0n, USDC: 0n, USDT: 0n } }
      // Never registered: nothing was ever deposited.
      if (session.registration.kind === 'unregistered') return result
      onStatus('Reading your private balance…')
      await syncNotes(nimbus, session, { signal, progress, reading })
      const rows = await nimbus.readBalances(session)
      for (const asset of Object.keys(result.balances)) {
        for (const row of rows.filter((item) => item.mint === MINTS[asset])) {
          if (row.state === 'available' || row.state === 'pending') result.balances[asset] += row.total
          if (row.state === 'available') result.spendable[asset] += row.total
        }
      }
      return result
    } finally {
      nimbus.closeNimbusSession(session)
    }
  })
}

// Loads what a payment would otherwise load after the click: the SDK with its
// WebAssembly, and the proving files this browser does not hold yet (about
// 135 MB the first time, as Umbra's own app downloads when a wallet connects;
// nothing once the SDK has cached them). It asks the wallet for nothing and
// proves nothing. Not started while a payment runs or waits; a download under
// way when one starts is shared with it. Resolves to whether it ran to its
// end, never rejects.
let payments = 0
let preloading = null
export function preload({ provider } = {}) {
  if (payments) return Promise.resolve(false)
  preloading ??= (async () => {
    const { sdk } = await loadSdk()
    const { provingKeys, cacheDatabase } = sdk.settings
    const held = await heldArtifacts(cacheDatabase)
    // A browser that cannot say what the SDK holds downloads nothing ahead.
    if (!held) return true
    // A wallet whose notes this browser has read is registered: it needs no registration proof.
    const registered = Boolean(readMark(provider?.walletStandard?.account?.address))
    await warmProvingKeys(wantedFiles(provingKeys, held, { registered }))
    return true
  })().catch(() => false).finally(() => { preloading = null })
  return preloading
}

export async function execute({ kind, ...options }) {
  payments += 1
  try {
    // Timed from the click: a send behind a balance read shows the wait as queued.
    if (kind === 'send') {
      return await withTimings('umbrav2', { downloads: provingKeyDownload }, (timings) => exclusive(() => { timings.enter('other'); return send({ ...options, timings }) }))
    }
    if (kind === 'swap') return await exclusive(() => swap(options))
    throw new Error(`Umbra v2 has no browser ${kind} flow`)
  } finally { payments -= 1 }
}
