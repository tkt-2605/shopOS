import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const debug = !!process.env['TAURI_ENV_DEBUG']

/**
 * Source maps for a release, kept on the vendor's side and never shipped.
 *
 * A stack from a shop names minified functions in a bundle -- `at r (index-B3x9.js:1:83412)`
 * -- which is no use without the map that built it. Tauri puts everything in
 * `dist` inside the app, so the maps are made "hidden" (no comment pointing at
 * them) and moved out of `dist` to `sourcemaps/<version>/` before the bundle is
 * made. `release.yml` keeps that folder with the installer.
 */
function keepMapsAside(): Plugin {
  return {
    name: 'shopos-keep-maps-aside',
    apply: 'build',
    closeBundle() {
      if (debug) return
      const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version
      const dist = fileURLToPath(new URL('./dist', import.meta.url))
      const aside = fileURLToPath(new URL(`./sourcemaps/${version}`, import.meta.url))
      const walk = (dir: string, rel: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const here = join(dir, entry.name)
          if (entry.isDirectory()) walk(here, join(rel, entry.name))
          else if (entry.name.endsWith('.map')) {
            mkdirSync(join(aside, rel), { recursive: true })
            renameSync(here, join(aside, rel, entry.name))
          }
        }
      }
      walk(dist, '')
    },
  }
}

export default defineConfig({
  plugins: [react(), keepMapsAside()],
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
    sourcemap: debug ? true : 'hidden',
  },
})
