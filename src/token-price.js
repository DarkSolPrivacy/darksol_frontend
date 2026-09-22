import { useEffect, useState } from 'react'
import { MINTS } from '../protocols/addresses.js'

// Jupiter's free tier needs no key and already backs the swap quotes in
// protocols/shared/jupiter.js. Indicative display only: what a transfer or a
// payment actually settles at is decided on-chain, not here.
const ENDPOINT = 'https://lite-api.jup.ag/price/v3'

export function priceMap(data, assets) {
  return Object.fromEntries(assets.map((asset) => {
    const price = Number(data?.[MINTS[asset]]?.usdPrice)
    return [asset, Number.isFinite(price) && price > 0 ? price : null]
  }))
}

export function usdText(amount, price) {
  const value = Number(amount) * price
  if (!price || !Number.isFinite(value) || value <= 0) return ''
  return `≈ ${Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value)}`
}

export function useUsdPrices(assets) {
  const ids = assets.map((asset) => MINTS[asset]).join(',')
  const [prices, setPrices] = useState({})
  useEffect(() => {
    const controller = new AbortController()
    let timer
    async function load() {
      try {
        const response = await fetch(`${ENDPOINT}?ids=${ids}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`Jupiter price failed with HTTP ${response.status}`)
        const data = await response.json()
        if (!controller.signal.aborted) setPrices(priceMap(data, assets))
      } catch { /* An unpriced amount simply hides its estimate. */ }
      if (!controller.signal.aborted) timer = setTimeout(load, 60000)
    }
    load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [ids])
  return prices
}
