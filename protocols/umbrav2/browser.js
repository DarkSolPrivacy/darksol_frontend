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
import bs58 from 'bs58'
import { MINTS } from '../addresses.js'
import { TOKEN_DECIMALS } from '../shared/units.js'
import { createReceipt, throwWithReceipt } from '../shared/receipts.js'

// How long to wait for the indexer to see a registration or a deposit: three minutes.
const POLL_MS = 4000
const POLLS = 45

let loading = null

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
  onStatus('Preparing Umbra v2…')
  const { nimbus, sdk } = await loadSdk()
  // The page is already connected, so this asks the wallet for nothing.
  const connection = await nimbus.openWalletConnection(sdk, { wallet: standard.wallet })
  if (connection.kind !== 'connected') throw new Error('The wallet did not connect to Umbra v2.')
  const { signer, transactionVersion } = connection.connected
  if (signer.account.address !== standard.account.address) throw new Error('Switch the wallet back to the connected account and try again.')
  onStatus(unlocked(signer.account.address) ? 'Opening your Umbra v2 balance…' : 'Approve the Umbra v2 unlock message…')
  const opened = await nimbus.openNimbusSession(sdk, { connectedWallet: signer })
  if (opened.kind === 'declined') throw new Error('The Umbra v2 unlock message was declined.')
  return { nimbus, sdk, signer, transactionVersion, session: opened.session }
}

// Syncs the note store to the chain's tip. A step it could not finish (the
// store busy, a service down) leaves what it read and the next call goes on,
// so it is tried again; a partial sync must never read as a smaller balance.
// The first sync on a device reads the pool from the start, minutes of it.
async function syncNotes(nimbus, session, { signal, onStatus = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    const result = await nimbus.syncNoteStore(session, {}, { signal, onProgress: ({ round }) => onStatus(`Reading your private balance… (page ${round})`) })
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

// Withdraws `amount` to `recipient` through Umbra's relayer, the fees coming out
// of it, and records the payout on `receipt`. A pending settlement (the relayer
// took it but stopped reporting before it landed) still lands, so it counts as
// sent: the page must not offer to pay it again.
async function withdrawTo(nimbus, session, { asset, mint, amount, recipient }, receipt) {
  // Native SOL is paid to the wallet itself. Left to the SDK, it names the wallet's
  // wrapped-SOL token account, which the payout refuses: no key signs for lamports there.
  const withdrawn = await nimbus.withdraw(await nimbus.createWithdrawalContext(session),
    { mint, amount, recipient: String(recipient) },
    asset === 'SOL' ? { recipientTokenAccount: String(recipient) } : {})
  if (withdrawn.kind !== 'relayed') throw new Error(`the relayer did not take the withdrawal (${spendFailure(withdrawn)})`)
  const { settlement } = withdrawn
  if (settlement.kind === 'failed') throw new Error(`the withdrawal ${settlement.state}${settlement.failureCode ? ` (${settlement.failureCode})` : ''}`)
  receipt.withdrawals = [{ tx: settlement.kind === 'landed' ? bs58.encode(settlement.signature) : null }]
  return receipt
}

// Pays the recipient from the wallet's private balance, with no deposit.
export async function sendFromBalance({ nimbus, session, asset, mint, payout, recipient, onStatus = () => {} }) {
  if (session.registration.kind === 'unregistered') throw new Error('This wallet has no Umbra v2 private balance yet')
  onStatus('Reading your Umbra v2 balance…')
  await syncNotes(nimbus, session, { onStatus })
  const { available } = await mintBalance(nimbus, session, mint)
  if (available < payout) throw new Error(`Your Umbra v2 private balance can pay ${unitsText(available, asset)}, less than ${unitsText(payout, asset)}`)
  onStatus('Sending from your private balance…')
  return withdrawTo(nimbus, session, { asset, mint, amount: payout, recipient }, createReceipt({ provider: 'umbrav2', asset }))
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
  const { nimbus, sdk, signer, transactionVersion } = opened
  let { session } = opened
  try {
    if (source === 'shielded') return await sendFromBalance({ nimbus, session, asset, mint, payout, recipient, onStatus })
    if (session.registration.kind === 'unregistered') {
      onStatus('Approve the one-time Umbra v2 registration…')
      const register = async () => nimbus.register(await nimbus.createRegistrationContext(session), {}, { transactionVersion })
      let registration = await register()
      // A registration that stopped after preparing (a failed request, a rejected
      // signature) left the note store a birthday, and the next one, from a later
      // slot, is refused for good. The identity is not registered, so its store
      // holds nothing: start it over and try once more.
      if (registration.kind === 'store-refused' && registration.refusal?.kind === 'refused-later-birthday') {
        session = await restartNoteStore(nimbus, sdk, session, signer)
        registration = await register()
      }
      if (registration.kind !== 'complete' && !landed(registration)) throw new Error(`Umbra v2 registration did not land (${outcomeName(registration)}${registration.refusal?.kind ? `: ${registration.refusal.kind}` : ''})`)
      // A deposit is refused until the context API has indexed the registration.
      onStatus('Waiting for Umbra v2 to confirm the registration…')
      await waitFor('registration', async () => (await nimbus.readRegistration(session)).kind === 'registered')
    }

    onStatus('Approve the Umbra v2 deposit…')
    const deposited = await nimbus.deposit(await nimbus.createDepositContext(session),
      { mint, amount, recipient: session.walletAddress }, { transactionVersion })
    if (!landed(deposited)) throw new Error(`The Umbra v2 deposit did not land (${outcomeName(deposited)})`)
    const receipt = createReceipt({ provider: 'umbrav2', asset, depositSignature: bs58.encode(deposited.submission.submission.signature) })
    if (!payout) return receipt

    try {
      // The deposit synced the store before it ran, so this is what was already there.
      const before = (await mintBalance(nimbus, session, mint)).available
      // The new note reads as pending until it is final; only then can it be spent.
      onStatus('Waiting for the deposit to settle…')
      let available = 0n
      await waitFor('deposit', async () => {
        await syncNotes(nimbus, session)
        const now = await mintBalance(nimbus, session, mint)
        available = now.available
        return available > before && !now.pending
      })
      // Never more than this send, even when an earlier balance sits beside it.
      onStatus('Sending privately…')
      return await withdrawTo(nimbus, session, { asset, mint, amount: available < payout ? available : payout, recipient }, receipt)
    } catch (error) {
      return throwWithReceipt(receipt, 'The deposit landed, but the private send failed. The funds stay in your Umbra v2 private balance: pay from it with Use shielded funds', error)
    }
  } finally {
    nimbus.closeNimbusSession(session)
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
      await syncNotes(nimbus, session, { signal, onStatus })
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
  if (kind !== 'send') throw new Error(`Umbra v2 has no browser ${kind} flow`)
  return exclusive(() => send(options))
}
