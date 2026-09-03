import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['buffer', 'crypto', 'events', 'process', 'stream', 'util'] })],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
