import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Two kinds of test, because there are two kinds of code.
 *
 * The core is business rules and a database; it runs in node, with no browser
 * anywhere near it, and that is the whole point of keeping it in its own
 * package. The counter's screens are the other half — until now untested,
 * because there was nothing set up to render one.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          include: ['packages/*/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'portal',
          include: ['apps/portal/test/**/*.test.ts'],
          environment: 'node',
          /* Binds a real port and signs real Ed25519 keys per case; the
             default 5 s is tight once a suite does both. */
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'bench',
          include: ['tools/*/test/**/*.test.ts'],
          environment: 'node',
          // Two tills, two SQLite files and two HTTP servers per scenario. The
          // default 5 s is not enough for `third-till`, which bills 200 times.
          testTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        resolve: {
          /* The subpaths as well as the root. A screen may not import the node
             driver -- `vite.config.ts` aliases better-sqlite3 to an empty
             module so a stray one fails at build time -- but a *test* of a
             screen wants a real migrated database rather than a mock of one,
             and that is the only way to get a licence signature checked by the
             code that will really check it. */
          alias: {
            '@shopos/core/node': new URL('./packages/core/src/db/node-driver.ts', import.meta.url).pathname,
            '@shopos/core/migrations': new URL('./packages/core/src/db/migrations.ts', import.meta.url).pathname,
            '@shopos/core/licence': new URL('./packages/core/src/domain/licence.ts', import.meta.url).pathname,
            '@shopos/core/config': new URL('./packages/core/src/config/licensing.ts', import.meta.url).pathname,
            '@shopos/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
          },
        },
        test: {
          name: 'pos',
          /* `.ts` as well as `.tsx`: some of what the app decides is plain
             logic with no window in it, and a pure function does not become a
             component to get itself tested. */
          include: ['apps/pos/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
    ],
  },
})
