import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { getSetting, setSetting } from './bootstrap.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import {
  STANDARD_RECEIPT, checkFormat, withEveryBlock,
  type Block, type DocFormat, type FormatProblem, type PaperSize,
} from '../domain/docFormat.js'

/**
 * Where a shop's own bill layouts live.
 *
 * A table rather than a settings value, because this is a list: several formats
 * across two paper sizes, looked up by which document is being printed. A list
 * inside a settings blob is a list nothing can query, and the print path has to
 * ask "which format for a bill on 80mm" on every sale.
 */

export interface StoredFormat extends DocFormat {
  /** Storage facts, kept out of `DocFormat` so the renderer stays pure. */
  updatedAt: string
  /** The one the product ships with, which cannot be deleted. */
  builtIn: boolean
}

interface Row {
  id: string
  name: string
  paper: string
  kinds: string
  blocks: string
  updated_at: string
}

const BUILT_IN = STANDARD_RECEIPT.id

export async function listFormats(db: SqlDriver, paper?: PaperSize): Promise<StoredFormat[]> {
  const rows = await db.query<Row>(
    `SELECT id, name, paper, kinds, blocks, updated_at
       FROM doc_formats
      ${paper ? 'WHERE paper = ?' : ''}
      ORDER BY created_at`,
    paper ? [paper] : [],
  )
  return rows.map(readRow).filter((f): f is StoredFormat => f !== null)
}

export async function loadFormat(db: SqlDriver, id: string): Promise<StoredFormat | null> {
  const row = await db.get<Row>(
    `SELECT id, name, paper, kinds, blocks, updated_at FROM doc_formats WHERE id = ?`,
    [id],
  )
  return row ? readRow(row) : null
}

/**
 * Which format a document kind is currently printed with.
 *
 * One setting per kind rather than a column on the table, because "the format
 * bills use" is a single choice about the shop, not a property of any one
 * format. A flag on the row would need every other row cleared on each change,
 * and a moment mid-write where two are active or none is.
 */
const CHOICE = (kind: string) => `format_${kind}`

export async function chosenFormatId(db: SqlDriver, kind: string): Promise<string | null> {
  return (await getSetting(db, CHOICE(kind))) || null
}

export type ChooseResult = { ok: true } | { ok: false; code: 'NOT_FOUND' | 'WRONG_KIND' }

export async function chooseFormat(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  kind: string,
  id: string,
): Promise<ChooseResult> {
  const format = await loadFormat(db, id)
  if (!format) return { ok: false, code: 'NOT_FOUND' }
  if (!format.kinds.includes(kind)) return { ok: false, code: 'WRONG_KIND' }

  const before = await chosenFormatId(db, kind)
  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    await setSetting(tx, CHOICE(kind), id, now)
    await writeAudit(tx, ctx, {
      entity: 'doc_format',
      entityId: id,
      action: 'update',
      before: { [`chosen_for_${kind}`]: before },
      after: { [`chosen_for_${kind}`]: id },
    })
  })

  return { ok: true }
}

/**
 * The format the printer should use, which is never nothing.
 *
 * Printing is not a place to fail: a shop mid-sale needs paper out of the
 * machine more than it needs to be told its format row is missing. A format
 * that was chosen and then deleted, or a row that cannot be read, falls back to
 * the standard rather than throwing — and the standard is what the product
 * printed before any of this existed.
 */
export async function formatFor(
  db: SqlDriver,
  want: { kind: string; paper?: PaperSize },
): Promise<DocFormat> {
  const candidates = await listFormats(db, want.paper)
  const usable = candidates.filter((f) => f.kinds.includes(want.kind))

  const chosen = await chosenFormatId(db, want.kind)
  const picked = (chosen && usable.find((f) => f.id === chosen)) || usable[0]

  return picked ?? STANDARD_RECEIPT
}

export type SaveFormatResult =
  | { ok: true; id: string }
  | { ok: false; problems: FormatProblem[] }

export interface FormatInput {
  /** Absent for a format being created. */
  id?: string
  name: string
  paper: PaperSize
  kinds: string[]
  blocks: Block[]
}

export async function saveFormat(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: FormatInput,
): Promise<SaveFormatResult> {
  const clean: FormatInput = { ...input, name: input.name.trim() }

  const problems = checkFormat(clean)
  if (problems.length > 0) return { ok: false, problems }

  const id = clean.id ?? newId()
  const before = clean.id ? await loadFormat(db, clean.id) : null
  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    if (before) {
      await tx.execute(
        `UPDATE doc_formats SET name = ?, paper = ?, kinds = ?, blocks = ?, updated_at = ?
          WHERE id = ?`,
        [clean.name, clean.paper, json(clean.kinds), json(clean.blocks), now, id],
      )
    } else {
      await tx.execute(
        `INSERT INTO doc_formats (id, name, paper, kinds, blocks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, clean.name, clean.paper, json(clean.kinds), json(clean.blocks), now, now],
      )
    }

    /* The blocks go in as one field rather than fifteen. What a person wants
       from this history is "Ravi changed the receipt on Tuesday" and the two
       versions to compare — not thirteen rows saying a switch moved. */
    await writeAudit(tx, ctx, {
      entity: 'doc_format',
      entityId: id,
      action: before ? 'update' : 'create',
      before: before ? { name: before.name, paper: before.paper, blocks: json(before.blocks) } : null,
      after: { name: clean.name, paper: clean.paper, blocks: json(clean.blocks) },
    })
  })

  return { ok: true, id }
}

export type DeleteFormatResult =
  | { ok: true }
  | { ok: false; code: 'BUILT_IN' | 'NOT_FOUND' }

export async function deleteFormat(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  id: string,
): Promise<DeleteFormatResult> {
  /* The shipped format stays. It is the fallback the print path lands on when
     anything else is missing, and a shop that deleted it would have removed the
     floor it was standing on. */
  if (id === BUILT_IN) return { ok: false, code: 'BUILT_IN' }

  const before = await loadFormat(db, id)
  if (!before) return { ok: false, code: 'NOT_FOUND' }

  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(`DELETE FROM doc_formats WHERE id = ?`, [id])

    /* A choice pointing at a format that is gone would print the standard while
       the screen still named the deleted one. Clearing it here keeps the two
       from disagreeing. */
    for (const kind of before.kinds) {
      if ((await getSetting(tx, CHOICE(kind))) === id) await setSetting(tx, CHOICE(kind), '', now)
    }

    await writeAudit(tx, ctx, {
      entity: 'doc_format',
      entityId: id,
      action: 'delete',
      before: { name: before.name, paper: before.paper, blocks: json(before.blocks) },
      after: null,
    })
  })

  return { ok: true }
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * A row as a format, or null if the row cannot be believed.
 *
 * Two JSON columns written only by this file — but a format that fails to parse
 * must not take the print path down with it, so a bad row is dropped from the
 * list and `formatFor` lands on the standard instead.
 */
function readRow(row: Row): StoredFormat | null {
  try {
    const kinds: unknown = JSON.parse(row.kinds)
    const blocks: unknown = JSON.parse(row.blocks)
    if (!Array.isArray(kinds) || !Array.isArray(blocks)) return null

    const format: DocFormat = {
      id: row.id,
      name: row.name,
      paper: row.paper as PaperSize,
      kinds: kinds as string[],
      blocks: blocks as Block[],
    }

    // A format saved before a block existed must not silently lose it.
    return { ...withEveryBlock(format), updatedAt: row.updated_at, builtIn: row.id === BUILT_IN }
  } catch {
    return null
  }
}
