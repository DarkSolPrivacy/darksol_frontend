// NEAR Confidential Intents in the browser (darksol-backend docs/NEAR_CI.md and
// NEAR_INTENTS.md), new for the NEAR Hackathon (November 2026). A send is two
// 1Click swaps through DarkSol's API (/api/near-intents, which adds the partner
// key and keeps nothing):
//   shield    the wallet pays 1Click's one-time Solana deposit address; 1Click
//             bridges it and credits the user's confidential account on intents.near
//   unshield  1Click builds a transfer out of that account to a new deposit
//             address; this tab checks it and signs it with the account key; 1Click
//             withdraws to the recipient on Solana, less its fee (about $0.01)
// Between them the money is a private balance, which can wait and stay partly
// unspent (keep), or pay later sends (from shielded).
//
// The account key is derived from a wallet signature (account.js) and kept in
// this tab's sessionStorage only; the server sees the signed payloads.
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { MINTS } from '../addresses.js'
import { createReceipt, throwWithReceipt } from '../shared/receipts.js'
import { TOKEN_DECIMALS } from '../shared/units.js'
import { KEY_MESSAGE, accountFromSeed, loginPayload, seedFromSignature } from './account.js'
import { checkUnshieldIntent, TOKENS } from './intent.js'

const API = '/api/near-intents'
const STATUS_EVERY_MS = 5000
const STATUS_TIMEOUT_MS = 20 * 60_000
const SESSION_MS = 10 * 60_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rpcConnection = () => new Connection(import.meta.env.VITE_SOLANA_RPC_URL || new URL('/api/solana-rpc', window.location.origin).toString(), 'confirmed')
const seedKey = (address) => `darksol/nearci/seed/${address}`
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const fromHex = (text) => Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16))

// One send or read at a time: two sessions would race for the same balance.
let queue = Promise.resolve()
function exclusive(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

async function api(path, { method = 'GET', body, token } = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    // The API holds a visitor to three NEAR Intents calls a second.
    if (response.status === 429 && attempt < 5) { await sleep(1100); continue }
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch { json = { error: text.slice(0, 200) } }
    if (!response.ok) throw Object.assign(new Error(`NEAR Intents: ${json.message || json.error || `HTTP ${response.status}`}`), { status: response.status })
    return json
  }
}

const walletAddress = (provider) => provider?.publicKey?.toBase58?.() ?? null
function cachedSeed(address) {
  try { const value = sessionStorage.getItem(seedKey(address)); return value ? fromHex(value) : null } catch { return null }
}

// The account of the connected wallet: from this tab's key, or (when `prompt`)
// after the wallet signs the key message. Null when it would have to ask.
async function openAccount(provider, { prompt = true } = {}) {
  const address = walletAddress(provider)
  if (!address) throw new Error('Connect a Solana wallet')
  let seed = cachedSeed(address)
  if (!seed) {
    if (!prompt) return null
    if (typeof provider.signMessage !== 'function') throw new Error('This wallet cannot sign messages, which the NEAR Confidential Intents key needs')
    const { signature } = await provider.signMessage(KEY_MESSAGE)
    if (walletAddress(provider) !== address) throw new Error('Wallet account changed while signing')
    seed = seedFromSignature(signature)
    try { sessionStorage.setItem(seedKey(address), toHex(seed)) } catch {}
  }
  return accountFromSeed(seed)
}

// 1Click's session token for the account (a signed login), reused for ten minutes.
const sessions = new Map()
async function session(account, { fresh = false } = {}) {
  const kept = sessions.get(account.id)
  if (!fresh && kept && Date.now() - kept.at < SESSION_MS) return kept.token
  const { salt } = await api('/salt')
  const payload = loginPayload({ id: account.id, salt, nowMs: Date.now(), random: crypto.getRandomValues(new Uint8Array(7)) })
  const { accessToken } = await api('/auth', { method: 'POST', body: { signedData: account.signedData(payload) } })
  if (!accessToken) throw new Error('NEAR Intents: the login gave no session')
  sessions.set(account.id, { token: accessToken, at: Date.now() })
  return accessToken
}

async function readBalances(account) {
  let reply
  try {
    reply = await api('/balances', { token: await session(account) })
  } catch (error) {
    if (error.status !== 401) throw error
    reply = await api('/balances', { token: await session(account, { fresh: true }) })
  }
  const balances = { SOL: 0n, USDC: 0n, USDT: 0n }
  for (const row of reply.balances ?? []) {
    const asset = Object.keys(TOKENS).find((key) => TOKENS[key] === row.tokenId)
    if (asset && /^\d+$/.test(String(row.available ?? ''))) balances[asset] += BigInt(row.available)
  }
  return balances
}

// Polls 1Click until the swap of `depositAddress` ends; throws unless it succeeded.
async function settle(depositAddress, onStatus, label) {
  const started = Date.now()
  for (;;) {
    const status = await api(`/status?depositAddress=${encodeURIComponent(depositAddress)}`).catch((error) => ({ status: 'UNKNOWN', error }))
    if (status.status === 'SUCCESS') return status
    if (['REFUNDED', 'FAILED'].includes(status.status)) throw new Error(`${label} ${status.status === 'REFUNDED' ? 'was refunded' : 'failed'} (1Click status ${status.status})`)
    if (Date.now() - started > STATUS_TIMEOUT_MS) throw new Error(`${label} did not finish within 20 minutes; it may still complete. Check your private balance later.`)
    onStatus(`${label}… ${Math.round((Date.now() - started) / 1000)} s (usually about a minute)`)
    await sleep(STATUS_EVERY_MS)
  }
}

const deadline = () => new Date(Date.now() + 3_600_000).toISOString()

// Polls the signature: DarkSol's RPC proxy has no websocket, which web3.js's
// confirmTransaction waits on (it then reports a landed transaction as expired).
async function landed(connection, signature, lastValidBlockHeight) {
  for (;;) {
    const { value: [status] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    if (status?.err) throw new Error(`The deposit failed on Solana: ${JSON.stringify(status.err)}`)
    if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) return
    if (await connection.getBlockHeight('confirmed') > lastValidBlockHeight) {
      // Expired unless it landed in the meantime.
      const { value: [last] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      if (['confirmed', 'finalized'].includes(last?.confirmationStatus) && !last.err) return
      throw new Error('The deposit expired before it landed; nothing left your wallet. Try again.')
    }
    await sleep(1500)
  }
}

// Pays `units` of `asset` from the wallet into the account; resolves once 1Click credited it.
async function shield({ provider, account, asset, units, onStatus }) {
  const wallet = provider.publicKey
  const { quote } = await api('/quote', { method: 'POST', body: {
    mode: 'shield', dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 50, originAsset: TOKENS[asset], destinationAsset: TOKENS[asset],
    amount: String(units), recipient: account.id, refundTo: wallet.toBase58(), deadline: deadline(),
  } })
  if (!quote?.depositAddress || String(quote.amountIn) !== String(units)) throw new Error('NEAR Intents: the shield quote does not match the payment')
  const depositAddress = new PublicKey(quote.depositAddress)
  const transaction = new Transaction()
  if (asset === 'SOL') {
    transaction.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: depositAddress, lamports: BigInt(units) }))
  } else {
    const mint = new PublicKey(MINTS[asset])
    const source = getAssociatedTokenAddressSync(mint, wallet)
    const target = getAssociatedTokenAddressSync(mint, depositAddress, true)
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(wallet, target, depositAddress, mint),
      createTransferCheckedInstruction(source, mint, target, wallet, BigInt(units), TOKEN_DECIMALS[asset]),
    )
  }
  const connection = rpcConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  transaction.feePayer = wallet
  transaction.recentBlockhash = blockhash
  onStatus('Approve the deposit in your wallet…')
  const signed = await provider.signTransaction(transaction)
  const signature = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 5 })
  onStatus('Waiting for the deposit to confirm…')
  await landed(connection, signature, lastValidBlockHeight)
  // Tells 1Click about it so it need not wait to notice; best effort.
  await api('/deposit', { method: 'POST', body: { txHash: signature, depositAddress: quote.depositAddress } }).catch(() => {})
  await settle(quote.depositAddress, onStatus, 'Shielding into NEAR Confidential Intents')
  return { signature, depositAddress: quote.depositAddress }
}

// Pays `units` of `asset` out of the account to `recipient` (the recipient gets them less 1Click's fee).
async function unshield({ account, asset, units, recipient, onStatus }) {
  onStatus('Asking 1Click for the withdrawal…')
  const { quote } = await api('/quote', { method: 'POST', body: {
    mode: 'unshield', dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 50, originAsset: TOKENS[asset], destinationAsset: TOKENS[asset],
    amount: String(units), recipient, refundTo: account.id, deadline: deadline(),
  } })
  if (!quote?.depositAddress || String(quote.amountIn) !== String(units) || !(BigInt(quote.amountOut ?? 0) > 0n)) throw new Error('NEAR Intents: the withdrawal quote does not match the payment')
  const { intent } = await api('/intent', { method: 'POST', body: { signerId: account.id, depositAddress: quote.depositAddress } })
  const payload = typeof intent?.payload === 'string' ? intent.payload : JSON.stringify(intent?.payload)
  // Signs nothing but this exact transfer.
  checkUnshieldIntent(payload, { signer: account.id, receiver: quote.depositAddress, asset, units })
  onStatus('Signing the withdrawal with your NEAR Confidential Intents key…')
  await api('/intent/submit', { method: 'POST', body: { signedData: account.signedData(payload) } })
  const status = await settle(quote.depositAddress, onStatus, 'Paying the recipient from your private balance')
  return { amountOut: String(status.swapDetails?.amountOut ?? quote.amountOut), signature: status.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null }
}

/**
 * A send: `source: 'wallet'` shields `totalBaseUnits` first (more than the
 * payment when keeping part private), `'shielded'` pays from the private
 * balance. No recipients: shield only (a payment that waits).
 */
async function send({ provider, asset, recipients = [], totalBaseUnits, source = 'wallet', onStatus = () => {} }) {
  if (!TOKENS[asset]) throw new Error(`NEAR Confidential Intents does not send ${asset}`)
  if (recipients.length > 1) throw new Error('NEAR Confidential Intents pays one recipient per send')
  const account = await openAccount(provider, { prompt: true })
  const receipt = createReceipt({ provider: 'nearci', asset, account: account.id })
  if (source === 'wallet') {
    const shielded = await shield({ provider, account, asset, units: BigInt(totalBaseUnits), onStatus })
    receipt.depositSignature = shielded.signature
  }
  if (!recipients.length) return receipt
  const [recipient] = recipients
  try {
    const paid = await unshield({ account, asset, units: BigInt(recipient.baseUnits), recipient: recipient.publicKey.toBase58?.() ?? String(recipient.publicKey), onStatus })
    // `tx`: the Solana payout, which the receipt links to.
    receipt.withdrawals.push({ recipient: recipient.publicKey.toBase58?.() ?? String(recipient.publicKey), amount: paid.amountOut, tx: paid.signature })
    return receipt
  } catch (error) {
    if (receipt.depositSignature) throwWithReceipt(receipt, 'Shielded into your private balance, but the payment did not go out', error)
    throw error
  }
}

/** Asks the wallet for the key message alone, so balance reads after it ask nothing. */
export async function unlockShielded({ provider }) {
  await openAccount(provider, { prompt: true })
}

/** The private balance per asset, in base units. With `prompt: false`, null until this tab has the key. */
export async function shieldedBalances({ provider, prompt = true, signal, onStatus = () => {} }) {
  const account = await openAccount(provider, { prompt })
  if (!account) return null
  return exclusive(async () => {
    signal?.throwIfAborted()
    onStatus('Reading your NEAR Confidential Intents balance…')
    const balances = await readBalances(account)
    return { balances, spendable: { ...balances }, account: account.id }
  })
}

export async function execute({ kind, ...options }) {
  if (kind === 'send') return exclusive(() => send(options))
  throw new Error(`NEAR Confidential Intents has no browser ${kind} flow`)
}
