import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Permissions } from '@shopos/core'

/**
 * The permission grid must not promise what the code does not do.
 *
 * `ENFORCED` is a claim about this source tree: these are the capabilities the
 * screens actually check. The Roles screen draws a tickbox for each one and a
 * blank for the rest, so if the claim drifts the owner is either offered a
 * switch that changes nothing, or denied one that works.
 *
 * So the claim is checked against the code rather than trusted. This is the
 * test that fails when somebody adds a `Permissions.can` call and forgets to
 * say so — which is the good direction to fail in.
 */

/* From the working directory rather than from `import.meta.url`: this project
   runs in jsdom, where the module URL is the dev server's http one and not a
   file path at all. Vitest is configured at the repo root, so this is stable. */
const SRC = join(process.cwd(), 'apps', 'pos', 'src')

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return everyFile(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Every `Permissions.can(..., 'resource', 'capability')` in the screens. */
function checksInSource(): Set<string> {
  const found = new Set<string>()
  const call = /Permissions\.can\([^,]+,\s*'([a-z_]+)',\s*'([a-z]+)'/g

  for (const file of everyFile(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const [, resource, capability] of text.matchAll(call)) {
      found.add(`${resource}.${capability}`)
    }
  }
  return found
}

function claimed(): Set<string> {
  const out = new Set<string>()
  for (const resource of Permissions.RESOURCES) {
    for (const capability of Permissions.ENFORCED[resource]) out.add(`${resource}.${capability}`)
  }
  return out
}

describe('what the roles grid promises', () => {
  it('offers a tickbox for every check the screens actually make', () => {
    const missing = [...checksInSource()].filter((pair) => !claimed().has(pair))
    expect(missing, `checked in a screen but absent from ENFORCED: ${missing.join(', ')}`).toEqual([])
  })

  it('offers no tickbox for a check nothing makes', () => {
    const inSource = checksInSource()
    const hollow = [...claimed()].filter((pair) => !inSource.has(pair))
    expect(hollow, `listed in ENFORCED but nothing reads it: ${hollow.join(', ')}`).toEqual([])
  })

  it('names every resource, so a new one cannot be added without an answer', () => {
    for (const resource of Permissions.RESOURCES) {
      expect(Permissions.ENFORCED[resource], `${resource} has no entry`).toBeDefined()
    }
  })

  it('lists only capabilities that exist', () => {
    for (const resource of Permissions.RESOURCES) {
      for (const capability of Permissions.ENFORCED[resource]) {
        expect(Permissions.CAPABILITIES).toContain(capability)
      }
    }
  })
})
