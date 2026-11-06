import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { VersionedTransaction } from '@solana/web3.js'
import { COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM, MAX_ADDED_UNITS, walletAdditionsAllowed } from '../protocols/umbrav2/wallet-additions.js'
import { patchTransactionModule } from '../protocols/umbrav2/sdk-patch.js'

const fixture = JSON.parse(await readFile(new URL('./fixtures/solflare-guarded-funding.json', import.meta.url), 'utf8'))

// The compiled message as Kit's getCompiledTransactionMessageDecoder returns it,
// which is what the SDK hands walletAdditionsAllowed.
function compiled(base64) {
  const { message } = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'))
  return {
    version: message.version,
    header: {
      numSignerAccounts: message.header.numRequiredSignatures,
      numReadonlySignerAccounts: message.header.numReadonlySignedAccounts,
      numReadonlyNonSignerAccounts: message.header.numReadonlyUnsignedAccounts,
    },
    staticAccounts: message.staticAccountKeys.map(String),
    lifetimeToken: message.recentBlockhash,
    instructions: message.compiledInstructions.map((instruction) => ({
      programAddressIndex: instruction.programIdIndex,
      ...(instruction.accountKeyIndexes.length ? { accountIndices: [...instruction.accountKeyIndexes] } : {}),
      data: Uint8Array.from(instruction.data),
    })),
    addressTableLookups: message.addressTableLookups.map((lookup) => ({
      lookupTableAddress: String(lookup.accountKey),
      writableIndexes: [...lookup.writableIndexes],
      readonlyIndexes: [...lookup.readonlyIndexes],
    })),
  }
}

const built = () => compiled(fixture.built)
const signed = () => compiled(fixture.signed)
const indexOf = (message, address) => message.staticAccounts.indexOf(address)
const budgetLimit = (message) => message.instructions.find((ix) => message.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 2)
const setUnits = (instruction, units) => { new DataView(instruction.data.buffer).setUint32(1, units, true) }

test('the fixture is the Solflare case: guards appended and the compute limit raised', () => {
  const after = signed()
  assert.equal(after.instructions.length, built().instructions.length + 2)
  assert.equal(after.instructions.filter((ix) => after.staticAccounts[ix.programAddressIndex] === LIGHTHOUSE_PROGRAM).length, 2)
})

test('accepts the transaction Solflare returned for an Umbra v2 deposit funding', () => {
  assert.equal(walletAdditionsAllowed(built(), signed()), true)
})

test('accepts an unchanged message', () => {
  assert.equal(walletAdditionsAllowed(built(), built()), true)
})

test('refuses a changed instruction of the SDK', () => {
  const after = signed()
  after.instructions[1].data[1] ^= 1 // the token transfer's amount
  assert.equal(walletAdditionsAllowed(built(), after), false)
})

test('refuses a removed instruction of the SDK', () => {
  const after = signed()
  after.instructions.splice(0, 1)
  assert.equal(walletAdditionsAllowed(built(), after), false)
})

test('refuses an added instruction of any program but Lighthouse and the compute budget', () => {
  const after = signed()
  after.instructions.push({ ...after.instructions[0], data: Uint8Array.from(after.instructions[0].data) })
  assert.equal(walletAdditionsAllowed(built(), after), false)
})

test('refuses an account turned writable', () => {
  const after = signed()
  // Static accounts end System, ComputeBudget, the mint, Lighthouse, Token, all
  // read-only; three fewer read-only accounts makes the transfer's mint writable.
  const mint = after.staticAccounts[after.staticAccounts.length - 3]
  assert.ok(after.instructions[1].accountIndices.includes(after.staticAccounts.indexOf(mint)))
  after.header = { ...after.header, numReadonlyNonSignerAccounts: after.header.numReadonlyNonSignerAccounts - 3 }
  assert.equal(walletAdditionsAllowed(built(), after), false)
})

test('refuses another fee payer, signer set or blockhash', () => {
  const payer = signed()
  payer.staticAccounts[0] = payer.staticAccounts[1]
  assert.equal(walletAdditionsAllowed(built(), payer), false)
  const signers = signed()
  signers.header = { ...signers.header, numSignerAccounts: 2 }
  assert.equal(walletAdditionsAllowed(built(), signers), false)
  const blockhash = signed()
  blockhash.lifetimeToken = blockhash.staticAccounts[1]
  assert.equal(walletAdditionsAllowed(built(), blockhash), false)
})

test('refuses a changed priority fee', () => {
  const after = signed()
  const price = after.instructions.find((ix) => after.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 3)
  price.data[1] ^= 1
  assert.equal(walletAdditionsAllowed(built(), after), false)
})

test('refuses a priority fee the SDK did not set', () => {
  const before = built()
  before.instructions = before.instructions.filter((ix) => !(before.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 3))
  assert.equal(walletAdditionsAllowed(before, signed()), false)
})

test('bounds the compute limit the wallet may set', () => {
  const units = new DataView(budgetLimit(built()).data.buffer).getUint32(1, true)
  const lower = signed(); setUnits(budgetLimit(lower), units - 1)
  assert.equal(walletAdditionsAllowed(built(), lower), false)
  const most = signed(); setUnits(budgetLimit(most), units + MAX_ADDED_UNITS)
  assert.equal(walletAdditionsAllowed(built(), most), true)
  const over = signed(); setUnits(budgetLimit(over), units + MAX_ADDED_UNITS + 1)
  assert.equal(walletAdditionsAllowed(built(), over), false)
})

test('refuses a second compute limit', () => {
  const after = signed()
  after.instructions.push({ ...budgetLimit(after), data: Uint8Array.from(budgetLimit(after).data) })
  assert.equal(walletAdditionsAllowed(built(), after), false)
})

test('compares accounts by address, not position', () => {
  // Solflare inserted the Lighthouse program among the static accounts, which
  // moved the token program's index: still the same instruction.
  assert.notEqual(indexOf(built(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), indexOf(signed(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'))
  assert.equal(walletAdditionsAllowed(built(), signed()), true)
})

test('the SDK patch applies to the pinned nimbus-solana and fails loudly on another', async () => {
  const source = await readFile(new URL('../node_modules/@umbra-privacy/nimbus-solana/dist/flows/transaction.js', import.meta.url), 'utf8')
  const patched = patchTransactionModule(source)
  assert.match(patched, /^import \{ walletAdditionsAllowed as __walletAdditionsAllowed \} from /)
  assert.match(patched, /__walletAdditionsAllowed\(deps\.decodeSolanaTransactionMessage/)
  assert.match(patched, /messageBytes: new Uint8Array\(deps\.decodeSolanaTransaction\(\{ wire: walletSigning\.walletSigned \}\)\.messageBytes\)/)
  assert.throws(() => patchTransactionModule(source.replace('function readWalletSignature(', 'function readSignature(')), /flows\/transaction\.js changed/)
})
