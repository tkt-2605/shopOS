#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { migrate } from '@shopos/core'
import { openDatabase } from '@shopos/core/node'
import { MIGRATIONS } from '@shopos/core/migrations'
import { contents, disagreementsBetween, heldFromJson, type Row } from './books.js'

/**
 * Whether tills in separate processes hold the same books.
 *
 *   compare a1.json a2.json a3.json
 *
 * Each file is what `/control/dump` answered. The first is the one the others
 * are held to. Exits 0 when every till holds every row the same, 1 with the
 * rows that differ -- the same rule the in-process scenarios use, from
 * `books.ts`, so "converged" means one thing on the bench and in the soak.
 */

async function seededRows(): Promise<Map<string, Set<string>>> {
  /* What a migration writes on every till for itself: a till migrated and
     nothing else, the way `openShop` takes it from a till before pairing. */
  const dir = mkdtempSync(join(tmpdir(), 'shopos-compare-'))
  const db = openDatabase(join(dir, 'shop.db'))
  try {
    await migrate(db, MIGRATIONS)
    const seeded = new Map<string, Set<string>>()
    for (const [table, rows] of await contents(db)) seeded.set(table, new Set(rows.keys()))
    return seeded
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const files = process.argv.slice(2)
  if (files.length < 2) {
    process.stderr.write('compare <dump.json> <dump.json> [...]\n')
    process.exit(2)
  }
  const tills = files.map((f) => ({
    label: basename(f, '.json'),
    held: heldFromJson(JSON.parse(readFileSync(f, 'utf8')) as Record<string, Record<string, Row>>),
  }))
  const found = disagreementsBetween(tills, await seededRows())
  if (found.length === 0) {
    const rows = [...tills[0]!.held.values()].reduce((n, t) => n + t.size, 0)
    process.stdout.write(`same books on all ${tills.length} tills (${rows} rows)\n`)
    return
  }
  process.stdout.write(`${found.length} row(s) differ:\n`)
  for (const d of found.slice(0, 25)) {
    process.stdout.write(`  ${d.till}  ${d.table} ${d.rowId}  ${d.detail}\n`)
  }
  if (found.length > 25) process.stdout.write(`  ... and ${found.length - 25} more\n`)
  process.exit(1)
}

void main().catch((err: unknown) => {
  process.stderr.write(`compare: ${String(err)}\n`)
  process.exit(2)
})
