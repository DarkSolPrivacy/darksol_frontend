import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { nimbusWalletAdditions } from './protocols/umbrav2/sdk-patch.js'
import { staticPages } from './static-pages.js'

const api = process.env.DARKSOL_API_URL
// Umbra v2's prover needs shared memory, which only a cross-origin isolated page
// gets. vercel.json sends the same pair in production.
const isolated = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['buffer', 'crypto', 'events', 'process', 'stream', 'util'] }), nimbusWalletAdditions(), staticPages()],
  // `npm run dev` pre-bundles the SDK, which the plugins above do not see.
  optimizeDeps: { rolldownOptions: { plugins: [nimbusWalletAdditions()] } },
  server: {
    headers: isolated,
    proxy: {
      '/admin-stats': { target: api || 'https://api.darksol.app', changeOrigin: true },
      // Caddy answers 403 on /api/solana-rpc without the key only Vercel's
      // rewrite appends, so against the VPS that one route goes through Vercel.
      // Listed first: the first matching prefix wins.
      ...(api ? {} : { '/api/solana-rpc': { target: 'https://darksol.app', changeOrigin: true } }),
      // The read API runs on the VPS, so `npm run dev` needs no local
      // database and no backend checkout. changeOrigin is required or Caddy's
      // site block will not match a localhost Host and answers 404 itself.
      '/api': { target: api || 'https://api.darksol.app', changeOrigin: true },
    },
  },
})
