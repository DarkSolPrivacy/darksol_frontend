import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['buffer', 'crypto', 'events', 'process', 'stream', 'util'] })],
  server: {
    proxy: {
      // The read API runs on the VPS, so `npm run dev` needs no local
      // database and no backend checkout. changeOrigin is required or Caddy's
      // site block will not match a localhost Host and answers 404 itself.
      '/api': { target: process.env.DARKSOL_API_URL || 'https://api.darksol.app', changeOrigin: true },
    },
  },
})
