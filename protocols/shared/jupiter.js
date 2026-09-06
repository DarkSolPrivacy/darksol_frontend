// One Jupiter quote helper.
//
// The same fetch-and-validate existed twice, in scripts/protocols/cloak.ts and
// in server/app.js's /api/swap-quote, and the two had already diverged in which
// response fields they checked. Cloak and PrivacyCash both settle through
// Jupiter, so this is shared rather than protocol-owned.
//
// Uses global fetch only, so it runs unchanged in the browser, the server and
// the tsx CLI.
import { ENDPOINTS, MINTS } from '../addresses.js'

export const DEFAULT_SLIPPAGE_BPS = 100

function mintFor(asset) {
  // Callers pass either a symbol ('USDC') or an already-resolved mint address.
  const symbol = String(asset || '').toUpperCase()
  if (MINTS[symbol]) return MINTS[symbol]
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(asset))) return String(asset)
  throw new Error(`Unsupported swap asset: ${asset}`)
}

// Returns the normalized quote plus `raw`, because Cloak's CLI records the full
// route plan in its receipt while the browser only needs the bounds.
export async function quoteJupiter({ inputAsset, outputAsset, amount, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const inputMint = mintFor(inputAsset)
  const outputMint = mintFor(outputAsset)
  const requested = String(amount)
  if (!/^\d+$/.test(requested) || BigInt(requested) <= 0n) {
    throw new Error('amount must be positive integer base units')
  }

  const url = new URL(ENDPOINTS.jupiterQuote)
  url.search = new URLSearchParams({
    inputMint, outputMint, amount: requested,
    slippageBps: String(slippageBps), restrictIntermediateTokens: 'true',
  }).toString()

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Jupiter quote failed with HTTP ${response.status}`)
  const quote = await response.json()

  // Jupiter is quoted immediately before a proof is built around its output
  // bound, so a quote for a different route or amount must never pass through.
  if (quote.inputMint !== inputMint || quote.outputMint !== outputMint
    || quote.inAmount !== requested
    || !/^\d+$/.test(quote.outAmount || '')
    || !/^\d+$/.test(quote.otherAmountThreshold || '')) {
    throw new Error('Jupiter returned a quote for an unexpected route or amount')
  }

  return {
    inputMint, outputMint,
    inputBaseUnits: quote.inAmount,
    expectedOutputBaseUnits: quote.outAmount,
    minimumOutputBaseUnits: quote.otherAmountThreshold,
    priceImpactPct: quote.priceImpactPct,
    routeLabels: quote.routePlan?.map((leg) => leg.swapInfo?.label).filter(Boolean) || [],
    route: quote.routePlan?.map((leg) => ({
      ammKey: leg.swapInfo?.ammKey, label: leg.swapInfo?.label,
      inputMint: leg.swapInfo?.inputMint, outputMint: leg.swapInfo?.outputMint,
      inAmount: leg.swapInfo?.inAmount, outAmount: leg.swapInfo?.outAmount,
      percent: leg.percent,
    })) || [],
    raw: quote,
  }
}
