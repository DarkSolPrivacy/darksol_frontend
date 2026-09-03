// Vercel serverless entry point. An Express app is itself a (req, res) handler,
// so the same app that runs locally serves every /api route here; vercel.json
// rewrites /api/* onto this function.
export { default } from '../server/app.js'
