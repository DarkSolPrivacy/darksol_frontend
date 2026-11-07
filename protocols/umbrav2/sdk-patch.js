// Vite plugin: lets Umbra v2's SDK accept the guards Solflare adds to a
// transaction (see wallet-additions.js for what is accepted and why).
//
// It rewrites @umbra-privacy/nimbus-solana's flows/transaction.js (0.1.1) as the
// bundle is built, in three places:
//   1. readWalletSignature: a changed message passes when walletAdditionsAllowed
//      accepts it, and the wallet's signature is then checked over that message.
//   2. signTransactionWithWallet: the wire sent carries the message the wallet
//      signed (the one built, or the accepted one) instead of the one built.
//   3. an import of walletAdditionsAllowed.
// signTransactionWithWalletAndPlatform already has the platform wallet sign what
// the wallet returned. Each snippet must match exactly: an SDK update that moves
// them fails the build here instead of shipping the strict check again.
import { fileURLToPath } from 'node:url'

const TARGET = /[\\/]@umbra-privacy[\\/]nimbus-solana[\\/]dist[\\/]flows[\\/]transaction\.js$/
const ADDITIONS = fileURLToPath(new URL('./wallet-additions.js', import.meta.url))

const REPLACEMENTS = [
  [
    `function readWalletSignature(walletSigned, unsigned, args, deps) {`,
    `function readWalletSignature(walletSigned, built, args, deps) {
    let unsigned = built;`,
  ],
  [
    `    if (!isEqualBytes(new Uint8Array(transaction.messageBytes), new Uint8Array(unsigned.messageBytes))) {
        throw buildAlteredError("the wallet changed the transaction's message, so it signed a transaction other than the one built");
    }`,
    `    if (!isEqualBytes(new Uint8Array(transaction.messageBytes), new Uint8Array(unsigned.messageBytes))) {
        let allowed = false;
        try {
            allowed = __walletAdditionsAllowed(deps.decodeSolanaTransactionMessage({ messageBytes: new Uint8Array(unsigned.messageBytes) }), deps.decodeSolanaTransactionMessage({ messageBytes: new Uint8Array(transaction.messageBytes) }), { wallet: deps.encodeSolanaAddress({ publicKey: args.walletAddress }) });
        }
        catch {
            allowed = false;
        }
        if (!allowed) {
            throw buildAlteredError("the wallet changed the transaction's message, so it signed a transaction other than the one built");
        }
        unsigned = { ...unsigned, messageBytes: new Uint8Array(transaction.messageBytes) };
    }`,
  ],
  [
    `    const wire = deps.encodeSolanaTransaction({
        transaction: {
            messageBytes: unsigned.messageBytes,
            signatures: {
                [wallet]: walletSigning.signature,
            },
        },
    });`,
    `    const wire = deps.encodeSolanaTransaction({
        transaction: {
            messageBytes: new Uint8Array(deps.decodeSolanaTransaction({ wire: walletSigning.walletSigned }).messageBytes),
            signatures: {
                [wallet]: walletSigning.signature,
            },
        },
    });`,
  ],
]

export function patchTransactionModule(code) {
  let out = code
  for (const [from, to] of REPLACEMENTS) {
    if (out.split(from).length !== 2) throw new Error(`nimbus wallet-additions patch: the SDK's flows/transaction.js changed; review protocols/umbrav2/sdk-patch.js (missing: ${from.split('\n')[0].trim()})`)
    out = out.replace(from, to)
  }
  return `import { walletAdditionsAllowed as __walletAdditionsAllowed } from ${JSON.stringify(ADDITIONS)};\n${out}`
}

export function nimbusWalletAdditions() {
  return {
    name: 'nimbus-wallet-additions',
    enforce: 'pre',
    transform(code, id) {
      if (!TARGET.test(id.split('?')[0])) return null
      return { code: patchTransactionModule(code), map: null }
    },
  }
}
