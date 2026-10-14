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
export function explainFailure(message) {
  if (/403|access forbidden/i.test(message)) return 'Solana RPC access was denied. Check the server RPC configuration.'
  if (!NO_ANSWER.test(message)) return message
  const step = message.replace(NO_ANSWER, '').replace(/[:\s]+$/, '')
  // web3.js: "failed to get balance of account …: TypeError: Failed to fetch".
  if (/^failed to /i.test(step)) return `Could not reach the Solana network (${step.replace(/^failed to /i, '')}). Check your connection and try again.`
  if (step) return `${step}: no answer from the network.`
  return 'A request got no answer: the connection dropped or a service is down. Check your connection and try again.'
}
