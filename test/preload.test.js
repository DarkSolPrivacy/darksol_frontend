import assert from 'node:assert/strict'
import test from 'node:test'
import { allowsPreload, preloadRoute } from '../src/preload.js'

test('a data-saver connection preloads nothing', async () => {
  assert.equal(allowsPreload({ saveData: true }), false)
  assert.equal(allowsPreload({ saveData: false }), true)
  assert.equal(allowsPreload(undefined), true)
  const load = async () => assert.fail('no adapter is loaded')
  assert.equal(await preloadRoute('privacycash', { load, connection: { saveData: true } }), false)
})

test('only the selected pool is preloaded, through its adapter', async () => {
  const asked = []
  const provider = { publicKey: 'wallet' }
  const load = async (id) => { asked.push(id); return { preload: async (options) => { assert.equal(options.provider, provider); return true } } }
  assert.equal(await preloadRoute('cloakc', { load, connection: {}, provider }), true)
  assert.deepEqual(asked, ['cloakc'])
  assert.equal(await preloadRoute(null, { load, connection: {} }), false)
  assert.deepEqual(asked, ['cloakc'])
})

test('a failed preload is silent', async () => {
  assert.equal(await preloadRoute('umbrav2', { load: async () => { throw new Error('chunk failed to load') }, connection: {} }), false)
  assert.equal(await preloadRoute('umbrav2', { load: async () => ({ preload: async () => { throw new Error('offline') } }), connection: {} }), false)
  assert.equal(await preloadRoute('umbrav2', { load: async () => ({ preload: async () => false }), connection: {} }), false)
  // A pool with nothing to preload.
  assert.equal(await preloadRoute('nearci', { load: async () => ({}), connection: {} }), false)
})
