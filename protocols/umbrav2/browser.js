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

// Progress for the send button: a status line may say where the bar should be
// (0 to 1) once its step is done and about how long the step takes, so the bar
// keeps moving through the long ones (the proof). `within` fits a step's own
// 0-to-1 into its share of the whole send, which depends on what follows it.
const at = (to, seconds) => ({ to, seconds })
const within = (onStatus, from, to) => (text, hint) => onStatus(text, hint && at(from + (to - from) * hint.to, hint.seconds))

function loadSdk() {
  loading ??= (async () => {
    if (!window.crossOriginIsolated) throw new Error('Umbra v2 needs the page reloaded before it can send. Reload DarkSol and try again.')
    const nimbus = await import('@umbra-privacy/nimbus-solana-web')
    const gateway = new URL('/api/umbra-gateway', window.location.origin).toString()
    const sdk = await nimbus.loadNimbusSdk({ cluster: 'mainnet' }, {
      assetsBaseUrl: '/nimbus/',
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
// (signature-secret-store.js in @umbra-privacy/nimbus-solana-web 0.1.1, a key
// it keeps fixed). Read directly, so asking whether the tab is unlocked loads
// none of the SDK.
const secretKey = (address) => `umbra/nimbus-solana-web/account-secret/mainnet/solana:mainnet/${address}`
function unlocked(address) {
  try { return Boolean(address && sessionStorage.getItem(secretKey(address))) } catch { return false }
}

// Connects the wallet-standard account and opens its session. The wallet signs
// the unlock message only when this tab has not kept its secret.
async function openSession(provider, onStatus) {
  const standard = provider?.walletStandard
  if (!standard?.wallet) throw new Error('Umbra v2 needs a wallet-standard account. Reconnect the wallet and try again.')
  onStatus('Preparing Umbra v2…', at(0.03, 3))
  const { nimbus, sdk } = await loadSdk()
  // The page is already connected, so this asks the wallet for nothing.
  const connection = await nimbus.openWalletConnection(sdk, { wallet: standard.wallet })
  if (connection.kind !== 'connected') throw new Error('The wallet did not connect to Umbra v2.')
  const { signer, transactionVersion } = connection.connected
  if (signer.account.address !== standard.account.address) throw new Error('Switch the wallet back to the connected account and try again.')
  onStatus(unlocked(signer.account.address) ? 'Opening your Umbra v2 balance…' : 'Approve the Umbra v2 unlock message…', at(0.06, 5))
  const opened = await nimbus.openNimbusSession(sdk, { connectedWallet: signer })
  if (opened.kind === 'declined') throw new Error('The Umbra v2 unlock message was declined.')
  return { nimbus, sdk, signer, transactionVersion, session: opened.session }
}

// Syncs the note store to the chain's tip. A step it could not finish (the
// store busy, a service down) leaves what it read and the next call goes on,
// so it is tried again; a partial sync must never read as a smaller balance.
// The first sync on a device reads the pool from the start, minutes of it.
// A sync's pages as status lines whose bar mark (its own 0 to 1) creeps on with
// each page. Past a few pages it is a first read on this device, which scans
// the pool's notes here (about 3.5 minutes measured) and is kept for next time.
const COLD_PAGES = 3
const syncLine = (round) => round > COLD_PAGES
  ? `First Umbra v2 read on this device, a few minutes, only once… (page ${round})`
  : `Reading your private balance… (page ${round})`
async function syncNotes(nimbus, session, { signal, onStatus = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    const result = await nimbus.syncNoteStore(session, {}, { signal, onProgress: ({ round }) => onStatus(syncLine(round), at(1 - 0.85 ** round, 30)) })
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

// Status lines for a payout's stages, as its share of the bar (0 to 1).
function withdrawalProgress(onStatus) {
  return ({ stage }) => {
    if (stage === 'synced') onStatus('Proving the private transfer…', at(0.75, 30))
    else if (stage === 'proved') onStatus('Sending privately…', at(0.9, 8))
    else if (stage === 'relayed') onStatus('Confirming the transfer…', at(0.98, 10))
  }
}

// Withdraws `amount` to `recipient` through Umbra's relayer, the fees coming out
// of it, and records the payout on `receipt`. A pending settlement (the relayer
// took it but stopped reporting before it landed) still lands, so it counts as
// sent: the page must not offer to pay it again.
async function withdrawTo(nimbus, session, { asset, mint, amount, recipient, onStatus = () => {} }, receipt) {
  // Native SOL is paid to the wallet itself. Left to the SDK, it names the wallet's
  // wrapped-SOL token account, which the payout refuses: no key signs for lamports there.
  const withdraw = async (units) => nimbus.withdraw(await nimbus.createWithdrawalContext(session),
    { mint, amount: units, recipient: String(recipient) },
    { onProgress: withdrawalProgress(onStatus), ...(asset === 'SOL' ? { recipientTokenAccount: String(recipient) } : {}) })
  // The SDK (nimbus-solana 0.1.1) refuses an amount that no payout plus its fee
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
export async function sendFromBalance({ nimbus, session, asset, mint, payout, recipient, onStatus = () => {} }) {
  if (session.registration.kind === 'unregistered') throw new Error('This wallet has no Umbra v2 private balance yet')
  onStatus('Reading your Umbra v2 balance…', at(0.2, 8))
  await syncNotes(nimbus, session, { onStatus: within(onStatus, 0.06, 0.2) })
  const { available } = await mintBalance(nimbus, session, mint)
  if (available < payout) throw new Error(`Your Umbra v2 private balance can pay ${unitsText(available, asset)}, less than ${unitsText(payout, asset)}`)
  const paying = within(onStatus, 0.2, 1)
  paying('Sending from your private balance…', at(0.1, 5))
  return withdrawTo(nimbus, session, { asset, mint, amount: payout, recipient, onStatus: paying }, createReceipt({ provider: 'umbrav2', asset }))
}

// Status lines for the deposit's stages. The wallet is asked only once the
// deposit is endorsed and proved, up to a minute in: until then "Approve" would
// send the user looking for a wallet prompt that is not there. At transaction
// version 0 (every wallet today) the wallet signs one funding transaction, and
// the SDK's platform wallet alone signs the deposit that follows it.
function depositProgress(onStatus) {
  const done = new Set()
  return ({ stage }) => {
    done.add(stage)
    if (stage === 'synced') onStatus('Preparing the Umbra v2 deposit…', at(0.25, 5))
    else if (stage === 'prepared') onStatus('Proving the Umbra v2 deposit, up to a minute…', at(0.7, 45))
    else if ((stage === 'endorsed' || stage === 'proved') && done.has('endorsed') && done.has('proved')) onStatus('Approve the Umbra v2 deposit in your wallet…', at(0.75, 30))
    else if (stage === 'funding-signed' || stage === 'signed') onStatus('Sending the Umbra v2 deposit…', at(0.97, 12))
  }
}

// Registers the wallet the first time, then deposits `amount` of `mint` into
// its own private balance and returns the deposit's receipt. Registering may
// open a new session, which replaces `state.session`.
async function depositToSelf(opened, state, { asset, mint, amount, onStatus, receipt = {} }) {
  const { nimbus, sdk, signer, transactionVersion } = opened
  if (state.session.registration.kind === 'unregistered') {
    onStatus('Approve the one-time Umbra v2 registration…', at(0.08, 30))
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
    onStatus('Waiting for Umbra v2 to confirm the registration…', at(0.1, 20))
    await waitFor('registration', async () => (await nimbus.readRegistration(state.session)).kind === 'registered')
  }
  onStatus('Reading your Umbra v2 balance…', at(0.12, 6))
  // The deposit reads the pool before it starts. Read it here instead, so a first
  // read on this device (minutes) shows its pages; the deposit's own is then quick.
  await syncNotes(nimbus, state.session, { onStatus: within(onStatus, 0.12, 0.22) })
  const deposited = await nimbus.deposit(await nimbus.createDepositContext(state.session),
    { mint, amount, recipient: state.session.walletAddress },
    { transactionVersion, priorityFeeLamports: PRIORITY_FEE_LAMPORTS, onProgress: depositProgress(onStatus) })
  if (!landed(deposited)) throw new Error(`The Umbra v2 deposit did not land (${outcomeName(deposited)})`)
  return createReceipt({ provider: 'umbrav2', asset, ...receipt, depositSignature: bs58.encode(deposited.submission.submission.signature) })
}

// Waits until the deposit just made is spendable and returns what the balance
// can spend of `mint`. The deposit synced the store before it ran, so what is
// available at first was already there; the new note reads as pending until it
// is final.
async function settledBalance(nimbus, session, mint, onStatus) {
  const before = (await mintBalance(nimbus, session, mint)).available
  onStatus('Waiting for the deposit to settle…', at(1, 10))
  let available = 0n
  await waitFor('deposit', async () => {
    await syncNotes(nimbus, session)
    const now = await mintBalance(nimbus, session, mint)
    available = now.available
    return available > before && !now.pending
  })
  return available
}

// `source: 'shielded'` pays from the private balance; otherwise a deposit of
// `totalBaseUnits` goes in first and the recipient is paid from it: all of it,
// less when part stays shielded, nothing when shielding only.
async function send({ provider, asset, totalBaseUnits, recipient, recipients, source = 'wallet', onStatus }) {
  const mint = MINTS[String(asset).toUpperCase()]
  if (!mint) throw new Error(`Umbra v2 does not support ${asset}`)
  if (recipients?.length > 1) throw new Error('Umbra v2 sends to one recipient')
  const amount = BigInt(totalBaseUnits)
  const payout = recipients ? recipients.reduce((sum, item) => sum + BigInt(item.baseUnits), 0n) : amount
  if (source === 'shielded' ? !payout : payout > amount) throw new Error(source === 'shielded' ? 'Nothing to pay' : 'The recipient gets more than the deposit')

  const opened = await openSession(provider, onStatus)
  const { nimbus } = opened
  const state = { session: opened.session }
  try {
    if (source === 'shielded') return await sendFromBalance({ nimbus, session: state.session, asset, mint, payout, recipient, onStatus })
    // The bar: the deposit, then the wait for it to settle and the payout.
    const receipt = await depositToSelf(opened, state, { asset, mint, amount, onStatus: payout ? within(onStatus, 0, 0.6) : onStatus })
    if (!payout) return receipt
    try {
      const available = await settledBalance(nimbus, state.session, mint, within(onStatus, 0.6, 0.65))
      const paying = within(onStatus, 0.65, 1)
      paying('Sending privately…', at(0.1, 5))
      // Never more than this send, even when an earlier balance sits beside it.
      return await withdrawTo(nimbus, state.session, { asset, mint, amount: available < payout ? available : payout, recipient, onStatus: paying }, receipt)
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
  const opened = await openSession(provider, onStatus)
  const { nimbus } = opened
  const state = { session: opened.session }
  let receipt = createReceipt({ provider: 'umbrav2', asset: inputAsset, inputAsset, outputAsset })
  // Where the input is when something stops: still in the wallet, shielded, or in the one-time wallet.
  let stage = 'wallet'
  try {
    if (fromShielded) {
      if (state.session.registration.kind === 'unregistered') throw new Error('This wallet has no Umbra v2 private balance yet')
      onStatus('Reading your Umbra v2 balance…', at(0.15, 8))
      await syncNotes(nimbus, state.session, { onStatus: within(onStatus, 0.06, 0.15) })
      const { available } = await mintBalance(nimbus, state.session, mint)
      if (available < units) throw new Error(`Your Umbra v2 private balance can pay ${unitsText(available, inputAsset)}, less than ${unitsText(units, inputAsset)}`)
    } else {
      receipt = await depositToSelf(opened, state, { asset: inputAsset, mint, amount: deposited, onStatus: within(onStatus, 0, 0.45), receipt: { inputAsset, outputAsset } })
      stage = 'shielded'
      await settledBalance(nimbus, state.session, mint, within(onStatus, 0.45, 0.5))
    }
    stage = 'shielded'
    const burner = Keypair.generate()
    const task = { secret: toBase64(burner.secretKey), inputAsset, outputAsset, recipient: recipientKey.toBase58(), keep: String(INPUT_RESERVE) }
    // Saved before the withdrawal, so a swap cut short anywhere after it is found again.
    localStorage.setItem(swapTaskKey(owner), JSON.stringify(task))
    const moving = within(onStatus, 0.5, 0.75)
    moving(`Moving the ${inputAsset} to a one-time swap wallet…`, at(0.1, 5))
    await withdrawTo(nimbus, state.session, { asset: inputAsset, mint, amount: units, recipient: burner.publicKey.toBase58(), onStatus: moving }, {})
    stage = 'swap'
    const paid = await finishSwap({ connection, burner, task, wait: true, swap: ultraSwap, forget, onStatus })
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
    const { nimbus, session } = await openSession(provider, () => {})
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
    const { nimbus, session } = await openSession(provider, onStatus)
    try {
      const result = { balances: { SOL: 0n, USDC: 0n, USDT: 0n }, spendable: { SOL: 0n, USDC: 0n, USDT: 0n } }
      // Never registered: nothing was ever deposited.
      if (session.registration.kind === 'unregistered') return result
      onStatus('Reading your private balance…')
      await syncNotes(nimbus, session, { signal, onStatus: (text) => onStatus(text) })
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

export async function execute({ kind, ...options }) {
  if (kind === 'send') return exclusive(() => send(options))
  if (kind === 'swap') return exclusive(() => swap(options))
  throw new Error(`Umbra v2 has no browser ${kind} flow`)
}
