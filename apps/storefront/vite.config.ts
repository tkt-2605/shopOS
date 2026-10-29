import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * The storefront: a static site for Cloudflare Pages, talking to the main
 * till's web API through the tunnel.
 *
 * Not an npm workspace on purpose (it has no package.json): it uses the React
 * and Vite already installed at the root, so adding it changed no lockfile.
 *
 *   SHOP_API=https://api-shop.example.in npx vite build apps/storefront
 *
 * then drag `apps/storefront/dist` into the Pages project.
 */
const api = process.env['SHOP_API'] ?? 'http://127.0.0.1:7802'
/* What the main till uploads to Cloudflare (functions/data), there when the till is off. */
const data = process.env['SHOP_DATA'] ?? 'https://shop.thiruvengadam.me/data'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  define: { __SHOP_API__: JSON.stringify(api.replace(/\/+$/, '')), __SHOP_DATA__: JSON.stringify(data.replace(/\/+$/, '')) },
  server: { port: 1430, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
})
