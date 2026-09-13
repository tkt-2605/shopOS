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
        plugins: [react()],
        resolve: {
          alias: { '@shopos/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname },
        },
        test: {
          name: 'pos',
          include: ['apps/pos/test/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
})
