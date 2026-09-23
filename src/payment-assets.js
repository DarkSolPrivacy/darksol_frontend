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

const FIELD_MAX = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const integer = (value, max = FIELD_MAX) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < max

export function validateCheckout(invoice) {
  if (!invoice || invoice.version !== 1 || invoice.network !== 'solana-mainnet' || !Object.hasOwn(PAYMENT_ASSETS, invoice.asset)
    || !['cloakc', 'privacycash'].includes(invoice.protocol) || !/^[0-9a-f]{64}$/.test(invoice.payment_id)
    || !integer(invoice.amount, BigInt(Number.MAX_SAFE_INTEGER) + 1n) || BigInt(invoice.amount) <= 0n
    || !['pending', 'paid'].includes(invoice.status)) throw new Error('Unsupported payment invoice')
  const privacycash = invoice.protocol === 'privacycash'
  if (!Array.isArray(invoice.outputs) || invoice.outputs.length !== (privacycash ? 2 : 1)) throw new Error('Invalid payment outputs')
  for (const [index, output] of invoice.outputs.entries()) {
    if (output.amount !== (index ? '0' : invoice.amount)
      || output.mint !== paymentMint(invoice.protocol, invoice.asset)
      || !['publicKey', 'blinding', 'commitment'].every((key) => integer(output[key]))
      || BigInt(output.publicKey) === 0n || BigInt(output.commitment) === 0n
      || (privacycash && (typeof output.encryptedNote !== 'string' || !/^(?:[0-9a-f]{2}){16,4096}$/.test(output.encryptedNote)))) throw new Error('Invalid payment output')
  }
  if (new Set(invoice.outputs.map((output) => output.commitment)).size !== invoice.outputs.length) throw new Error('Duplicate payment output')
  return invoice
}
