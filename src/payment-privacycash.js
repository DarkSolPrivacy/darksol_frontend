import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Buffer } from 'buffer'
import BN from 'bn.js'
import { WasmFactory } from '@lightprotocol/hasher.rs'
import { Utxo } from '../node_modules/privacycash/dist/models/utxo.js'
import { Keypair } from '../node_modules/privacycash/dist/models/keypair.js'
import { ALT_ADDRESS, FEE_RECIPIENT, MERKLE_TREE_DEPTH, PROGRAM_ID } from '../node_modules/privacycash/dist/utils/constants.js'
import { getExtDataHash, getMintAddressField, getProgramAccounts, findCrossCheckNullifierPDAs, findNullifierPDAs, queryRemoteTreeState } from '../node_modules/privacycash/dist/utils/utils.js'
import { serializeProofAndExtData } from '../node_modules/privacycash/dist/utils/encryption.js'
import { parseProofToBytesArray, parseToBytesArray, prove } from '../node_modules/privacycash/dist/utils/prover.js'
import { PAYMENT_ASSETS } from './payment-assets.js'

const randomField = () => BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(31))).toString('hex')).toString()

// privacycash@1.2.2 deposit() always replaces the outputs with payer-owned notes.
// Keep its circuit/serialization/account layout, supplying the invoice's public outputs instead.
// SPL pools route the placeholder recipient and fee through FEE_RECIPIENT's token account.
const feeAccount = (invoice) => invoice.asset === 'SOL' ? FEE_RECIPIENT
  : getAssociatedTokenAddressSync(new PublicKey(invoice.outputs[0].mint), FEE_RECIPIENT, true)

export async function privacyCashDepositInput(invoice, root) {
  const wasm = await WasmFactory.getInstance()
  const mint = invoice.outputs[0].mint
  const inputs = [0, 1].map(() => new Utxo({ lightWasm: wasm, amount: '0', blinding: randomField(), mintAddress: mint, keypair: new Keypair(randomField(), wasm) }))
  const outputs = invoice.outputs.map((output) => new Utxo({ lightWasm: wasm,
    amount: output.amount, blinding: output.blinding, mintAddress: output.mint, keypair: { pubkey: output.publicKey } }))
  const commitments = outputs.map((output) => output.getCommitment().toString())
  if (commitments.some((value, index) => value !== invoice.outputs[index].commitment)) throw new Error('Payment note commitment does not match')
  const extData = {
    recipient: feeAccount(invoice).toString(), feeRecipient: feeAccount(invoice),
    extAmount: new BN(invoice.amount), fee: new BN(0), mintAddress: mint,
    encryptedOutput1: Buffer.from(invoice.outputs[0].encryptedNote, 'hex'),
    encryptedOutput2: Buffer.from(invoice.outputs[1].encryptedNote, 'hex'),
  }
  const input = {
    root: String(root), inputNullifier: await Promise.all(inputs.map((note) => note.getNullifier())),
    outputCommitment: commitments, publicAmount: invoice.amount, extDataHash: getExtDataHash(extData),
    inAmount: inputs.map(() => '0'), inPrivateKey: inputs.map((note) => note.keypair.privkey.toString()),
    inBlinding: inputs.map((note) => note.blinding.toString()), inPathIndices: [0, 0],
    inPathElements: inputs.map(() => Array(MERKLE_TREE_DEPTH).fill('0')),
    outAmount: outputs.map((note) => note.amount.toString()), outBlinding: outputs.map((note) => note.blinding.toString()),
    outPubkey: outputs.map((note) => note.keypair.pubkey.toString()), mintAddress: getMintAddressField(new PublicKey(mint)),
  }
  return { input, extData }
}

export async function depositPrivacyCashInvoice({ invoice, connection, publicKey, signTransaction, signal, onStatus }) {
  const { token } = PAYMENT_ASSETS[invoice.asset]
  const mint = new PublicKey(invoice.outputs[0].mint)
  const { treeTokenAccount, globalConfigAccount, ...accounts } = getProgramAccounts()
  // Each SPL mint has its own tree; SOL uses the default one.
  const treeAccount = token ? PublicKey.findProgramAddressSync([Buffer.from('merkle_tree'), mint.toBuffer()], PROGRAM_ID)[0] : accounts.treeAccount
  const tree = await connection.getAccountInfo(treeAccount)
  if (!tree?.owner.equals(PROGRAM_ID) || tree.data.length < 4128) throw new Error('PrivacyCash pool is unavailable')
  const maximum = Buffer.from(tree.data).readBigUInt64LE(4120)
  if (maximum > 0n && BigInt(invoice.amount) > maximum) throw new Error('Payment exceeds the PrivacyCash deposit limit')
  onStatus('Preparing private deposit...')
  const state = await queryRemoteTreeState(token ?? undefined)
  const { input, extData } = await privacyCashDepositInput(invoice, state.root)
  signal?.throwIfAborted()
  onStatus('Generating payment proof...')
  const result = await prove(input, '/circuit2/transaction2')
  signal?.throwIfAborted()
  const proofBytes = parseProofToBytesArray(result.proof)
  const publicInputs = parseToBytesArray(result.publicSignals)
  const proof = { proofA: proofBytes.proofA, proofB: proofBytes.proofB.flat(), proofC: proofBytes.proofC,
    root: publicInputs[0], publicAmount: publicInputs[1], extDataHash: publicInputs[2],
    inputNullifiers: [publicInputs[3], publicInputs[4]], outputCommitments: [publicInputs[5], publicInputs[6]] }
  const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(proof)
  const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(proof)
  const lookup = await connection.getAddressLookupTable(ALT_ADDRESS)
  if (!lookup.value) throw new Error('PrivacyCash address lookup table is unavailable')
  const feeTokenAccount = feeAccount(invoice)
  // Account order follows privacycash@1.2.2 depositSPL().
  const keys = token ? [
    { pubkey: treeAccount, isSigner: false, isWritable: true },
    { pubkey: nullifier0PDA, isSigner: false, isWritable: true },
    { pubkey: nullifier1PDA, isSigner: false, isWritable: true },
    { pubkey: nullifier2PDA, isSigner: false, isWritable: false },
    { pubkey: nullifier3PDA, isSigner: false, isWritable: false },
    { pubkey: globalConfigAccount, isSigner: false, isWritable: false },
    { pubkey: publicKey, isSigner: true, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(mint, publicKey), isSigner: false, isWritable: true },
    { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: feeTokenAccount, isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(mint, globalConfigAccount, true), isSigner: false, isWritable: true },
    { pubkey: feeTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ] : [
    { pubkey: treeAccount, isSigner: false, isWritable: true },
    { pubkey: nullifier0PDA, isSigner: false, isWritable: true },
    { pubkey: nullifier1PDA, isSigner: false, isWritable: true },
    { pubkey: nullifier2PDA, isSigner: false, isWritable: false },
    { pubkey: nullifier3PDA, isSigner: false, isWritable: false },
    { pubkey: treeTokenAccount, isSigner: false, isWritable: true },
    { pubkey: globalConfigAccount, isSigner: false, isWritable: false },
    { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]
  const instruction = new TransactionInstruction({ programId: PROGRAM_ID, keys,
    data: serializeProofAndExtData(proof, extData, Boolean(token)) })
  const { blockhash } = await connection.getLatestBlockhash()
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }), instruction]
  const transaction = () => new VersionedTransaction(new TransactionMessage({
    payerKey: publicKey, recentBlockhash: blockhash, instructions,
  }).compileToV0Message([lookup.value]))
  let unsigned = transaction()
  if (unsigned.serialize().length > 1232) { instructions.splice(1, 1); unsigned = transaction() }
  if (unsigned.serialize().length > 1232) throw new Error('Payment transaction exceeds Solana size limit')
  signal?.throwIfAborted()
  const signed = await signTransaction(unsigned)
  signal?.throwIfAborted()
  onStatus('Submitting deposit...')
  return connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 })
}
