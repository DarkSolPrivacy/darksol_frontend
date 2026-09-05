import test from 'node:test'
import assert from 'node:assert/strict'
import { listProtocols } from '../protocols/registry.js'
import { loadCli, loadCommands, loadIndexer } from '../protocols/load.js'

// A manifest's `modules` block is a promise about what the folder contains, and
// the UI greys out routes based on it without attempting an import. These tests
// make the promise checkable, so a protocol cannot claim a capability it has not
// implemented -- the failure mode a plain registry lookup would only surface at
// runtime, in front of a user holding a funded wallet.

for (const manifest of listProtocols()) {
  const { id, modules, indexer, extensionCommands } = manifest

  if (modules.indexer) {
    test(`${id} ships the indexer module it declares`, async () => {
      const module = await loadIndexer(id)
      assert.equal(module.lane, indexer.lane, 'module lane must match the manifest')
      if (indexer.lane === 'solana') {
        assert.equal(typeof module.decode, 'function', 'a Solana lane needs decode()')
      } else {
        assert.equal(typeof module.run, 'function', 'an EVM lane needs run()')
      }
    })
  }

  if (modules.cli) {
    test(`${id} ships the CLI capabilities it declares`, async () => {
      const module = await loadCli(id)
      for (const fn of ['snapshot', 'balance', 'deposit', 'send']) {
        assert.equal(typeof module[fn], 'function', `${id}/cli.ts is missing ${fn}()`)
      }
      // Swap is only promised when the manifest says the swap executes.
      if (manifest.swap.execution === 'sdk') {
        assert.equal(typeof module.swap, 'function', `${id} declares swap: sdk but ships no swap()`)
      }
    })
  }

  if (extensionCommands) {
    test(`${id} wires every extension command it declares`, async () => {
      const commands = (await loadCommands(id)).default
      for (const name of Object.keys(extensionCommands)) {
        assert.equal(typeof commands[name]?.run, 'function', `${name} is declared but not implemented`)
        assert.equal(typeof commands[name].execute, 'boolean', `${name} must say whether it broadcasts`)
      }
    })
  }
}

test('a protocol that does not declare a module is not expected to have one', () => {
  // Curvy has no browser path; the UI relies on this to refuse execution rather
  // than failing on a missing import.
  const curvy = listProtocols().find(({ id }) => id === 'curvy')
  assert.equal(curvy.modules.browser, false)
})
