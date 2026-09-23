import { PublicKey } from '@solana/web3.js'
import { recoverPaymentNote, derivedInvoiceId, privacyCashIv, privacyCashNotes } from './payment-notes.js'
import { validateSolanaAddress } from './transfer-validation.js'
import { PAYMENT_ASSETS } from './payment-assets.js'

// Version 2 notes did not exist before these output counts in each PrivacyCash
// tree, so a cold scan starts there instead of downloading the pool's history.
export const PRIVACYCASH_FIRST_OUTPUT = Object.freeze({ SOL: 813000, USDC: 90500, USDT: 8800 })
// ponytail: fixed gap limit, like a wallet's address gap; raise it if merchants
// leave more than this many unpaid links in a row after their last known one.
export const SCAN_GAP = 50

const memoryStorage = (entries) => ({
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => entries.set(key, String(value)),
  removeItem: (key) => entries.delete(key),
})

async function withdrawPrivacyCash({ record, encryption, address, recipient, connection, onStatus }) {
  const { asset, amount, outputs } = record.invoice
  const { token, pcMint } = PAYMENT_ASSETS[asset]
  const [{ WasmFactory }, { withdraw }, { withdrawSPL }, { localstorageKey }, { queryRemoteTreeState }, { LSK_ENCRYPTED_OUTPUTS, LSK_FETCH_OFFSET }, { setLogger }, { getAssociatedTokenAddressSync }] = await Promise.all([
    import('@lightprotocol/hasher.rs'),
    import('../node_modules/privacycash/dist/withdraw.js'),
    import('../node_modules/privacycash/dist/withdrawSPL.js'),
    import('../node_modules/privacycash/dist/getUtxos.js'),
    import('../node_modules/privacycash/dist/utils/utils.js'),
    import('../node_modules/privacycash/dist/utils/constants.js'),
    import('../node_modules/privacycash/dist/utils/logger.js'),
    import('@solana/spl-token'),
  ])
  const publicKey = new PublicKey(address)
  const { nextIndex } = await queryRemoteTreeState(token ?? undefined)
  // The SPL cache is keyed by the owner's token account, the SOL cache by the owner.
  const owner = token ? getAssociatedTokenAddressSync(new PublicKey(pcMint), publicKey) : publicKey
  // The SDK's own UTXO cache, seeded with this invoice's note and a fetch offset
  // at the tip: withdraw() then spends the known note instead of trial-decrypting
  // every output in the pool.
  const storage = memoryStorage(new Map([
    [LSK_FETCH_OFFSET + localstorageKey(owner), nextIndex],
    [LSK_ENCRYPTED_OUTPUTS + localstorageKey(owner), JSON.stringify([outputs[0].encryptedNote])],
  ]))
  setLogger((level, message) => { if (level === 'info') onStatus(message) })
  try {
    const common = { recipient, publicKey, connection, storage, encryptionService: encryption,
      lightWasm: await WasmFactory.getInstance(), keyBasePath: '/circuit2/transaction2' }
    const result = token
      ? await withdrawSPL({ ...common, mintAddress: pcMint, base_units: Number(amount) })
      : await withdraw({ ...common, amount_in_lamports: Number(amount) })
    return result.tx
  } catch (error) {
    if (/unspent UTXO|no balance/.test(error.message)) throw new Error('No unspent funds: this payment is not deposited yet or was already withdrawn')
    throw error
  } finally {
    setLogger(() => {})
  }
}

async function withdrawCloak({ note, provider, address, recipient, connection, onStatus }) {
  const sdk = await import('@cloak.dev/sdk')
  onStatus('Locating your note in the Cloak pool...')
  const commitment = BigInt(note.commitment)
  const leaf = (await sdk.fetchCommitments(sdk.CLOAK_PRODUCTION_RELAY_URL)).find((entry) => BigInt('0x' + entry.commitment) === commitment)
  if (!leaf) throw new Error('This payment has not reached the Cloak pool yet')
  const result = await sdk.fullWithdraw([{ ...note, commitment, index: leaf.index }], recipient, {
    connection, programId: sdk.CLOAK_PROGRAM_ID, relayUrl: sdk.CLOAK_PRODUCTION_RELAY_URL,
    // Cloak's relay authenticates the requesting wallet; the recipient can differ.
    walletPublicKey: new PublicKey(address),
    signMessage: async (message) => { const signed = await provider.signMessage(message); return signed?.signature ?? signed },
    disableChainNotes: true, enforceViewingKeyRegistration: false, onProgress: onStatus,
  })
  return result.signature
}

// Spends the invoice's funded note to `recipient`. The pool's relayer pays the
// network fee, so the merchant wallet signs nothing on-chain.
export async function withdrawPaymentNote({ record, provider, address, keys, recipient, connection, signal, onStatus = () => {} }) {
  const target = validateSolanaAddress(recipient)
  if (!target.valid) throw new Error(target.error)
  onStatus('Recovering your private note...')
  const { notes, encryption } = await recoverPaymentNote({ provider, address, record, keys, signal })
  signal?.throwIfAborted()
  return record.invoice.protocol === 'privacycash'
    ? withdrawPrivacyCash({ record, encryption, address, recipient: target.publicKey, connection, onStatus })
    : withdrawCloak({ note: notes[0], provider, address, recipient: target.publicKey, connection, onStatus })
}

// Rebuilds version 2 PrivacyCash records from the chain alone: each note's IV is
// derived from its index, so the scan matches outputs without decrypting them.
// Returns records ready for withdrawPaymentNote, with `spent` from the nullifiers.
// ponytail: Cloak has no on-chain note to find without its amount; a Cloak scan
// needs an index of deposit amounts and commitments. Its notes are derivable, so
// the server record or a backup is enough to withdraw them.
export async function scanPrivacyCashNotes({ keys, connection, fromIndex = 0, toIndex = SCAN_GAP, signal, onStatus = () => {} }) {
  const [{ RELAYER_API_URL }, { isUtxoSpent }] = await Promise.all([
    import('../node_modules/privacycash/dist/utils/constants.js'),
    import('../node_modules/privacycash/dist/getUtxos.js'),
  ])
  const wanted = new Map()
  for (let index = fromIndex; index < toIndex; index++) {
    for (const output of [0, 1]) wanted.set(await privacyCashIv(keys, index, output), { index, output })
  }
  // Each asset has its own tree; an index is used once, so it lands in only one.
  const found = new Map()
  for (const [asset, { token }] of Object.entries(PAYMENT_ASSETS)) {
    for (let start = PRIVACYCASH_FIRST_OUTPUT[asset], more = true; more; start += 10000) {
      signal?.throwIfAborted()
      onStatus(`Scanning PrivacyCash ${asset} outputs from ${start}...`)
      const response = await fetch(`${RELAYER_API_URL}/utxos/range?${token ? `token=${token}&` : ''}start=${start}&end=${start + 10000}`, { signal })
      if (!response.ok) throw new Error('PrivacyCash indexer is unavailable')
      const page = await response.json()
      for (const encrypted of page.encrypted_outputs || []) {
        const match = typeof encrypted === 'string' && wanted.get(encrypted.slice(16, 40))
        if (match) {
          if (!found.has(match.index)) found.set(match.index, { asset, sealed: [] })
          found.get(match.index).sealed[match.output] = encrypted
        }
      }
      more = Boolean(page.hasMore && page.encrypted_outputs?.length)
    }
  }
  const records = []
  for (const [index, { asset, sealed }] of [...found].sort((a, b) => a[0] - b[0])) {
    if (!sealed[0] || !sealed[1]) continue
    const notes = await privacyCashNotes(keys, index, sealed).then((result) => result.notes, () => null)
    if (!notes || notes[0].mintAddress !== PAYMENT_ASSETS[asset].pcMint) continue
    const outputs = notes.map((note, output) => ({ amount: note.amount.toString(), mint: note.mintAddress,
      publicKey: note.keypair.pubkey.toString(), blinding: note.blinding.toString(),
      commitment: note.getCommitment().toString(), encryptedNote: sealed[output] }))
    // A nullifier binds the leaf index, which the note only learns once deposited.
    const indices = await fetch(`${RELAYER_API_URL}/utxos/indices`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ encrypted_outputs: [sealed[0]], ...(PAYMENT_ASSETS[asset].token && { token: PAYMENT_ASSETS[asset].token }) }) }).then((result) => result.json())
    if (typeof indices.indices?.[0] !== 'number') throw new Error('PrivacyCash indexer is unavailable')
    notes[0].index = indices.indices[0]
    records.push({
      record: { version: 2, index, invoice: { version: 1, id: await derivedInvoiceId(keys, index), network: 'solana-mainnet',
        protocol: 'privacycash', asset, amount: outputs[0].amount, outputs }, reference: 'Recovered from chain', createdAt: new Date().toISOString() },
      spent: await isUtxoSpent(connection, notes[0]),
    })
  }
  return records
}
