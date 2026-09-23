import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { randomBytes } from 'node:crypto'
import bs58 from 'bs58'
import { fileURLToPath } from 'node:url'
import { createPaymentLink, listPaymentLinks, getPaymentLink, reportPaymentDeposit, paymentLinkUrl } from '../src/payment-api.js'
import { prepareMerchantAccess, preparePaymentKeys, preparePaymentNote } from '../src/payment-notes.js'
import { payPaymentInvoice, validateCheckout } from '../src/payment-deposit.js'
import { privacyCashDepositInput } from '../src/payment-privacycash.js'
import { MINTS } from '../protocols/addresses.js'

async function owner() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKey = new PublicKey(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const messages = []
  const provider = { publicKey, isConnected: true,
    signMessage: async (message) => { messages.push(new TextDecoder().decode(message)); return new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, message)) },
    signTransaction: () => { throw new Error('Unexpected spending') },
  }
  return { provider, address: publicKey.toBase58(), messages }
}

async function draft(protocol, asset = 'SOL', amount = '0.02') {
  const wallet = await owner()
  const entries = new Map()
  const storage = { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) }
  const record = await preparePaymentNote({ ...wallet, keys: await preparePaymentKeys(wallet), index: 0, protocol, asset, amount, storage })
  const { id, ...terms } = record.invoice
  return { wallet, record, invoice: { ...terms, payment_id: id, status: 'pending' } }
}

test('merchant access is stable and stays independent of random invoice messages', async () => {
  const wallet = await owner()
  const first = await prepareMerchantAccess(wallet)
  assert.deepEqual(await prepareMerchantAccess(wallet), first)
  assert.equal(wallet.messages[0], wallet.messages[1])
  assert.notEqual(first.credential, first.merchant_id)
})

test('API calls scope credentials to merchant routes and submit only the saved record / transaction ID', async (t) => {
  const { wallet, record, invoice } = await draft('cloakc')
  const access = await prepareMerchantAccess(wallet)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options })
    return new Response(JSON.stringify({ payment_id: invoice.payment_id, payment_url: `https://darksol.app/pay/${invoice.payment_id}`, status: 'pending' }), { status: 200 })
  })
  await createPaymentLink({ record, access })
  await createPaymentLink({ record, access })
  assert.equal(requests[0].body, requests[1].body)
  assert.equal(requests[0].body, JSON.stringify(record))
  assert.equal(requests[0].body.includes(wallet.address), false)
  await listPaymentLinks({ access, offset: 50 })
  assert.equal(requests[2].headers.Authorization, `Bearer ${access.credential}`)
  await getPaymentLink(invoice.payment_id)
  const transaction = bs58.encode(randomBytes(64))
  await reportPaymentDeposit(invoice.payment_id, transaction)
  assert.equal(requests[3].headers.Authorization, undefined)
  assert.equal(requests[4].headers.Authorization, undefined)
  assert.deepEqual(JSON.parse(requests[4].body), { transaction_id: transaction })
  assert.throws(() => reportPaymentDeposit(invoice.payment_id, 'invalid'), /transaction ID/)
  assert.throws(() => paymentLinkUrl('javascript:alert(1)'), /Invalid payment URL/)
})

test('backend errors stay errors; HTML outages do not produce a successful payment', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 502 }))
  await assert.rejects(getPaymentLink('a'.repeat(64)), { status: 502 })
})

test('checkout rejects wrong networks, settled invoices and mismatched public commitments before signing', async () => {
  const { wallet, invoice } = await draft('cloakc')
  validateCheckout(invoice)
  assert.throws(() => validateCheckout({ ...invoice, network: 'solana-devnet' }), /Unsupported/)
  const options = { invoice, ...wallet, onSigned: () => { throw new Error('Unexpected signing') },
    connection: { getGenesisHash: async () => 'devnet', getBalance: async () => 1000000000 } }
  await assert.rejects(payPaymentInvoice(options), /mainnet/)
  await assert.rejects(payPaymentInvoice({ ...options, invoice: { ...invoice, status: 'paid' } }), /already paid/)
  options.connection.getGenesisHash = async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
  const corrupt = structuredClone(invoice)
  corrupt.outputs[0].commitment = '1'
  await assert.rejects(payPaymentInvoice({ ...options, invoice: corrupt }), /commitment does not match/)
  wallet.provider.publicKey = PublicKey.default
  await assert.rejects(payPaymentInvoice(options), /account changed/)
})

test('PrivacyCash proof input binds the original merchant outputs and ciphertext, with fresh dummy inputs', async () => {
  const { invoice } = await draft('privacycash')
  const first = await privacyCashDepositInput(invoice, '0')
  const second = await privacyCashDepositInput(invoice, '0')
  assert.deepEqual(first.input.outputCommitment, invoice.outputs.map((output) => output.commitment))
  assert.deepEqual(first.input.outPubkey, invoice.outputs.map((output) => output.publicKey))
  assert.equal(first.extData.encryptedOutput1.toString('hex'), invoice.outputs[0].encryptedNote)
  assert.equal(first.extData.encryptedOutput2.toString('hex'), invoice.outputs[1].encryptedNote)
  assert.deepEqual(first.input.inAmount, ['0', '0'])
  assert.notDeepEqual(first.input.inputNullifier, second.input.inputNullifier)
  const changed = structuredClone(invoice)
  changed.outputs[0].blinding = '1'
  await assert.rejects(privacyCashDepositInput(changed, '0'), /commitment does not match/)
})

test('USDC and USDT invoices carry each pool mint and asset-specific limits', async () => {
  const mainnet = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
  for (const asset of ['USDC', 'USDT']) {
    for (const protocol of ['privacycash', 'cloakc']) {
      const { wallet, invoice } = await draft(protocol, asset, '2.5')
      assert.equal(invoice.amount, '2500000')
      assert.equal(invoice.outputs[0].mint, MINTS[asset])
      validateCheckout(invoice)
      const swapped = structuredClone(invoice)
      swapped.asset = 'SOL'
      assert.throws(() => validateCheckout(swapped), /Invalid payment output/)
      const connection = { getGenesisHash: async () => mainnet, getBalance: async () => 1000000000,
        getTokenAccountBalance: async () => ({ value: { amount: '2499999' } }) }
      await assert.rejects(payPaymentInvoice({ invoice, ...wallet, connection, onSigned: () => {} }), new RegExp(`Not enough ${asset}`))
    }
  }
  const { wallet, invoice } = await draft('cloakc', 'USDC', '0.5')
  await assert.rejects(payPaymentInvoice({ invoice, ...wallet, connection: {}, onSigned: () => {} }), /minimum payment of 1 USDC/)
})

test('PrivacyCash USDC proof input uses the mint field and the fee recipient token account', async () => {
  const { getMintAddressField } = await import('../node_modules/privacycash/dist/utils/utils.js')
  const { getAssociatedTokenAddressSync } = await import('@solana/spl-token')
  const { FEE_RECIPIENT } = await import('../node_modules/privacycash/dist/utils/constants.js')
  const { invoice } = await draft('privacycash', 'USDC', '2.5')
  const { input, extData } = await privacyCashDepositInput(invoice, '0')
  assert.equal(input.mintAddress, getMintAddressField(new PublicKey(MINTS.USDC)))
  assert.deepEqual(input.outputCommitment, invoice.outputs.map((output) => output.commitment))
  assert.equal(extData.recipient, getAssociatedTokenAddressSync(new PublicKey(MINTS.USDC), FEE_RECIPIENT, true).toBase58())
})

for (const asset of ['SOL', 'USDC']) test(`PrivacyCash ${asset} invoice proof verifies using the installed SDK circuit`, { skip: !process.env.PAYMENT_PROOF_CHECK }, async (t) => {
  t.after(async () => { await globalThis.curve_bn128?.terminate() })
  const { invoice } = await draft('privacycash', asset, '2.5')
  const { input } = await privacyCashDepositInput(invoice, '0')
  const { prove } = await import('../node_modules/privacycash/dist/utils/prover.js')
  const { zKey, groth16 } = await import('snarkjs')
  const base = fileURLToPath(new URL('../public/circuit2/transaction2', import.meta.url))
  const { proof, publicSignals } = await prove(input, base, { singleThread: true })
  assert.deepEqual(publicSignals.slice(5, 7), invoice.outputs.map((output) => output.commitment))
  const key = await zKey.exportVerificationKey(base + '.zkey')
  assert.equal(await groth16.verify(key, publicSignals, proof), true)
})
