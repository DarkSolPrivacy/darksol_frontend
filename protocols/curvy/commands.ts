// Curvy-specific CLI commands.
//
// Registration, portal inspection and portal recovery have no equivalent in the
// other protocols, so they stay out of the shared cli.ts interface rather than
// forcing every future protocol to stub them. The CLI finds them through
// manifest.extensionCommands, which is why the dispatcher no longer knows the
// string "curvy" at all.
//
// `execute: true` marks a command that broadcasts, so private-sol.ts can demand
// the --execute flag for it without keeping its own list.
import { curvyAuthDiagnostic, curvyPortalStatus, curvyRecoverPortal, registerCurvy } from './cli.js'

export default Object.freeze({
  'curvy:register': Object.freeze({
    execute: true,
    usage: 'curvy:register -- <handle.curvy.name> --execute',
    run: (args: string[]) => registerCurvy(args[0]),
  }),
  'curvy:auth-diagnostic': Object.freeze({
    execute: false,
    usage: 'curvy:auth-diagnostic',
    run: () => curvyAuthDiagnostic(),
  }),
  'curvy:portal-status': Object.freeze({
    execute: false,
    usage: 'curvy:portal-status -- <address>',
    run: (args: string[]) => curvyPortalStatus(args[0]),
  }),
  'curvy:recover': Object.freeze({
    execute: true,
    usage: 'curvy:recover -- <portal-address> <token-symbol> --execute',
    run: (args: string[]) => curvyRecoverPortal(args[0], args[1]),
  }),
})
