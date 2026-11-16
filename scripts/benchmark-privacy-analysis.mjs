// Local CPU benchmark; needs the sibling backend checkout. No database/network.
// node scripts/benchmark-privacy-analysis.mjs
import assert from 'node:assert/strict'
import { serialize, deserialize } from 'node:v8'
import { createSimulator } from '../../darksol-backend/server/forensics/privacy-sim.js'
import { prepareAnalysis } from '../../darksol-backend/server/forensics/privacy-analysis.js'
import { preparedSimulation } from '../src/privacy-analysis.js'

let seed = 7
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const rows = [], balances = new Map()
const relayer = 'benchmark-relayer'
for (let i = 0; i < 24000; i++) {
  const blockTime = 1_000_000 + i * 450
  let direction, signer, recipient, amount
  if (random() < 0.55 || !balances.size) {
    direction = 'deposit'; signer = `wallet-${Math.floor(random() * 80)}`; recipient = null
    amount = [7, 10, 25, 30, 50, 100, 250, 1000, 1200][Math.floor(random() * 9)] * 1e6
    balances.set(signer, (balances.get(signer) ?? 0) + amount)
  } else {
    const [wallet, balance] = [...balances][Math.floor(random() * balances.size)]
    direction = 'withdraw'; signer = relayer; recipient = `recipient-${i}`
    amount = random() < 0.4 ? balance : Math.max(1, Math.floor(balance * (0.2 + random() * 0.6)))
    if (amount === balance) balances.delete(wallet); else balances.set(wallet, balance - amount)
  }
  rows.push({ seq: String(i), signature: String(i), n: i * 2, direction, signer, recipient, net: String(amount), gross: String(amount), slot: blockTime * 2.5, blockTime, k: null })
}
const options = { pool: { protocol: 'privacycash', asset: 'USDC', relayers: [relayer] } }
let started = performance.now()
const sim = createSimulator(options)
sim.append(rows)
const buildMs = performance.now() - started
const bytes = serialize(sim.checkpoint())
started = performance.now()
const restored = createSimulator({ ...options, checkpoint: deserialize(bytes) })
const restoreMs = performance.now() - started
const generation = await prepareAnalysis({ protocol: 'privacycash', asset: 'USDC', sim, source: { revision: 'benchmark', through: sim.through },
  solUsd: 100, amounts: [6, 28, 90, 1000].map((x) => x * 1e6), budgetMs: Infinity })
const table = { model: 'privacy-analysis/1', asset: 'USDC', pools: { privacycash: generation } }
const samples = []
for (const amount of [6, 28, 90, 1000]) {
  const request = { asset: 'USDC', amount: String(amount), recipients: 1, maxWait: '24h' }
  const entry = generation.entries[String(amount * 1e6)]
  const input = { x: amount * 1e6, solUsd: 100, waits: generation.waits, amountMode: 'gross', keepNet: true,
    strategies: ['exact', 'keep', 'balance'], balanceNowOnly: true, deposits: entry.cells.filter((c) => c.strategy === 'keep' && c.wait === 'now').map((c) => Number(c.deposit)) }
  const lookup = preparedSimulation(table, request)
  assert.deepEqual(lookup.pools.privacycash.cells, sim.simulate(input))
  assert.deepEqual(restored.simulate(input), sim.simulate(input))
  started = performance.now()
  for (let i = 0; i < 5; i++) sim.simulate(input)
  const simulationMs = (performance.now() - started) / 5
  started = performance.now()
  for (let i = 0; i < 10000; i++) preparedSimulation(table, request)
  const lookupMs = (performance.now() - started) / 10000
  samples.push({ amount, simulationMs: +simulationMs.toFixed(3), lookupMs: +lookupMs.toFixed(4) })
}
console.log(JSON.stringify({ rows: rows.length, buildMs: +buildMs.toFixed(1), restoreMs: +restoreMs.toFixed(1),
  checkpointMB: +(bytes.length / 1024 ** 2).toFixed(2), tableKB: +(Buffer.byteLength(JSON.stringify(table)) / 1024).toFixed(1),
  rssMB: +(process.memoryUsage().rss / 1024 ** 2).toFixed(1), samples }, null, 2))
