import { eq, and, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { ZERO, type Money } from '../money.js'
import type { Qty } from '../quantity.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { parseCsvRecords } from '../domain/csv.js'
import { isHsn } from '../domain/hsn.js'
import { money, tax, quantity } from '../domain/importCells.js'
import { categoriesFor, importedProductId } from './importIds.js'
import { businessDate } from '../dates.js'
import { createStockEntry, submitStockEntry } from './stockEntry.js'
import { addPrimaryBarcode, importRowsTakingACode } from './barcodes.js'
import { requirePermission } from '../integrity/permissions.js'
import { importRowsUnderCost } from './belowCost.js'
import { familyProblems, attachFamilies } from './importFamilies.js'
import { followFamily } from './variants.js'

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
 * And with its unit, when the row says one. Pencils sold in a box of ten and
 * the same pencils sold loose are two items with one name and one brand, as
 * the item screen lets a shop make them: `PLATINUM, APSARA, piece` is the loose
 * one, never a price change to the box. A row with no unit matches whichever
 * unit the item is in. A file never changes an item's unit, because the stock
 * is counted in it: ten packs renamed to pieces are ten pencils, not a hundred.
 * A row whose barcode is an item in another unit is refused (`UNIT_DIFFERS`);
 * the unit is renamed on the item, which knows what that means.
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
  // The family a row is a variant of, by name, and which kind it is (`importFamilies.ts`).
  'variantof', 'variant',
] as const

export type ImportAction = 'create' | 'update'

export type RowProblem =
  /** No name, and a product without one cannot be sold or found. */
  | 'NO_NAME'
  /** A variant of an item that is in neither the shop nor the file, or is a variant itself. */
  | 'NO_FAMILY'
  /** A family named, and no kind: Blue, 500 g. */
  | 'NO_VARIANT'
  /** A rate that is not a number. Blank is fine; `12.3.4` is not. */
  | 'BAD_RATE'
  | 'BAD_MRP'
  | 'BAD_COST'
  /** A tax rate that is not a number, or is not a percentage. */
  | 'BAD_TAX'
  | 'BAD_QTY'
  /** Not 4, 6 or 8 digits. A warning everywhere else; here it is a refusal. */
  | 'BAD_HSN'
  /** The same barcode on the same name and brand twice in one file: one row repeated. */
  | 'BARCODE_TWICE'
  /** The same name and brand twice in one file. */
  | 'NAME_TWICE'
  /** This barcode already belongs to a different product in the shop. */
  | 'BARCODE_TAKEN'
  /** No brand and no barcode, and the name is more than one item here. */
  | 'NAME_AMBIGUOUS'
  /** The barcode is on several items here (069), and the row names none of them. */
  | 'BARCODE_SHARED'
  /** The barcode is an item sold in another unit here; a file does not change what stock is counted in. */
  | 'UNIT_DIFFERS'
  /**
   * The selling rate, without its GST, is below what the item costs: the file's
   * own cost where the row has one, the latest recorded where it does not
   * (`services/belowCost.ts`). A warning rather than a refusal for a person who
   * may go below cost: `applyImport` takes these rows when told to allow them.
   */
  | 'BELOW_COST'

export interface PlannedRow {
  /** 1-based, counting the header, so it matches what Excel shows. */
  line: number
  name: string
  action: ImportAction | null
  problem: RowProblem | null
  /**
   * On a `BELOW_COST` row: what it would have done, and the price and cost
   * that stopped it, both per base unit before GST. Allowed, it does that.
   */
  belowCost?: { action: ImportAction; sellsAt: Money; cost: Money }
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
  /** The family this row is a variant of, by name, and its label in it. */
  variantOf: string | null
  variant: string | null
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
  /** Of the skipped, those held only for selling below cost: a person who may can allow them. */
  belowCost: number
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
      baseUnit: schema.products.baseUnit,
      parentProductId: schema.products.parentProductId,
    })
    .from(schema.products)
    .where(isNull(schema.products.deletedAt))

  /* Every code an item answers to, not only its primary: a file row carrying
     the old packaging's barcode is that item, and the scanner agrees. */
  const scanned = await q(db)
    .select({ productId: schema.productBarcodes.productId, barcode: schema.productBarcodes.barcode })
    .from(schema.productBarcodes)
    .where(isNull(schema.productBarcodes.deletedAt))

  /* A code may be on several items since 069, so each code holds a set. */
  const byBarcode = new Map<string, Set<string>>()
  const hold = (code: string, id: string) => byBarcode.set(code, (byBarcode.get(code) ?? new Set()).add(id))
  const byName = new Map<string, { id: string; brand: string; unit: string; coded: boolean }[]>()
  const unitOf = new Map(existing.map((p) => [p.id, p.baseUnit.trim().toLowerCase()]))
  for (const p of existing) {
    if (p.barcode !== null && p.barcode !== '') hold(p.barcode, p.id)
  }
  const live = new Set(existing.map((p) => p.id))
  for (const b of scanned) if (live.has(b.productId)) hold(b.barcode, b.productId)
  const coded = new Set([...byBarcode.values()].flatMap((ids) => [...ids]))
  for (const p of existing) {
    const key = p.name.trim().toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), {
      id: p.id, brand: (p.brand ?? '').trim().toLowerCase(), unit: p.baseUnit.trim().toLowerCase(), coded: coded.has(p.id),
    }])
  }

  /* Which names each code carries across the whole file. A code the file puts
     on two names is one code on two items, so a new name with it is a new item
     rather than the one the shop already has under that code, renamed. */
  const namesInFile = new Map<string, Set<string>>()
  for (const { values } of rows) {
    const code = (values['barcode'] ?? '').trim()
    if (code === '') continue
    const key = `${(values['name'] ?? '').trim().toLowerCase()}\u0000${(values['brand'] ?? '').trim().toLowerCase()}`
    namesInFile.set(code, (namesInFile.get(code) ?? new Set()).add(key))
  }

  /** Each code seen so far, with the names and brands it was seen on. */
  const seenBarcodes = new Map<string, Set<string>>()
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
    const variantOf = (row['variantof'] ?? '').trim() || null
    const variant = (row['variant'] ?? '').trim() || null

    const refuse = (problem: RowProblem): void => {
      planned.push({
        line, name, action: null, problem, productId: null, brand, category,
        barcode, hsn, taxRateBp: null, rate: null, mrp: null, unit, cost: null, openingQty: null, variantOf, variant,
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
    const lowerUnit = unit?.toLowerCase() ?? null
    // The unit is part of what a row names: the box and the loose pencil may share the rest.
    const nameKey = `${lowerName}\u0000${lowerBrand ?? ''}\u0000${lowerUnit ?? ''}`
    if (barcode !== null && seenBarcodes.get(barcode)?.has(nameKey)) { refuse('BARCODE_TWICE'); return }
    const before = seenNames.get(nameKey)
    if (before !== undefined && (barcode === null || !before.allCoded)) { refuse('NAME_TWICE'); return }

    /* The items this name could mean. With a brand, the item of that brand --
       or, when there is none, one with no brand yet, which the file is now
       giving one. Without a brand, every item of that name. */
    const ofBrand = (items: { id: string; brand: string; unit: string; coded: boolean }[]) => {
      if (lowerBrand === null) return items
      const branded = items.filter((p) => p.brand === lowerBrand)
      return branded.length > 0 ? branded : items.filter((p) => p.brand === '')
    }
    const sameName = byName.get(lowerName) ?? []
    /* Whatever its unit: the items a code is told apart from by name. */
    const anyUnit = ofBrand(sameName)
    /* And in the row's unit, when it says one: an item in another unit is another item. */
    const candidates = ofBrand(sameName.filter((p) => lowerUnit === null || p.unit === lowerUnit))

    /* Barcode first, then exact name -- and since 069 a code may be several
       items', so the name says which of them. A row with a barcode that
       belongs to a *differently named* product is refused rather than
       matched: the file and the shop disagree about what that code is, and
       guessing either way silently renames something or duplicates it. */
    const holders = barcode === null ? [] : [...(byBarcode.get(barcode) ?? [])]
    let matchedByBarcode: string | undefined
    if (holders.length > 0) {
      const named = holders.filter((id) => candidates.some((p) => p.id === id))
      const sharedInFile = (namesInFile.get(barcode!)?.size ?? 0) > 1
      if (named.length > 1) { refuse('NAME_AMBIGUOUS'); return }
      if (named.length === 1) matchedByBarcode = named[0]
      // The one item with this code, under a name the shop has since changed.
      else if (holders.length === 1 && anyUnit.length === 0 && !sharedInFile) {
        if (lowerUnit !== null && unitOf.get(holders[0]!) !== lowerUnit) { refuse('UNIT_DIFFERS'); return }
        matchedByBarcode = holders[0]
      }
      // This item's code, in a unit it is not counted in.
      else if (holders.length === 1 && anyUnit.some((p) => p.id === holders[0])) { refuse('UNIT_DIFFERS'); return }
      else if (holders.length === 1 && anyUnit.length > 0) { refuse('BARCODE_TAKEN'); return }
      else if (!sharedInFile) { refuse('BARCODE_SHARED'); return }
      // Otherwise a new item, sharing a code the file gives to other names too.
    }
    /* By name only what the code cannot contradict: a row with a barcode the
       shop has not seen matches an item with no barcode yet, never one that
       already answers to another. */
    const byNameOnly = barcode === null ? candidates : candidates.filter((p) => !p.coded)
    if (matchedByBarcode === undefined && byNameOnly.length > 1) { refuse('NAME_AMBIGUOUS'); return }

    const productId = matchedByBarcode ?? byNameOnly[0]?.id ?? null

    if (barcode !== null) seenBarcodes.set(barcode, (seenBarcodes.get(barcode) ?? new Set()).add(nameKey))
    seenNames.set(nameKey, { allCoded: (before?.allCoded ?? true) && barcode !== null })

    planned.push({
      line,
      name,
      action: productId === null ? 'create' : 'update',
      problem: null,
      productId,
      brand, category, barcode, hsn,
      taxRateBp: taxRateBp === null ? null : taxRateBp,
      rate: rate === null ? null : rate,
      mrp: mrp === null ? null : mrp,
      unit,
      cost: cost === null ? null : cost,
      openingQty: openingQty === null ? null : openingQty,
      variantOf, variant,
    })
  })

  // A family is a link between rows, so it is checked once every row is read.
  const family = familyProblems(planned.filter((r) => r.problem === null), existing)
  for (const row of planned) {
    const problem = family.get(row.line)
    if (problem) { row.problem = problem; row.action = null }
  }

  // Whose a code becomes, where the shop holds every code to one item (`uniqueBarcode`).
  const taken = await importRowsTakingACode(db, planned.filter((r) => r.problem === null).map((r) => ({ key: r.line, productId: r.productId, barcode: r.barcode, family: r.variantOf })))
  for (const row of planned) if (taken.has(row.line)) { row.problem = 'BARCODE_TAKEN'; row.action = null }

  /* Last, so a row held for its price has passed every other check: allowing
     it must not let through anything else that was wrong with it. After
     matching, which says whose cost applies. */
  const under = await importRowsUnderCost(db, planned.filter((r) => r.problem === null).map((r) => ({
    key: r.line, name: r.name, productId: r.action === 'update' ? r.productId : null,
    rate: r.rate, cost: r.cost, taxRateBp: r.taxRateBp,
  })))
  for (const row of planned) {
    const held = under.get(row.line)
    if (!held || row.action === null) continue
    row.belowCost = { action: row.action, ...held }
    row.problem = 'BELOW_COST'
    row.action = null
  }

  return {
    headers,
    unknownColumns: headers.filter((h) => h !== '' && !known.has(h)),
    rows: planned,
    create: planned.filter((r) => r.action === 'create').length,
    update: planned.filter((r) => r.action === 'update').length,
    skip: planned.filter((r) => r.problem !== null).length,
    belowCost: planned.filter((r) => r.problem === 'BELOW_COST').length,
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
  opts: { allowBelowCost?: boolean } = {},
): Promise<CatalogueImportResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  /* Below cost, allowed by somebody who may: the clearance price, or a file
     whose costs went up. Refused outright to anybody else, as at the item. */
  if (opts.allowBelowCost) await requirePermission(db, ctx.actorId, 'below_cost', 'write')
  const allowed = opts.allowBelowCost
    ? plan.rows.filter((r) => r.problem === 'BELOW_COST' && r.belowCost).map((r) => ({ ...r, action: r.belowCost!.action, problem: null }))
    : []
  const usable = [...plan.rows.filter((r) => r.problem === null && r.action !== null), ...allowed]
  const allowedLines = new Set(allowed.map((r) => r.line))
  /** Each allowed row, written to the audit trail the way the item page writes one. */
  const underCost: { productId: string; name: string; sellsAt: Money; cost: Money }[] = []
  const now = new Date().toISOString()
  let created = 0
  let updated = 0
  const opening: { productId: string; qty: Qty; unitCost: Money }[] = []
  let stockIgnored = 0
  await db.transaction(async (tx) => {
    const categoryId = await categoriesFor(tx, ctx, usable, now)
    const written: { productId: string; variantOf: string | null; variant: string | null }[] = []

    for (const row of usable) {
      if (row.action === 'create') {
        const id = await importedProductId(tx, row.barcode, row.name)
        written.push({ productId: id, variantOf: row.variantOf, variant: row.variant })
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
          /* Its cost price, whether or not it came with stock: a file's cost
             used to value only the opening stock, and was lost without it. */
          ...(row.cost !== null ? { costPrice: row.cost, costPriceAt: now } : {}),
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
        if (allowedLines.has(row.line)) underCost.push({ productId: id, name: row.name, ...row.belowCost! })
        if (row.openingQty !== null && row.openingQty > 0) {
          // A first count with no cost is stock valued at nothing, and every sale of it all margin.
          opening.push({ productId: id, qty: row.openingQty, unitCost: row.cost ?? ZERO })
        }
        continue
      }
      written.push({ productId: row.productId as string, variantOf: row.variantOf, variant: row.variant })
      if (row.openingQty !== null && row.openingQty > 0) stockIgnored += 1
      /* Only what the file actually said. `undefined` is "the file was
         silent"; a blank cell parses to null above and lands here as
         undefined, so it is never written. */
      const change: Record<string, unknown> = { updatedAt: now }
      if (row.brand !== null) change['brand'] = row.brand
      if (row.category !== null) change['categoryId'] = categoryId(row.category)
      if (row.hsn !== null) change['hsnCode'] = row.hsn
      if (row.taxRateBp !== null) change['taxRateBp'] = row.taxRateBp
      if (row.rate !== null) change['baseRate'] = row.rate
      if (row.mrp !== null) change['mrp'] = row.mrp
      /* The cost price, as typed on the item: the Cost column and the
         below-cost floor read it while it is newer than the last purchase.
         It used to be dropped here without a word. */
      if (row.cost !== null) { change['costPrice'] = row.cost; change['costPriceAt'] = now }

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
      if (allowedLines.has(row.line)) underCost.push({ productId: row.productId as string, name: row.name, ...row.belowCost! })
    }
    // Once every row is in, so a family that is a new line in this same file is there to belong to.
    await attachFamilies(tx, ctx, written, now)
    /* A family priced as one stays one price, as when it is saved on its page:
       a parent's new rate goes down to its variants, a variant's goes back to
       the parent's. Without this a file could price one colour on its own. */
    for (const row of usable) if (row.action === 'update') await followFamily(tx, ctx, row.productId as string)
    for (const line of underCost) {
      await writeAudit(tx, ctx, {
        entity: 'products', entityId: line.productId, action: 'update',
        after: { below_cost: `${line.name}: ${(line.sellsAt / 100).toFixed(2)} under ${(line.cost / 100).toFixed(2)}`, source: 'csv import' },
      })
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

  return { created, updated, skipped: plan.skip - allowed.length, stocked: opening.length, stockIgnored }
}
