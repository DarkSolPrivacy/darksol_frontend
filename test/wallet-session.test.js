import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { noWalletLinks, standardProvider } from '../src/wallet-session.js'

test('with no wallet, a phone opens this very page inside a wallet app; a computer gets where to install one', () => {
  const page = 'https://darksol.app/pay/abc?x=1#top'
  const iphone = noWalletLinks(page, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')
  assert.equal(iphone.phone, true)
  assert.deepEqual(iphone.links.map((link) => link.href), [
    'https://phantom.app/ul/browse/https%3A%2F%2Fdarksol.app%2Fpay%2Fabc%3Fx%3D1%23top?ref=https%3A%2F%2Fdarksol.app',
    'https://solflare.com/ul/v1/browse/https%3A%2F%2Fdarksol.app%2Fpay%2Fabc%3Fx%3D1%23top?ref=https%3A%2F%2Fdarksol.app'])
  // iPadOS asks for desktop pages as a Mac; only touch gives it away.
  assert.equal(noWalletLinks(page, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5).phone, true)
  const desktop = noWalletLinks(page, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36', 0)
  assert.equal(desktop.phone, false)
  assert.deepEqual(desktop.links.map((link) => link.href), ['https://phantom.com/download', 'https://solflare.com/download'])
})

// A Wallet Standard wallet that signs with a local keypair, as Solflare or Phantom would.
function fakeWallet() {
  const signer = Keypair.generate()
  const account = { address: signer.publicKey.toBase58(), publicKey: signer.publicKey.toBytes() }
  const listeners = []
  const wallet = {
    name: 'Fake', icon: 'data:image/svg+xml;base64,', chains: ['solana:mainnet'], accounts: [],
    features: {
      'standard:connect': { connect: async () => { wallet.accounts = [account]; return { accounts: wallet.accounts } } },
      'standard:disconnect': { disconnect: async () => { wallet.accounts = [] } },
      'standard:events': { on: (_event, listener) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1) } },
      'solana:signMessage': { signMessage: async ({ message }) => [{ signedMessage: message, signature: new Uint8Array(64).fill(7) }] },
      'solana:signTransaction': { signTransaction: async ({ transaction, chain }) => {
        assert.equal(chain, 'solana:mainnet')
        try { const tx = VersionedTransaction.deserialize(transaction); tx.sign([signer]); return [{ signedTransaction: tx.serialize() }] }
        catch { const tx = Transaction.from(transaction); tx.partialSign(signer); return [{ signedTransaction: tx.serialize({ requireAllSignatures: false }) }] }
      } },
    },
  }
  return { wallet, signer, emit: (accounts) => listeners.forEach((listener) => listener({ accounts })) }
}

test('a Wallet Standard wallet behaves like the injected provider the app signs with', async () => {
  const { wallet, signer, emit } = fakeWallet()
  const provider = standardProvider(wallet)
  assert.equal(standardProvider(wallet), provider)
  assert.equal(provider.isConnected, false)
  assert.equal(String((await provider.connect()).publicKey), signer.publicKey.toBase58())
  assert.equal(provider.walletStandard.account.address, signer.publicKey.toBase58())
  assert.deepEqual((await provider.signMessage(new Uint8Array([1]), 'utf8')).signature, new Uint8Array(64).fill(7))

  const instruction = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })
  const blockhash = Keypair.generate().publicKey.toBase58()
  const versioned = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: [instruction] }).compileToV0Message())
  const signed = await provider.signTransaction(versioned)
  assert.ok(signed instanceof VersionedTransaction)
  assert.deepEqual(signed.message.serialize(), versioned.message.serialize())
  assert.ok(signed.signatures[0].some((byte) => byte !== 0))

  const legacy = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash }).add(instruction)
  const signedLegacy = await provider.signTransaction(legacy)
  assert.equal(signedLegacy.version, undefined)
  assert.ok(signedLegacy.verifySignatures())

  const changes = []
  const onChange = (publicKey) => changes.push(String(publicKey))
  const onDisconnect = () => changes.push('disconnected')
  provider.on('accountChanged', onChange)
  provider.on('disconnect', onDisconnect)
  const next = Keypair.generate().publicKey.toBase58()
  emit([{ address: next }])
  emit([])
  assert.deepEqual(changes, [next, 'disconnected'])
  provider.off('accountChanged', onChange)
  provider.off('disconnect', onDisconnect)
  emit([])
  assert.equal(changes.length, 2)
})
