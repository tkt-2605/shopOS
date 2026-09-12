import type { SqlDriver } from './driver.js'

export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Migrations are immutable once released. Editing a shipped migration means two
 * shops with the same user_version have different schemas — the exact drift the
 * previous system died of. Add a new file instead.
 */
export async function migrate(db: SqlDriver, migrations: Migration[]): Promise<number> {
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  assertContiguous(ordered)

  const row = await db.get<{ user_version: number }>('PRAGMA user_version')
  const current = row?.user_version ?? 0
  const pending = ordered.filter((m) => m.version > current)
  if (pending.length === 0) return current

  for (const m of pending) {
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(m.sql)) {
        await tx.execute(statement)
      }
      // PRAGMA will not bind a parameter, and the value is a validated integer.
      await tx.execute(`PRAGMA user_version = ${m.version}`)
    })
  }

  return pending[pending.length - 1]?.version ?? current
}

export async function currentVersion(db: SqlDriver): Promise<number> {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version')
  return row?.user_version ?? 0
}

function assertContiguous(ordered: Migration[]): void {
  ordered.forEach((m, i) => {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(`migration version must be a positive integer: ${m.name}`)
    }
    if (m.version !== i + 1) {
      throw new Error(`migration versions must be contiguous from 1; found ${m.version} at position ${i + 1}`)
    }
  })
}

/**
 * Splits on semicolons at statement level, keeping CREATE TRIGGER bodies intact —
 * their inner statements end in semicolons too.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buffer = ''
  let inBlock = false

  for (const rawLine of sql.split('\n')) {
    const line = rawLine.replace(/--.*$/, '')
    if (line.trim() === '') {
      if (buffer.trim() !== '') buffer += '\n'
      continue
    }

    buffer += line + '\n'

    if (/\bBEGIN\b/i.test(line) && /\bCREATE\s+TRIGGER\b/i.test(buffer)) inBlock = true

    if (inBlock) {
      if (/\bEND\s*;/i.test(line)) {
        out.push(buffer.trim())
        buffer = ''
        inBlock = false
      }
      continue
    }

    if (line.trimEnd().endsWith(';')) {
      out.push(buffer.trim())
      buffer = ''
    }
  }

  if (buffer.trim() !== '') out.push(buffer.trim())
  return out.filter((s) => s !== '' && s !== ';')
}
