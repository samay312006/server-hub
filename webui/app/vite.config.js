import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  // ws:true so the xterm.js terminal websocket (/api/term) proxies in dev too.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8088', ws: true } } },
})
