import type { SqlDriver } from '../../db/driver.js'
import { applyingRemote } from '../changefeed.js'

/**
 * `document_items.fulfilled_qty`, held to the records of what each line became.
 *
 * A line has been fulfilled by what bills took from it (`bill_fulfilments`,
 * removed when the bill is cancelled) and what conversions took from it
 * (`document_fulfilments`, 054). The figure itself is raised in place, one step
 * at a time, and two tills billing or converting against one order while apart
 * each raise their own copy -- one copy of the order wins the merge and the
 * other's step is gone, while the records of both arrive.
 *
 * Only ever raised. Too high refuses a second delivery against the order until
 * a person looks; too low -- which is what a bill or conversion not arrived
 * yet would make it look -- would let the same order be billed twice. A
 * difference downwards, or a line fulfilled beyond what it ordered (two tills
 * converting the same quotation while apart), is returned and left for a person.
 */

export interface FulfilledDrift {
  documentItemId: string
  stored: number
  derived: number
  /** False for a difference this pass deliberately does not act on. */
  repairable: boolean
}

/* raw: correlated sums per line, which the builder cannot say. */
const DERIVED = `
  SELECT di.id AS document_item_id, di.document_id, di.qty, di.fulfilled_qty AS stored,
         COALESCE((SELECT SUM(bf.qty) FROM bill_fulfilments bf WHERE bf.document_item_id = di.id), 0)
       + COALESCE((SELECT SUM(df.qty) FROM document_fulfilments df WHERE df.document_item_id = di.id), 0) AS derived
    FROM document_items di`

/** Enough placeholders per statement to stay well under SQLite's limit. */
const CHUNK = 400

/**
 * Every order line whose fulfilled quantity disagrees with its records, and,
 * with `repair`, the ones that are safe to raise put right -- written as a
 * merge is. `documentIds` scopes it to the documents a batch touched; null or
 * absent means every line.
 */
export async function reconcileFulfilledQty(
  db: SqlDriver, opts: { repair?: boolean; documentIds?: readonly string[] | null } = {},
): Promise<FulfilledDrift[]> {
  const scope = opts.documentIds ?? null
  if (scope !== null && scope.length === 0) return []

  const drift: FulfilledDrift[] = []
  for (let i = 0; i < (scope?.length ?? 1); i += CHUNK) {
    const ids = scope === null ? null : scope.slice(i, i + CHUNK)
    const where = ids === null ? '' : ` WHERE di.document_id IN (${ids.map(() => '?').join(', ')})`
    const rows = await db.query<{ document_item_id: string; qty: number; stored: number; derived: number }>(
      `SELECT * FROM (${DERIVED}${where}) WHERE stored <> derived`, ids ?? [],
    )
    drift.push(...rows.map((r) => ({
      documentItemId: r.document_item_id, stored: r.stored, derived: r.derived,
      repairable: r.derived > r.stored && r.derived <= r.qty,
    })))
  }

  const fix = drift.filter((d) => d.repairable)
  if (opts.repair && fix.length > 0) {
    await applyingRemote(db, async (tx) => {
      for (const d of fix) {
        // raw: the derived figure comes from the correlated query above.
        await tx.execute('UPDATE document_items SET fulfilled_qty = MAX(fulfilled_qty, ?) WHERE id = ?',
          [d.derived, d.documentItemId])
      }
    })
  }
  return drift
}
