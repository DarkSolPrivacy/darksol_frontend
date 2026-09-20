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
