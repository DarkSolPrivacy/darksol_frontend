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

async function withdrawPrivacyCash({ records, encryptions, address, recipient, connection, onStatus }) {
  const { asset } = records[0].invoice
  const amount = records.reduce((sum, record) => sum + BigInt(record.invoice.amount), 0n)
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
  // The SDK's own UTXO cache, seeded with these invoices' notes and a fetch offset
  // at the tip: withdraw() then spends the known notes instead of trial-decrypting
  // every output in the pool. It spends its two largest notes, so two fit one proof.
  const storage = memoryStorage(new Map([
    [LSK_FETCH_OFFSET + localstorageKey(owner), nextIndex],
    [LSK_ENCRYPTED_OUTPUTS + localstorageKey(owner), JSON.stringify(records.map((record) => record.invoice.outputs[0].encryptedNote))],
  ]))
  // Each note has its own key, so decryption tries each; the SDK's zero change
  // note is sealed under the first.
  const encryption = Object.assign(Object.create(encryptions[0]), {
    async decryptUtxo(sealed, wasm) {
      for (const service of encryptions) {
        try { return await service.decryptUtxo(sealed, wasm) } catch { /* Another note's key. */ }
      }
      throw new Error('Failed to decrypt data. Invalid encryption key or corrupted data.')
    },
  })
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

async function withdrawCloak({ notes, provider, address, recipient, connection, onStatus }) {
  const sdk = await import('@cloak.dev/sdk')
  onStatus('Locating your note in the Cloak pool...')
  const leaves = await sdk.fetchCommitments(sdk.CLOAK_PRODUCTION_RELAY_URL)
  const inputs = notes.map((note) => {
    const commitment = BigInt(note.commitment)
    const leaf = leaves.find((entry) => BigInt('0x' + entry.commitment) === commitment)
    if (!leaf) throw new Error('This payment has not reached the Cloak pool yet')
    return { ...note, commitment, index: leaf.index }
  })
  const result = await sdk.fullWithdraw(inputs, recipient, {
    connection, programId: sdk.CLOAK_PROGRAM_ID, relayUrl: sdk.CLOAK_PRODUCTION_RELAY_URL,
    // Cloak's relay authenticates the requesting wallet; the recipient can differ.
    walletPublicKey: new PublicKey(address),
    signMessage: async (message) => { const signed = await provider.signMessage(message); return signed?.signature ?? signed },
    disableChainNotes: true, enforceViewingKeyRegistration: false, onProgress: onStatus,
  })
  return result.signature
}

// Groups records into withdrawals: both pools prove two input notes at once, so
// two notes of the same pool and asset share one transaction and one fixed fee.
export function pairNotes(records) {
  const groups = new Map()
  for (const record of records) {
    const key = `${record.invoice.protocol}:${record.invoice.asset}`
    groups.set(key, [...groups.get(key) ?? [], record])
  }
  return [...groups.values()].flatMap((group) => group.flatMap((record, index) => index % 2 ? [] : [group.slice(index, index + 2)]))
}

// Spends one or two funded notes of the same pool and asset (see pairNotes) to
// `recipient`. The pool's relayer pays the network fee, so the merchant wallet
// signs nothing on-chain.
export async function withdrawPaymentNotes({ records, provider, address, keys, recipient, connection, signal, onStatus = () => {} }) {
  const target = validateSolanaAddress(recipient)
  if (!target.valid) throw new Error(target.error)
  const [{ protocol, asset }] = records.map((record) => record.invoice)
  if (records.length > 2 || records.some((record) => record.invoice.protocol !== protocol || record.invoice.asset !== asset)) throw new Error('A withdrawal spends at most two notes of one pool and asset')
  onStatus(`Recovering your private note${records.length === 1 ? '' : 's'}...`)
  const recovered = []
  for (const record of records) {
    recovered.push(await recoverPaymentNote({ provider, address, record, keys, signal }))
    signal?.throwIfAborted()
  }
  return protocol === 'privacycash'
    ? withdrawPrivacyCash({ records, encryptions: recovered.map((item) => item.encryption), address, recipient: target.publicKey, connection, onStatus })
    : withdrawCloak({ notes: recovered.map((item) => item.notes[0]), provider, address, recipient: target.publicKey, connection, onStatus })
}

// Rebuilds version 2 PrivacyCash records from the chain alone: each note's IV is
// derived from its index, so the scan matches outputs without decrypting them.
// Returns records ready for withdrawPaymentNotes, with `spent` from the nullifiers.
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
