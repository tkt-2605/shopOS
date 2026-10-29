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

/**
 * The site's Content-Security-Policy, as a Cloudflare Pages `_headers` file.
 * Written at build time because it names the till's and the data's addresses,
 * which only the build knows. Scripts from this site and Google's sign-in, and
 * nothing else: the customer's session sits in the page's storage, and a
 * script that got in could place orders in their name. Pages only -- the
 * Android app serves the same files from the phone, not through Pages.
 */
export function securityHeaders(apiUrl: string, dataUrl: string): string {
  const origin = (url: string) => new URL(url).origin
  const google = 'https://accounts.google.com'
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${google}/gsi/client`,
    `style-src 'self' 'unsafe-inline' ${google}/gsi/style`,
    `img-src 'self' data: blob: ${origin(apiUrl)} ${origin(dataUrl)} https://*.googleusercontent.com`,
    `connect-src 'self' ${origin(apiUrl)} ${origin(dataUrl)} ${google}/gsi/`,
    `frame-src ${google}/gsi/`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
  return [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '',
  ].join('\n')
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), {
    name: 'shop-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: securityHeaders(api, data) })
    },
  }],
  define: { __SHOP_API__: JSON.stringify(api.replace(/\/+$/, '')), __SHOP_DATA__: JSON.stringify(data.replace(/\/+$/, '')) },
  server: { port: 1430, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
})
