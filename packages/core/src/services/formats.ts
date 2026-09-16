import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { getSetting, setSetting } from './bootstrap.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import {
  STANDARD_FOR, channelOf, checkFormat, withEveryBlock,
  type Block, type Channel, type DocFormat, type FormatProblem, type PaperSize,
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

/** The columns every read of this table wants. One list, so they cannot drift. */
const formatShape = {
  id: schema.docFormats.id,
  name: schema.docFormats.name,
  paper: schema.docFormats.paper,
  kinds: schema.docFormats.kinds,
  blocks: schema.docFormats.blocks,
  template: schema.docFormats.template,
  updatedAt: schema.docFormats.updatedAt,
}

type Row = { [K in keyof typeof formatShape]: K extends 'template' ? string | null : string }

/* Both shipped formats. Each is the floor its own print path lands on when
   anything else is missing, so neither can be deleted. */
const BUILT_IN = new Set(Object.values(STANDARD_FOR).map((f) => f.id))

export async function listFormats(db: SqlDriver, paper?: PaperSize): Promise<StoredFormat[]> {
  const rows = await q(db)
    .select(formatShape)
    .from(schema.docFormats)
    .where(paper ? eq(schema.docFormats.paper, paper) : undefined)
    .orderBy(schema.docFormats.createdAt)
  return rows.map(readRow).filter((f): f is StoredFormat => f !== null)
}

export async function loadFormat(db: SqlDriver, id: string): Promise<StoredFormat | null> {
  const [row] = await q(db)
    .select(formatShape)
    .from(schema.docFormats)
    .where(eq(schema.docFormats.id, id))
  return row ? readRow(row) : null
}

/**
 * Which format a document is currently printed with, per machine.
 *
 * A setting per kind and channel rather than a column on the table, because
 * "the format bills use" is a choice about the shop, not a property of any one
 * format — and it is two choices, since the till roll and the sheet handed to a
 * business customer are different documents. A flag on the row would need every
 * other row cleared on each change, with a moment mid-write where two are
 * active or none is.
 */
const CHOICE = (kind: string, channel: Channel) => `format_${kind}_${channel}`

export async function chosenFormatId(
  db: SqlDriver,
  kind: string,
  channel: Channel,
): Promise<string | null> {
  return (await getSetting(db, CHOICE(kind, channel))) || null
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

  // The format's own paper says which machine this is a choice about, so
  // picking an A4 layout cannot quietly change what the till prints.
  const channel = channelOf(format.paper)
  const before = await chosenFormatId(db, kind, channel)
  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    await setSetting(tx, CHOICE(kind, channel), id, now)
    await writeAudit(tx, ctx, {
      entity: 'doc_format',
      entityId: id,
      action: 'update',
      before: { [`chosen_${kind}_${channel}`]: before },
      after: { [`chosen_${kind}_${channel}`]: id },
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
  want: { kind: string; channel: Channel },
): Promise<DocFormat> {
  const usable = (await listFormats(db)).filter(
    (f) => f.kinds.includes(want.kind) && channelOf(f.paper) === want.channel,
  )

  const chosen = await chosenFormatId(db, want.kind, want.channel)
  const picked = (chosen && usable.find((f) => f.id === chosen)) || usable[0]

  return picked ?? STANDARD_FOR[want.channel]
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
  /** The shop's own HTML for a sheet. Blank or absent means the blocks lay it out. */
  template?: string | null
}

export async function saveFormat(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: FormatInput,
): Promise<SaveFormatResult> {
  /* An all-whitespace template is no template: it is what a shop leaves behind
     when it selects everything in the box and deletes it, and storing it would
     leave a format that renders a blank sheet rather than going back to the
     blocks. Normalised here rather than at four call sites. */
  const template = (input.template ?? '').trim()
  const clean: FormatInput = {
    ...input,
    name: input.name.trim(),
    template: template === '' ? null : template,
  }

  const problems = checkFormat(clean)
  if (problems.length > 0) return { ok: false, problems }

  const id = clean.id ?? newId()
  const before = clean.id ? await loadFormat(db, clean.id) : null
  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    const fields = {
      name: clean.name,
      paper: clean.paper,
      kinds: json(clean.kinds),
      blocks: json(clean.blocks),
      template: clean.template ?? null,
      updatedAt: now,
    }
    if (before) {
      await q(tx).update(schema.docFormats).set(fields).where(eq(schema.docFormats.id, id))
    } else {
      await q(tx).insert(schema.docFormats).values({ ...fields, id, createdAt: now })
    }

    /* The blocks go in as one field rather than fifteen. What a person wants
       from this history is "Ravi changed the receipt on Tuesday" and the two
       versions to compare — not thirteen rows saying a switch moved. */
    await writeAudit(tx, ctx, {
      entity: 'doc_format',
      entityId: id,
      action: before ? 'update' : 'create',
      /* The template goes in as "yes there is one" rather than as the markup.
         A history page is for "Ravi changed the A4 sheet on Tuesday"; four
         kilobytes of HTML in an audit row is four kilobytes nobody reads. */
      before: before
        ? { name: before.name, paper: before.paper, blocks: json(before.blocks), template: had(before.template) }
        : null,
      after: {
        name: clean.name, paper: clean.paper, blocks: json(clean.blocks),
        template: had(clean.template),
      },
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
  if (BUILT_IN.has(id)) return { ok: false, code: 'BUILT_IN' }

  const before = await loadFormat(db, id)
  if (!before) return { ok: false, code: 'NOT_FOUND' }

  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    await q(tx).delete(schema.docFormats).where(eq(schema.docFormats.id, id))

    /* A choice pointing at a format that is gone would print the standard while
       the screen still named the deleted one. Clearing it here keeps the two
       from disagreeing. */
    const channel = channelOf(before.paper)
    for (const kind of before.kinds) {
      if ((await getSetting(tx, CHOICE(kind, channel))) === id) {
        await setSetting(tx, CHOICE(kind, channel), '', now)
      }
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

/** What the history says about a template, which is not the template. */
function had(template: string | null | undefined): string {
  return (template ?? '').trim() === '' ? 'laid out by blocks' : 'the shop’s own HTML'
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
      template: row.template,
    }

    // A format saved before a block existed must not silently lose it.
    return { ...withEveryBlock(format), updatedAt: row.updatedAt, builtIn: BUILT_IN.has(row.id) }
  } catch {
    return null
  }
}
