// Which changes a wallet may make to a transaction Umbra v2's SDK asks it to sign.
//
// The SDK (@umbra-privacy/nimbus-solana 0.1.1, flows/transaction.js) refuses any
// signed message that differs from the one it built: "the wallet changed the
// transaction's message … nothing was sent". Solflare always changes it. Its
// backend simulation returns the transaction with Lighthouse guard instructions
// appended (assertions that fail the transaction if balances differ from the
// simulation) and the compute limit raised to pay for them, and with no price
// set it appends a SetComputeUnitPrice of its own. Every Umbra v2 deposit and
// registration from Solflare was refused.
//
// sdk-patch.js routes the SDK's check through `walletAdditionsAllowed`, which
// accepts a changed message only when every instruction the SDK built is still
// there, unchanged and in order, and the wallet added nothing but:
//   - Lighthouse instructions, which only read accounts and assert;
//   - a higher SetComputeUnitLimit, by at most MAX_ADDED_UNITS.
// The fee payer, the signers, the blockhash, the lookup tables, the price and
// the loaded-accounts limit must not change. Anything else is still refused.
//
// Both arguments are compiled messages, as Kit's getCompiledTransactionMessageDecoder
// (the SDK's decodeSolanaTransactionMessage) returns them.

export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
// Solflare raised the limit by 40,000 units for two guards.
export const MAX_ADDED_UNITS = 200_000
const MAX_UNITS = 1_400_000

const SET_COMPUTE_UNIT_LIMIT = 2
const SET_COMPUTE_UNIT_PRICE = 3
const SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 4

const bytesOf = (data) => (data ? Uint8Array.from(data) : new Uint8Array(0))
const hex = (data) => Array.from(bytesOf(data), (byte) => byte.toString(16).padStart(2, '0')).join('')

function sameLookups(a = [], b = []) {
  if (a.length !== b.length) return false
  return a.every((lookup, index) => {
    const other = b[index]
    return String(lookup.lookupTableAddress) === String(other.lookupTableAddress)
      && hex(lookup.writableIndexes) === hex(other.writableIndexes)
      && hex(lookup.readonlyIndexes) === hex(other.readonlyIndexes)
  })
}

// Each instruction as its program, its accounts with their roles, and its data.
// A static account is named by its address; one loaded from a lookup table by its
// position among the loaded accounts, the same in both once the tables match.
function resolveInstructions(message) {
  const { header, staticAccounts, addressTableLookups = [], instructions } = message
  const statics = staticAccounts.length
  const writableLoaded = addressTableLookups.reduce((sum, lookup) => sum + bytesOf(lookup.writableIndexes).length, 0)
  const account = (index) => {
    if (index >= statics) {
      const position = index - statics
      return `loaded#${position}:${position < writableLoaded ? 'w' : 'r'}`
    }
    const signer = index < header.numSignerAccounts
    const writable = signer
      ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
      : index < statics - header.numReadonlyNonSignerAccounts
    return `${staticAccounts[index]}:${signer ? 's' : ''}${writable ? 'w' : 'r'}`
  }
  return instructions.map((instruction) => ({
    program: String(staticAccounts[instruction.programAddressIndex]),
    accounts: (instruction.accountIndices ?? []).map(account),
    data: bytesOf(instruction.data),
  }))
}

const sameInstruction = (a, b) => a.program === b.program && a.accounts.join() === b.accounts.join() && hex(a.data) === hex(b.data)

// The compute budget instructions by type, or null when one is malformed or repeated.
function budgetOf(instructions) {
  const budget = new Map()
  for (const instruction of instructions) {
    const type = instruction.data[0]
    if (instruction.accounts.length || budget.has(type)) return null
    if (![SET_COMPUTE_UNIT_LIMIT, SET_COMPUTE_UNIT_PRICE, SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT].includes(type)) return null
    budget.set(type, instruction.data)
  }
  return budget
}

const unitsOf = (data) => (data?.length === 5 ? new DataView(data.buffer, data.byteOffset, 5).getUint32(1, true) : null)

export function walletAdditionsAllowed(built, signed) {
  if (built.version !== signed.version || built.version !== 0) return false
  if (String(built.lifetimeToken) !== String(signed.lifetimeToken)) return false
  if (built.header.numSignerAccounts !== signed.header.numSignerAccounts
    || built.header.numReadonlySignerAccounts !== signed.header.numReadonlySignerAccounts) return false
  for (let index = 0; index < built.header.numSignerAccounts; index++) {
    if (String(built.staticAccounts[index]) !== String(signed.staticAccounts[index])) return false
  }
  if (!sameLookups(built.addressTableLookups, signed.addressTableLookups)) return false

  const before = resolveInstructions(built)
  const after = resolveInstructions(signed)
  const isBudget = (instruction) => instruction.program === COMPUTE_BUDGET_PROGRAM
  const isGuard = (instruction) => instruction.program === LIGHTHOUSE_PROGRAM
  if (before.some(isGuard)) return false

  // The SDK's own instructions, compute budget aside: all kept, in order, unchanged.
  const kept = before.filter((instruction) => !isBudget(instruction))
  const rest = after.filter((instruction) => !isBudget(instruction) && !isGuard(instruction))
  if (kept.length !== rest.length || !kept.every((instruction, index) => sameInstruction(instruction, rest[index]))) return false

  const budgetBefore = budgetOf(before.filter(isBudget))
  const budgetAfter = budgetOf(after.filter(isBudget))
  if (!budgetBefore || !budgetAfter) return false
  for (const type of [SET_COMPUTE_UNIT_PRICE, SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT]) {
    if (hex(budgetBefore.get(type)) !== hex(budgetAfter.get(type))) return false
  }
  const unitsBefore = unitsOf(budgetBefore.get(SET_COMPUTE_UNIT_LIMIT))
  const unitsAfter = unitsOf(budgetAfter.get(SET_COMPUTE_UNIT_LIMIT))
  if (unitsBefore === null || unitsAfter === null) return false
  return unitsAfter >= unitsBefore && unitsAfter <= unitsBefore + MAX_ADDED_UNITS && unitsAfter <= MAX_UNITS
}
