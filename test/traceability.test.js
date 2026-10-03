import assert from 'node:assert/strict'
import test from 'node:test'
import { amountMatches, formatCount, formatSpan, groupCandidates, parseSignature, signatureOfEvent } from '../src/traceability.js'

const SIG = '3Hsvq9zsWJdD6dxC6CJR479Dj6BxAhpNMiST31bxeREUv2fV3KDVx1W69C6PA3iGidJTeNjbBcvEbWRfWQJP2zjL'
const event = (signature, outer = 2) => `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD:6VVKJ44WTJGCksTGJHjf1kJWZaMf9Nswgj6w7Dtrw55D:T0:${signature}:${outer}`

test('a signature or an explorer link to one', () => {
  assert.equal(parseSignature(`  ${SIG}\n`), SIG)
  assert.equal(parseSignature(`https://solscan.io/tx/${SIG}?cluster=mainnet`), SIG)
  assert.equal(parseSignature(`https://explorer.solana.com/tx/${SIG}`), SIG)
  assert.equal(parseSignature('6VVKJ44WTJGCksTGJHjf1kJWZaMf9Nswgj6w7Dtrw55D'), null, 'an address is not a signature')
  assert.equal(parseSignature(`${SIG.slice(0, -1)}0`), null, '0 is not base58')
  assert.equal(parseSignature(''), null)
})

test('spans and counts read as one unit', () => {
  assert.deepEqual([24, 600, 5 * 3600, 36528327].map(formatSpan), ['24 s', '10 min', '5 h', '423 days'])
  assert.equal(formatSpan(null), '–')
  assert.equal(formatCount('834174'), '834,174')
})

test('amount matches skip the target and read signatures from event ids', () => {
  assert.equal(signatureOfEvent(event('abc')), 'abc')
  const observations = [
    { id: 'deposits_net_equal_gross', sources: [event(SIG), event('dep1'), event('dep2')] },
    { id: 'deposits_gross_equal_net', sources: [event(SIG), event('dep2'), event('dep3')] },
    { id: 'same_size_transacts', sources: [event(SIG), event('other')] },
  ]
  assert.deepEqual([...amountMatches(observations)], ['dep1', 'dep2', 'dep3'])
})

test('candidate leaves group by the transaction that created them, across pages', () => {
  const leaf = (leafIndex, signature) => ({ leafIndex, signature, slot: '10', createdBy: 'deposit' })
  const first = groupCandidates([leaf('9', 'a'), leaf('8', 'a'), leaf('7', 'b')])
  assert.deepEqual(first.map(({ signature, leaves }) => [signature, leaves]), [['a', ['9', '8']], ['b', ['7']]])
  const both = groupCandidates([leaf('6', 'b'), leaf('5', 'c')], first)
  assert.deepEqual(both.map(({ signature, leaves }) => [signature, leaves]), [['a', ['9', '8']], ['b', ['7', '6']], ['c', ['5']]])
  assert.deepEqual(first[1].leaves, ['7'], 'the earlier page is not mutated')
})
