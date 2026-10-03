import assert from 'node:assert/strict'
import test from 'node:test'
import { LINK_RULES, amountMatches, candidateReason, formatAmount, formatCount, formatSpan, groupCandidates, linkVerdict, parseSignature, poolName, reasonText, REASON_TITLES, secondsBetween, signatureOfEvent } from '../src/traceability.js'

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

test('a linkage reads as what an observer concludes', () => {
  assert.equal(linkVerdict(null), null)
  assert.equal(linkVerdict({ status: 'deposit', wallet: 'w', withdrawals: [] }), null)
  assert.deepEqual(linkVerdict({ status: 'linked', tier: 'strong', rule: 'exact_deposit' }),
    { tone: 'linked', title: 'Linked to one wallet', text: LINK_RULES.exact_deposit })
  assert.equal(linkVerdict({ status: 'linked', tier: 'likely', rule: 'root_pinned' }).title, 'Probably linked to one wallet')
  assert.deepEqual([linkVerdict({ status: 'ranked', candidates: 1234 }).tone, linkVerdict({ status: 'ranked', candidates: 1234 }).title], ['hidden', 'Hidden among 1,234 wallets'])
  assert.equal(linkVerdict({ status: 'unexplained', candidates: 0 }).title, 'No single wallet could have paid for it')
  assert.equal(linkVerdict({ status: 'not_computed' }).tone, 'pending')
})

test('candidate reasons, SOL amounts and block-time spans', () => {
  assert.equal(candidateReason({ exact: true, match: true }, true), 'Linked')
  assert.equal(candidateReason({ exact: true, match: true }, false), 'Exact balance')
  assert.equal(candidateReason({ match: true }), 'Same-amount deposit')
  assert.equal(candidateReason({ pair: true }), 'Completes a pair')
  assert.equal(candidateReason({}), 'Can cover it')
  assert.deepEqual(['350200000', '1966421000', '5000000000', null].map((units) => formatAmount(units)), ['0.3502 SOL', '1.9664 SOL', '5 SOL', '–'])
  const usdc = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }
  assert.deepEqual(['12340000', '7513337', '450000'].map((units) => formatAmount(units, usdc)), ['12.34 USDC', '7.51 USDC', '0.45 USDC'])
  assert.equal(formatAmount('350200000', { symbol: 'SOL', decimals: 9 }), '0.3502 SOL')
  assert.deepEqual([secondsBetween('1790000077', '1790000000'), secondsBetween(null, '1'), secondsBetween('1', undefined)], [77, null, null])
})

test('the pool name comes from the report, and Cloak reports get their own wording', () => {
  assert.equal(poolName({ target: { protocol: 'cloakc' }, deployment: { asset: { symbol: 'USDC', decimals: 6 } } }), 'Cloak USDC pool')
  assert.equal(poolName({ target: { protocol: 'privacycash' }, deployment: { asset: null } }), 'Privacy Cash pool')
  assert.equal(poolName({ target: { protocol: 'auto' }, deployment: { asset: null } }), null)
  assert.equal(reasonText(REASON_TITLES, 'cloakc', 'DEPLOYMENT_BEHAVIOUR_VERIFIED'), 'Program versions are verified by replay, not by a reproducible build.')
  assert.equal(reasonText(REASON_TITLES, 'privacycash', 'DEPLOYMENT_BEHAVIOUR_VERIFIED'), REASON_TITLES.DEPLOYMENT_BEHAVIOUR_VERIFIED)
})
