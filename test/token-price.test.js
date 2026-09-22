import test from 'node:test'
import assert from 'node:assert/strict'
import { MINTS } from '../protocols/addresses.js'
import { priceMap, usdText } from '../src/token-price.js'

test('a missing, zero or malformed quote leaves the amount unpriced', () => {
  const live = { [MINTS.SOL]: { usdPrice: 117.88691996891183 }, [MINTS.USDC]: { usdPrice: 0 }, [MINTS.USDT]: { usdPrice: 'oops' } }
  assert.deepEqual(priceMap(live, ['SOL', 'USDC', 'USDT']), { SOL: 117.88691996891183, USDC: null, USDT: null })
  assert.deepEqual(priceMap(undefined, ['SOL']), { SOL: null })
  assert.equal(usdText('1', null), '')
  assert.equal(usdText('', 117.88), '')
  assert.equal(usdText('abc', 117.88), '')
})

test('the estimate keeps cents for normal amounts and more precision for dust', () => {
  assert.equal(usdText('1', 117.88691996891183), '≈ $117.89')
  assert.equal(usdText('0.001', 117.88691996891183), '≈ $0.1179')
  assert.equal(usdText('1000', 117.88691996891183), '≈ $117,886.92')
})
