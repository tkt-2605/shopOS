import { eq, and, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId, derivedId } from '../ids.js'
import { parseMoney, ZERO, type Money } from '../money.js'
import { parseQty, QTY_SCALE, type Qty } from '../quantity.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { parseCsvRecords, toCsv } from '../domain/csv.js'
import { isHsn } from '../domain/hsn.js'
import { businessDate } from '../dates.js'
import { createStockEntry, submitStockEntry } from './stockEntry.js'
import { addPrimaryBarcode } from './barcodes.js'
import { requirePermission } from '../integrity/permissions.js'

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
 *
 * A name is an item *with its brand*. A stationery shop has Oil Pastels 12S
 * from Camel, Doms and Youva, and the counter tells them apart by the brand
 * beside the name, so a file may carry all three. A row that names no brand
 * matches on the name alone -- a file of names and rates is a price update --
 * and when that name is more than one item here it is refused rather than
 * given to whichever was found first.
 *
 * A name and brand may repeat when barcodes tell the items apart. Six exam pads
 * of no brand at six prices are six things on the shelf, and the shop's old
 * system held them under one name; refusing them made the import rename them,
 * which the shop then had to undo by hand. What stays refused is a repeat that
 * would have to *guess*: a row with no barcode, whose only handle is the name.
 * And a row whose barcode is new does not land on a same-named item that
 * already answers to a different code -- that is a second product, not a
 * second label for the first, and merging them would put two shelves' stock
 * and sales on one item. A second label is added on the item itself.
 */

/** The columns a file may carry. Only `name` is required. */
export const IMPORT_COLUMNS = [
  'name', 'brand', 'category', 'barcode', 'hsn', 'tax', 'unit', 'rate', 'mrp', 'cost', 'openingqty',
] as const

export type ImportAction = 'create' | 'update'

export type RowProblem =
  /** No name, and a product without one cannot be sold or found. */
  | 'NO_NAME'
  /** A rate that is not a number. Blank is fine; `12.3.4` is not. */
  | 'BAD_RATE'
  | 'BAD_MRP'
  | 'BAD_COST'
  /** A tax rate that is not a number, or is not a percentage. */
  | 'BAD_TAX'
  | 'BAD_QTY'
  /** Not 4, 6 or 8 digits. A warning everywhere else; here it is a refusal. */
  | 'BAD_HSN'
  /** The same barcode twice in one file, which cannot both be right. */
  | 'BARCODE_TWICE'
  /** The same name and brand twice in one file. */
  | 'NAME_TWICE'
  /** This barcode already belongs to a different product in the shop. */
  | 'BARCODE_TAKEN'
  /** No brand and no barcode, and the name is more than one item here. */
  | 'NAME_AMBIGUOUS'

export interface PlannedRow {
  /** 1-based, counting the header, so it matches what Excel shows. */
  line: number
  name: string
  action: ImportAction | null
  problem: RowProblem | null
  /** The product this row would change, when the action is `update`. */
  productId: string | null
  brand: string | null
  /** A category by name; one the shop does not have yet is made. */
  category: string | null
  barcode: string | null
  hsn: string | null
  taxRateBp: number | null
  rate: Money | null
  mrp: Money | null
  unit: string | null
  /** What one unit of the opening stock cost. Only read with `openingQty`, on a new item. */
  cost: Money | null
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
      brand: schema.products.brand,
      barcode: schema.products.barcode,
    })
    .from(schema.products)
    .where(isNull(schema.products.deletedAt))

  /* Every code an item answers to, not only its primary: a file row carrying
     the old packaging's barcode is that item, and the scanner agrees. */
  const scanned = await q(db)
    .select({ productId: schema.productBarcodes.productId, barcode: schema.productBarcodes.barcode })
    .from(schema.productBarcodes)
    .where(isNull(schema.productBarcodes.deletedAt))

  const byBarcode = new Map<string, string>()
  const byName = new Map<string, { id: string; brand: string; coded: boolean }[]>()
  for (const p of existing) {
    if (p.barcode !== null && p.barcode !== '') byBarcode.set(p.barcode, p.id)
  }
  const live = new Set(existing.map((p) => p.id))
  for (const b of scanned) if (live.has(b.productId)) byBarcode.set(b.barcode, b.productId)
  const coded = new Set(byBarcode.values())
  for (const p of existing) {
    const key = p.name.trim().toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), {
      id: p.id, brand: (p.brand ?? '').trim().toLowerCase(), coded: coded.has(p.id),
    }])
  }

  const seenBarcodes = new Set<string>()
  /* Each name and brand seen so far, and whether every row carrying it had a
     barcode: a repeat is only told apart from the first by its code. */
  const seenNames = new Map<string, { allCoded: boolean }>()
  const planned: PlannedRow[] = []

  rows.forEach(({ line, values: row }) => {
    const name = (row['name'] ?? '').trim()
    const brand = (row['brand'] ?? '').trim() || null
    const category = (row['category'] ?? '').trim() || null
    const barcode = (row['barcode'] ?? '').trim() || null
    const hsn = (row['hsn'] ?? '').trim() || null
    const unit = (row['unit'] ?? '').trim() || null

    const refuse = (problem: RowProblem): void => {
      planned.push({
        line, name, action: null, problem, productId: null, brand, category,
        barcode, hsn, taxRateBp: null, rate: null, mrp: null, unit, cost: null, openingQty: null,
      })
    }

    if (name === '') { refuse('NO_NAME'); return }
    if (hsn !== null && !isHsn(hsn)) { refuse('BAD_HSN'); return }

    const rate = money(row['rate'])
    if (rate === 'bad') { refuse('BAD_RATE'); return }
    const mrp = money(row['mrp'])
    if (mrp === 'bad') { refuse('BAD_MRP'); return }
    const cost = money(row['cost'])
    if (cost === 'bad') { refuse('BAD_COST'); return }

    const taxRateBp = tax(row['tax'])
    if (taxRateBp === 'bad') { refuse('BAD_TAX'); return }

    const openingQty = quantity(row['openingqty'])
    if (openingQty === 'bad') { refuse('BAD_QTY'); return }

    const lowerName = name.toLowerCase()
    const lowerBrand = brand?.toLowerCase() ?? null
    const nameKey = `${lowerName}\u0000${lowerBrand ?? ''}`
    if (barcode !== null && seenBarcodes.has(barcode)) { refuse('BARCODE_TWICE'); return }
    const before = seenNames.get(nameKey)
    if (before !== undefined && (barcode === null || !before.allCoded)) { refuse('NAME_TWICE'); return }

    /* The items this name could mean. With a brand, the item of that brand --
       or, when there is none, one with no brand yet, which the file is now
       giving one. Without a brand, every item of that name. */
    const sameName = byName.get(lowerName) ?? []
    const candidates = lowerBrand === null
      ? sameName
      : (() => {
          const branded = sameName.filter((p) => p.brand === lowerBrand)
          return branded.length > 0 ? branded : sameName.filter((p) => p.brand === '')
        })()

    /* Barcode first, then exact name. A row with a barcode that belongs to a
       *differently named* product is refused rather than matched: the file
       and the shop disagree about what that code is, and guessing either way
       silently renames something or duplicates it. */
    const matchedByBarcode = barcode === null ? undefined : byBarcode.get(barcode)
    if (matchedByBarcode !== undefined
        && candidates.length > 0
        && !candidates.some((p) => p.id === matchedByBarcode)) {
      refuse('BARCODE_TAKEN')
      return
    }
    /* By name only what the code cannot contradict: a row with a barcode the
       shop has not seen matches an item with no barcode yet, never one that
       already answers to another. */
    const byNameOnly = barcode === null ? candidates : candidates.filter((p) => !p.coded)
    if (matchedByBarcode === undefined && byNameOnly.length > 1) { refuse('NAME_AMBIGUOUS'); return }

    const productId = matchedByBarcode ?? byNameOnly[0]?.id ?? null

    if (barcode !== null) seenBarcodes.add(barcode)
    seenNames.set(nameKey, { allCoded: (before?.allCoded ?? true) && barcode !== null })

    planned.push({
      line,
      name,
      action: productId === null ? 'create' : 'update',
      problem: null,
      productId,
      brand,
      category,
      barcode,
      hsn,
      taxRateBp: taxRateBp === null ? null : taxRateBp,
      rate: rate === null ? null : rate,
      mrp: mrp === null ? null : mrp,
      unit,
      cost: cost === null ? null : cost,
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
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const usable = plan.rows.filter((r) => r.problem === null && r.action !== null)
  const now = new Date().toISOString()
  let created = 0
  let updated = 0
  const opening: { productId: string; qty: Qty; unitCost: Money }[] = []
  let stockIgnored = 0
  await db.transaction(async (tx) => {
    const categoryId = await categoriesFor(tx, ctx, usable, now)

    for (const row of usable) {
      if (row.action === 'create') {
        const id = await importedProductId(tx, row.barcode, row.name)
        await q(tx).insert(schema.products).values({
          id,
          name: row.name,
          brand: row.brand,
          categoryId: row.category === null ? null : categoryId(row.category),
          hsnCode: row.hsn,
          baseUnit: row.unit ?? 'piece',
          taxRateBp: row.taxRateBp ?? 0,
          baseRate: row.rate ?? (0 as Money),
          mrp: row.mrp,
          createdAt: now,
          updatedAt: now,
        })
        /* The scanner reads `product_barcodes`, not the column on the item. An
           import that wrote only the column made items that showed a barcode
           in every list and did not come up when it was scanned. */
        if (row.barcode !== null) await addPrimaryBarcode(tx, id, row.barcode, now)
        await writeAudit(tx, ctx, {
          entity: 'products', entityId: id, action: 'create',
          after: { name: row.name, base_rate: row.rate ?? 0, source: 'csv import' },
        })
        created += 1
        if (row.openingQty !== null && row.openingQty > 0) {
          // A first count with no cost is stock valued at nothing, and every sale of it all margin.
          opening.push({ productId: id, qty: row.openingQty, unitCost: row.cost ?? ZERO })
        }
        continue
      }
      if (row.openingQty !== null && row.openingQty > 0) stockIgnored += 1
      /* Only what the file actually said. `undefined` is "the file was
         silent"; a blank cell parses to null above and lands here as
         undefined, so it is never written. */
      const change: Record<string, unknown> = { updatedAt: now }
      if (row.brand !== null) change['brand'] = row.brand
      if (row.category !== null) change['categoryId'] = categoryId(row.category)
      if (row.hsn !== null) change['hsnCode'] = row.hsn
      if (row.unit !== null) change['baseUnit'] = row.unit
      if (row.taxRateBp !== null) change['taxRateBp'] = row.taxRateBp
      if (row.rate !== null) change['baseRate'] = row.rate
      if (row.mrp !== null) change['mrp'] = row.mrp

      await q(tx).update(schema.products)
        .set(change)
        .where(eq(schema.products.id, row.productId as string))
      if (row.barcode !== null) {
        const [has] = await q(tx)
          .select({ id: schema.productBarcodes.id })
          .from(schema.productBarcodes)
          .where(and(
            eq(schema.productBarcodes.productId, row.productId as string),
            eq(schema.productBarcodes.barcode, row.barcode),
            isNull(schema.productBarcodes.deletedAt),
          ))
        // A code the item already answers to is left as it is -- primary or not.
        if (!has) await addPrimaryBarcode(tx, row.productId as string, row.barcode, now)
      }

      await writeAudit(tx, ctx, {
        entity: 'products', entityId: row.productId as string, action: 'update',
        after: {
          ...(change as Record<string, never>),
          ...(row.barcode !== null ? { barcode: row.barcode } : {}),
          source: 'csv import',
        },
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
      brand: schema.products.brand,
      category: schema.categories.name,
      barcode: schema.products.barcode,
      hsn: schema.products.hsnCode,
      taxRateBp: schema.products.taxRateBp,
      unit: schema.products.baseUnit,
      rate: schema.products.baseRate,
      mrp: schema.products.mrp,
      onHand: sql<number>`COALESCE(${schema.productStock.qtyOnHand}, 0)`,
      value: sql<number>`COALESCE(${schema.productStock.stockValue}, 0)`,
    })
    .from(schema.products)
    // Left joined, so an item never counted or never grouped still gets a row
    // rather than vanishing from its own catalogue.
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .leftJoin(schema.categories, and(
      eq(schema.categories.id, schema.products.categoryId),
      isNull(schema.categories.deletedAt),
    ))
    .where(and(isNull(schema.products.deletedAt), eq(schema.products.isActive, 1)))
    .orderBy(schema.products.name)

  return toCsv(
    ['name', 'brand', 'category', 'barcode', 'hsn', 'tax', 'unit', 'rate', 'mrp', 'cost', 'openingqty'],
    rows.map((r) => [
      r.name,
      r.brand ?? '',
      r.category ?? '',
      r.barcode ?? '',
      r.hsn ?? '',
      // Basis points back to the percentage a person typed.
      r.taxRateBp === 0 ? '' : String(r.taxRateBp / 100),
      r.unit,
      money2(r.rate),
      r.mrp === null ? '' : money2(r.mrp),
      // What one on the shelf is valued at: derived from the value, which is what is kept.
      r.onHand > 0 ? money2(Math.round(r.value * QTY_SCALE / r.onHand) as Money) : '',
      String(r.onHand / QTY_SCALE),
    ]),
  )
}

/**
 * The category each name in the file means, making the ones the shop lacks.
 *
 * By name, ignoring case, as `createCategory` holds them unique. Made here in
 * the import's own transaction rather than through `createCategory`, which
 * opens one of its own, so a failed import does not leave its categories behind.
 */
async function categoriesFor(
  tx: SqlDriver, ctx: AuditContext, rows: PlannedRow[], now: string,
): Promise<(name: string) => string> {
  const ids = new Map<string, string>()
  const known = await q(tx)
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(isNull(schema.categories.deletedAt))
  for (const c of known) ids.set(c.name.trim().toLowerCase(), c.id)

  for (const row of rows) {
    if (row.category === null || ids.has(row.category.toLowerCase())) continue
    // Derived, as an imported product is, so two tills importing one file make one category.
    const derived = await derivedId('categories', 'import', row.category.toLowerCase())
    const [taken] = await q(tx).select({ id: schema.categories.id }).from(schema.categories)
      .where(eq(schema.categories.id, derived))
    const id = taken ? newId() : derived
    await q(tx).insert(schema.categories).values({ id, name: row.category, createdAt: now, updatedAt: now })
    await writeAudit(tx, ctx, {
      entity: 'categories', entityId: id, action: 'create',
      after: { name: row.category, source: 'csv import' },
    })
    ids.set(row.category.toLowerCase(), id)
  }

  return (name) => ids.get(name.toLowerCase()) as string
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
