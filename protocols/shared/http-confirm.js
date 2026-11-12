// web3.js's confirmTransaction waits on a websocket subscription. DarkSol's RPC
// proxy (/api/solana-rpc, in production and in development) has no websocket,
// so the subscription never opens, the one status check web3.js makes after it
// never runs, and confirmTransaction only ends when the transaction's blockhash
// expires: it then throws TransactionExpiredBlockheightExceededError, and an SDK
// that looks again (Cloak's does) finds the transaction landed long before.
// Measured on mainnet for a Cloak deposit: 35 s spent that way.
//
// confirmByPolling asks for the signature's status over HTTP instead, until it
// reaches the commitment asked for, and fails as web3.js does: a transaction
// that failed resolves with its error in `value.err`, and one whose blockhash
// expired without landing throws the same TransactionExpiredBlockheightExceededError.
// It waits for exactly what web3.js waits for; only the means of asking changed.
import { Connection, TransactionExpiredBlockheightExceededError } from '@solana/web3.js'

export const POLL_MS = 500
// The block height is read less often than the status: it only says when to give up.
const HEIGHT_EVERY = 4

const reached = (status, commitment) => {
  const level = status?.confirmationStatus
  if (commitment === 'processed' || commitment === 'recent') return Boolean(level)
  if (commitment === 'finalized' || commitment === 'max' || commitment === 'root') return level === 'finalized'
  return level === 'confirmed' || level === 'finalized'
}

// `strategy` is web3.js's blockhash strategy { signature, lastValidBlockHeight,
// abortSignal }. A read that fails is tried again on the next round.
export async function confirmByPolling(connection, strategy, commitment = 'confirmed', { every = POLL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const { signature, lastValidBlockHeight, abortSignal } = strategy
  for (let round = 0; ; round++) {
    abortSignal?.throwIfAborted()
    try {
      const { context, value: [status] } = await connection.getSignatureStatuses([signature])
      if (status?.err) return { context, value: { err: status.err } }
      if (reached(status, commitment)) return { context, value: { err: null } }
    } catch { /* Asked again next round. */ }
    if (round % HEIGHT_EVERY === 0) {
      let height = -1
      try { height = await connection.getBlockHeight(commitment) } catch { /* Read again next time. */ }
      if (height > lastValidBlockHeight) {
        // It may have landed since the status was read.
        const { context, value: [status] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
        if (status?.err) return { context, value: { err: status.err } }
        if (reached(status, commitment)) return { context, value: { err: null } }
        throw new TransactionExpiredBlockheightExceededError(signature)
      }
    }
    await sleep(every)
  }
}

// A Connection whose confirmTransaction polls over HTTP. Strategies other than
// a blockhash with its expiry (a durable nonce, a bare signature) go to
// web3.js's own, unchanged.
export function pollingConnection(endpoint, commitment = 'confirmed') {
  const connection = new Connection(endpoint, commitment)
  const original = connection.confirmTransaction.bind(connection)
  connection.confirmTransaction = (strategy, given) => {
    if (typeof strategy !== 'object' || strategy === null || !strategy.signature || !Number.isSafeInteger(strategy.lastValidBlockHeight) || strategy.nonceValue) return original(strategy, given)
    return confirmByPolling(connection, strategy, given ?? connection.commitment ?? 'confirmed')
  }
  return connection
}
