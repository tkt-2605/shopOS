import { eq, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { parseMoney, type Money } from '../money.js'
import { businessDate } from '../dates.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { parseCsvRecords, toCsv } from '../domain/csv.js'
import { isGstin } from '../domain/gstin.js'
import type { ImportAction, ImportResult } from './import.js'

/**
 * The supplier list, in and out of a spreadsheet.
 *
 * ## Where this differs from the customer one, and why
 *
 * **The opening balance is applied here.** On the customer side it is handed
 * back for the screen to post, because there it is a *document* -- a bill, or
 * a receipt nothing points at -- and raising one needs a register. A
 * supplier's is a column on the supplier (`050_what_the_shop_owed_before.sql`
 * says why), so there is no document, no register, and nothing to hand back.
 *
 * That asymmetry is worth stating rather than smoothing over: the two look
 * like the same feature and are stored differently, and the day suppliers get
 * a real payables ledger this function has to change and the customer one
 * does not.
 *
 * **There is no customer code.** Suppliers are matched on GSTIN, then phone,
 * then exact name. GSTIN is strongest and is genuinely identifying -- it is
 * the registration number, one per supplier per state. Name is last for the
 * same reason as everywhere else, though it bites less here: a shop has forty
 * suppliers, not four thousand, and `createSupplier` already refuses a
 * duplicate name outright.
 */

/** The columns a supplier file may carry. Only `name` is required. */
export const SUPPLIER_COLUMNS = [
  'name', 'phone', 'gstin', 'address', 'opening', 'openingasof',
] as const

export type SupplierRowProblem =
  | 'NO_NAME'
  | 'BAD_GSTIN'
  | 'BAD_OPENING'
  | 'BAD_DATE'
  | 'GSTIN_TWICE'
  | 'PHONE_TWICE'
  | 'NAME_TWICE'
  /** That GSTIN and that phone point at two different suppliers here. */
  | 'GSTIN_TAKEN'

export interface PlannedSupplier {
  /** 1-based, counting the header, so it is the line Excel shows. */
  line: number
  name: string
  action: ImportAction | null
  problem: SupplierRowProblem | null
  supplierId: string | null
  phone: string | null
  gstin: string | null
  address: string | null
  /** Signed: negative is an advance the shop had already paid them. */
  opening: Money | null
  openingAsOf: string | null
}

export interface SupplierPlan {
  headers: string[]
  unknownColumns: string[]
  rows: PlannedSupplier[]
  create: number
  update: number
  skip: number
  /** Rows carrying a balance carried over, so a screen can say it will set it. */
  withOpening: number
}

/** What a supplier file would do, without doing any of it. */
export async function planSupplierImport(db: SqlDriver, text: string): Promise<SupplierPlan> {
  const { headers, rows } = parseCsvRecords(text)
  const known = new Set<string>(SUPPLIER_COLUMNS)

  const existing = await q(db)
    .select({
      id: schema.suppliers.id,
      name: schema.suppliers.name,
      phone: schema.suppliers.phone,
      gstin: schema.suppliers.gstin,
    })
    .from(schema.suppliers)
    .where(isNull(schema.suppliers.deletedAt))

  const byGstin = new Map<string, string>()
  const byPhone = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const s of existing) {
    if (s.gstin !== null && s.gstin !== '') byGstin.set(s.gstin.toUpperCase(), s.id)
    if (s.phone !== null && s.phone !== '') byPhone.set(s.phone, s.id)
    byName.set(s.name.trim().toLowerCase(), s.id)
  }

  const seenGstins = new Set<string>()
  const seenPhones = new Set<string>()
  const seenNames = new Set<string>()
  const planned: PlannedSupplier[] = []

  rows.forEach(({ line, values: row }) => {
    const name = (row['name'] ?? '').trim()
    const phone = (row['phone'] ?? '').trim() || null
    const gstin = ((row['gstin'] ?? '').trim().toUpperCase()) || null
    const address = (row['address'] ?? '').trim() || null
    const asOf = (row['openingasof'] ?? '').trim() || null

    const refuse = (problem: SupplierRowProblem): void => {
      planned.push({
        line, name, action: null, problem, supplierId: null,
        phone, gstin, address, opening: null, openingAsOf: asOf,
      })
    }

    if (name === '') { refuse('NO_NAME'); return }
    if (gstin !== null && !isGstin(gstin)) { refuse('BAD_GSTIN'); return }
    if (asOf !== null && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { refuse('BAD_DATE'); return }

    const opening = money(row['opening'])
    if (opening === 'bad') { refuse('BAD_OPENING'); return }

    const lowerName = name.toLowerCase()
    if (gstin !== null && seenGstins.has(gstin)) { refuse('GSTIN_TWICE'); return }
    if (phone !== null && seenPhones.has(phone)) { refuse('PHONE_TWICE'); return }
    if (seenNames.has(lowerName)) { refuse('NAME_TWICE'); return }

    const matchedByGstin = gstin === null ? undefined : byGstin.get(gstin)
    const matchedByPhone = phone === null ? undefined : byPhone.get(phone)
    if (matchedByGstin !== undefined && matchedByPhone !== undefined
        && matchedByGstin !== matchedByPhone) {
      /* The file and the shop disagree about who this is. Either answer
         merges or duplicates an account the shop owes money on. */
      refuse('GSTIN_TAKEN')
      return
    }

    const supplierId = matchedByGstin ?? matchedByPhone ?? byName.get(lowerName) ?? null

    if (gstin !== null) seenGstins.add(gstin)
    if (phone !== null) seenPhones.add(phone)
    seenNames.add(lowerName)

    planned.push({
      line,
      name,
      action: supplierId === null ? 'create' : 'update',
      problem: null,
      supplierId,
      phone, gstin, address,
      opening: opening === null ? null : opening,
      openingAsOf: asOf,
    })
  })

  return {
    headers,
    unknownColumns: headers.filter((h) => h !== '' && !known.has(h)),
    rows: planned,
    create: planned.filter((r) => r.action === 'create').length,
    update: planned.filter((r) => r.action === 'update').length,
    skip: planned.filter((r) => r.problem !== null).length,
    withOpening: planned.filter((r) => r.problem === null && r.opening !== null).length,
  }
}

/**
 * Carries out a supplier plan, in one transaction.
 *
 * A blank cell leaves the existing value alone, as everywhere else: a file
 * carrying only name and phone is a phone-number tidy-up and must not clear
 * every GSTIN in the list on its way through.
 */
export async function applySupplierImport(
  db: SqlDriver, ctx: AuditContext, plan: SupplierPlan,
): Promise<ImportResult> {
  const usable = plan.rows.filter((r) => r.problem === null && r.action !== null)
  const now = new Date().toISOString()
  let created = 0
  let updated = 0

  await db.transaction(async (tx) => {
    for (const row of usable) {
      /* The opening balance goes in with everything else, because here it is
         a column rather than a document. See the note at the top of the file
         for why the customer side cannot do this. */
      const opening = row.opening === null
        ? {}
        : { openingBalance: row.opening, openingAsOf: row.openingAsOf ?? businessDate() }

      if (row.action === 'create') {
        const id = newId()
        await q(tx).insert(schema.suppliers).values({
          id,
          name: row.name,
          phone: row.phone,
          gstin: row.gstin,
          address: row.address,
          ...opening,
          createdAt: now,
          updatedAt: now,
        })
        await writeAudit(tx, ctx, {
          entity: 'suppliers', entityId: id, action: 'create',
          after: { name: row.name, source: 'csv import' },
        })
        created += 1
        continue
      }

      const change: Record<string, unknown> = { updatedAt: now, ...opening }
      if (row.phone !== null) change['phone'] = row.phone
      if (row.gstin !== null) change['gstin'] = row.gstin
      if (row.address !== null) change['address'] = row.address

      await q(tx).update(schema.suppliers)
        .set(change)
        .where(eq(schema.suppliers.id, row.supplierId as string))
      await writeAudit(tx, ctx, {
        entity: 'suppliers', entityId: row.supplierId as string, action: 'update',
        after: { ...(change as Record<string, never>), source: 'csv import' },
      })
      updated += 1
    }
  })

  return { created, updated, skipped: plan.skip }
}

/**
 * The supplier list as a file, in the shape `planSupplierImport` reads.
 *
 * Unlike the customer export, `opening` carries its real figure. It is a
 * field rather than a document, so re-importing it sets the same number
 * again instead of posting a second one -- which is what makes the round
 * trip safe here and not there.
 */
export async function exportSuppliers(db: SqlDriver): Promise<string> {
  const rows = await q(db)
    .select({
      name: schema.suppliers.name,
      phone: schema.suppliers.phone,
      gstin: schema.suppliers.gstin,
      address: schema.suppliers.address,
      openingBalance: schema.suppliers.openingBalance,
      openingAsOf: schema.suppliers.openingAsOf,
    })
    .from(schema.suppliers)
    .where(isNull(schema.suppliers.deletedAt))
    .orderBy(schema.suppliers.name)

  return toCsv(
    [...SUPPLIER_COLUMNS],
    rows.map((r) => [
      r.name,
      r.phone ?? '',
      r.gstin ?? '',
      r.address ?? '',
      /* Blank where nobody has ever said, rather than `0.00`. Writing a zero
         would turn "never asked" into "answered nothing" on the way back in,
         and those are different things -- `openingAsOf` is what tells them
         apart. */
      r.openingAsOf === null ? '' : (r.openingBalance / 100).toFixed(2),
      r.openingAsOf ?? '',
    ]),
  )
}

/** A money cell. Signed: negative is an advance the shop has already paid. */
function money(raw: string | undefined): Money | null | 'bad' {
  const text = (raw ?? '').trim()
  if (text === '') return null
  const cleaned = text.replace(/[\u{20B9},\s]/gu, '')

  const negative = cleaned.startsWith('-')
  const value = parseMoney(negative ? cleaned.slice(1) : cleaned)
  if (value === null) return 'bad'
  return (negative ? -value : value) as Money
}
