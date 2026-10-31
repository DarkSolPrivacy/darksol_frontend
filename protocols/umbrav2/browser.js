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
// to the recipient. The wallet signs the unlock message (once per tab), the
// one-time registration and the deposit; Umbra's relayer submits the withdrawal.
import bs58 from 'bs58'
import { MINTS } from '../addresses.js'
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

async function send({ provider, asset, totalBaseUnits, recipient, onStatus }) {
  const mint = MINTS[String(asset).toUpperCase()]
  if (!mint) throw new Error(`Umbra v2 does not support ${asset}`)
  const standard = provider?.walletStandard
  if (!standard?.wallet) throw new Error('Umbra v2 needs a wallet-standard account. Reconnect the wallet and try again.')

  onStatus('Preparing Umbra v2…')
  const { nimbus, sdk } = await loadSdk()
  // The page is already connected, so this asks the wallet for nothing.
  const connection = await nimbus.openWalletConnection(sdk, { wallet: standard.wallet })
  if (connection.kind !== 'connected') throw new Error('The wallet did not connect to Umbra v2.')
  const { signer, transactionVersion } = connection.connected
  if (signer.account.address !== standard.account.address) throw new Error('Switch the wallet back to the connected account and try again.')

  onStatus('Approve the Umbra v2 unlock message…')
  const opened = await nimbus.openNimbusSession(sdk, { connectedWallet: signer })
  if (opened.kind === 'declined') throw new Error('The Umbra v2 unlock message was declined.')
  let { session } = opened
  try {
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

    const amount = BigInt(totalBaseUnits)
    onStatus('Approve the Umbra v2 deposit…')
    const deposited = await nimbus.deposit(await nimbus.createDepositContext(session),
      { mint, amount, recipient: session.walletAddress }, { transactionVersion })
    if (!landed(deposited)) throw new Error(`The Umbra v2 deposit did not land (${outcomeName(deposited)})`)
    const receipt = createReceipt({ provider: 'umbrav2', asset, depositSignature: bs58.encode(deposited.submission.submission.signature) })

    try {
      const balance = async () => {
        const rows = (await nimbus.readBalances(session)).filter((row) => row.mint === mint)
        return {
          available: rows.filter((row) => row.state === 'available').reduce((sum, row) => sum + row.total, 0n),
          pending: rows.some((row) => row.state === 'pending'),
        }
      }
      // The deposit synced the store before it ran, so this is what was already there.
      const before = (await balance()).available
      // The new note reads as pending until it is final; only then can it be spent.
      onStatus('Waiting for the deposit to settle…')
      let available = 0n
      await waitFor('deposit', async () => {
        await nimbus.syncNoteStore(session)
        const now = await balance()
        available = now.available
        return available > before && !now.pending
      })

      // Never more than this send, even when an earlier balance sits beside it.
      onStatus('Sending privately…')
      // Native SOL is paid to the wallet itself. Left to the SDK, it names the wallet's
      // wrapped-SOL token account, which the payout refuses: no key signs for lamports there.
      const withdrawn = await nimbus.withdraw(await nimbus.createWithdrawalContext(session),
        { mint, amount: available < amount ? available : amount, recipient: String(recipient) },
        asset === 'SOL' ? { recipientTokenAccount: String(recipient) } : {})
      if (withdrawn.kind !== 'relayed') throw new Error(`the relayer did not take the withdrawal (${spendFailure(withdrawn)})`)
      const { settlement } = withdrawn
      if (settlement.kind === 'failed') throw new Error(`the withdrawal ${settlement.state}${settlement.failureCode ? ` (${settlement.failureCode})` : ''}`)
      // pending: the relayer took it but stopped reporting before it landed. It still lands.
      if (settlement.kind === 'landed') receipt.withdrawals = [{ tx: bs58.encode(settlement.signature) }]
      return receipt
    } catch (error) {
      return throwWithReceipt(receipt, 'The deposit landed, but the private send failed. The funds stay in your Umbra v2 private balance', error)
    }
  } finally {
    nimbus.closeNimbusSession(session)
  }
}

export async function execute({ kind, ...options }) {
  if (kind !== 'send') throw new Error(`Umbra v2 has no browser ${kind} flow`)
  return send(options)
}
