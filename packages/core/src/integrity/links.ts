import type { SqlDriver } from '../db/driver.js'

/**
 * Nothing a document references is ever hard-deleted. Before a delete is allowed
 * the inbound references are counted and the caller is told where they are —
 * "used on 14 bills, most recent INV-2026-0431" rather than a foreign-key error.
 */

export interface LinkRule {
  table: string
  column: string
  label: string
  /** Column carrying a human reference, shown as the most recent example. */
  displayColumn?: string
}

export const LINK_RULES: Readonly<Record<string, readonly LinkRule[]>> = {
  products: [
    { table: 'bill_items', column: 'product_id', label: 'bills', displayColumn: 'bill_id' },
    { table: 'stock_entry_items', column: 'product_id', label: 'stock entries' },
    { table: 'stock_ledger', column: 'product_id', label: 'stock ledger entries' },
    { table: 'batches', column: 'product_id', label: 'batches', displayColumn: 'batch_no' },
    { table: 'item_prices', column: 'product_id', label: 'price list entries' },
    { table: 'customer_item_prices', column: 'product_id', label: 'customer prices' },
    { table: 'sales_return_items', column: 'product_id', label: 'returns' },
  ],
  customers: [
    { table: 'bills', column: 'customer_id', label: 'bills', displayColumn: 'doc_no' },
    { table: 'payment_entries', column: 'customer_id', label: 'payments', displayColumn: 'doc_no' },
    { table: 'loyalty_entries', column: 'customer_id', label: 'loyalty entries' },
    { table: 'customer_item_prices', column: 'customer_id', label: 'customer prices' },
  ],
  price_lists: [
    { table: 'item_prices', column: 'price_list_id', label: 'price list entries' },
    { table: 'customers', column: 'price_list_id', label: 'customers' },
  ],
  suppliers: [
    { table: 'stock_entries', column: 'supplier_id', label: 'stock entries', displayColumn: 'doc_no' },
    { table: 'payment_entries', column: 'supplier_id', label: 'payments', displayColumn: 'doc_no' },
  ],
  roles: [{ table: 'users', column: 'role_id', label: 'users', displayColumn: 'username' }],
  registers: [
    { table: 'bills', column: 'register_id', label: 'bills', displayColumn: 'doc_no' },
    { table: 'cash_sessions', column: 'register_id', label: 'cash sessions' },
  ],
  categories: [{ table: 'products', column: 'category_id', label: 'products', displayColumn: 'name' }],
  users: [
    { table: 'bills', column: 'created_by', label: 'bills', displayColumn: 'doc_no' },
    { table: 'cash_sessions', column: 'opened_by', label: 'cash sessions' },
  ],
}

export interface LinkReference {
  label: string
  count: number
  example: string | null
}

export interface LinkCheck {
  deletable: boolean
  references: LinkReference[]
}

export async function checkLinks(db: SqlDriver, entity: string, id: string): Promise<LinkCheck> {
  const rules = LINK_RULES[entity]
  if (!rules || rules.length === 0) return { deletable: true, references: [] }

  const references: LinkReference[] = []

  for (const rule of rules) {
    const countRow = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${rule.table} WHERE ${rule.column} = ?`,
      [id],
    )
    const count = countRow?.n ?? 0
    if (count === 0) continue

    let example: string | null = null
    if (rule.displayColumn) {
      const row = await db.get<Record<string, string>>(
        `SELECT ${rule.displayColumn} AS v FROM ${rule.table} WHERE ${rule.column} = ? ORDER BY rowid DESC LIMIT 1`,
        [id],
      )
      example = row?.['v'] ?? null
    }

    references.push({ label: rule.label, count, example })
  }

  return { deletable: references.length === 0, references }
}

export class LinkedRecordError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
    readonly references: LinkReference[],
  ) {
    super(`Cannot delete: ${describe(references)}. Deactivate it instead.`)
    this.name = 'LinkedRecordError'
  }
}

export async function assertDeletable(db: SqlDriver, entity: string, id: string): Promise<void> {
  const check = await checkLinks(db, entity, id)
  if (!check.deletable) throw new LinkedRecordError(entity, id, check.references)
}

function describe(references: LinkReference[]): string {
  return references
    .map((r) => {
      const base = `used on ${r.count} ${r.label}`
      return r.example ? `${base}, most recent ${r.example}` : base
    })
    .join('; ')
}
