import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CHECK_EVERY_MS, patchConfirmationPoll } from '../protocols/privacycash/sdk-patch.js'

const FILES = ['deposit', 'withdraw', 'depositSPL', 'withdrawSPL']
const source = (name) => readFileSync(new URL(`../node_modules/privacycash/dist/${name}.js`, import.meta.url), 'utf8')

// The SDK's own confirmation loop, cut out of its file and run with a clock the
// test moves: `exists(n)` answers the n-th /utxos/check.
function runLoop(code, exists) {
  const start = code.indexOf('    let retryTimes = 0;')
  const end = code.indexOf('\n    }\n', code.indexOf('while (true) {', start)) + '\n    }\n'.length
  const loop = new Function('Date', 'setTimeout', 'fetch', 'logger', 'Buffer', 'RELAYER_API_URL', 'encryptedOutput1', 'signature', 'relayerTokenName',
    'isPartial', 'recipient', 'amount_in_lamports', 'fee_in_lamports', 'base_units', 'fee_base_units',
    `return (async () => {\n${code.slice(start, end)}\n})()`)
  let now = 1_000_000
  const delays = []
  const checks = []
  const clock = { now: () => now }
  const wait = (resolve, ms) => { delays.push(ms); now += ms; resolve() }
  const fetch = async (url) => { checks.push(url); now += 100; return { json: async () => ({ exists: exists(checks.length) }) } }
  const logger = { info() {}, debug() {} }
  const result = loop(clock, wait, fetch, logger, Buffer, 'https://relayer', new Uint8Array([1, 2]), 'sig', 'usdc', false, 'R', 1, 0, 1, 0)
  return result.then((value) => ({ value, delays, checks, elapsed: now - 1_000_000 }), (error) => { throw Object.assign(error, { delays, checks, elapsed: now - 1_000_000 }) })
}

test('the patch applies once to each confirmation loop of the pinned SDK, and fails loudly on another', () => {
  for (const name of FILES) {
    const patched = patchConfirmationPoll(source(name))
    assert.ok(patched.includes('__checkUntil'), name)
    assert.ok(!patched.includes('setTimeout(resolve, itv * 1000)'), name)
    assert.ok(!patched.includes('retryTimes >= 10'), name)
  }
  assert.throws(() => patchConfirmationPoll(source('deposit').replace('let itv = 2;', 'let itv = 3;')), /confirmation loop changed/)
  assert.throws(() => patchConfirmationPoll('export const nothing = 1'), /confirmation loop changed/)
})

test('a note already indexed is confirmed at the first check, with no sleep before it', async () => {
  for (const name of FILES) {
    const before = await runLoop(source(name), () => true)
    assert.deepEqual(before.delays, [2000], name)
    const after = await runLoop(patchConfirmationPoll(source(name)), () => true)
    assert.deepEqual(after.delays, [0], name)
    assert.equal(after.checks.length, 1)
    assert.deepEqual(after.value, before.value)
  }
})

test('a note indexed later is checked every 500 ms until it is', async () => {
  const after = await runLoop(patchConfirmationPoll(source('withdraw')), (n) => n === 4)
  assert.deepEqual(after.delays, [0, CHECK_EVERY_MS, CHECK_EVERY_MS, CHECK_EVERY_MS])
  assert.equal(after.value.tx, 'sig')
})

test('a note never indexed fails with the same error at the same deadline', async () => {
  for (const name of FILES) {
    const before = await runLoop(source(name), () => false).then(() => assert.fail('no deadline'), (error) => error)
    const after = await runLoop(patchConfirmationPoll(source(name)), () => false).then(() => assert.fail('no deadline'), (error) => error)
    assert.equal(after.message, before.message)
    assert.match(after.message, /Refresh the page/)
    // 11 sleeps of 2 s before: 22 s and the checks. The patch stops once 22 s have passed.
    assert.equal(before.checks.length, 11)
    assert.ok(after.elapsed >= 22_000 && after.elapsed <= 22_000 + CHECK_EVERY_MS + 100, `${name}: ${after.elapsed}`)
  }
})
