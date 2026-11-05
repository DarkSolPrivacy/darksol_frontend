import assert from 'node:assert/strict'
import test from 'node:test'
import bs58 from 'bs58'
import { withdrawNotes } from '../protocols/cloakc/browser.js'
import { sendFromBalance, shieldedBalances } from '../protocols/umbrav2/browser.js'
import { MINTS } from '../protocols/addresses.js'

const memoryStorage = () => {
  const entries = new Map()
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key) }
}

// Stands in for @cloak.dev/sdk: a note is { amount, blinding }, serialized as its two numbers.
function fakeCloak({ failWithdraw = false } = {}) {
  let next = 100
  const calls = []
  const note = (amount, keypair = { privateKey: 1n }) => ({ amount, keypair, mintAddress: 'SOL', blinding: BigInt(next++) })
  return {
    calls, note,
    serializeUtxo: (utxo) => new TextEncoder().encode(`${utxo.amount}:${utxo.blinding}`),
    createUtxo: async (amount, keypair, mint) => note(amount, keypair, mint),
    transact: async ({ inputUtxos, outputUtxos, externalAmount }) => {
      calls.push(['merge', inputUtxos.map((utxo) => utxo.amount), externalAmount])
      return { signature: 'merge', outputUtxos: [{ ...outputUtxos[0], index: next++ }], commitmentIndices: [0, 1], merkleTree: [] }
    },
    partialWithdraw: async (inputs, recipient, amount) => {
      if (failWithdraw) throw new Error('relay down')
      calls.push(['withdraw', inputs.map((utxo) => utxo.amount), amount])
      const change = inputs.reduce((sum, utxo) => sum + utxo.amount, 0n) - amount
      return { signature: 'withdrawal', outputUtxos: change ? [note(change, inputs[0].keypair)] : [] }
    },
  }
}
const savedAmounts = (wallet) => JSON.parse(localStorage.getItem(`cloak-utxos-${wallet}`) || '[]').map((entry) => atob(entry).split(':')[0]).sort()

test('Cloak pays from more than two notes by merging the smallest first, saving each merge before the next step', async () => {
  globalThis.localStorage = memoryStorage()
  const sdk = fakeCloak()
  const notes = [5n, 3n, 2n, 1n].map((amount) => sdk.note(amount))
  localStorage.setItem('cloak-utxos-W', JSON.stringify(notes.map((utxo) => btoa(new TextDecoder().decode(sdk.serializeUtxo(utxo))))))
  const withdrawal = await withdrawNotes({ sdk, options: {}, wallet: 'W', notes, amount: 9n, recipient: 'R' })
  assert.equal(withdrawal.signature, 'withdrawal')
  // Two private merges, no external amount, then one withdrawal from two notes.
  assert.deepEqual(sdk.calls, [['merge', [1n, 2n], 0n], ['merge', [3n, 3n], 0n], ['withdraw', [6n, 5n], 9n]])
  // Only the change is left.
  assert.deepEqual(savedAmounts('W'), ['2'])
})

test('a Cloak withdrawal that fails after a merge leaves the merged note saved', async () => {
  globalThis.localStorage = memoryStorage()
  const sdk = fakeCloak({ failWithdraw: true })
  const notes = [4n, 3n, 2n].map((amount) => sdk.note(amount))
  localStorage.setItem('cloak-utxos-W', JSON.stringify(notes.map((utxo) => btoa(new TextDecoder().decode(sdk.serializeUtxo(utxo))))))
  await assert.rejects(withdrawNotes({ sdk, options: {}, wallet: 'W', notes, amount: 8n, recipient: 'R' }), /relay down/)
  assert.deepEqual(savedAmounts('W'), ['4', '5'])
})

// Stands in for @umbra-privacy/nimbus-solana-web.
function fakeNimbus({ rows, settlement = { kind: 'landed', signature: new Uint8Array(64).fill(7) }, outcome = 'relayed', syncs = [] }) {
  const calls = []
  return {
    calls,
    syncNoteStore: async () => { calls.push(['sync']); return syncs.shift() ?? { kind: 'ingested', caughtUp: true } },
    readBalances: async () => rows,
    createWithdrawalContext: async () => 'context',
    withdraw: async (context, args, options) => {
      calls.push(['withdraw', args, options])
      return outcome === 'relayed' ? { kind: 'relayed', settlement } : { kind: 'relay-refused', code: 'busy' }
    },
  }
}
const registered = { registration: { kind: 'registered' } }

test('Umbra v2 pays from the private balance with no deposit, the SOL payout to the wallet itself', async () => {
  const nimbus = fakeNimbus({ rows: [{ mint: MINTS.USDC, state: 'available', total: 5_000_000n }, { mint: MINTS.USDC, state: 'pending', total: 9_000_000n }] })
  const receipt = await sendFromBalance({ nimbus, session: registered, asset: 'USDC', mint: MINTS.USDC, payout: 2_000_000n, recipient: 'Recipient' })
  assert.deepEqual(receipt, { provider: 'umbrav2', asset: 'USDC', depositSignature: null, withdrawals: [{ tx: bs58.encode(new Uint8Array(64).fill(7)) }] })
  assert.deepEqual(nimbus.calls, [['sync'], ['withdraw', { mint: MINTS.USDC, amount: 2_000_000n, recipient: 'Recipient' }, {}]])
  const sol = fakeNimbus({ rows: [{ mint: MINTS.SOL, state: 'available', total: 10n }] })
  await sendFromBalance({ nimbus: sol, session: registered, asset: 'SOL', mint: MINTS.SOL, payout: 10n, recipient: 'Recipient' })
  assert.deepEqual(sol.calls[1][2], { recipientTokenAccount: 'Recipient' })
})

test('Umbra v2 refuses a payment its spendable balance does not cover, and counts a pending settlement as sent', async () => {
  // A note still settling cannot be spent yet.
  const rows = [{ mint: MINTS.USDC, state: 'available', total: 1_000_000n }, { mint: MINTS.USDC, state: 'pending', total: 9_000_000n }]
  await assert.rejects(sendFromBalance({ nimbus: fakeNimbus({ rows }), session: registered, asset: 'USDC', mint: MINTS.USDC, payout: 2_000_000n, recipient: 'R' }), /can pay 1 USDC, less than 2 USDC/)
  await assert.rejects(sendFromBalance({ nimbus: fakeNimbus({ rows }), session: { registration: { kind: 'unregistered' } }, asset: 'USDC', mint: MINTS.USDC, payout: 1n, recipient: 'R' }), /no Umbra v2 private balance/)
  await assert.rejects(sendFromBalance({ nimbus: fakeNimbus({ rows, outcome: 'refused' }), session: registered, asset: 'USDC', mint: MINTS.USDC, payout: 1n, recipient: 'R' }), /did not take the withdrawal \(busy\)/)
  // The relayer took it and it still lands: the page must not offer to pay again.
  const pending = await sendFromBalance({ nimbus: fakeNimbus({ rows, settlement: { kind: 'pending', state: 'submitted' } }), session: registered, asset: 'USDC', mint: MINTS.USDC, payout: 1n, recipient: 'R' })
  assert.deepEqual(pending.withdrawals, [{ tx: null }])
})

test('an Umbra v2 sync that stops partway is tried again, never read as a smaller balance', async () => {
  const rows = [{ mint: MINTS.USDC, state: 'available', total: 5_000_000n }]
  const unavailable = { kind: 'unavailable', step: 'notes', detail: {} }
  const flaky = fakeNimbus({ rows, syncs: [unavailable] })
  await sendFromBalance({ nimbus: flaky, session: registered, asset: 'USDC', mint: MINTS.USDC, payout: 1n, recipient: 'R' })
  assert.deepEqual(flaky.calls.map(([name]) => name), ['sync', 'sync', 'withdraw'])
  const down = fakeNimbus({ rows, syncs: [unavailable, unavailable, unavailable] })
  await assert.rejects(sendFromBalance({ nimbus: down, session: registered, asset: 'USDC', mint: MINTS.USDC, payout: 1n, recipient: 'R' }), /could not finish reading your notes \(notes\)/)
  assert.ok(!down.calls.some(([name]) => name === 'withdraw'))
})

test('reading the Umbra v2 balance asks nothing of the wallet until this tab has unlocked it', async () => {
  globalThis.sessionStorage = memoryStorage()
  const provider = { walletStandard: { wallet: {}, account: { address: 'Wallet111' } } }
  assert.equal(await shieldedBalances({ provider, prompt: false }), null)
})
