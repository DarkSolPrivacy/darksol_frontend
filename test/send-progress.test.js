import assert from 'node:assert/strict'
import test from 'node:test'
import { reportProgress } from '../protocols/privacycash/browser.js'

function statusesFor(lines) {
  const seen = []
  let log = () => {}
  reportProgress({ setLogger: (fn) => { log = fn } }, (message) => seen.push(message))
  for (const [level, message] of lines) log(level, message)
  return seen
}

test('SDK logs become live send status', () => {
  assert.deepEqual(statusesFor([
    ['debug', ' ####fetch_utxo_offset 400'],
    ['debug', 'got utxo data'],
    ['debug', 'Found 7 total UTXOs for usdc'],
    ['info', 'generating ZK proof...'],
    ['error', 'boom'],
  ]), ['Scanning notes 400…', 'Loaded 7 notes…', 'Generating ZK proof…'])
})

import { CEILING, START, awaitsWallet, nextProgress } from '../src/send-progress.js'

const run = (steps) => steps.reduce((bar, [text, hint]) => nextProgress(bar, text, hint), null)

test('the bar follows the hints an adapter sends, easing over each step', () => {
  const bar = run([['Preparing Umbra v2…', { to: 0.03, seconds: 3 }], ['Proving the Umbra v2 deposit, up to a minute…', { to: 0.42, seconds: 45 }]])
  assert.equal(bar.to, 0.42)
  assert.equal(bar.seconds, 45)
})

test('the bar never moves back, and only a finished payment fills it', () => {
  // A retried payout reports its stages again from the start.
  assert.equal(run([['Sending privately…', { to: 0.9, seconds: 8 }], ['Proving the private transfer…', { to: 0.75, seconds: 30 }]]).to, 0.9)
  assert.ok(run([['Done', { to: 1.5, seconds: 1 }]]).to < 1)
})

test('without hints each new step moves the bar part of the way, never past the ceiling', () => {
  const lines = ['Preparing privacy tools…', 'Checking balance…', 'Generating ZK proof…', 'Approve deposit in your wallet…', 'Sending…', 'Waiting for the pool to index your change…']
  let bar = null
  let last = 0
  for (const line of lines) {
    bar = nextProgress(bar, line)
    assert.ok(bar.to > last, line)
    last = bar.to
  }
  assert.ok(bar.to < CEILING)
  assert.ok(nextProgress(null, 'Sending…').to > START.to)
})

test('lines that differ only in numbers are one step', () => {
  const scanning = run([['Scanning notes 400…'], ['Scanning notes 800…'], ['Scanning notes 1,200…']])
  assert.equal(scanning.to, nextProgress(null, 'Scanning notes 400…').to)
  assert.equal(run([['Reading your private balance… (page 1)'], ['Reading your private balance… (page 2)']]).to, nextProgress(null, 'Reading your private balance… (page 1)').to)
})

test('a wallet prompt is told apart', () => {
  assert.equal(awaitsWallet('Approve the Umbra v2 deposit in your wallet…'), true)
  assert.equal(awaitsWallet('Approve deposit in your wallet…'), true)
  assert.equal(awaitsWallet('Proving the Umbra v2 deposit, up to a minute…'), false)
  assert.equal(awaitsWallet(''), false)
})

test('Umbra v2 reports a mark for every step of a send', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../protocols/umbrav2/browser.js', import.meta.url), 'utf8')
  // Every status line of a send carries a hint. Without one: an earlier swap
  // being finished, and the balance read, which is no send.
  const bare = [...source.matchAll(/(?:onStatus|paying|moving)\((['`][^'`]*['`])\)/g)].map((match) => match[1])
  assert.deepEqual(bare, ["'Finishing your earlier swap…'", "'Reading your private balance…'"])
})
