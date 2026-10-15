import { migrate, type SqlDriver } from '@shopos/core'
import { openMemoryDatabase } from '@shopos/core/node'
import { MIGRATIONS } from '@shopos/core/migrations'
import { contents, disagreementsBetween, type Disagreement } from '../../virtual-till/src/books.js'

/*
 * Why two tills disagree: every row one holds that the other does not, or
 * holds differently, on every table that travels. The same comparison the
 * soak tests use to say tills have converged (`virtual-till/src/books.ts`),
 * pointed at two real databases.
 */

/** Rows every till writes for itself at upgrade time, compared by contents only. */
async function seededRows(): Promise<Map<string, Set<string>>> {
  const db = openMemoryDatabase()
  try {
    // A till migrated and nothing else, as `virtual-till/src/compare.ts` takes it.
    await migrate(db, MIGRATIONS)
    const seeded = new Map<string, Set<string>>()
    for (const [table, rows] of await contents(db)) seeded.set(table, new Set(rows.keys()))
    return seeded
  } finally {
    await db.close()
  }
}

export async function diffShops(a: SqlDriver, b: SqlDriver, labels: [string, string] = ['A', 'B']): Promise<Disagreement[]> {
  return disagreementsBetween(
    [{ label: labels[0], held: await contents(a) }, { label: labels[1], held: await contents(b) }],
    await seededRows(),
  )
}

export function renderDiff(found: readonly Disagreement[], limit = 60): string {
  if (found.length === 0) return 'The two hold the same on every table that travels.'
  const byTable = new Map<string, number>()
  for (const d of found) byTable.set(d.table, (byTable.get(d.table) ?? 0) + 1)
  return [
    `${found.length} row(s) differ: ${[...byTable].map(([t, n]) => `${n} ${t}`).join(', ')}`,
    ...found.slice(0, limit).map((d) => `  ${d.table} ${d.rowId}: ${d.detail}`),
    ...(found.length > limit ? [`  ... and ${found.length - limit} more`] : []),
  ].join('\n')
}
