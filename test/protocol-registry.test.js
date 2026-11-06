import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import {
  BRIDGE_CAPABILITIES, EXTENSION_COMMANDS, LOGOS, PROGRAMS, PROTOCOLS, PROTOCOL_IDS,
  PROVIDER_CAPABILITIES, SWAP_CAPABILITIES, getProtocol, listProtocols, manifests, resolveProtocolId,
} from '../protocols/registry.js'
import { validateManifest, validateRegistry } from '../protocols/schema.js'
import { CONTRACTS, MINTS, MINT_SYMBOLS, PROGRAMS as RAW_PROGRAMS } from '../protocols/addresses.js'

// --- schema ---------------------------------------------------------------

test('every manifest satisfies the schema', () => {
  for (const manifest of manifests) {
    const { valid, errors } = validateManifest(manifest)
    assert.equal(valid, true, `${manifest.id}: ${errors.join('; ')}`)
  }
})

test('the registry has no duplicate id, alias or primary address', () => {
  const { valid, errors } = validateRegistry(manifests)
  assert.equal(valid, true, errors.join('; '))
})

test('every address parses as the chain it claims', () => {
  for (const address of Object.values(RAW_PROGRAMS)) {
    assert.equal(new PublicKey(address).toBase58(), address, `${address} is not canonical base58`)
  }
  for (const [name, address] of Object.entries(CONTRACTS)) {
    assert.match(address, /^0x[0-9a-f]{40}$/, `${name} is not a lowercase EVM address`)
  }
  for (const [symbol, mint] of Object.entries(MINTS)) {
    assert.equal(new PublicKey(mint).toBase58(), mint, `${symbol} mint is not canonical base58`)
    assert.equal(MINT_SYMBOLS[mint], symbol, `${symbol} is missing from the reverse map`)
  }
})

// The three protocols that existed before the registry. Golden comparisons are
// scoped to these so adding a protocol never means editing a golden literal.
const ORIGINAL = ['cloakc', 'privacycash', 'curvy']
const pick = (table) => Object.fromEntries(ORIGINAL.map((id) => [id, table[id]]))

// --- golden tables --------------------------------------------------------
//
// Literal copies of the tables that existed before the registry, pasted in
// rather than imported, so this file proves the derivation reproduces them.
// Delete a block only when its consumer is gone, never to make a test pass.

test('PROGRAMS reproduces the pinned addresses from scripts/runtime.ts', () => {
  assert.deepEqual(PROGRAMS, {
    cloakc: 'zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW',
    privacycash: '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD',
    curvyVault: '0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00',
    curvyAggregator: '0xe51924cef003a654ec9735c4d97f5d4862cbcbb1',
  })
})

test('PROVIDER_CAPABILITIES reproduces server/privacy-engine.js', () => {
  assert.deepEqual(pick(PROVIDER_CAPABILITIES), {
    privacycash: {
      id: 'privacycash', name: 'PrivacyCash', network: 'Solana',
      supportsMultiRecipient: true, maxRecipients: null, supportsDeadline: true,
      supportsPrivateSwap: true, swapAggregator: 'Jupiter',
      protocolExecution: { label: 'historical p50 / p95 when available' },
      withdrawalFee: {
        variableRate: 0.0035, fixedAmount: 0.006, fixedToken: 'SOL', fixedBasis: 'recipient',
        label: '0.35% + 0.006 SOL equivalent per recipient',
      },
    },
    cloakc: {
      id: 'cloakc', name: 'CLOAKC', network: 'Solana',
      supportsMultiRecipient: false, maxRecipients: 1, supportsDeadline: false,
      supportsPrivateSwap: true, swapAggregator: 'Jupiter',
      capabilityNote: 'Current mainnet 0.2.x integration is treated as single-recipient.',
      protocolExecution: { label: 'historical p50 / p95 when available' },
      withdrawalFee: {
        variableRate: 0.003, variableByToken: { SOL: 0.003, USDC: 0.00125, USDT: 0.00125 },
        fixedAmount: 0.005, fixedToken: 'SOL', fixedBasis: 'transaction',
        fixedByToken: { SOL: 0.005, USDC: 0.45, USDT: 0.45 }, label: '0.3% + 0.005 SOL, or 0.125% + 0.45 USDC/USDT per exit',
      },
    },
    curvy: {
      id: 'curvy', name: 'Curvy', network: 'Arbitrum One', chainId: 42161,
      supportsMultiRecipient: false, maxRecipients: 1, supportsDeadline: false,
      supportsPrivateSwap: true, swapAggregator: 'LiFi',
      supportedTokens: ['USDC', 'SOL', 'USDT'],
      capabilityNote: 'The current integration treats each public unshield as a single-recipient exit.',
      protocolExecution: { label: 'historical p50 / p95 when available' },
      withdrawalFee: {
        variableRate: 0.003, fixedAmount: 0, fixedToken: null, fixedBasis: 'transaction',
        label: '0.1% aggregation + 0.2% unshielding; shielding separately costs 0.1%',
      },
    },
  })
})

test('SWAP_CAPABILITIES reproduces src/swap-routes.js', () => {
  assert.deepEqual(pick(SWAP_CAPABILITIES), {
    cloakc: {
      inputAssets: ['SOL'], outputAssets: ['USDC', 'USDT'], execution: 'sdk',
      note: 'Cloak swaps private SOL to a public SPL-token recipient through Jupiter.',
    },
    privacycash: {
      inputAssets: ['USDC', 'SOL', 'USDT'], outputAssets: ['USDC', 'SOL', 'USDT'],
      execution: 'sdk',
      note: 'PrivacyCash swaps through Jupiter in a signature-derived swap wallet and re-shields the output before paying the recipient.',
    },
    curvy: {
      inputAssets: ['USDC', 'SOL', 'USDT'], outputAssets: ['USDC', 'SOL', 'USDT'],
      execution: 'sdk',
      note: 'Curvy swaps supported private Vault currencies through a LiFi-backed intent.',
    },
  })
})

test('BRIDGE_CAPABILITIES reproduces src/bridge-routes.js', () => {
  assert.deepEqual(pick(BRIDGE_CAPABILITIES), {
    privacycash: {
      execution: 'sdk',
      note: 'PrivacyCash bridges by withdrawing privately to a NEAR Intents market-maker address.',
    },
    cloakc: {
      execution: 'unsupported',
      note: 'Cloak is Solana-only. Its SDK and Shield Pool program expose no bridge.',
    },
    curvy: {
      execution: 'documented-only',
      note: 'Curvy bridges through LI.FI entry/exit Portals, but this app has no Curvy browser path.',
    },
  })
})

test('PROTOCOLS carries every field server/app.js and server/index.js read', () => {
  const fields = ({ id, name, programId, docs, feePolicy, chain, chainId, explorerAccount, explorerTransaction }) =>
    ({ id, name, programId, docs, feePolicy, chain, chainId, explorerAccount, explorerTransaction })

  assert.deepEqual(fields(PROTOCOLS.cloakc), {
    id: 'cloakc', name: 'CLOAKC', programId: 'zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW',
    docs: 'https://docs.cloak.ag/sdk/introduction',
    feePolicy: { label: '0.125–0.3% protocol fee', detail: 'SOL exits: 0.3% + 0.005 SOL · USDC/USDT exits: 0.125% + 0.45' },
    chain: 'solana', chainId: null,
    // app.js built this by concatenating solscan onto programId.
    explorerAccount: 'https://solscan.io/account/zh1eLd6rSphLejbFfJEneUwzHRfMKxgzrgkfwA6qRkW',
    explorerTransaction: 'https://solscan.io/tx/',
  })

  assert.deepEqual(fields(PROTOCOLS.curvy), {
    id: 'curvy', name: 'Curvy', programId: '0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00',
    docs: 'https://docs.curvy.box/',
    feePolicy: {
      label: '0.3% private exit path',
      detail: '0.1% aggregation + 0.2% unshielding; shielding separately costs 0.1%',
    },
    chain: 'arbitrum', chainId: 42161,
    explorerAccount: 'https://arbiscan.io/address/0xcc8d5c60a8fb15aa3793647ef531f1ba7df24f00',
    explorerTransaction: 'https://arbiscan.io/tx/',
  })

  assert.equal(PROTOCOLS.privacycash.feePolicy.label, '0.35% + base fee')
  assert.equal(
    PROTOCOLS.privacycash.explorerAccount,
    'https://solscan.io/account/9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD',
  )
})

test('main.jsx display metadata is reproduced, and its hand-typed values are corrected', () => {
  // The three shortProgram strings in main.jsx were typed by hand and none of
  // them agreed on a rule: cloakc kept 3 trailing characters, privacycash 4.
  // Deriving them settles on 4 + 4, which is what the short() helper the rest
  // of the UI uses already does. cloakc gains one character in the display.
  assert.equal(PROTOCOLS.cloakc.shortProgram, 'zh1e…qRkW')
  assert.equal(PROTOCOLS.privacycash.shortProgram, '9fhQ…QyQD')

  // src/main.jsx:37 displayed '0xB4BA...B6d5', which is neither a prefix nor a
  // suffix of the deployed vault: it was hand-typed and drifted. shortProgram is
  // derived from the address now, so the display cannot disagree with the
  // contract the indexer actually reads.
  assert.equal(PROTOCOLS.curvy.shortProgram, '0xcc…4f00')
  assert.notEqual(PROTOCOLS.curvy.shortProgram, '0xB4BA…B6d5')

  assert.deepEqual(pick(LOGOS), {
    cloakc: { src: '/logos/cloak.png', source: 'https://www.cloak.ag/brand' },
    privacycash: { src: '/logos/privacycash-icon.png', source: 'https://privacycash.mintlify.app/' },
    curvy: { src: '/logos/curvy.svg', source: 'https://www.curvy.box/' },
  })
})

// --- lookups --------------------------------------------------------------

test('protocol ids and lookups behave like the tables they replace', () => {
  for (const id of ORIGINAL) assert.ok(PROTOCOL_IDS.includes(id), `${id} missing from PROTOCOL_IDS`)
  assert.equal(getProtocol('cloakc').name, 'CLOAKC')
  assert.equal(getProtocol('nope'), null)
})

test('aliases replace substring sniffing without matching unrelated ids', () => {
  assert.equal(resolveProtocolId('CLOAKC'), 'cloakc')
  assert.equal(resolveProtocolId('cloak'), 'cloakc')
  assert.equal(resolveProtocolId('Privacy Cash'), 'privacycash')
  assert.equal(resolveProtocolId('curvy'), 'curvy')
  // providerKey() matched any id containing "cloak"; an alias table does not.
  assert.notEqual(resolveProtocolId('cloakclone'), 'cloakc')
})

test('listProtocols answers the questions that were hardcoded arrays', () => {
  const ids = (filter) => listProtocols(filter).map((item) => item.id)
  // src/main.jsx:966 hardcoded ['privacycash','cloakc'] and ['curvy'].
  assert.deepEqual(ids({ chain: 'arbitrum' }), ['curvy'])
  for (const id of ['cloakc', 'privacycash']) assert.ok(ids({ chain: 'solana' }).includes(id))
  assert.ok(!ids({ chain: 'solana' }).includes('curvy'))
  // server/index.js selected its EVM lane with includes('curvy').
  assert.deepEqual(ids({ lane: 'evm' }), ['curvy'])
  assert.deepEqual(ids({ lane: 'solana' }), ['cloakc', 'privacycash', 'umbra', 'umbrav2'])
  // Only protocols whose capability actually executes. Umbra v1 documents swaps
  // but ships no swap module, so it must not appear here; Umbra v2 swaps in a
  // one-time wallet through Jupiter.
  assert.deepEqual(ids({ capability: 'swap' }), ['cloakc', 'privacycash', 'curvy', 'umbrav2'])
  assert.deepEqual(ids({ capability: 'bridge' }), ['privacycash'])
  for (const id of ['umbra', 'umbrav2']) assert.ok(ids({ capability: 'send' }).includes(id))
})

test('Umbra v1 is legacy and names Umbra v2 as its successor', () => {
  assert.equal(PROTOCOLS.umbra.legacy, true)
  assert.equal(PROTOCOLS.umbra.supersededBy, 'umbrav2')
  assert.equal(PROVIDER_CAPABILITIES.umbra.legacy, true)
  assert.equal(PROTOCOLS.umbrav2.legacy, false)
  assert.equal(PROVIDER_CAPABILITIES.umbrav2.legacy, undefined)
  assert.equal(resolveProtocolId('nimbus'), 'umbrav2')
})

test('extension commands are namespaced to their owner and carry their usage', () => {
  for (const [command, entry] of Object.entries(EXTENSION_COMMANDS)) {
    // The namespace is what lets the CLI route a bare command to a protocol
    // without knowing any protocol names.
    assert.ok(command.startsWith(`${entry.protocol}:`), `${command} is not namespaced to ${entry.protocol}`)
    // The CLI builds its help from these, so an empty one would silently
    // produce a blank line instead of a documented command.
    assert.ok(entry.usage.startsWith(command), `${command} usage should lead with the command`)
  }
  for (const command of ['curvy:register', 'curvy:recover']) {
    assert.equal(EXTENSION_COMMANDS[command].protocol, 'curvy')
  }
})
