// What a DarkSol unshield may sign (darksol-backend docs/NEAR_INTENTS.md). Pure.
// 1Click's generate-intent returns the payload; it is signed only if it is the
// one transfer the quote described, so neither 1Click nor DarkSol's API can get
// a different transfer signed. The shape, from the 2026-11-08 test:
//   { verifying_contract: 'intents.far', signer_id, deadline, nonce,
//     intents: [{ intent: 'transfer', receiver_id: <deposit address>,
//                 tokens: { 'imt:<Treasury>:<token id>': '<amount>' } }] }

export const TREASURY = '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'
/** The tokens a DarkSol send can shield, as 1Click names them on intents.near. */
export const TOKENS = Object.freeze({
  SOL: 'nep141:sol.omft.near',
  USDC: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  USDT: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
})
const CONTRACTS = ['intents.far', 'intents.near']
const MAX_DEADLINE_MS = 7 * 86_400_000

/** Throws unless `payload` transfers exactly `units` of `asset` from `signer` to `receiver`. */
export function checkUnshieldIntent(payload, { signer, receiver, asset, units, now = Date.now() }) {
  let intent
  try { intent = JSON.parse(payload) } catch { throw new Error('NEAR Intents: the withdrawal to sign is not JSON') }
  const fail = (why) => { throw new Error(`NEAR Intents: refusing to sign the withdrawal (${why})`) }
  if (!CONTRACTS.includes(intent?.verifying_contract)) fail('unknown contract')
  if (intent.signer_id !== signer) fail('another signer')
  const ends = Date.parse(intent.deadline)
  if (!(ends > now) || ends - now > MAX_DEADLINE_MS) fail('deadline')
  if (!Array.isArray(intent.intents) || intent.intents.length !== 1) fail('not one transfer')
  const [transfer] = intent.intents
  if (transfer?.intent !== 'transfer' || transfer.receiver_id !== receiver) fail('another receiver')
  const tokens = Object.entries(transfer.tokens ?? {})
  if (tokens.length !== 1) fail('not one token')
  const [[token, amount]] = tokens
  if (token !== `imt:${TREASURY}:${TOKENS[asset]}` && token !== TOKENS[asset]) fail('another token')
  if (String(amount) !== String(units)) fail('another amount')
  return intent
}
