// Umbra-specific CLI commands.
//
// Registration has no equivalent in the other protocols: Umbra derives its keys
// from a wallet signature and publishes the resulting public keys on-chain, and
// nothing else works until that has happened once. It is idempotent, but it
// does broadcast, so it carries the --execute guard.
import { register } from './cli.js'

export default Object.freeze({
  'umbra:register': Object.freeze({
    execute: true,
    usage: 'umbra:register -- --execute',
    run: () => register(),
  }),
})
