import { eq, and, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { parseMoney, type Money } from '../money.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { parseCsvRecords, toCsv } from '../domain/csv.js'
import { isGstin, stateFromGstin } from '../domain/gstin.js'
import { isStateCode } from '../domain/states.js'
import type { ImportAction, ImportResult } from './import.js'

/**
 * The customer book, in and out of a spreadsheet.
 *
 * Its own file rather than more of `import.ts`, because the two share a shape
 * and almost nothing else: the matching rules are different, the columns are
 * different, and the one genuinely awkward part -- an opening balance that is
 * a document rather than a field -- has no counterpart on the product side.
 *
 * ## Matching: code, then phone, then exact name
 *
 * In that order, and the order is the whole of it.
 *
 * **Code** is strongest: a shop that keeps customer codes means them.
 *
 * **Phone** next. Two customers sharing a number is the household case and is
 * uncommon enough to be worth matching on.
 *
 * **Name** last, and only when the row offers neither of the others. Two
 * people called Kumar is the ordinary case, not the exception, and merging
 * them would join two accounts that owe different amounts -- a mistake nobody
 * discovers until one of them is chased for the other's money.
 */

/** The columns a customer file may carry. Only `name` is required. */
export const CUSTOMER_COLUMNS = [
  'name', 'code', 'phone', 'email', 'gstin', 'address', 'state', 'creditlimit', 'opening',
] as const

export type CustomerRowProblem =
  | 'NO_NAME'
  | 'BAD_GSTIN'
  | 'BAD_STATE'
  | 'BAD_LIMIT'
  | 'BAD_OPENING'
  | 'CODE_TWICE'
  | 'PHONE_TWICE'
  | 'NAME_TWICE'
  /** That code and that phone point at two different people in this shop. */
  | 'CODE_TAKEN'

export interface PlannedCustomer {
  /** 1-based, counting the header, so it is the line Excel shows. */
  line: number
  name: string
  action: ImportAction | null
  problem: CustomerRowProblem | null
  customerId: string | null
  code: string | null
  phone: string | null
  email: string | null
  gstin: string | null
  address: string | null
  stateCode: string | null
  creditLimit: Money | null
  /**
   * What they owed when the books moved. Signed: negative is money the shop
   * was already holding for them.
   *
   * Carried on the plan and **not written by `applyCustomerImport`**. An
   * opening balance is a document -- a bill, or a receipt nothing points at --
   * and raising one needs a register, which an import has no business
   * choosing. The result hands back the ids and amounts so a screen that has
   * a register can post them.
   */
  opening: Money | null
}

export interface CustomerPlan {
  headers: string[]
  unknownColumns: string[]
  rows: PlannedCustomer[]
  create: number
  update: number
  skip: number
  /** Rows carrying an opening balance, so a screen can say it will post them. */
  withOpening: number
}

/** What a customer file would do, without doing any of it. */
export async function planCustomerImport(db: SqlDriver, text: string): Promise<CustomerPlan> {
  const { headers, rows } = parseCsvRecords(text)
  const known = new Set<string>(CUSTOMER_COLUMNS)

  const existing = await q(db)
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
      code: schema.customers.code,
      phone: schema.customers.phone,
    })
    .from(schema.customers)
    .where(isNull(schema.customers.deletedAt))

  const byCode = new Map<string, string>()
  const byPhone = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const c of existing) {
    if (c.code !== null && c.code !== '') byCode.set(c.code.toLowerCase(), c.id)
    if (c.phone !== null && c.phone !== '') byPhone.set(c.phone, c.id)
    byName.set(c.name.trim().toLowerCase(), c.id)
  }

  const seenCodes = new Set<string>()
  const seenPhones = new Set<string>()
  const seenNames = new Set<string>()
  const planned: PlannedCustomer[] = []

  rows.forEach(({ line, values: row }) => {
    const name = (row['name'] ?? '').trim()
    const code = (row['code'] ?? '').trim() || null
    const phone = (row['phone'] ?? '').trim() || null
    const email = (row['email'] ?? '').trim() || null
    const gstin = ((row['gstin'] ?? '').trim().toUpperCase()) || null
    const address = (row['address'] ?? '').trim() || null
    const state = (row['state'] ?? '').trim() || null

    const refuse = (problem: CustomerRowProblem): void => {
      planned.push({
        line, name, action: null, problem, customerId: null,
        code, phone, email, gstin, address, stateCode: state,
        creditLimit: null, opening: null,
      })
    }

    if (name === '') { refuse('NO_NAME'); return }
    if (gstin !== null && !isGstin(gstin)) { refuse('BAD_GSTIN'); return }
    if (state !== null && !isStateCode(state)) { refuse('BAD_STATE'); return }

    const creditLimit = money(row['creditlimit'])
    if (creditLimit === 'bad') { refuse('BAD_LIMIT'); return }
    const opening = money(row['opening'], { signed: true })
    if (opening === 'bad') { refuse('BAD_OPENING'); return }

    const lowerCode = code === null ? null : code.toLowerCase()
    const lowerName = name.toLowerCase()

    if (lowerCode !== null && seenCodes.has(lowerCode)) { refuse('CODE_TWICE'); return }
    if (phone !== null && seenPhones.has(phone)) { refuse('PHONE_TWICE'); return }
    /* Only when the row offers nothing stronger. Two rows called Kumar with
       different phone numbers are two customers, and refusing the second
       would leave one of them out of the shop entirely. */
    if (lowerCode === null && phone === null && seenNames.has(lowerName)) {
      refuse('NAME_TWICE')
      return
    }

    const matchedByCode = lowerCode === null ? undefined : byCode.get(lowerCode)
    const matchedByPhone = phone === null ? undefined : byPhone.get(phone)
    if (matchedByCode !== undefined && matchedByPhone !== undefined
        && matchedByCode !== matchedByPhone) {
      /* The file and the shop disagree about who this is. Either answer
         silently merges or duplicates an account that owes money. */
      refuse('CODE_TAKEN')
      return
    }

    const customerId = matchedByCode ?? matchedByPhone ?? byName.get(lowerName) ?? null

    if (lowerCode !== null) seenCodes.add(lowerCode)
    if (phone !== null) seenPhones.add(phone)
    seenNames.add(lowerName)

    planned.push({
      line,
      name,
      action: customerId === null ? 'create' : 'update',
      problem: null,
      customerId,
      code, phone, email, gstin, address,
      stateCode: state,
      creditLimit: creditLimit === null ? null : creditLimit,
      opening: opening === null ? null : opening,
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

export interface CustomerImportResult extends ImportResult {
  /** Rows that asked for an opening balance, for a caller that has a register. */
  opening: { customerId: string; name: string; amount: Money }[]
}

/**
 * Carries out a customer plan, in one transaction.
 *
 * As with the catalogue, a blank cell leaves the existing value alone: a file
 * carrying only name and phone is a phone-number tidy-up, and must not clear
 * every address in the book on its way through.
 */
export async function applyCustomerImport(
  db: SqlDriver, ctx: AuditContext, plan: CustomerPlan,
): Promise<CustomerImportResult> {
  const usable = plan.rows.filter((r) => r.problem === null && r.action !== null)
  const now = new Date().toISOString()
  const opening: CustomerImportResult['opening'] = []
  let created = 0
  let updated = 0

  await db.transaction(async (tx) => {
    for (const row of usable) {
      let id = row.customerId

      if (row.action === 'create') {
        id = newId()
        await q(tx).insert(schema.customers).values({
          id,
          name: row.name,
          code: row.code,
          phone: row.phone,
          email: row.email,
          gstin: row.gstin,
          address: row.address,
          /* Derived the way `services/customers.ts` derives it: the GSTIN says
             which state, and only where there is none does the column stay
             null for the shop's own to stand in. What it must never again be
             is the literal '33' that INSERT used to carry, which made every
             customer in every shop a Tamil Nadu customer. */
          stateCode: row.stateCode ?? (row.gstin === null ? null : stateFromGstin(row.gstin)),
          ...(row.creditLimit === null ? {} : { creditLimit: row.creditLimit }),
          createdAt: now,
          updatedAt: now,
        })
        await writeAudit(tx, ctx, {
          entity: 'customers', entityId: id, action: 'create',
          after: { name: row.name, source: 'csv import' },
        })
        created += 1
      } else {
        const change: Record<string, unknown> = { updatedAt: now }
        if (row.code !== null) change['code'] = row.code
        if (row.phone !== null) change['phone'] = row.phone
        if (row.email !== null) change['email'] = row.email
        if (row.gstin !== null) change['gstin'] = row.gstin
        if (row.address !== null) change['address'] = row.address
        if (row.stateCode !== null) change['stateCode'] = row.stateCode
        if (row.creditLimit !== null) change['creditLimit'] = row.creditLimit

        await q(tx).update(schema.customers)
          .set(change)
          .where(eq(schema.customers.id, id as string))
        await writeAudit(tx, ctx, {
          entity: 'customers', entityId: id as string, action: 'update',
          after: { ...(change as Record<string, never>), source: 'csv import' },
        })
        updated += 1
      }

      if (row.opening !== null && row.opening !== 0 && id !== null) {
        opening.push({ customerId: id, name: row.name, amount: row.opening })
      }
    }
  })

  return { created, updated, skipped: plan.skip, opening }
}

/** The customer book as a file, in the shape `planCustomerImport` reads. */
export async function exportCustomers(db: SqlDriver): Promise<string> {
  const rows = await q(db)
    .select({
      name: schema.customers.name,
      code: schema.customers.code,
      phone: schema.customers.phone,
      email: schema.customers.email,
      gstin: schema.customers.gstin,
      address: schema.customers.address,
      stateCode: schema.customers.stateCode,
      creditLimit: schema.customers.creditLimit,
    })
    .from(schema.customers)
    .where(and(isNull(schema.customers.deletedAt), eq(schema.customers.isActive, 1)))
    .orderBy(schema.customers.name)

  /* `opening` is exported as a blank column rather than left out. It is a
     column the import understands, and a shop that exports, fills it in and
     re-imports is doing the thing it is for -- but exporting a *figure* there
     would re-post every opening balance on the way back in. */
  return toCsv(
    [...CUSTOMER_COLUMNS],
    rows.map((r) => [
      r.name,
      r.code ?? '',
      r.phone ?? '',
      r.email ?? '',
      r.gstin ?? '',
      r.address ?? '',
      r.stateCode ?? '',
      r.creditLimit === 0 ? '' : (r.creditLimit / 100).toFixed(2),
      '',
    ]),
  )
}

/**
 * A money cell.
 *
 * `signed` is for a balance carried over, where a minus means the shop is
 * holding their money. `parseMoney` refuses a minus, which is right for a
 * credit limit and wrong for a balance.
 */
function money(
  raw: string | undefined, opts: { signed?: boolean } = {},
): Money | null | 'bad' {
  const text = (raw ?? '').trim()
  if (text === '') return null
  const cleaned = text.replace(/[\u{20B9},\s]/gu, '')

  const negative = opts.signed === true && cleaned.startsWith('-')
  const value = parseMoney(negative ? cleaned.slice(1) : cleaned)
  // Below zero after the one sign allowed for is a second minus, or a minus
  // where none is allowed: a credit limit of -500 is not a limit.
  if (value === null || value < 0) return 'bad'
  return (negative ? -value : value) as Money
}
