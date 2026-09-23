import { useEffect, useRef, useState } from 'react'
import { getWallets } from '@wallet-standard/app'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'

const CHAIN = 'solana:mainnet'
const REQUIRED = ['standard:connect', 'solana:signMessage', 'solana:signTransaction']
const LAST_WALLET = 'darksol:wallet:v1'
const providers = new WeakMap()

// Wraps a Wallet Standard wallet (Phantom, Solflare, Backpack, ...) in the
// Phantom-style provider that the payment and protocol code already call.
export function standardProvider(wallet) {
  if (providers.has(wallet)) return providers.get(wallet)
  const account = () => wallet.accounts[0]
  const feature = (name) => wallet.features[name]
  const listeners = { accountChanged: new Set(), disconnect: new Set() }
  let stop = null
  const provider = {
    get publicKey() { return account() ? new PublicKey(account().address) : null },
    get isConnected() { return Boolean(account()) },
    // Umbra's SDK signs through the standard account directly.
    get walletStandard() { return account() ? { wallet, account: account() } : null },
    async connect({ silent = false } = {}) {
      await feature('standard:connect').connect({ silent })
      return { publicKey: provider.publicKey }
    },
    async disconnect() { await feature('standard:disconnect')?.disconnect() },
    async signMessage(message) {
      const [output] = await feature('solana:signMessage').signMessage({ account: account(), message })
      return { signature: output.signature }
    },
    async signTransaction(transaction) {
      const legacy = transaction.version === undefined
      const bytes = legacy ? transaction.serialize({ requireAllSignatures: false, verifySignatures: false }) : transaction.serialize()
      const [output] = await feature('solana:signTransaction').signTransaction({ account: account(), transaction: bytes, chain: CHAIN })
      return legacy ? Transaction.from(output.signedTransaction) : VersionedTransaction.deserialize(output.signedTransaction)
    },
    on(event, handler) {
      listeners[event]?.add(handler)
      stop ??= feature('standard:events')?.on('change', ({ accounts }) => {
        if (!accounts) return
        if (accounts[0]) listeners.accountChanged.forEach((listener) => listener(new PublicKey(accounts[0].address)))
        else listeners.disconnect.forEach((listener) => listener())
      })
    },
    off(event, handler) {
      listeners[event]?.delete(handler)
      if (!listeners.accountChanged.size && !listeners.disconnect.size) { stop?.(); stop = null }
    },
  }
  providers.set(wallet, provider)
  return provider
}

// Installed Solana wallets. A wallet that predates Wallet Standard is still
// reachable through the injected global.
function walletChoices() {
  const choices = getWallets().get()
    .filter((wallet) => wallet.chains.includes(CHAIN) && REQUIRED.every((name) => name in wallet.features))
    .map((wallet) => ({ name: wallet.name, icon: wallet.icon, provider: standardProvider(wallet) }))
  const injected = window.phantom?.solana || window.solana
  return choices.length || !injected ? choices : [{ name: 'Browser wallet', icon: null, provider: injected }]
}

const remembered = () => { try { return localStorage.getItem(LAST_WALLET) } catch { return null } }
const remember = (name) => { try { name ? localStorage.setItem(LAST_WALLET, name) : localStorage.removeItem(LAST_WALLET) } catch { /* Pick again next visit. */ } }

export function useWalletSession() {
  const [wallet, setWallet] = useState(null)
  const [connecting, setConnecting] = useState(false)
  // Set while the user picks between several installed wallets.
  const [picker, setPicker] = useState(null)
  const pending = useRef(null)
  const generation = useRef(0)

  // Reconnect the last wallet without a prompt; wallets may register after load.
  useEffect(() => {
    const name = remembered()
    if (!name) return
    let tried = false
    async function restore() {
      const choice = walletChoices().find((option) => option.name === name)
      if (tried || !choice) return
      tried = true
      const current = generation.current
      try {
        // `silent` is the standard flag; an injected wallet takes `onlyIfTrusted`.
        if (!choice.provider.isConnected) await choice.provider.connect({ silent: true, onlyIfTrusted: true })
        if (current === generation.current && choice.provider.publicKey) setWallet({ provider: choice.provider, address: String(choice.provider.publicKey) })
      } catch { /* Not authorized any more: Connect asks again. */ }
    }
    restore()
    return getWallets().on('register', restore)
  }, [])

  useEffect(() => {
    const provider = wallet?.provider
    if (!provider?.on) return
    const accountChanged = (publicKey) => {
      generation.current++
      setWallet(publicKey ? { provider, address: String(publicKey) } : null)
    }
    const disconnected = () => { generation.current++; setWallet(null) }
    provider.on('accountChanged', accountChanged)
    provider.on('disconnect', disconnected)
    return () => {
      provider.off?.('accountChanged', accountChanged)
      provider.off?.('disconnect', disconnected)
    }
  }, [wallet?.provider])

  // Resolves to the session, or null when the user closes the picker.
  function connectWallet() {
    if (pending.current) return pending.current
    const current = generation.current
    setConnecting(true)
    pending.current = (async () => {
      const options = walletChoices()
      if (!options.length) throw new Error('Install a Solana wallet such as Phantom or Solflare')
      const choice = options.length === 1 ? options[0] : await new Promise((resolve) => setPicker({ options, resolve }))
      if (!choice) return null
      const { provider } = choice
      const connected = await provider.connect()
      const address = String(connected?.publicKey || provider.publicKey || '')
      if (!address) throw new Error('Wallet did not provide an address')
      if (current !== generation.current || (provider.publicKey && String(provider.publicKey) !== address)) {
        throw new Error('Wallet account changed while connecting. Please try again.')
      }
      remember(choice.name)
      const session = { provider, address }
      setWallet(session)
      return session
    })().finally(() => { pending.current = null; setConnecting(false); setPicker(null) })
    return pending.current
  }

  async function disconnectWallet() {
    const provider = wallet?.provider
    generation.current++
    remember(null)
    setWallet(null)
    try { await provider?.disconnect?.() } catch { /* The local session is already cleared. */ }
  }

  return { wallet, connecting, connectWallet, disconnectWallet, picker }
}
