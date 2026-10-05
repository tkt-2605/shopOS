import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative, sep } from 'node:path'

/**
 * The shape of the core, held by a test rather than by memory.
 *
 * Every rule here was true of the code before it was written down, and each one
 * had already been broken once: two import cycles, a domain file reaching into
 * the driver for a type, services that grew past a thousand lines one fix at a
 * time. Nothing failed when they did, because nothing was looking. A layering
 * that is only a convention is kept by whoever remembers it, and a solo
 * codebase is one that forgets.
 *
 * The rules:
 *
 * - No import cycles anywhere under `src`. A cycle is two modules that cannot be
 *   understood, tested or replaced one at a time, and in ESM it is also a load
 *   order bug waiting for the day somebody reads a binding at the top level.
 * - The core never imports the shell: no Tauri, no React, nothing from `apps`.
 *   It runs in node for every test and in the portal, neither of which has them.
 * - `domain/` is pure. It does not import services, repos or anything that
 *   talks to a database -- pricing and tax are arithmetic, and a function that
 *   needs a driver to add up a bill is not arithmetic any more.
 * - No source file over 600 lines, `db/schema.ts` excepted: it is the database
 *   written out one table to a block, and splitting it would scatter the one
 *   thing somebody reads end to end.
 * - No module importing more than 16 others. Past that a file is doing several
 *   jobs, whatever its length says.
 *
 * The scan reads source as text, with comments blanked, so a rule can be named
 * in the prose that explains it without tripping itself.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const MAX_LINES = 600
const MAX_FAN_OUT = 16
const LONG_ALLOWED = new Set(['db/schema.ts'])
/* A barrel's job is to import everything; its fan-out is its purpose. The
   area barrels under `api/` are barrels too (4 October): each is one of the
   entry points core is published in. */
const FAN_OUT_ALLOWED = new Set(['index.ts'])
const isBarrel = (file: string) => FAN_OUT_ALLOWED.has(file) || /^api\/[a-z]+\.ts$/.test(file)

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return everyFile(path)
    return /\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

/** Comments blanked, line numbering intact. */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (line, lead: string) => lead + ' '.repeat(line.length - lead.length))
}

/** Every module specifier a file names: static, re-exported and dynamic. */
export function specifiers(source: string): string[] {
  const code = withoutComments(source)
  const found: string[] = []
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1]!)
  }
  return found
}

/** A relative specifier as the file it names, or null for a package. */
function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]
  return candidates.find((c) => existsSync(c)) ?? base
}

/** Lines as an editor numbers them: a final newline does not start another. */
export function lineCount(source: string): number {
  return source.replace(/\r?\n$/, '').split('\n').length
}

function name(file: string): string {
  return relative(SRC, file).split(sep).join('/')
}

const files = everyFile(SRC)
const graph = new Map<string, string[]>(files.map((file) => {
  const local = specifiers(readFileSync(file, 'utf8'))
    .map((spec) => resolveLocal(file, spec))
    .filter((f): f is string => f !== null)
  return [file, [...new Set(local)]]
}))

/** Tarjan: every strongly connected component with more than one module in it. */
export function cyclesIn(edges: Map<string, string[]>): string[][] {
  let next = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const found: string[][] = []

  const visit = (v: string) => {
    index.set(v, next)
    low.set(v, next)
    next++
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) ?? []) {
      if (!edges.has(w)) continue
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(w)
      } while (w !== v)
      if (component.length > 1 || (edges.get(v) ?? []).includes(v)) found.push(component)
    }
  }

  for (const v of edges.keys()) if (!index.has(v)) visit(v)
  return found
}

describe('the core', () => {
  it('is looking at real source, so an empty result means something', () => {
    expect(files.length).toBeGreaterThan(90)
    expect(files.some((f) => name(f) === 'services/billing.ts')).toBe(true)
    expect(files.some((f) => name(f) === 'domain/pricing.ts')).toBe(true)
  })

  it('has no import cycles', () => {
    const cycles = cyclesIn(graph).map((c) => c.map(name).sort().join(' <-> '))
    expect(cycles).toEqual([])
  })

  it('never imports the shell: no Tauri, no React, nothing from apps', () => {
    const found: string[] = []
    for (const [file] of graph) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const escapes = spec.startsWith('.') && !resolve(dirname(file), spec).startsWith(SRC)
        if (/^@tauri-apps\//.test(spec) || /^react(-dom)?(\/|$)/.test(spec) || /(^|\/)apps\//.test(spec) || escapes) {
          found.push(`${name(file)} imports ${spec}`)
        }
      }
    }
    expect(found).toEqual([])
  })

  it('keeps domain/ pure: no services, no repos, no database', () => {
    const found: string[] = []
    for (const [file, deps] of graph) {
      if (!name(file).startsWith('domain/')) continue
      for (const dep of deps) {
        if (/^(services|repos|db|integrity)\//.test(name(dep))) found.push(`${name(file)} imports ${name(dep)}`)
      }
      const code = withoutComments(readFileSync(file, 'utf8'))
      if (/\bSqlDriver\b/.test(code)) found.push(`${name(file)} names SqlDriver`)
      if (/^drizzle-orm/m.test(specifiers(readFileSync(file, 'utf8')).join('\n'))) found.push(`${name(file)} imports drizzle`)
    }
    expect(found).toEqual([])
  })

  it(`has no source file over ${MAX_LINES} lines`, () => {
    const long = files
      .filter((f) => !LONG_ALLOWED.has(name(f)))
      .map((f) => ({ file: name(f), lines: lineCount(readFileSync(f, 'utf8')) }))
      .filter((f) => f.lines > MAX_LINES)
      .map((f) => `${f.file}: ${f.lines}`)
    expect(long).toEqual([])
  })

  it(`has no module importing more than ${MAX_FAN_OUT} others`, () => {
    const wide = [...graph]
      .filter(([file]) => !isBarrel(name(file)))
      .filter(([, deps]) => deps.length > MAX_FAN_OUT)
      .map(([file, deps]) => `${name(file)}: ${deps.length}`)
    expect(wide).toEqual([])
  })
})

describe('the published areas', () => {
  it('only re-export: nothing is defined in a barrel, so an area is never a second home for code', () => {
    const offending: string[] = []
    for (const file of files.filter((f) => isBarrel(name(f)))) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('//'))
        .join('\n')
      // Every statement is an `export ... from '...'`, possibly over several lines.
      const statements = code.split(/(?<=from '[^']+')\n?/).map((s) => s.trim()).filter(Boolean)
      for (const s of statements) {
        if (!/^export\s/.test(s) || !/from '[^']+'$/.test(s)) offending.push(`${name(file)}: ${s.slice(0, 60)}`)
      }
    }
    expect(offending).toEqual([])
  })

  it('are each a published entry point', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> }
    for (const file of files.filter((f) => /^api\//.test(name(f)))) {
      const area = name(file).replace(/^api\//, '').replace(/\.ts$/, '')
      expect(pkg.exports[`./${area}`], `${area} is published`).toBe(`./src/api/${area}.ts`)
    }
  })
})

describe('the scanner itself', () => {
  it('finds a cycle when there is one, and only then', () => {
    const edges = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']]])
    expect(cyclesIn(edges).map((c) => c.sort())).toEqual([['a', 'b', 'c']])
    expect(cyclesIn(new Map([['a', ['b']], ['b', []]]))).toEqual([])
  })

  it('reads static, type-only, re-exported and dynamic imports', () => {
    const source = [
      `import { a } from './a.js'`,
      `import type { B } from './b.js'`,
      `export { c } from './c.js'`,
      `export * as D from './d.js'`,
      `const e = await import('./e.js')`,
      `import {`,
      `  f,`,
      `} from './f.js'`,
    ].join('\n')
    expect(specifiers(source).sort()).toEqual(['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js'])
  })

  it('does not count an import named in a comment', () => {
    const source = `// import { x } from './x.js'\n/* import { y } from './y.js' */\nconst z = 1`
    expect(specifiers(source)).toEqual([])
  })
})
