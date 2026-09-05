// Umbra test-only CLI adapter.
//
// Two things differ from the other Solana protocols and shape this file:
//
// 1. Every key derives from a 64-byte master seed produced by a deterministic
//    wallet signature, so there is no key material to store here. The CLI signs
//    with the existing disposable test keypair.
// 2. A private send is not one call. Funds move ATA -> ETA (encrypted balance),
//    and a Stealth Pool note is then written for the recipient, who later burns
//    it through Umbra's relayer. Only the note breaks the sender/recipient link.
import { Connection, PublicKey } from '@solana/web3.js'
import { loadKeypair, parseRecipient, solanaRpcUrl } from '../../scripts/runtime.js'
import { MINTS } from '../addresses.js'
import manifest from './manifest.js'

const programId = new PublicKey(manifest.addresses.program)

// Devnet has its own program and services; everything else here is mainnet.
function network() {
  return process.env.UMBRA_NETWORK === 'devnet' ? 'devnet' : 'mainnet'
}

async function client() {
  const [{ getUmbraClient, createSignerFromPrivateKeyBytes }, owner] = await Promise.all([
    import('@umbra-privacy/sdk'),
    loadKeypair(),
  ])
  const signer = await createSignerFromPrivateKeyBytes(owner.secretKey)
  return getUmbraClient({
    signer,
    network: network(),
    rpcUrl: solanaRpcUrl(),
    indexerApiEndpoint: manifest.services.indexerApi,
    relayerApiEndpoint: manifest.services.relayerApi,
  })
}

function mintFor(symbol: string) {
  const mint = MINTS[String(symbol || 'SOL').toUpperCase() as keyof typeof MINTS]
  if (!mint) throw new Error(`Umbra supports ${Object.keys(MINTS).join(', ')}`)
  return new PublicKey(mint)
}

export async function snapshot() {
  const connection = new Connection(solanaRpcUrl(), 'confirmed')
  const [program, { custodyOwners, poolBalances }] = await Promise.all([
    connection.getAccountInfo(programId, 'confirmed'),
    import('./indexer.js'),
  ])
  // The per-user balances inside are encrypted, but custody is not: these are
  // plain SPL accounts owned by Umbra's per-mint pool PDAs.
  const balances = await poolBalances((method: string, params: unknown[]) =>
    fetch(solanaRpcUrl(), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
      signal: AbortSignal.timeout(30_000),
    }).then(async (response) => {
      const payload = await response.json()
      if (payload.error) throw new Error(payload.error.message)
      return payload.result
    }))
  return {
    protocol: 'umbra',
    network: network(),
    programId: programId.toBase58(),
    executable: Boolean(program?.executable),
    pools: custodyOwners(),
    balances,
    poolSource: manifest.indexer.poolSource,
  }
}

export async function balance() {
  const umbra = await client()
  const { getEncryptedBalanceQuerierFunction } = await import('@umbra-privacy/sdk/query')
  const query = getEncryptedBalanceQuerierFunction({ client: umbra })
  const encrypted = await query(mintFor(process.env.UMBRA_ASSET || 'SOL'))
  return { protocol: 'umbra', asset: process.env.UMBRA_ASSET || 'SOL', encryptedBalance: encrypted }
}

// Shield: move a public ATA balance into the encrypted token account.
export async function deposit(baseUnits: bigint) {
  const umbra = await client()
  const [{ getATAIntoETADirectDepositorFunction }, { createU64 }] = await Promise.all([
    import('@umbra-privacy/sdk/deposit'),
    import('@umbra-privacy/sdk/types'),
  ])
  const run = getATAIntoETADirectDepositorFunction({ client: umbra })
  const result = await run(umbra.signer.address, mintFor(process.env.UMBRA_ASSET || 'SOL'), createU64({ value: baseUnits }))
  return { protocol: 'umbra', action: 'deposit', baseUnits, result }
}

// Private send: write a Stealth Pool note the recipient can burn.
//
// Receiver-burnable requires the recipient to be registered with Umbra. When
// they are not, the note is self-burnable and its secret has to reach them out
// of band -- so the receipt says which kind was written rather than implying
// the transfer is complete either way.
export async function send(recipientAddress: string, baseUnits: bigint) {
  const recipient = parseRecipient(recipientAddress)
  const umbra = await client()
  const [deposits, query, { createU64 }] = await Promise.all([
    import('@umbra-privacy/sdk/deposit'),
    import('@umbra-privacy/sdk/query'),
    import('@umbra-privacy/sdk/types'),
  ])

  const accountQuery = query.getUserAccountQuerierFunction({ client: umbra })
  const registered = Boolean(await accountQuery(recipient.toBase58()).catch(() => null))

  const factory = registered
    ? deposits.getATAIntoReceiverBurnableStealthPoolNoteCreatorFunction
    : deposits.getATAIntoSelfBurnableStealthPoolNoteCreatorFunction
  const run = factory({ client: umbra })
  const result = await run({
    destinationAddress: recipient.toBase58(),
    mint: mintFor(process.env.UMBRA_ASSET || 'SOL'),
    amount: createU64({ value: baseUnits }),
  })
  return {
    protocol: 'umbra',
    action: 'send',
    noteKind: registered ? 'receiver-burnable' : 'self-burnable',
    recipientRegistered: registered,
    recipient: recipient.toBase58(),
    baseUnits,
    result,
    ...(registered ? {} : {
      warning: 'The recipient is not registered with Umbra, so a self-burnable note was written. '
        + 'They cannot claim it until its secret is delivered out of band.',
    }),
  }
}

// Registration is idempotent and required before any other flow.
export async function register() {
  const umbra = await client()
  const { getUserRegistrationFunction } = await import('@umbra-privacy/sdk/registration')
  const run = getUserRegistrationFunction({ client: umbra })
  return { protocol: 'umbra', action: 'register', result: await run({ confidential: true, anonymous: true }) }
}
