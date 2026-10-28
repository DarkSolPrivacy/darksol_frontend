import assert from 'node:assert/strict'
import test from 'node:test'
import { outsideSummary, privacyTiles, ruleRows, share } from '../src/pool-privacy.js'

// A day of /api/pool-privacy (backend docs/POOL_PRIVACY.md).
const STATS = {
  protocol: 'privacycash', span: '1d', withdrawals: 590, deposits: 373,
  oneToOne: { total: 61, strong: 22, weak: 39, withinSeconds: 120 },
  lone: { total: 48, withinSeconds: 60 },
  linker: {
    checked: 580, strong: 70, likely: 5,
    rules: { self_relay: 2, same_address: 30, only_feasible: 0, exact_balance: 9, exact_deposit: 29, pair_sum: 0, root_pinned: 5, unexplained: 1 },
    candidates: { median: 1240, buckets: { 1: 0, '2-10': 12, '11-100': 40, '101-1000': 110, '1001+': 343 } },
  },
  outside24h: { withdrawals: 590, checked: 410, linked: 23, shared: 2, clean: 300, busy: 60, self: 25, pending: 180 },
}

test('a share is a percentage with sensible precision, and a dash over nothing', () => {
  assert.equal(share(61, 590), '10%')
  assert.equal(share(23, 410), '5.6%')
  assert.equal(share(1, 5000), '<0.1%')
  assert.equal(share(0, 590), '0%')
  assert.equal(share(3, 0), '—')
})

test('the headline tiles read the strongest-candidate, same-amount, lone and anonymity-set counts', () => {
  assert.deepEqual(privacyTiles(STATS).map(({ label, value, note }) => [label, value, note]), [
    ['Strongest candidate found', '12%', '70 of 580'],
    ['Same amount just before', '10%', '61 of 590'],
    ['Only deposit that minute', '8.1%', '48 of 590'],
    ['Wallets that could have paid', '1,240', 'for a typical withdrawal'],
  ])
  const unchecked = privacyTiles({ ...STATS, linker: { ...STATS.linker, checked: 0, strong: 0, likely: 0, candidates: { median: null, buckets: {} } } })
  assert.deepEqual([0, 3].map((index) => [unchecked[index].value, unchecked[index].note]), [['—', 'Not checked yet'], ['—', 'for a typical withdrawal']])
})

test('rules are listed largest first, empty ones dropped, the unexplained last', () => {
  assert.deepEqual(ruleRows(STATS).map(({ rule, count, width }) => [rule, count, Math.round(width)]), [
    ['same_address', 30, 100], ['exact_deposit', 29, 97], ['exact_balance', 9, 30], ['root_pinned', 5, 17], ['self_relay', 2, 7], ['unexplained', 1, 3],
  ])
})

test('the outside scan reads as a share of checked recipients, with only the non-empty parts', () => {
  const summary = outsideSummary(STATS.outside24h)
  assert.equal(summary.value, '5.6%')
  assert.equal(summary.note, '23 of 410 recipients paid or were paid by a deposit wallet')
  assert.deepEqual(summary.parts.map(({ key }) => key), ['linked', 'clean', 'busy', 'self', 'shared', 'pending'])
  const empty = outsideSummary({ withdrawals: 3, checked: 0, linked: 0, shared: 0, clean: 0, busy: 0, self: 0, pending: 3 })
  assert.deepEqual([empty.value, empty.note, empty.parts.map(({ key }) => key)], ['—', 'No recipient checked yet', ['pending']])
})
