import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The webview can run any SQL it likes -- core is TypeScript and runs there --
 * so the Content Security Policy is the wall between a receipt template with a
 * script in it and the whole database. What it allows is asserted here so that
 * loosening it is a decision somebody sees in a diff, not a line that drifted.
 */

// From the root, as `joiningIsNotSettingUp.test.ts` does: jsdom's import.meta.url is not a file.
const conf = JSON.parse(readFileSync(
  join(process.cwd(), 'apps', 'pos', 'src-tauri', 'tauri.conf.json'), 'utf8',
)) as { app: { security: { csp: string } } }

const directives = new Map(conf.app.security.csp.split(';').map((d) => {
  const [name, ...values] = d.trim().split(/\s+/)
  return [name!, values] as const
}))

describe('the content security policy', () => {
  it('runs only the app\'s own scripts', () => {
    expect(directives.get('script-src')).toEqual(["'self'"])
  })

  it('never allows eval, inline script or a remote origin anywhere', () => {
    for (const [name, values] of directives) {
      expect(values, name).not.toContain("'unsafe-eval'")
      if (name !== 'style-src') expect(values, name).not.toContain("'unsafe-inline'")
      for (const v of values) expect(v, `${name} ${v}`).not.toMatch(/^(https?:|wss?:)\/\/(?!asset\.localhost)/)
    }
  })

  it('leaves the network to Rust: no connect-src of its own', () => {
    expect(directives.has('connect-src')).toBe(false)
  })
})
