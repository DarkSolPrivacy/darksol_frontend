import { useEffect, useRef, useState } from 'react'

const injectedWallet = () => window.phantom?.solana || window.solana

export function useWalletSession() {
  const [wallet, setWallet] = useState(() => {
    const provider = injectedWallet()
    return provider?.isConnected && provider.publicKey ? { provider, address: String(provider.publicKey) } : null
  })
  const [connecting, setConnecting] = useState(false)
  const pending = useRef(null)
  const generation = useRef(0)

  useEffect(() => {
    const provider = wallet?.provider || injectedWallet()
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

  function connectWallet() {
    if (pending.current) return pending.current
    const provider = injectedWallet()
    const current = generation.current
    setConnecting(true)
    pending.current = (async () => {
      if (!provider?.connect) throw new Error('Install Phantom or another compatible Solana wallet')
      const connected = await provider.connect()
      const address = String(connected?.publicKey || provider.publicKey || '')
      if (!address) throw new Error('Wallet did not provide an address')
      if (current !== generation.current || (provider.publicKey && String(provider.publicKey) !== address)) {
        throw new Error('Wallet account changed while connecting. Please try again.')
      }
      const session = { provider, address }
      setWallet(session)
      return session
    })().finally(() => { pending.current = null; setConnecting(false) })
    return pending.current
  }

  async function disconnectWallet() {
    const provider = wallet?.provider
    generation.current++
    setWallet(null)
    try { await provider?.disconnect?.() } catch { /* The local session is already cleared. */ }
  }

  return { wallet, connecting, connectWallet, disconnectWallet }
}
