import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  resolve: {
    alias: {
      // The Node driver must never reach the webview. Aliasing it to an empty
      // module turns a stray import into a build-time failure instead of a
      // confusing runtime one.
      'better-sqlite3': fileURLToPath(new URL('./src/empty.ts', import.meta.url)),
    },
  },
  build: {
    target: process.env['TAURI_ENV_PLATFORM'] === 'windows' ? 'chrome105' : 'es2022',
    sourcemap: !!process.env['TAURI_ENV_DEBUG'],
  },
})
