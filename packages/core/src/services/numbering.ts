import type { SqlDriver } from '../db/driver.js'

/**
 * Numbers are scoped per register and per fiscal year. The register prefix is not
 * cosmetic — two terminals billing offline must not both mint INV-0042, and a
 * globally sequential counter cannot survive a second till.
 */

export type DocType = 'bill' | 'return' | 'payment' | 'stock_entry'

const ABBREV: Record<DocType, string> = {
  bill: 'INV',
  return: 'CRN',
  payment: 'RCP',
  stock_entry: 'STE',
}

/** Indian fiscal year runs April to March: 2026-06-01 is "26-27". */
export function fiscalYear(date: Date): string {
  const year = date.getUTCFullYear()
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1
  return `${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

export async function nextDocNo(
  tx: SqlDriver,
  docType: DocType,
  registerPrefix: string,
  on: Date = new Date(),
): Promise<string> {
  const fy = fiscalYear(on)
  const scope = `${docType}:${registerPrefix}:${fy}`

  await tx.execute(
    `INSERT INTO doc_sequences (scope, last_value) VALUES (?, 0) ON CONFLICT (scope) DO NOTHING`,
    [scope],
  )
  await tx.execute(`UPDATE doc_sequences SET last_value = last_value + 1 WHERE scope = ?`, [scope])

  const row = await tx.get<{ last_value: number }>(
    `SELECT last_value FROM doc_sequences WHERE scope = ?`,
    [scope],
  )
  const seq = row?.last_value ?? 1

  return `${ABBREV[docType]}/${registerPrefix}/${fy}/${String(seq).padStart(5, '0')}`
}

export async function peekDocNo(db: SqlDriver, docType: DocType, registerPrefix: string, on: Date = new Date()): Promise<string> {
  const fy = fiscalYear(on)
  const row = await db.get<{ last_value: number }>(
    `SELECT last_value FROM doc_sequences WHERE scope = ?`,
    [`${docType}:${registerPrefix}:${fy}`],
  )
  return `${ABBREV[docType]}/${registerPrefix}/${fy}/${String((row?.last_value ?? 0) + 1).padStart(5, '0')}`
}
