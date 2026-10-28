// The one place a new protocol is registered.
//
// These imports are deliberately STATIC. A readdir + dynamic-import barrel also
// resolves under node, tsx and Vite -- that was measured, not assumed -- but
// Vercel builds the serverless bundle by tracing static imports, and
// server/app.js reaches this file through api/index.js. A dynamically
// discovered manifest would be missing from the deployed function while every
// local check stayed green.
import cloakc from './cloakc/manifest.js'
import curvy from './curvy/manifest.js'
import privacycash from './privacycash/manifest.js'
import umbra from './umbra/manifest.js'
import umbrav2 from './umbrav2/manifest.js'

export const manifests = Object.freeze([cloakc, privacycash, curvy, umbra, umbrav2])
