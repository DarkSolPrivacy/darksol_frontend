// Keep this browser contract in sync with darksol-backend/src/merchant-identity.js.
export const MERCHANT_IDENTITY_MESSAGE = [
  'DarkSol merchant access',
  'Version: 1',
  'App: darksol.app',
  'Purpose: derive merchant identity and API access only.',
  'This is not a payment note recovery message. Keep this signature private.',
].join('\n')

export const MERCHANT_ID_DOMAIN = 'DarkSol merchant identity v1\n'
const encoder = new TextEncoder()
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export async function deriveMerchantAccess(signature) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('Invalid merchant signature')
  const material = await crypto.subtle.importKey('raw', signature, 'HKDF', false, ['deriveBits'])
  const credential = hex(new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('DarkSol merchant access v1'),
    info: encoder.encode('api-bearer-credential'),
  }, material, 256)))
  const merchant_id = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(MERCHANT_ID_DOMAIN + credential))))
  return { merchant_id, credential }
}
