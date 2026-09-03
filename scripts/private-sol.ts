#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCurvySecrets, curvyAuthDiagnostic, curvyBalance, curvyCheck, curvyDeposit, curvyEstimateExternal, curvyPortalStatus, curvyRecoverPortal, curvySend, curvySnapshot, curvySwap, registerCurvy } from './protocols/curvy.js'
import { cloakBalance, cloakDeposit, cloakSend, cloakSnapshot, cloakSwapSolToToken } from './protocols/cloak.js'
import { privacyCashBalance, privacyCashDeposit, privacyCashSend, privacyCashSnapshot } from './protocols/privacycash.js'
import {
  assertProtocol,
  json,
  loadKeypair,
  parseLamports,
  PROTOCOL_IDS,
  recipientKeypairPath,
  requireExecute,
  senderKeypairPath,
  walletsDir,
  writePrivateJson,
} from './runtime.js'

export function usage() {
  return `Test-only private SOL SDK runner

  npm run wallets:create
  npm run protocol:check
  npm run protocol:snapshot -- <cloakc|privacycash|curvy>
  npm run protocol:balance -- <cloakc|privacycash|curvy>
  npm run protocol:estimate -- curvy <lamports>
  npm run protocol:deposit -- <cloakc|privacycash|curvy> <lamports> --execute
  npm run protocol:send -- <cloakc|privacycash|curvy> <recipient> <lamports> --execute
  npm run protocol:swap -- cloakc <recipient> <lamports> [USDC|USDT] --execute
  npm run protocol:swap -- curvy <from-symbol> <to-symbol> <base-units> --execute
  npm run curvy:register -- <handle.curvy.name> --execute
  npm run curvy:auth-diagnostic
  npm run curvy:portal-status -- <address>
  npm run curvy:recover -- <portal-address> <token-symbol> --execute

Amounts are integer lamports. Mutating commands never broadcast without --execute.`
}

async function main(args = process.argv.slice(2)) {
  const [command, protocolValue, first, second, third] = args
  if (command === 'wallets:create') {
    if (!existsSync(senderKeypairPath()) || !existsSync(recipientKeypairPath())) {
      throw new Error('Wallet files are missing. Generate them with the documented solana-keygen commands.')
    }
    const [sender, recipient, secrets] = await Promise.all([
      loadKeypair(senderKeypairPath()),
      loadKeypair(recipientKeypairPath()),
      ensureCurvySecrets(),
    ])
    const addresses = {
      sender: sender.publicKey.toBase58(),
      recipient: recipient.publicKey.toBase58(),
      curvyIdentity: secrets.userAddress,
    }
    await writePrivateJson(resolve(walletsDir(), 'addresses.json'), addresses)
    return addresses
  }
  if (command === 'curvy:register') {
    requireExecute(args)
    return registerCurvy(protocolValue)
  }
  if (command === 'curvy:auth-diagnostic') return curvyAuthDiagnostic()
  if (command === 'curvy:portal-status') return curvyPortalStatus(protocolValue)
  if (command === 'curvy:recover') {
    requireExecute(args)
    return curvyRecoverPortal(protocolValue, first)
  }
  if (command === 'check') {
    const protocols = protocolValue === 'all' || !protocolValue ? PROTOCOL_IDS : [assertProtocol(protocolValue)]
    return Promise.all(protocols.map((protocol) => protocol === 'cloakc' ? cloakSnapshot() : protocol === 'privacycash' ? privacyCashSnapshot() : curvyCheck()))
  }
  const protocol = assertProtocol(protocolValue)
  if (command === 'snapshot') return protocol === 'cloakc' ? cloakSnapshot() : protocol === 'privacycash' ? privacyCashSnapshot() : curvySnapshot()
  if (command === 'balance') return protocol === 'cloakc' ? cloakBalance() : protocol === 'privacycash' ? privacyCashBalance() : curvyBalance()
  if (command === 'estimate') {
    if (protocol !== 'curvy') throw new Error('read-only external-route estimation is currently available for curvy')
    return curvyEstimateExternal(parseLamports(first))
  }
  if (command === 'deposit') {
    requireExecute(args)
    const lamports = parseLamports(first)
    return protocol === 'cloakc' ? cloakDeposit(lamports) : protocol === 'privacycash' ? privacyCashDeposit(lamports) : curvyDeposit(lamports)
  }
  if (command === 'send') {
    requireExecute(args)
    const lamports = parseLamports(second)
    return protocol === 'cloakc' ? cloakSend(first, lamports) : protocol === 'privacycash' ? privacyCashSend(first, lamports) : curvySend(first, lamports)
  }
  if (command === 'swap') {
    requireExecute(args)
    if (protocol === 'cloakc') return cloakSwapSolToToken(first, parseLamports(second), third === '--execute' || !third ? 'USDC' : third)
    if (protocol === 'curvy') return curvySwap(first, second, parseLamports(third))
    throw new Error('the installed PrivacyCash SDK does not expose its private-swap flow')
  }
  throw new Error(usage())
}

main().then((result) => {
  console.log(json(result))
  process.exit(0)
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
