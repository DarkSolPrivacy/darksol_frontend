import { Contract, Interface, JsonRpcProvider, formatUnits, toBeHex } from 'ethers'
import { databaseStats, getSyncState, saveSyncState, storeIndexedData, storePoolSnapshot } from './db.js'

export const CURVY = Object.freeze({
  id: 'curvy',
  chain: 'arbitrum',
  chainId: 42161,
  deploymentBlock: 396_728_892,
  confirmations: 64,
  overlapBlocks: 2_400,
  vault: '0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00',
  aggregator: '0xe51924cef003a654ec9735c4d97f5d4862cbcbb1',
})

const ASSETS = Object.freeze({
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6, tokenId: 2 },
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6, tokenId: 3 },
  '0x2bcc6d6cdbbdc0a4071e48bb3b969b06b3330c07': { symbol: 'SOL', decimals: 9, tokenId: 4 },
})
const ASSETS_BY_ID = Object.freeze(Object.fromEntries(Object.entries(ASSETS).map(([address, asset]) => [asset.tokenId, { ...asset, address }])))
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const VAULT_ABI = [
  'event Transfer(address indexed from,address indexed to,uint256 token_id,uint256 amount)',
  'event Deposit(address indexed tokenAddress,address indexed to,uint256 amount)',
  'event Withdraw(address indexed tokenAddress,address indexed to,uint256 amount)',
]
const vaultInterface = new Interface(VAULT_ABI)

function rpcUrl() {
  if (!process.env.ARBITRUM_RPC_URL) throw new Error('ARBITRUM_RPC_URL is not configured')
  return process.env.ARBITRUM_RPC_URL
}

function provider() {
  return new JsonRpcProvider(rpcUrl(), CURVY.chainId, { staticNetwork: true })
}

async function transferPages(evm, fromBlock, toBlock, direction) {
  const transfers = []
  let pageKey
  let pages = 0
  do {
    const request = {
      fromBlock: toBeHex(fromBlock), toBlock: toBeHex(toBlock), category: ['erc20'],
      withMetadata: true, excludeZeroValue: true, maxCount: '0x3e8',
      contractAddresses: Object.keys(ASSETS), [direction]: CURVY.vault,
    }
    if (pageKey) request.pageKey = pageKey
    const result = await evm.send('alchemy_getAssetTransfers', [request])
    transfers.push(...(result?.transfers || []))
    pageKey = result?.pageKey
    pages += 1
  } while (pageKey)
  return { transfers, pages }
}

async function jsonRpcBatch(requests) {
  if (!requests.length) return []
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(rpcUrl(), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requests), signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`Alchemy returned HTTP ${response.status}`)
      const payload = await response.json()
      if (!Array.isArray(payload)) throw new Error('Alchemy batch response was not an array')
      const errors = payload.filter(({ error }) => error)
      if (errors.length) throw new Error(errors[0].error.message || 'Alchemy JSON-RPC batch failed')
      return payload
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolveWait) => setTimeout(resolveWait, 500 * (2 ** attempt)))
    }
  }
  throw lastError
}

async function receiptsFor(transfers) {
  const hashes = [...new Set(transfers.map(({ hash }) => hash).filter(Boolean))]
  const receipts = new Map()
  for (let offset = 0; offset < hashes.length; offset += 50) {
    const batch = hashes.slice(offset, offset + 50).map((hash, index) => ({
      jsonrpc: '2.0', id: offset + index + 1, method: 'eth_getTransactionReceipt', params: [hash],
    }))
    const responses = await jsonRpcBatch(batch)
    for (const response of responses) if (response.result?.transactionHash) receipts.set(response.result.transactionHash.toLowerCase(), response.result)
  }
  return receipts
}

function assetForEvent(parsed) {
  if (parsed.name === 'Transfer') return ASSETS_BY_ID[Number(parsed.args.token_id)] || null
  const address = String(parsed.args.tokenAddress).toLowerCase()
  return ASSETS[address] ? { ...ASSETS[address], address } : null
}

function directionForEvent(parsed) {
  if (parsed.name === 'Deposit') return 'deposit'
  if (parsed.name === 'Withdraw') return 'withdraw'
  if (parsed.name === 'Transfer' && String(parsed.args.from).toLowerCase() === ZERO_ADDRESS) return 'deposit'
  if (parsed.name === 'Transfer' && String(parsed.args.to).toLowerCase() === ZERO_ADDRESS) return 'withdraw'
  return null
}

function matchingTransfer(transfers, receipt, asset, direction, parsed, usedTransfers) {
  const hash = receipt.transactionHash.toLowerCase()
  const tokenAddress = asset.address.toLowerCase()
  const candidates = transfers.filter((transfer) => !usedTransfers.has(transfer)
    && transfer.hash?.toLowerCase() === hash
    && transfer.rawContract?.address?.toLowerCase() === tokenAddress
    && (direction === 'deposit'
      ? transfer.to?.toLowerCase() === CURVY.vault.toLowerCase()
      : transfer.from?.toLowerCase() === CURVY.vault.toLowerCase()))
  if (!candidates.length) return null

  const eventAmount = parsed.args.amount == null ? null : BigInt(parsed.args.amount)
  const eventParticipant = parsed.args.to == null ? null : String(parsed.args.to).toLowerCase()
  candidates.sort((left, right) => {
    const score = (transfer) => {
      const rawValue = transfer.rawContract?.value
      const exactAmount = rawValue != null && eventAmount != null && BigInt(rawValue) === eventAmount
      const participant = direction === 'deposit' ? transfer.from : transfer.to
      const exactParticipant = eventParticipant != null && participant?.toLowerCase() === eventParticipant
      return Number(exactAmount) * 2 + Number(exactParticipant)
    }
    return score(right) - score(left)
  })
  const match = candidates[0]
  usedTransfers.add(match)
  return match
}

function indexedRecords(transfers, receipts) {
  const byHash = new Map()
  for (const transfer of transfers) {
    const hash = transfer.hash?.toLowerCase()
    if (!hash) continue
    if (!byHash.has(hash)) byHash.set(hash, [])
    byHash.get(hash).push(transfer)
  }
  const transactions = []
  const flows = []
  for (const [hash, receipt] of receipts) {
    if (receipt.status !== '0x1') continue
    const relatedTransfers = byHash.get(hash) || []
    const timestampText = relatedTransfers.find(({ metadata }) => metadata?.blockTimestamp)?.metadata.blockTimestamp
    const blockTime = timestampText ? Math.floor(Date.parse(timestampText) / 1000) : null
    if (!blockTime) continue
    const transactionFlows = []
    // Current Vault calls can emit both legacy Transfer and newer Deposit/Withdraw
    // events for the same movement. A real ERC-20 transfer may back only one flow.
    const usedTransfers = new Set()
    for (const log of receipt.logs || []) {
      if (log.address?.toLowerCase() !== CURVY.vault.toLowerCase()) continue
      let parsed
      try { parsed = vaultInterface.parseLog({ topics: log.topics, data: log.data }) } catch { continue }
      if (!parsed) continue
      const direction = directionForEvent(parsed)
      const asset = assetForEvent(parsed)
      if (!direction || !asset) continue
      const observedTransfer = matchingTransfer(relatedTransfers, receipt, asset, direction, parsed, usedTransfers)
      if (!observedTransfer?.rawContract?.value) continue
      const amountRaw = BigInt(observedTransfer.rawContract.value)
      if (amountRaw <= 0n) continue
      const participant = direction === 'deposit'
        ? observedTransfer.from || receipt.from
        : observedTransfer.to || String(parsed.args.to || receipt.to)
      transactionFlows.push({
        id: `${receipt.transactionHash}:${Number.parseInt(log.logIndex, 16)}`,
        signature: receipt.transactionHash,
        instructionIndex: String(Number.parseInt(log.logIndex, 16)),
        timestamp: blockTime,
        participant: participant || 'unknown',
        direction,
        asset: asset.symbol,
        amountRaw: amountRaw.toString(), decimals: asset.decimals,
        amount: Number(formatUnits(amountRaw, asset.decimals)),
        flowType: direction, counterAsset: null, linkedFlowId: null,
      })
    }
    if (!transactionFlows.length) continue
    transactions.push({
      hash: receipt.transactionHash,
      blockNumber: Number.parseInt(receipt.blockNumber, 16),
      blockTime,
      chainId: CURVY.chainId,
      receipt,
    })
    flows.push(...transactionFlows)
  }
  return { transactions, flows }
}

async function poolBalances(evm, blockNumber) {
  const balances = { USDC: 0, SOL: 0, USDT: 0 }
  await Promise.all(Object.entries(ASSETS).map(async ([address, asset]) => {
    const token = new Contract(address, ['function balanceOf(address) view returns(uint256)'], evm)
    const raw = await token.balanceOf(CURVY.vault, { blockTag: blockNumber })
    balances[asset.symbol] += Number(formatUnits(raw, asset.decimals))
  }))
  return balances
}

export async function indexCurvy() {
  const evm = provider()
  const network = await evm.getNetwork()
  if (Number(network.chainId) !== CURVY.chainId) throw new Error(`ARBITRUM_RPC_URL returned chain ${network.chainId}, expected 42161`)
  const latest = await evm.getBlockNumber()
  const toBlock = Math.max(CURVY.deploymentBlock, latest - CURVY.confirmations)
  const state = getSyncState(CURVY.id)
  const previousCursor = Number(state?.chainCursor)
  const sourceIdentity = `${CURVY.chainId}:${CURVY.vault.toLowerCase()}`
  const fullHistory = state?.sourceIdentity !== sourceIdentity || !state?.historyComplete || !Number.isInteger(previousCursor)
  const fromBlock = fullHistory ? CURVY.deploymentBlock : Math.max(CURVY.deploymentBlock, previousCursor - CURVY.overlapBlocks)
  const [incoming, outgoing] = await Promise.all([
    transferPages(evm, fromBlock, toBlock, 'toAddress'),
    transferPages(evm, fromBlock, toBlock, 'fromAddress'),
  ])
  const transfers = [...incoming.transfers, ...outgoing.transfers]
  const receipts = await receiptsFor(transfers)
  const indexed = indexedRecords(transfers, receipts)
  storeIndexedData(CURVY.id, indexed.transactions, indexed.flows)
  const safeBlock = await evm.getBlock(toBlock)
  if (!safeBlock?.timestamp) throw new Error('Unable to read the confirmed Arbitrum block timestamp')
  const deploymentBlock = fullHistory ? await evm.getBlock(CURVY.deploymentBlock) : null
  const balances = await poolBalances(evm, toBlock)
  storePoolSnapshot(CURVY.id, balances, safeBlock.timestamp)
  saveSyncState(CURVY.id, {
    backfilledFrom: fullHistory ? deploymentBlock?.timestamp ?? safeBlock.timestamp : state?.backfilledFrom,
    syncedThrough: safeBlock.timestamp,
    historyComplete: true,
    chainCursor: String(toBlock),
    sourceIdentity,
  })
  return {
    protocol: CURVY.id, chain: CURVY.chain, chainId: CURVY.chainId,
    mode: fullHistory ? 'backfill' : 'incremental', fromBlock, toBlock,
    pages: incoming.pages + outgoing.pages,
    candidateTransfers: transfers.length,
    transactions: indexed.transactions.length,
    flows: indexed.flows.length,
    snapshot: balances,
    storage: databaseStats(CURVY.id),
  }
}
