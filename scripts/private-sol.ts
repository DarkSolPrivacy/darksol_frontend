#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { EXTENSION_COMMANDS, PROTOCOLS, PROTOCOL_IDS, listProtocols } from '../protocols/registry.js'
import { loadCli, loadCommands } from '../protocols/load.js'
import {
  assertProtocol,
  json,
  loadKeypair,
  parseLamports,
  recipientKeypairPath,
  requireExecute,
  senderKeypairPath,
  walletsDir,
  writePrivateJson,
} from './runtime.js'

// Commands that broadcast. Everything else is read-only, so the --execute guard
// is derived from this one list rather than repeated per branch.
const MUTATING = new Set(['deposit', 'send', 'swap'])

export function usage() {
  const extensions = Object.values(EXTENSION_COMMANDS).map(({ usage: help }) => `  npm run ${help}`).join('\n')
  return `Test-only private SOL SDK runner

  npm run wallets:create
  npm run protocol:check
  npm run protocol:snapshot -- <${PROTOCOL_IDS.join('|')}>
  npm run protocol:balance -- <${PROTOCOL_IDS.join('|')}>
  npm run protocol:estimate -- <protocol> <lamports>
  npm run protocol:deposit -- <protocol> <lamports> --execute
  npm run protocol:send -- <protocol> <recipient> <lamports> --execute
  npm run protocol:swap -- <protocol> ... --execute
${extensions}

Amounts are integer lamports. Mutating commands never broadcast without --execute.`
}

// Every protocol declares which capabilities it ships, so an unimplemented one
// reports that plainly instead of falling through a ternary to another
// protocol's function.
async function capability(protocol: string, command: string) {
  const cli: any = await loadCli(protocol)
  const run = cli[command]
  if (typeof run !== 'function') {
    throw new Error(`${PROTOCOLS[protocol].name} does not expose a ${command} flow in its SDK`)
  }
  return run
}

async function main(args = process.argv.slice(2)) {
  const [command, protocolValue, first, second] = args
  if (!command) throw new Error(usage())

  if (command === 'wallets:create') {
    if (!existsSync(senderKeypairPath()) || !existsSync(recipientKeypairPath())) {
      throw new Error('Wallet files are missing. Generate them with the documented solana-keygen commands.')
    }
    const [sender, recipient] = await Promise.all([
      loadKeypair(senderKeypairPath()),
      loadKeypair(recipientKeypairPath()),
    ])
    // Any protocol may need to create its own identity material first.
    const identities: Record<string, unknown> = {}
    for (const { id } of listProtocols()) {
      const cli: any = await loadCli(id)
      if (typeof cli.walletSetup === 'function') identities[id] = await cli.walletSetup()
    }
    const addresses = {
      sender: sender.publicKey.toBase58(),
      recipient: recipient.publicKey.toBase58(),
      identities,
    }
    await writePrivateJson(resolve(walletsDir(), 'addresses.json'), addresses)
    return addresses
  }

  // Protocol-specific commands, found through the manifests.
  if (command && EXTENSION_COMMANDS[command]) {
    const owner = EXTENSION_COMMANDS[command].protocol
    const commands: any = (await loadCommands(owner)).default
    const entry = commands[command]
    if (!entry) throw new Error(`${command} is declared by ${owner} but missing from its commands module`)
    if (entry.execute) requireExecute(args)
    return entry.run(args.slice(1))
  }

  if (command === 'check') {
    const protocols = protocolValue === 'all' || !protocolValue
      ? [...PROTOCOL_IDS]
      : [assertProtocol(protocolValue)]
    return Promise.all(protocols.map(async (protocol) => {
      const cli: any = await loadCli(protocol)
      return (cli.check || cli.snapshot)()
    }))
  }

  const protocol = assertProtocol(protocolValue)
  if (MUTATING.has(command)) requireExecute(args)

  if (command === 'snapshot' || command === 'balance') return (await capability(protocol, command))()
  if (command === 'estimate') return (await capability(protocol, 'estimate'))(parseLamports(first))
  if (command === 'deposit') return (await capability(protocol, 'deposit'))(parseLamports(first))
  if (command === 'send') return (await capability(protocol, 'send'))(first, parseLamports(second))
  // Swap arguments differ by protocol -- Cloak takes a recipient, Curvy a
  // currency pair -- so each adapter parses its own raw args rather than the
  // shared interface pretending the two are the same call.
  if (command === 'swap') return (await capability(protocol, 'swap'))(args.slice(2))

  throw new Error(usage())
}

main().then((result) => {
  console.log(json(result))
  process.exit(0)
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
