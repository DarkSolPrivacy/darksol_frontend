import assert from 'node:assert/strict'
import test from 'node:test'
import { PublicKey } from '@solana/web3.js'
import { preparePaymentNote, recoverPaymentNote, readPaymentDrafts } from '../src/payment-notes.js'

function storage() {
  const entries = new Map()
  return {
    get length() { return entries.size },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  }
}

async function wallet() {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKey = new PublicKey(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
  const messages = []
  const provider = {
    publicKey, isConnected: true,
    async signMessage(message) {
      messages.push(new TextDecoder().decode(message))
      return { signature: new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, message)) }
    },
    signTransaction() { throw new Error('Note preparation must not sign transactions') },
  }
  return { provider, address: publicKey.toBase58(), messages }
}

for (const protocol of ['privacycash', 'cloakc']) {
  test(`${protocol}: prepare, encrypt, and recover a merchant note with the real SDK`, async () => {
    const owner = await wallet()
    const local = storage()
    const record = await preparePaymentNote({ ...owner, protocol, amount: '0.02', reference: 'Order 1', storage: local })
    assert.equal(owner.messages.length, 1)
    assert.match(owner.messages[0], /^DarkSol private payment link\n/)
    assert.equal(record.invoice.amount, '20000000')
    assert.equal(record.invoice.outputs.length, protocol === 'privacycash' ? 2 : 1)
    assert.equal(record.invoice.outputs[0].amount, '20000000')
    assert.equal(JSON.stringify(record).includes(owner.address), false)
    assert.equal(/privateKey|spendingKey|"signature"/.test(JSON.stringify(record)), false)

    // A payer can reconstruct the commitment from public invoice fields only.
    if (protocol === 'privacycash') {
      const [{ WasmFactory }, { Utxo }] = await Promise.all([
        import('@lightprotocol/hasher.rs'), import('../node_modules/privacycash/dist/models/utxo.js'),
      ])
      const lightWasm = await WasmFactory.getInstance()
      for (const output of record.invoice.outputs) {
        const publicNote = new Utxo({
          lightWasm, amount: output.amount, blinding: output.blinding,
          mintAddress: output.mint, keypair: { pubkey: output.publicKey },
        })
        assert.equal(publicNote.getCommitment().toString(), output.commitment)
      }
      assert.equal(record.invoice.outputs[1].amount, '0')
      assert.notEqual(record.invoice.outputs[0].blinding, record.invoice.outputs[1].blinding)
    } else {
      const sdk = await import('@cloak.dev/sdk')
      const output = record.invoice.outputs[0]
      const commitment = await sdk.computeUtxoCommitment({
        amount: BigInt(output.amount), blinding: BigInt(output.blinding),
        mintAddress: new PublicKey(output.mint),
        keypair: { publicKey: BigInt(output.publicKey), privateKey: 0n },
      })
      assert.equal(commitment.toString(), output.commitment)
    }
    assert.equal(readPaymentDrafts(local, owner.address).length, 1)
    const recovered = await recoverPaymentNote({ ...owner, record })
    assert.equal(owner.messages[0], owner.messages[1])
    assert.equal(recovered.fundedIndex, null)
    assert.equal(recovered.notes[0].amount.toString(), '20000000')
    const spendingKey = recovered.notes[0].keypair.privateKey ?? recovered.notes[0].keypair.privkey
    assert.ok(BigInt(spendingKey.toString()) > 0n)

    const second = await preparePaymentNote({ ...owner, protocol, amount: '0.02', storage: local })
    assert.notEqual(record.invoice.id, second.invoice.id)
    assert.notEqual(record.invoice.outputs[0].commitment, second.invoice.outputs[0].commitment)
    assert.notEqual(record.invoice.outputs[0].publicKey, second.invoice.outputs[0].publicKey)
    assert.equal(readPaymentDrafts(local, owner.address).length, 2)

    const stranger = await wallet()
    assert.equal(readPaymentDrafts(local, stranger.address).length, 0)
    await assert.rejects(recoverPaymentNote({ ...stranger, record }))
    const modified = structuredClone(record)
    modified.invoice.outputs[0].commitment = '1'
    await assert.rejects(recoverPaymentNote({ ...owner, record: modified }))
    const forgedMessage = { ...record, signingMessage: 'Sign another message' }
    const approvals = owner.messages.length
    await assert.rejects(recoverPaymentNote({ ...owner, record: forgedMessage }), /Invalid payment recovery/)
    assert.equal(owner.messages.length, approvals)
  })
}

test('reject invalid inputs, rejected signatures, changed accounts, and cancelled work without saving', async () => {
  const owner = await wallet()
  const local = storage()
  const options = { ...owner, protocol: 'cloakc', amount: '0.02', storage: local }
  await assert.rejects(preparePaymentNote({ ...options, amount: '-1' }))
  await assert.rejects(preparePaymentNote({ ...options, protocol: 'unknown' }))
  assert.equal(owner.messages.length, 0)
  owner.provider.signMessage = async () => { throw new Error('User rejected request') }
  await assert.rejects(preparePaymentNote(options), /User rejected/)
  owner.provider.signMessage = async () => { owner.provider.publicKey = PublicKey.default; return new Uint8Array(64) }
  await assert.rejects(preparePaymentNote(options), /account changed/)
  const other = await wallet()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(preparePaymentNote({ ...options, ...other, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(other.messages.length, 0)
  assert.equal(local.length, 0)
})

test('invalid signatures and storage failures never report a prepared draft', async () => {
  const owner = await wallet()
  const local = storage()
  const sign = owner.provider.signMessage
  owner.provider.signMessage = async () => new Uint8Array(64)
  await assert.rejects(preparePaymentNote({ ...owner, protocol: 'cloakc', amount: '0.02', storage: local }), /verified/)
  owner.provider.signMessage = sign
  local.setItem = () => { throw new Error('Storage quota exceeded') }
  await assert.rejects(preparePaymentNote({ ...owner, protocol: 'cloakc', amount: '0.02', storage: local }), /quota/)
  assert.equal(local.length, 0)
})
