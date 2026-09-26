import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

/**
 * The screens ask the core; they do not reach past it.
 *
 * Two rules, and both had been broken before this test existed. Five files in
 * the app wrote their own SQL -- a customer's name read for a printed
 * statement, today's takings for the dashboard -- which is a query the core
 * cannot see, cannot test against a real database, and will not update when a
 * migration renames the column under it. And a shell call made from a screen
 * is a screen that cannot be rendered in a test without pretending to be the
 * desktop.
 *
 * So:
 *
 * - No SQL in the app, and no driver calls, outside the driver itself.
 *   `CoreProvider.tsx` opens the database and the two wrappers around it
 *   (`nudgingDriver.ts`, `writeLock.ts`) are drivers in their own right: they
 *   implement `SqlDriver` and pass every call through. Everything else asks a
 *   function in `@shopos/core`.
 * - No `@tauri-apps` import outside `core/` -- not in `pages/`, not in `ui/`,
 *   not in `App.tsx`. The shell is reached through the adapters in `core/`,
 *   each of which has one job and a seam a test can replace.
 * - No file over 500 lines: pages, components, and the hooks and adapters in
 *   `core/` alike. Past that a screen is several screens, and a hook several
 *   jobs, and the next change to one of them is a change to all of them.
 *
 * Read as text with comments blanked, so a rule can be explained next to where
 * somebody would break it without the explanation tripping the scan.
 */

/* From the working directory: this project runs in jsdom, where the module URL
   is the dev server's and not a path. Vitest is configured at the repo root. */
const SRC = join(process.cwd(), 'apps', 'pos', 'src')

const MAX_COMPONENT_LINES = 500

/** The driver and the two wrappers that are drivers themselves. */
const DRIVERS = new Set(['core/CoreProvider.tsx', 'core/nudgingDriver.ts', 'core/writeLock.ts'])

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return everyFile(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

function name(file: string): string {
  return relative(SRC, file).split(sep).join('/')
}

/** Comments blanked, line numbering intact. */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (line, lead: string) => lead + ' '.repeat(line.length - lead.length))
}

/**
 * A statement, not a word. Upper case and followed by what that statement needs
 * next, so "Select a customer" on a button is not a query and neither is a
 * sentence that happens to say "update".
 */
const SQL = /\b(SELECT\s[\s\S]{0,400}?\bFROM\b|INSERT\s+(OR\s+\w+\s+)?INTO\b|UPDATE\s+["\w]+\s+SET\b|DELETE\s+FROM\b|PRAGMA\s+\w|CREATE\s+(TABLE|INDEX|TRIGGER)\b|DROP\s+TABLE\b|WITH\s+\w+\s+AS\s*\()/

/** A driver method called on something that is plainly a driver. */
const DRIVER_CALL = /\b(db|tx|driver|sql|core\.db)\s*\.\s*(query|queryValues|get|execute|transaction)\s*(<[^>()]*>)?\s*\(/

const TAURI = /(from\s*|import\s*\(\s*|import\s+)['"]@tauri-apps\//

export function lineCount(source: string): number {
  return source.replace(/\r?\n$/, '').split('\n').length
}

const files = everyFile(SRC)

function scan(pattern: RegExp, where: (file: string) => boolean): string[] {
  const found: string[] = []
  for (const file of files) {
    if (!where(name(file))) continue
    const code = withoutComments(readFileSync(file, 'utf8'))
    const lines = code.split('\n')
    lines.forEach((line, i) => {
      if (pattern.test(line)) found.push(`${name(file)}:${i + 1}`)
    })
    /* A statement written across lines is still a statement. */
    const whole = code.replace(/\s+/g, ' ')
    if (pattern === SQL && pattern.test(whole) && !found.some((f) => f.startsWith(`${name(file)}:`))) {
      found.push(name(file))
    }
  }
  return found
}

describe('the app', () => {
  it('is looking at real source, so an empty result means something', () => {
    expect(files.length).toBeGreaterThan(60)
    expect(files.some((f) => name(f) === 'pages/Billing.tsx')).toBe(true)
    expect(files.some((f) => name(f) === 'core/CoreProvider.tsx')).toBe(true)
  })

  it('writes no SQL outside the driver', () => {
    expect(scan(SQL, (f) => !DRIVERS.has(f))).toEqual([])
  })

  it('calls the driver nowhere but the driver', () => {
    expect(scan(DRIVER_CALL, (f) => !DRIVERS.has(f))).toEqual([])
  })

  it('calls the driver nowhere but the driver, whatever the variable is called', () => {
    /* The scan above goes by name -- `db`, `tx` -- and the independent review
       walked straight past it with `(d: SqlDriver) => d.query(...)`. This asks
       the compiler instead: any call to a driver method on a value whose type
       is a driver. A name can be anything; a type cannot be talked round. */
    expect(driverCallsByType()).toEqual([])
  }, 60_000)

  it('reaches the shell only through the adapters in core/', () => {
    expect(scan(TAURI, (f) => !f.startsWith('core/'))).toEqual([])
  })

  it(`has no file over ${MAX_COMPONENT_LINES} lines`, () => {
    const long = files
      .map((f) => ({ file: name(f), lines: lineCount(readFileSync(f, 'utf8')) }))
      .filter((f) => f.lines > MAX_COMPONENT_LINES)
      .map((f) => `${f.file}: ${f.lines}`)
    expect(long).toEqual([])
  })
})

describe('the scanner itself', () => {
  it('catches the queries it was written for', () => {
    const guilty = [
      'const row = await db.get<{ price_list_id: string | null }>(',
      '  `SELECT price_list_id FROM customers WHERE id = ?`, [id],',
      ')',
    ].join('\n')
    expect(SQL.test(withoutComments(guilty))).toBe(true)
    expect(DRIVER_CALL.test(withoutComments(guilty))).toBe(true)
    expect(DRIVER_CALL.test('await db.query<Movement>(')).toBe(true)
    expect(SQL.test('`UPDATE sync_conflicts SET acknowledged = 1`')).toBe(true)
  })

  it('does not fire on words a screen says to a person', () => {
    for (const text of [
      '<option>Select a customer</option>',
      "setError('Could not update the price list.')",
      "label: 'Delete from this list'",
      'const picked = items.get(id)',
      "window.localStorage.getItem('tab')",
    ]) {
      expect(SQL.test(text)).toBe(false)
      expect(DRIVER_CALL.test(text)).toBe(false)
    }
  })

  it('catches a Tauri import and ignores one named in a comment', () => {
    expect(TAURI.test(`import { invoke } from '@tauri-apps/api/core'`)).toBe(true)
    expect(TAURI.test(`const { open } = await import('@tauri-apps/plugin-dialog')`)).toBe(true)
    expect(TAURI.test(withoutComments(`// import { invoke } from '@tauri-apps/api/core'`))).toBe(false)
  })
})

/** The methods only a driver has, which is how a driver is recognised by type. */
const DRIVER_METHODS = new Set(['query', 'queryValues', 'get', 'execute', 'transaction'])

function driverCallsByType(): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(process.cwd(), 'apps', 'pos', 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )
  if (!config) throw new Error('could not read the app tsconfig')
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options })
  const checker = program.getTypeChecker()
  const found: string[] = []

  for (const source of program.getSourceFiles()) {
    const file = source.fileName.split('/').join(sep)
    if (!file.startsWith(SRC + sep)) continue
    const where = name(file)
    if (DRIVERS.has(where)) continue

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && DRIVER_METHODS.has(node.expression.name.text)) {
        const receiver = checker.getTypeAtLocation(node.expression.expression)
        /* `queryValues` is the driver's own: nothing else in the app has it,
           so a type carrying it and `transaction` is a driver. */
        if (receiver.getProperty('queryValues') && receiver.getProperty('transaction')) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart())
          found.push(`${where}:${line + 1}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}
