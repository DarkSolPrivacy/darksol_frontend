// The receipt shape every browser adapter returns, and the partial-failure
// convention they all share: when a deposit succeeds but the exit fails, the
// thrown Error carries `.receipt` so the UI can still show the user where their
// funds are. Previously reimplemented in each of the three client modules.

export function createReceipt({ provider, asset, depositSignature = null, ...rest }) {
  return { provider, asset, depositSignature, withdrawals: [], ...rest }
}

// Wraps `cause` in an Error that keeps the partially-completed receipt attached.
export function throwWithReceipt(receipt, message, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(`${message}: ${detail}`)
  error.receipt = receipt
  error.cause = cause
  throw error
}
