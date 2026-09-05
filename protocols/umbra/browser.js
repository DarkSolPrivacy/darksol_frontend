// Umbra browser adapter.
//
// Two differences from the other Solana adapters:
//
// 1. The SDK signs through a wallet-standard account, not the injected
//    `window.solana` provider the others use. The manifest says so with
//    signerKind, and the caller passes the wallet-standard account through as
//    `provider.walletStandard`.
// 2. Scanning for incoming notes is stateful. Without a persistent store every
//    scan restarts from the first tree, so IndexedDB stores are wired up here
//    the same way privacycash/browser.js caches its signature in localStorage.
import { MINTS } from '../addresses.js'
import { createReceipt, throwWithReceipt } from '../shared/receipts.js'
import manifest from './manifest.js'

const NETWORK = 'mainnet'

async function openSession({ provider, onStatus }) {
  const account = provider?.walletStandard
  if (!account?.wallet || !account?.account) {
    throw new Error('Umbra needs a wallet-standard account. Reconnect the wallet and try again.')
  }

  onStatus('Preparing Umbra…')
  const [sdk, stores] = await Promise.all([
    import('@umbra-privacy/sdk'),
    import('@umbra-privacy/sdk/store-adapters'),
  ])

  // Without these every scan re-reads every tree from zero.
  const storageBackend = stores.createBrowserStorageBackend({ dbName: 'umbra' })
  const signer = sdk.createSignerFromWalletAccount(account.wallet, account.account)

  const client = await sdk.getUmbraClient({
    signer,
    network: NETWORK,
    rpcUrl: import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString(),
    indexerApiEndpoint: manifest.services.indexerApi,
    relayerApiEndpoint: manifest.services.relayerApi,
    utxoDataStore: stores.createShardedUtxoDataStore({ storageBackend }),
    nullifierStore: stores.createShardedNullifierStore({ storageBackend }),
    // Hold the wallet prompt until a key is actually needed, so connecting does
    // not immediately ask the user to sign something.
    deferMasterSeedSignature: true,
  })
  return { sdk, client }
}

async function send({ provider, asset, totalBaseUnits, recipient, onStatus }) {
  const mint = MINTS[String(asset).toUpperCase()]
  if (!mint) throw new Error(`Umbra does not support ${asset}`)
  const { client } = await openSession({ provider, onStatus })

  const [registration, deposit, query, types] = await Promise.all([
    import('@umbra-privacy/sdk/registration'),
    import('@umbra-privacy/sdk/deposit'),
    import('@umbra-privacy/sdk/query'),
    import('@umbra-privacy/sdk/types'),
  ])

  onStatus('Approve Umbra registration…')
  // Idempotent: a returning user is not asked to register again.
  await registration.getUserRegistrationFunction({ client })({ confidential: true, anonymous: true })

  onStatus('Checking the recipient…')
  const accountQuery = query.getUserAccountQuerierFunction({ client })
  const registered = Boolean(await accountQuery(recipient).catch(() => null))

  const receipt = createReceipt({
    provider: 'umbra',
    asset,
    noteKind: registered ? 'receiver-burnable' : 'self-burnable',
    recipientRegistered: registered,
  })

  try {
    onStatus('Approve the private note…')
    const factory = registered
      ? deposit.getATAIntoReceiverBurnableStealthPoolNoteCreatorFunction
      : deposit.getATAIntoSelfBurnableStealthPoolNoteCreatorFunction
    const result = await factory({ client })({
      destinationAddress: recipient,
      mint,
      amount: types.createU64({ value: BigInt(totalBaseUnits) }),
    })
    receipt.depositSignature = result?.signature ?? result?.signatures?.[0] ?? null
    receipt.withdrawals = [{ tx: receipt.depositSignature }]
    if (!registered) {
      // Saying this plainly matters: the funds have left the wallet but the
      // recipient cannot claim them yet.
      receipt.warning = 'The recipient is not registered with Umbra, so a self-burnable note was written. '
        + 'They cannot claim it until its secret is delivered out of band.'
    }
    return receipt
  } catch (error) {
    return throwWithReceipt(receipt, 'Umbra registration succeeded, but the private note failed', error)
  }
}

export async function execute({ kind, ...options }) {
  if (kind !== 'send') throw new Error(`Umbra has no browser ${kind} flow`)
  return send(options)
}
