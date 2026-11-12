// Vite plugin: makes Privacy Cash's confirmation poll check at once.
//
// After a deposit or a withdrawal is relayed, the SDK (privacycash 1.2.2,
// dist/deposit.js, withdraw.js, depositSPL.js, withdrawSPL.js) asks the
// relayer whether the new note is indexed (/utxos/check), sleeping 2 s before
// every check, up to 11 checks: about 22 s. Measured on mainnet, the first
// check always found the note, so each leg of a send spent 2.1 s on that
// sleep, 4.3 s in a wallet-funded send (docs/PRIVATE_SEND_PERFORMANCE.md).
//
// The patch checks at once, then every 500 ms, and gives up when 11 times the
// SDK's 2 s have passed, as before. It waits for the same thing and throws the
// same error at the same deadline; only the first check comes sooner and the
// later ones closer together. Each snippet must match exactly once in each file:
// an SDK update that moves them fails the build here instead of shipping
// unpatched.
const TARGET = /[\\/]privacycash[\\/]dist[\\/](deposit|withdraw|depositSPL|withdrawSPL)\.js$/

export const FIRST_CHECK_MS = 0
export const CHECK_EVERY_MS = 500

const REPLACEMENTS = [
  [
    `    let retryTimes = 0;
    let itv = 2;`,
    `    let retryTimes = 0;
    let itv = 2;
    const __checkUntil = Date.now() + 11 * itv * 1000;`,
  ],
  [
    `        await new Promise(resolve => setTimeout(resolve, itv * 1000));`,
    `        await new Promise(resolve => setTimeout(resolve, retryTimes === 0 ? ${FIRST_CHECK_MS} : ${CHECK_EVERY_MS}));`,
  ],
  [
    `        if (retryTimes >= 10) {`,
    `        if (Date.now() >= __checkUntil) {`,
  ],
]

export function patchConfirmationPoll(code) {
  let out = code
  for (const [from, to] of REPLACEMENTS) {
    if (out.split(from).length !== 2) throw new Error(`privacycash confirmation patch: the SDK's confirmation loop changed; review protocols/privacycash/sdk-patch.js (missing: ${from.split('\n')[0].trim()})`)
    out = out.replace(from, to)
  }
  return out
}

export function privacyCashConfirmationPoll() {
  return {
    name: 'privacycash-confirmation-poll',
    enforce: 'pre',
    transform(code, id) {
      if (!TARGET.test(id.split('?')[0])) return null
      return { code: patchConfirmationPoll(code), map: null }
    },
  }
}
