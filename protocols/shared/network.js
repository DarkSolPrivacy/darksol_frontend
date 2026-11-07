// What a browser throws for a request that got no answer at all: Chrome's
// "Failed to fetch", Firefox's "NetworkError when attempting to fetch
// resource." and Safari's "Load failed". Being offline, a dropped connection,
// a blocked request and a gateway error without CORS headers all read the same.
const NO_ANSWER = /(?:TypeError: )?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)\s*$/

/** True for a fetch that never got a response, whatever the browser calls it. */
export const isNoAnswer = (error) => error instanceof TypeError && NO_ANSWER.test(error.message)

/**
 * A failure message a payer can act on. A bare "Failed to fetch" says neither
 * what was being reached nor what to do; whatever a message says before it
 * (web3.js names its RPC call, our wrappers say what already went through) is kept.
 */
// A wallet that cannot pay the network fee, as Umbra v2's SDK says it before
// anything is signed (two wordings), and as Solana itself refuses the
// transaction. A wallet with no SOL has no account at all.
const UMBRA_NO_ACCOUNT = /has no account on the cluster, so Solana would refuse it as AccountNotFound; it needs (\d+) lamports/
const UMBRA_TOO_FEW = /the connected wallet holds (\d+) lamports and paying for this flow's transactions requires (\d+)/
const NO_FEE_SOL = /no record of a prior credit|insufficient lamports|insufficient ?funds ?for ?fee|AccountNotFound/i
// Phantom's code 4100: the account selected in the wallet has not connected this
// site, typically after switching accounts in the wallet.
const WALLET_UNAUTHORIZED = /has not been authorized by the user/i

const solText = (lamports) => `${(Math.ceil(Number(lamports) / 1000) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL`
export const NO_SOL_MESSAGE = 'This wallet has no SOL for network fees. Every private payment pays a small Solana fee in SOL, and a first one also pays some one-time account rent. Add about 0.01 SOL to this wallet, then try again.'

export function explainFailure(message) {
  const noAccount = message.match(UMBRA_NO_ACCOUNT)
  if (noAccount) return `This wallet has no SOL for network fees: this step needs ${solText(noAccount[1])}. Add a little more than that (a first private payment also pays one-time account rent; about 0.01 SOL covers it), then try again.`
  const tooFew = message.match(UMBRA_TOO_FEW)
  if (tooFew) return `Not enough SOL for network fees: this step needs ${solText(tooFew[2])} and the wallet has ${solText(tooFew[1])}. Add a little SOL, then try again.`
  if (NO_FEE_SOL.test(message)) return 'Not enough SOL to pay the network fee. Add a little SOL to this wallet (about 0.01 SOL), then try again.'
  if (WALLET_UNAUTHORIZED.test(message)) return 'Your wallet refused to sign: this site is not connected for the account now selected in the wallet. Open the wallet and switch to the account shown at the top right of this page (or disconnect here and connect the one you want), then try again.'
  if (/\b403\b|access forbidden/i.test(message)) return 'Solana RPC access was denied. Check the server RPC configuration.'
  if (!NO_ANSWER.test(message)) return message
  const step = message.replace(NO_ANSWER, '').replace(/[:\s]+$/, '')
  // web3.js: "failed to get balance of account …: TypeError: Failed to fetch".
  if (/^failed to /i.test(step)) return `Could not reach the Solana network (${step.replace(/^failed to /i, '')}). Check your connection and try again.`
  if (step) return `${step}: no answer from the network.`
  return 'A request got no answer: the connection dropped or a service is down. Check your connection and try again.'
}
