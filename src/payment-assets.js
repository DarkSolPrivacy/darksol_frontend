import { MINTS } from '../protocols/addresses.js'

// PrivacyCash notes carry the System program id as SOL's mint; Cloak uses wrapped SOL.
// `token` is PrivacyCash's relayer name for the SPL tree; SOL has the default tree.
export const PAYMENT_ASSETS = Object.freeze({
  SOL: { decimals: 9, pcMint: '11111111111111111111111111111112', cloakMint: MINTS.SOL, token: null, cloakMin: 10000000n },
  USDC: { decimals: 6, pcMint: MINTS.USDC, cloakMint: MINTS.USDC, token: 'usdc', cloakMin: 1000000n },
  USDT: { decimals: 6, pcMint: MINTS.USDT, cloakMint: MINTS.USDT, token: 'usdt', cloakMin: 1000000n },
})

export const paymentMint = (protocol, asset) => PAYMENT_ASSETS[asset][protocol === 'privacycash' ? 'pcMint' : 'cloakMint']
export const assetAmount = (units, asset) => Number(units) / 10 ** PAYMENT_ASSETS[asset].decimals
export const cloakMinimum = (asset) => `${assetAmount(PAYMENT_ASSETS[asset].cloakMin, asset)} ${asset}`
