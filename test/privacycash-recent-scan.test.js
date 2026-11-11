import assert from 'node:assert/strict'
import test from 'node:test'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { MINTS } from '../protocols/addresses.js'
import {
  LSK_ENCRYPTED_OUTPUTS, LSK_FETCH_OFFSET, RECENT_NOTES, coversRecentOnly, scanKeys, scanOlderNotes, scanRecentFirst, treeSize,
} from '../protocols/privacycash/recent-scan.js'

const memory = (entries = {}) => {
  const map = new Map(Object.entries(entries))
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }
}
const keys = { offset: 'fetch_offsetKEY', outputs: 'encrypted_outputsKEY', history: 'tradeHistoryKEY' }

test('the storage keys are the SDK\'s own: the wallet for SOL, its token account for a token', async () => {
  const constants = await import('../node_modules/privacycash/dist/utils/constants.js')
  assert.equal(LSK_FETCH_OFFSET, constants.LSK_FETCH_OFFSET)
  assert.equal(LSK_ENCRYPTED_OUTPUTS, constants.LSK_ENCRYPTED_OUTPUTS)
  const { localstorageKey } = await import('privacycash/utils')
  const wallet = Keypair.generate().publicKey
  assert.equal(scanKeys(localstorageKey, wallet, 'SOL').offset, LSK_FETCH_OFFSET + localstorageKey(wallet))
  const account = getAssociatedTokenAddressSync(new PublicKey(MINTS.USDC), wallet)
  assert.equal(scanKeys(localstorageKey, wallet.toBase58(), 'USDC').offset, LSK_FETCH_OFFSET + localstorageKey(account))
  assert.equal(scanKeys(localstorageKey, wallet, 'USDC').outputs, LSK_ENCRYPTED_OUTPUTS + localstorageKey(account))
})

test('the tree size comes from the relayer\'s merkle root, by token', async () => {
  const asked = []
  const fetcher = async (url) => { asked.push(url); return new Response(JSON.stringify({ root: '1', nextIndex: 895_848 })) }
  assert.equal(await treeSize('SOL', fetcher), 895_848)
  assert.equal(await treeSize('USDC', fetcher), 895_848)
  assert.deepEqual(asked, ['https://api3.privacycash.org/merkle/root', 'https://api3.privacycash.org/merkle/root?token=usdc'])
  await assert.rejects(treeSize('SOL', async () => new Response('{}', { status: 502 })), /502/)
  await assert.rejects(treeSize('SOL', async () => new Response('{"root":"1"}')), /nextIndex/)
})

test('a first scan starts at the last 100,000 notes and says the balance is recent-only', async () => {
  const storage = memory()
  const scanned = []
  const start = await scanRecentFirst({ keys, storage, size: async () => 895_848, scan: async (offset) => { scanned.push(offset); storage.setItem(keys.offset, '895848') } })
  assert.equal(RECENT_NOTES, 100_000)
  assert.equal(start, 795_848)
  assert.deepEqual(scanned, [795_848])
  assert.equal(coversRecentOnly(keys, storage), true)
  // Done: the next call finds the position and does nothing.
  assert.equal(await scanRecentFirst({ keys, storage, size: async () => assert.fail('no size read'), scan: async () => assert.fail('no scan') }), null)
  assert.equal(storage.getItem(keys.offset), '895848')
})

test('a saved position is never moved', async () => {
  for (const position of ['0', '40', '500000', '895848']) {
    const storage = memory({ [keys.offset]: position })
    assert.equal(await scanRecentFirst({ keys, storage, size: async () => assert.fail('no size read'), scan: async () => assert.fail('no scan') }), null)
    assert.equal(storage.getItem(keys.offset), position)
    assert.equal(coversRecentOnly(keys, storage), false)
    assert.equal(storage.map.size, 1)
  }
  // Another tab scanned while the size was read.
  const storage = memory()
  const size = async () => { storage.setItem(keys.offset, '12'); return 895_848 }
  assert.equal(await scanRecentFirst({ keys, storage, size, scan: async () => assert.fail('no scan') }), null)
  assert.equal(storage.getItem(keys.offset), '12')
})

test('a small tree or an unreadable size leaves the SDK\'s scan from note 0', async () => {
  for (const size of [async () => 100_000, async () => 8_800, async () => { throw new Error('relayer down') }]) {
    const storage = memory()
    assert.equal(await scanRecentFirst({ keys, storage, size, scan: async () => assert.fail('no scan') }), null)
    assert.equal(storage.map.size, 0)
  }
})

test('a first scan that was cut short starts over instead of resuming past what it found', async () => {
  const storage = memory()
  // Two pages in, the connection drops: the SDK has saved its position, not its notes.
  await assert.rejects(scanRecentFirst({ keys, storage, size: async () => 895_848, scan: async () => { storage.setItem(keys.offset, '835848'); throw new Error('Failed to fetch') } }), /Failed to fetch/)
  assert.equal(storage.getItem(keys.offset), '835848')
  const scanned = []
  const start = await scanRecentFirst({ keys, storage, size: async () => assert.fail('the first start is kept'), scan: async (offset) => { scanned.push([offset, storage.getItem(keys.offset)]); storage.setItem(keys.offset, '900000') } })
  assert.equal(start, 795_848)
  // From the same start, with the unfinished scan's position gone.
  assert.deepEqual(scanned, [[795_848, null]])
  assert.equal(coversRecentOnly(keys, storage), true)
  assert.equal(await scanRecentFirst({ keys, storage, size: async () => assert.fail('done'), scan: async () => assert.fail('done') }), null)
})

test('the full rescan adds older notes to the cache and leaves the SDK\'s position alone', async () => {
  const storage = memory({ [keys.offset]: '895848', [keys.outputs]: JSON.stringify(['recent-note']), 'darksol-pc-recent-from:fetch_offsetKEY': '795848' })
  const found = await scanOlderNotes({ keys, storage, scan: async (shadow) => {
    assert.equal(shadow.getItem(keys.offset), null)
    shadow.setItem(keys.offset, '895900')
    shadow.setItem(keys.outputs, JSON.stringify(['old-note', 'recent-note']))
    shadow.setItem(keys.history, '1,2')
  } })
  assert.equal(found, true)
  assert.equal(storage.getItem(keys.offset), '895848')
  assert.deepEqual(JSON.parse(storage.getItem(keys.outputs)), ['recent-note', 'old-note'])
  assert.equal(coversRecentOnly(keys, storage), false)
  // Nothing of the rescan's own is left, and a second one has nothing to do.
  assert.deepEqual([...storage.map.keys()].sort(), [keys.offset, keys.outputs].sort())
  assert.equal(await scanOlderNotes({ keys, storage, scan: async () => assert.fail('no scan') }), false)
})

test('an interrupted full rescan changes nothing and starts over', async () => {
  const before = { [keys.offset]: '895848', [keys.outputs]: JSON.stringify(['recent-note']), 'darksol-pc-recent-from:fetch_offsetKEY': '795848' }
  const storage = memory(before)
  await assert.rejects(scanOlderNotes({ keys, storage, scan: async (shadow) => { shadow.setItem(keys.offset, '400000'); throw new Error('aborted') } }), /aborted/)
  assert.deepEqual(Object.fromEntries(storage.map), before)
  assert.equal(coversRecentOnly(keys, storage), true)
  await scanOlderNotes({ keys, storage, scan: async (shadow) => { assert.equal(shadow.getItem(keys.offset), null); shadow.setItem(keys.outputs, '[]') } })
  assert.equal(coversRecentOnly(keys, storage), false)
})

// The real SDK against a relayer that holds 100 notes, 20 a page: the wallet's
// are note 10 (older than the window) and note 85.
test('with the SDK: the window finds the recent note, later scans start at the tip, the rescan finds the old one', async (t) => {
  const [{ WasmFactory }, { EncryptionService, getUtxos, localstorageKey }, { Utxo }, { Keypair: UtxoKeypair }] = await Promise.all([
    import('@lightprotocol/hasher.rs'), import('privacycash/utils'),
    import('../node_modules/privacycash/dist/models/utxo.js'), import('../node_modules/privacycash/dist/models/keypair.js'),
  ])
  const lightWasm = await WasmFactory.getInstance()
  const encryptionService = new EncryptionService()
  encryptionService.deriveEncryptionKeyFromSignature(Keypair.generate().secretKey)
  const keypair = new UtxoKeypair(encryptionService.getUtxoPrivateKeyV2(), lightWasm)
  const note = (amount, index) => Buffer.from(encryptionService.encryptUtxo(new Utxo({ lightWasm, amount: String(amount), keypair, index }))).toString('hex')
  const tree = Array.from({ length: 100 }, (_, index) => 'ab'.repeat(80) + index.toString(16).padStart(4, '0'))
  tree[10] = note(7_000_000, 10)
  tree[85] = note(20_000_000, 85)
  const starts = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const { pathname, searchParams } = new URL(String(url))
    if (pathname === '/merkle/root') return new Response(JSON.stringify({ root: '1', nextIndex: tree.length }))
    if (pathname === '/utxos/range') {
      const start = Number(searchParams.get('start'))
      starts.push(start)
      return new Response(JSON.stringify({ encrypted_outputs: tree.slice(start, start + 20), hasMore: start + 20 < tree.length, total: tree.length }))
    }
    if (pathname === '/utxos/indices') return new Response(JSON.stringify({ indices: JSON.parse(init.body).encrypted_outputs.map((output) => tree.indexOf(output)) }))
    throw new Error(`Unexpected request ${url}`)
  })
  const publicKey = Keypair.generate().publicKey
  const connection = { getMultipleAccountsInfo: async (accounts) => accounts.map(() => null) }
  const storage = memory()
  const common = { publicKey, connection, encryptionService, storage }
  const scanKeysOf = scanKeys(localstorageKey, publicKey, 'SOL')
  const amounts = (utxos) => utxos.map((utxo) => Number(utxo.amount.toString())).sort((a, b) => a - b)

  const start = await scanRecentFirst({ keys: scanKeysOf, storage, size: () => treeSize('SOL'), scan: (offset) => getUtxos({ ...common, offset }), recent: 30 })
  assert.equal(start, 70)
  assert.deepEqual(starts.splice(0), [70, 90])
  assert.equal(storage.getItem(scanKeysOf.offset), '100')

  // What deposit() and withdraw() do: a scan with no offset, from the saved position.
  assert.deepEqual(amounts(await getUtxos(common)), [20_000_000])
  assert.deepEqual(starts.splice(0), [100])
  assert.equal(coversRecentOnly(scanKeysOf, storage), true)

  assert.equal(await scanOlderNotes({ keys: scanKeysOf, storage, scan: (shadow) => getUtxos({ ...common, storage: shadow }) }), true)
  assert.deepEqual(starts.splice(0), [0, 20, 40, 60, 80])
  assert.equal(storage.getItem(scanKeysOf.offset), '100')
  assert.equal(coversRecentOnly(scanKeysOf, storage), false)
  assert.deepEqual(amounts(await getUtxos(common)), [7_000_000, 20_000_000])
  assert.deepEqual(starts.splice(0), [100])
})
