import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FALLBACK_EXAMPLES, LINK_RULES, amountLead, amountMatches, candidateReason, clueTiles, depositorOf, exampleAmount, exampleLag, formatAmount, formatCount,
  formatSpan, groupCandidates, historyBehind, parseSignature, pickExamples, poolName, reasonText, REASON_TITLES, signatureOfEvent, slotSpan, sourceRows,
  traceVerdict,
} from '../src/traceability.js'

const SIG = '3Hsvq9zsWJdD6dxC6CJR479Dj6BxAhpNMiST31bxeREUv2fV3KDVx1W69C6PA3iGidJTeNjbBcvEbWRfWQJP2zjL'
const DEP = 'EzGZuMoox648jCyBUNUPXYH42q74i5isPSPHtwjqTpAMDgFiV4FUx7H9Eq6JdQ5uKYhgvjASDtw4qD325mbqsV6'
const event = (signature, outer = 2) => `9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD:6VVKJ44WTJGCksTGJHjf1kJWZaMf9Nswgj6w7Dtrw55D:T0:${signature}:${outer}`
const observation = (id, value, sources = [event(SIG)]) => ({ id, value: value === null ? null : String(value), sources })

// The 1 SOL withdrawal 3Hsvq9zs: a 1 SOL deposit 92 slots before, nothing else that minute,
// the proof built right after it, yet ranked among 28,610 wallets (its amount is round).
const report = (linkage = null) => ({
  target: { protocol: 'privacycash', slot: '452901551' },
  candidates: { items: [{ signature: DEP, slot: '452901459', createdBy: 'deposit', leafIndex: '834173' }] },
  linkage,
  observations: [
    observation('root_lag_leaves', 0, [event(DEP), event(SIG)]),
    observation('root_lag_slots', 92, [event(DEP), event(SIG)]),
    observation('deposits_net_equal_gross', 2, [event(SIG), event(DEP), event('older')]),
    observation('deposits_gross_equal_net', 0),
    observation('nearest_amount_match_slots', 92, [event(DEP), event(SIG)]),
    observation('same_size_transacts', 13),
    observation('crowding_deposits', 1, [event(SIG), event(DEP)]),
    observation('crowding_withdrawals', 0),
  ],
})
const ranked = {
  status: 'ranked', candidates: 28610, wallet: null,
  top: [{ wallet: 'W1', exact: true, match: true, lastDeposit: { signature: 'old1', slot: '367389896' } }, { wallet: 'W2', exact: true, lastDeposit: { signature: 'old2', slot: '366000000' } }],
}

test('a signature or an explorer link to one, and nothing else', () => {
  assert.equal(parseSignature(`  ${SIG}\n`), SIG)
  assert.equal(parseSignature(`https://solscan.io/tx/${SIG}?cluster=mainnet`), SIG)
  assert.equal(parseSignature(`https://explorer.solana.com/tx/${SIG}`), SIG)
  assert.equal(parseSignature(`​${SIG}﻿`), SIG, 'invisible characters from a copy are dropped')
  assert.equal(parseSignature(SIG.replace('3', '３')), SIG, 'full-width digits are normalized')
  assert.equal(parseSignature('6VVKJ44WTJGCksTGJHjf1kJWZaMf9Nswgj6w7Dtrw55D'), null, 'an address is not a signature')
  assert.equal(parseSignature(`${SIG.slice(0, -1)}0`), null, '0 is not base58')
  assert.equal(parseSignature(`https://solscan.io/tx/${SIG}0abc`), null, 'a link must end where the signature does')
  assert.equal(parseSignature('1'.repeat(88)), null, 'base58 that is not 64 bytes')
  assert.equal(parseSignature('..%2F..%2Fadmin-stats'), null)
  assert.equal(parseSignature(`../../admin-stats/${SIG}`), null)
  assert.equal(parseSignature(''), null)
  assert.equal(parseSignature(undefined), null)
})

test('spans and counts read as one unit', () => {
  assert.deepEqual([24, 600, 5 * 3600, 36528327].map(formatSpan), ['24 s', '10 min', '5 h', '423 days'])
  assert.equal(formatSpan(null), '–')
  assert.equal(formatCount('834174'), '834,174')
  assert.deepEqual([slotSpan('452901551', '452901459'), slotSpan(null, '1'), slotSpan('1', undefined)], [36.800000000000004, null, null])
  assert.equal(formatSpan(slotSpan('452901551', '452901459')), '37 s')
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

test('a same-amount deposit within a minute is the lead, with what makes it stand out', () => {
  assert.deepEqual(amountLead(report()), { signature: DEP, seconds: 36.800000000000004, alone: true, proofAfter: true })
  const busy = report()
  busy.observations = busy.observations.map((o) => o.id === 'crowding_withdrawals' ? observation(o.id, 2) : o.id === 'root_lag_leaves' ? observation(o.id, 3) : o)
  assert.deepEqual([amountLead(busy).alone, amountLead(busy).proofAfter], [false, false])
  const late = report()
  late.observations = late.observations.map((o) => o.id === 'nearest_amount_match_slots' ? observation(o.id, 151, o.sources) : o)
  assert.equal(amountLead(late), null, 'more than a minute before is no lead')
  assert.equal(amountLead({ observations: [observation('nearest_amount_match_slots', null)] }), null)
})

test('the verdict prefers a rule, then the same-amount lead, over a large anonymity set', () => {
  assert.equal(traceVerdict({ linkage: { status: 'deposit', wallet: 'w', withdrawals: [] } }), null)
  assert.deepEqual(traceVerdict({ ...report(), linkage: { status: 'linked', tier: 'strong', rule: 'exact_deposit' } }),
    { tone: 'linked', title: 'Linked to one wallet', text: LINK_RULES.exact_deposit })
  assert.equal(traceVerdict({ linkage: { status: 'linked', tier: 'likely', rule: 'root_pinned' } }).title, 'Probably linked to one wallet')
  // The misleading case: ranked among 28,610 wallets, but a 1 SOL deposit landed 37 s before.
  assert.deepEqual([traceVerdict(report(ranked)).tone, traceVerdict(report(ranked)).title], ['likely', 'Likely paid by a deposit 37 s earlier'])
  assert.deepEqual([traceVerdict({ linkage: ranked }).tone, traceVerdict({ linkage: ranked }).title], ['hidden', 'Hidden among 28,610 wallets'])
  assert.equal(traceVerdict({ linkage: { status: 'unexplained', candidates: 0 } }).title, 'No single wallet could have paid for it')
  assert.equal(traceVerdict({ linkage: { status: 'not_computed' } }).tone, 'pending')
  assert.equal(traceVerdict(report(null)).tone, 'likely', 'the lead holds without a linker')
  assert.equal(traceVerdict({ observations: [] }), null)
})

// The USDC withdrawal 635gCxWR on 2026-10-14: its 97,500 leaves sat past a 2-leaf hole at 97,492.
test('a withdrawal the stored history has not reached is fresh or waiting, not missing', () => {
  const landed = 1_791_975_000
  const behind = (blockTime) => ({
    status: 'incomplete', target: { protocol: 'privacycash', blockTime: blockTime === null ? null : String(blockTime) },
    coverage: { eventHistory: { requiredLeaves: '97500', contiguousLeaves: '97492' }, rootReconstruction: { replayedLeaves: '97492' } },
    linkage: { status: 'not_computed' },
  })
  assert.deepEqual(historyBehind(behind(landed), landed + 180), { transactions: 4, age: 180, fresh: true })
  assert.deepEqual(traceVerdict(behind(landed), landed + 180),
    { tone: 'pending', title: 'Fresh withdrawal, still being processed', text: 'It landed 3 min ago, and the pool history is still being replayed up to it. Check back in a few minutes.' })
  assert.deepEqual([traceVerdict(behind(landed), landed + 3600).title, traceVerdict(behind(landed), landed + 3600).text],
    ['Not traced yet', 'The stored pool history stops about 4 transactions before this withdrawal. It can be traced once that history is filled in.'])
  assert.equal(historyBehind(behind(null)).fresh, false, 'no block time (an older backend) never claims fresh')
  const replayOnly = behind(landed)
  replayOnly.coverage.eventHistory.contiguousLeaves = '97500'
  assert.equal(historyBehind(replayOnly, landed).transactions, 4, 'the replay lagging alone counts too')
  const reached = behind(landed)
  reached.coverage = { eventHistory: { requiredLeaves: '97488', contiguousLeaves: '97492' }, rootReconstruction: { replayedLeaves: '97492' } }
  assert.equal(historyBehind(reached), null)
  assert.equal(traceVerdict(reached).title, 'Not linked yet')
  assert.equal(historyBehind({ ...behind(landed), status: 'ready' }), null)
})

test('clue tiles flag what gives the withdrawal away', () => {
  assert.deepEqual(clueTiles(report()).map(({ id, value, flag }) => [id, value, flag]),
    [['matching', 2, false], ['deposits', 1, true], ['withdrawals', 0, true], ['size', 13, false]])
  assert.deepEqual(clueTiles({ observations: [observation('crowding_deposits', null)] }), [])
  // A quiet minute and a unique size give nothing away without a deposit to pair with.
  const quiet = ['deposits_net_equal_gross', 'deposits_gross_equal_net', 'crowding_deposits', 'crowding_withdrawals', 'same_size_transacts'].map((id) => observation(id, 0))
  assert.deepEqual(clueTiles({ observations: quiet }).map(({ flag }) => flag), [false, false, false, false])
  const rare = [observation('deposits_net_equal_gross', 1), observation('same_size_transacts', 1)]
  assert.deepEqual(clueTiles({ observations: rare }).map(({ id, flag }) => [id, flag]), [['matching', true], ['size', true]])
})

test('most likely sources put the deposit seconds before ahead of the ranked wallets', () => {
  const rows = sourceRows(report(ranked))
  assert.deepEqual(rows.map(({ signature, wallet, reasons, highlight }) => [signature, wallet, reasons, highlight]), [
    [DEP, null, ['Same-amount deposit'], true],
    ['older', null, ['Same-amount deposit'], false],
    ['old1', 'W1', ['Exact balance'], false],
    ['old2', 'W2', ['Exact balance'], false],
  ])
  assert.equal(formatSpan(rows[0].seconds), '37 s')
  assert.equal(rows[1].seconds, null, 'a match outside the loaded page has no known time')
  // Linked: the wallet's last deposit is the same-amount one, so they are one row.
  const linked = sourceRows(report({ status: 'linked', wallet: 'W0', top: [{ wallet: 'W0', match: true, lastDeposit: { signature: DEP, slot: '452901459' } }, ...ranked.top] }))
  assert.deepEqual(linked[0], { signature: DEP, wallet: 'W0', reasons: ['Linked', 'Same-amount deposit'], seconds: 36.800000000000004, highlight: true })
  assert.equal(linked.length, 4)
  // The report's related deposits give every match its time and depositor.
  const related = { ...report(ranked), related: [
    { relation: 'swap_state', signature: 'swap', slot: '1' },
    { relation: 'same_amount_deposit', signature: DEP, slot: '452901459', wallet: 'D0' },
    { relation: 'same_amount_deposit', signature: 'older', slot: '452900051', wallet: 'D1' },
  ] }
  assert.deepEqual(sourceRows(related).slice(0, 2).map(({ wallet, seconds }) => [wallet, formatSpan(seconds)]), [['D0', '37 s'], ['D1', '10 min']])
  assert.deepEqual([depositorOf(related, 'older'), depositorOf(related, 'old2'), depositorOf(related, 'swap'), depositorOf(report(), DEP)], ['D1', 'W2', null, null])
})

test('candidate reasons and amounts in the pool asset', () => {
  assert.equal(candidateReason({ exact: true, match: true }, true), 'Linked')
  assert.equal(candidateReason({ exact: true, match: true }, false), 'Exact balance')
  assert.equal(candidateReason({ match: true }), 'Same-amount deposit')
  assert.equal(candidateReason({ pair: true }), 'Completes a pair')
  assert.equal(candidateReason({}), 'Can cover it')
  assert.deepEqual(['350200000', '1966421000', '5000000000', null].map((units) => formatAmount(units)), ['0.3502 SOL', '1.9664 SOL', '5 SOL', '–'])
  const usdc = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }
  assert.deepEqual(['12340000', '7513337', '450000'].map((units) => formatAmount(units, usdc)), ['12.34 USDC', '7.51 USDC', '0.45 USDC'])
  assert.equal(formatAmount('350200000', { symbol: 'SOL', decimals: 9 }), '0.3502 SOL')
})

test('examples are off-grid withdrawals, fresh from the API or from the fallback', () => {
  for (const example of FALLBACK_EXAMPLES) {
    assert.equal(parseSignature(example.signature), example.signature)
    assert.notEqual(BigInt(example.gross) % 10_000_000n, 0n, `${exampleAmount(example)} is off the 0.01 SOL grid`)
    assert.ok(exampleLag(example) <= 60)
  }
  assert.equal(exampleAmount(FALLBACK_EXAMPLES[0]), '1.1284 SOL')
  const fresh = { protocol: 'cloakc', signature: SIG, asset: { symbol: 'USDC', decimals: 6 }, gross: '12345678', slot: '100', deposit: { signature: DEP, slot: '50' } }
  assert.equal(pickExamples(undefined, 3, () => 0.5).length, 3, 'no response: three fallback examples')
  assert.deepEqual(pickExamples([fresh, { ...fresh, signature: '../admin' }]), [fresh], 'an invalid signature is never offered')
  assert.equal(exampleLag(fresh), 20)
  const order = [0.9, 0.1, 0.5]
  assert.deepEqual(pickExamples(FALLBACK_EXAMPLES.slice(0, 3), 2, () => order.shift()).map(({ gross }) => gross), [FALLBACK_EXAMPLES[1].gross, FALLBACK_EXAMPLES[2].gross])
})

test('the pool name comes from the report, and Cloak reports get their own wording', () => {
  assert.equal(poolName({ target: { protocol: 'cloakc' }, deployment: { asset: { symbol: 'USDC', decimals: 6 } } }), 'Cloak USDC pool')
  assert.equal(poolName({ target: { protocol: 'privacycash' }, deployment: { asset: null } }), 'Privacy Cash pool')
  assert.equal(poolName({ target: { protocol: 'privacycash' }, deployment: { asset: { symbol: 'USDT', decimals: 6 } } }), 'Privacy Cash USDT pool')
  assert.equal(poolName({ target: { protocol: 'auto' }, deployment: { asset: null } }), null)
  assert.equal(reasonText(REASON_TITLES, 'cloakc', 'DEPLOYMENT_BEHAVIOUR_VERIFIED'), 'Program versions are verified by replay, not by a reproducible build.')
  assert.equal(reasonText(REASON_TITLES, 'privacycash', 'DEPLOYMENT_BEHAVIOUR_VERIFIED'), REASON_TITLES.DEPLOYMENT_BEHAVIOUR_VERIFIED)
})
