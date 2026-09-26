import { eq, and, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId, derivedId } from '../ids.js'
import { parseMoney, type Money } from '../money.js'
import { parseQty, type Qty } from '../quantity.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { parseCsvRecords, toCsv } from '../domain/csv.js'
import { isHsn } from '../domain/hsn.js'
import { businessDate } from '../dates.js'
import { createStockEntry, submitStockEntry } from './stockEntry.js'

/**
 * Getting a shop's catalogue in, from the spreadsheet it already has.
 *
 * Until this existed, onboarding a shop meant typing two thousand items at
 * the counter. That is not a slow start, it is a reason not to buy.
 *
 * ## Nothing happens until somebody has seen what will happen
 *
 * `planImport` reads the file and decides, row by row, what it *would* do. It
 * writes nothing. `applyImport` takes that plan and carries it out in one
 * transaction.
 *
 * The split is the whole design. A shopkeeper handing over a file they got
 * from a wholesaler has no idea what is in it, and the two failures that
 * matter -- silently creating four hundred duplicates, and silently changing
 * the price of everything they sell -- are both invisible at the moment they
 * happen and expensive a week later. So the counts are shown first, with the
 * reason for every row that will be skipped, and the apply is a second
 * decision.
 *
 * ## Matching
 *
 * Barcode first, then exact name. In that order and no fuzzier, because the
 * cost of a wrong match is worse than the cost of a duplicate: a duplicate is
 * visible in a list and can be merged, while a wrong match has quietly
 * overwritten the price of something else.
 *
 * Names are matched case-insensitively and trimmed -- `Rice 5kg ` and
 * `rice 5kg` are one item, and a shop that has both in a spreadsheet meant
 * one.
 */

/** The columns a file may carry. Only `name` is required. */
export const IMPORT_COLUMNS = [
  'name', 'barcode', 'hsn', 'tax', 'unit', 'rate', 'mrp', 'openingqty',
] as const

export type ImportAction = 'create' | 'update'

export type RowProblem =
  /** No name, and a product without one cannot be sold or found. */
  | 'NO_NAME'
  /** A rate that is not a number. Blank is fine; `12.3.4` is not. */
  | 'BAD_RATE'
  | 'BAD_MRP'
  /** A tax rate that is not a number, or is not a percentage. */
  | 'BAD_TAX'
  | 'BAD_QTY'
  /** Not 4, 6 or 8 digits. A warning everywhere else; here it is a refusal. */
  | 'BAD_HSN'
  /** The same barcode twice in one file, which cannot both be right. */
  | 'BARCODE_TWICE'
  /** The same name twice in one file. */
  | 'NAME_TWICE'
  /** This barcode already belongs to a different product in the shop. */
  | 'BARCODE_TAKEN'

export interface PlannedRow {
  /** 1-based, counting the header, so it matches what Excel shows. */
  line: number
  name: string
  action: ImportAction | null
  problem: RowProblem | null
  /** The product this row would change, when the action is `update`. */
  productId: string | null
  barcode: string | null
  hsn: string | null
  taxRateBp: number | null
  rate: Money | null
  mrp: Money | null
  unit: string | null
  openingQty: Qty | null
}

export interface ImportPlan {
  /** Headers as they were found, after normalising. */
  headers: string[]
  /** Columns in the file this import does not know. Carried, never guessed at. */
  unknownColumns: string[]
  rows: PlannedRow[]
  create: number
  update: number
  skip: number
}

/**
 * What the file would do, without doing any of it.
 *
 * Never throws on bad content: a file full of rubbish is a plan full of
 * problems, which is a thing a screen can show. Throwing would leave the
 * shopkeeper with a stack trace and no idea which line was wrong.
 */
export async function planImport(db: SqlDriver, text: string): Promise<ImportPlan> {
  const { headers, rows } = parseCsvRecords(text)
  const known = new Set<string>(IMPORT_COLUMNS)

  const existing = await q(db)
    .select({
      id: schema.products.id,
      name: schema.products.name,
      barcode: schema.products.barcode,
    })
    .from(schema.products)
    .where(isNull(schema.products.deletedAt))

  const byBarcode = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const p of existing) {
    if (p.barcode !== null && p.barcode !== '') byBarcode.set(p.barcode, p.id)
    byName.set(p.name.trim().toLowerCase(), p.id)
  }

  const seenBarcodes = new Set<string>()
  const seenNames = new Set<string>()
  const planned: PlannedRow[] = []

  rows.forEach(({ line, values: row }) => {
    const name = (row['name'] ?? '').trim()
    const barcode = (row['barcode'] ?? '').trim() || null
    const hsn = (row['hsn'] ?? '').trim() || null
    const unit = (row['unit'] ?? '').trim() || null

    const refuse = (problem: RowProblem): void => {
      planned.push({
        line, name, action: null, problem, productId: null,
        barcode, hsn, taxRateBp: null, rate: null, mrp: null, unit, openingQty: null,
      })
    }

    if (name === '') { refuse('NO_NAME'); return }
    if (hsn !== null && !isHsn(hsn)) { refuse('BAD_HSN'); return }

    const rate = money(row['rate'])
    if (rate === 'bad') { refuse('BAD_RATE'); return }
    const mrp = money(row['mrp'])
    if (mrp === 'bad') { refuse('BAD_MRP'); return }

    const taxRateBp = tax(row['tax'])
    if (taxRateBp === 'bad') { refuse('BAD_TAX'); return }

    const openingQty = quantity(row['openingqty'])
    if (openingQty === 'bad') { refuse('BAD_QTY'); return }

    const lowerName = name.toLowerCase()
    if (barcode !== null && seenBarcodes.has(barcode)) { refuse('BARCODE_TWICE'); return }
    if (seenNames.has(lowerName)) { refuse('NAME_TWICE'); return }

    /* Barcode first, then exact name. A row with a barcode that belongs to a
       *differently named* product is refused rather than matched: the file
       and the shop disagree about what that code is, and guessing either way
       silently renames something or duplicates it. */
    const matchedByBarcode = barcode === null ? undefined : byBarcode.get(barcode)
    const matchedByName = byName.get(lowerName)
    if (matchedByBarcode !== undefined
        && matchedByName !== undefined
        && matchedByBarcode !== matchedByName) {
      refuse('BARCODE_TAKEN')
      return
    }

    const productId = matchedByBarcode ?? matchedByName ?? null

    if (barcode !== null) seenBarcodes.add(barcode)
    seenNames.add(lowerName)

    planned.push({
      line,
      name,
      action: productId === null ? 'create' : 'update',
      problem: null,
      productId,
      barcode,
      hsn,
      taxRateBp: taxRateBp === null ? null : taxRateBp,
      rate: rate === null ? null : rate,
      mrp: mrp === null ? null : mrp,
      unit,
      openingQty: openingQty === null ? null : openingQty,
    })
  })

  return {
    headers,
    unknownColumns: headers.filter((h) => h !== '' && !known.has(h)),
    rows: planned,
    create: planned.filter((r) => r.action === 'create').length,
    update: planned.filter((r) => r.action === 'update').length,
    skip: planned.filter((r) => r.problem !== null).length,
  }
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
}

/** The catalogue's result, which alone can carry stock. */
export interface CatalogueImportResult extends ImportResult {
  /** New items that came in with stock, posted as one opening entry. */
  stocked: number
  /**
   * Existing items whose opening quantity was left alone. A file exported from
   * here carries the shop's current count in that column, so posting it again
   * on the way back in would double the stock of everything in it.
   */
  stockIgnored: number
}

/**
 * Carries out a plan, in one transaction.
 *
 * One transaction because half an imported catalogue is worse than none: the
 * shopkeeper cannot tell which half, and running the file again would then
 * create duplicates of everything that did land. Either the file went in or
 * it did not.
 *
 * **A blank cell leaves the existing value alone.** A file that carries only
 * `name` and `rate` is a price update, and it must not wipe every HSN code in
 * the shop on its way through. That is why every field is nullable in
 * `PlannedRow` and why the update below is built one key at a time.
 */
export async function applyImport(
  db: SqlDriver, ctx: AuditContext, plan: ImportPlan,
): Promise<CatalogueImportResult> {
  const usable = plan.rows.filter((r) => r.problem === null && r.action !== null)
  const now = new Date().toISOString()
  let created = 0
  let updated = 0
  const opening: { productId: string; qty: Qty }[] = []
  let stockIgnored = 0
  await db.transaction(async (tx) => {
    for (const row of usable) {
      if (row.action === 'create') {
        const id = await importedProductId(tx, row.barcode, row.name)
        await q(tx).insert(schema.products).values({
          id,
          name: row.name,
          barcode: row.barcode,
          hsnCode: row.hsn,
          baseUnit: row.unit ?? 'piece',
          taxRateBp: row.taxRateBp ?? 0,
          baseRate: row.rate ?? (0 as Money),
          mrp: row.mrp,
          createdAt: now,
          updatedAt: now,
        })
        await writeAudit(tx, ctx, {
          entity: 'products', entityId: id, action: 'create',
          after: { name: row.name, base_rate: row.rate ?? 0, source: 'csv import' },
        })
        created += 1
        if (row.openingQty !== null && row.openingQty > 0) opening.push({ productId: id, qty: row.openingQty })
        continue
      }
      if (row.openingQty !== null && row.openingQty > 0) stockIgnored += 1
      /* Only what the file actually said. `undefined` is "the file was
         silent"; a blank cell parses to null above and lands here as
         undefined, so it is never written. */
      const change: Record<string, unknown> = { updatedAt: now }
      if (row.barcode !== null) change['barcode'] = row.barcode
      if (row.hsn !== null) change['hsnCode'] = row.hsn
      if (row.unit !== null) change['baseUnit'] = row.unit
      if (row.taxRateBp !== null) change['taxRateBp'] = row.taxRateBp
      if (row.rate !== null) change['baseRate'] = row.rate
      if (row.mrp !== null) change['mrp'] = row.mrp

      await q(tx).update(schema.products)
        .set(change)
        .where(eq(schema.products.id, row.productId as string))

      await writeAudit(tx, ctx, {
        entity: 'products', entityId: row.productId as string, action: 'update',
        after: { ...(change as Record<string, never>), source: 'csv import' },
      })
      updated += 1
    }

    /* The column was read, checked, shown on the plan -- and then dropped here,
       so a shop that imported its catalogue with its stock got the catalogue and
       none of the stock. Posted as one opening entry, the document a first count
       is, inside this same transaction: the items and their stock land together
       or not at all. */
    if (opening.length > 0) {
      // A stock entry is signed by a person, and the table holds it to one.
      if (ctx.actorId === null) throw new Error('opening stock needs somebody signed in to record it')
      const entry = await createStockEntry(tx, {
        entryType: 'opening',
        lines: opening,
        reference: 'Catalogue import',
        postingDate: businessDate(),
        actorId: ctx.actorId,
      })
      if (!entry.ok) throw new Error(`the opening stock could not be recorded: ${entry.code}`)
      const posted = await submitStockEntry(tx, { entryId: entry.entryId, actorId: ctx.actorId })
      if (!posted.ok) throw new Error(`the opening stock could not be recorded: ${posted.code}`)
    }
  })

  return { created, updated, skipped: plan.skip, stocked: opening.length, stockIgnored }
}

/**
 * The catalogue as a file, in the same shape `planImport` reads.
 *
 * Round-tripping is the point: a shop exports, edits prices in Excel, and
 * imports the same file back. Every column here is one this importer
 * understands, and `csvRoundTrip.test.ts` holds that to account -- an export
 * with a column the import ignores is a column of edits that silently do
 * nothing.
 */
export async function exportCatalogue(db: SqlDriver): Promise<string> {
  const rows = await q(db)
    .select({
      name: schema.products.name,
      barcode: schema.products.barcode,
      hsn: schema.products.hsnCode,
      taxRateBp: schema.products.taxRateBp,
      unit: schema.products.baseUnit,
      rate: schema.products.baseRate,
      mrp: schema.products.mrp,
      // raw: the materialised count, left joined so an item never counted
      // still gets a row rather than vanishing from its own catalogue.
      onHand: sql<number>`COALESCE((SELECT ps.qty_on_hand FROM product_stock ps
                                     WHERE ps.product_id = products.id), 0)`,
    })
    .from(schema.products)
    .where(and(isNull(schema.products.deletedAt), eq(schema.products.isActive, 1)))
    .orderBy(schema.products.name)

  return toCsv(
    ['name', 'barcode', 'hsn', 'tax', 'unit', 'rate', 'mrp', 'openingqty'],
    rows.map((r) => [
      r.name,
      r.barcode ?? '',
      r.hsn ?? '',
      // Basis points back to the percentage a person typed.
      r.taxRateBp === 0 ? '' : String(r.taxRateBp / 100),
      r.unit,
      money2(r.rate),
      r.mrp === null ? '' : money2(r.mrp),
      String(r.onHand / 10_000),
    ]),
  )
}

/* ── reading one cell ──────────────────────────────────────────────────── */

/** `null` for a blank cell, `'bad'` for one that is not a number. */
function money(raw: string | undefined): Money | null | 'bad' {
  const text = (raw ?? '').trim()
  if (text === '') return null
  // A file from a wholesaler often carries the symbol and thousands commas.
  const cleaned = text.replace(/[₹,\s]/g, '')
  const value = parseMoney(cleaned)
  // A price below zero is not a price.
  return value === null || value < 0 ? 'bad' : value
}

function money2(value: Money): string {
  return (value / 100).toFixed(2)
}

/**
 * A tax percentage as basis points.
 *
 * `5`, `5%` and `5.0` are all five per cent. A number above 100 is refused
 * rather than clamped: somebody has typed basis points into a percent column,
 * and importing it as 2,800% tax would be visible only on the first bill.
 */
function tax(raw: string | undefined): number | null | 'bad' {
  const text = (raw ?? '').trim().replace('%', '')
  if (text === '') return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 100) return 'bad'
  return Math.round(value * 100)
}

function quantity(raw: string | undefined): Qty | null | 'bad' {
  const text = (raw ?? '').trim()
  if (text === '') return null
  const value = parseQty(text)
  // Opening stock is what is on the shelf, which is not below nothing.
  return value === null || value < 0 ? 'bad' : value
}

/**
 * The id an imported product is created under.
 *
 * Derived from what the row is -- its barcode, or its name where it has none --
 * so two tills importing the same file while apart create the same product
 * rather than two, which the merge then joins into one. A random id would give
 * the shop every item twice, and nothing would refuse it: `code` is empty on
 * an import, so no UNIQUE is there to notice.
 *
 * A hint and not a key. A name can be changed; if something already holds the
 * derived id here -- an item renamed and then imported again -- the row gets a
 * fresh one instead of failing the whole import on a primary key.
 */
async function importedProductId(tx: SqlDriver, barcode: string | null, name: string): Promise<string> {
  const id = await derivedId('products', 'import', barcode?.trim() || name.trim().toLowerCase())
  const [taken] = await q(tx).select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, id))
  return taken ? newId() : id
}
