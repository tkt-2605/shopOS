import type { SqlDriver } from '../db/driver.js'
import { DOCUMENT_TABLES, assertCanApply, parseDocStatus, type DocAction } from './docstatus.js'

/**
 * The docstatus check, made again inside the transaction that acts on it.
 *
 * Every submit and cancel reads the document, checks it may take the action,
 * and only then opens a transaction to do it. Between the two, the same call
 * can run again -- a second click on a payment button, a retried request --
 * and it reads the same draft, passes the same check and queues behind the
 * first. When its turn comes it posts the stock, the money and a new number a
 * second time onto a document that is already submitted.
 *
 * Writes are serialized, so a read made inside the transaction is the answer:
 * nothing can change the row between here and the commit. Call it first thing
 * in the transaction and the second caller is refused with the same
 * `DocStatusError` the outer check would have given it.
 */
export async function recheckDocStatus(
  tx: SqlDriver,
  table: string,
  id: string,
  entity: string,
  action: DocAction,
): Promise<void> {
  if (!DOCUMENT_TABLES.has(table)) throw new Error(`${table} is not a document table`)
  // raw: the table is named at run time, from the fixed set checked above
  const row = await tx.get<{ docstatus: number }>(`SELECT docstatus FROM ${table} WHERE id = ?`, [id])
  if (!row) throw new Error(`unknown ${entity}: ${id}`)
  assertCanApply(entity, parseDocStatus(Number(row.docstatus)), action)
}
