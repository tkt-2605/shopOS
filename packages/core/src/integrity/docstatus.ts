/**
 * Document lifecycle. A submitted document is immutable — it moved stock, took
 * money, and printed. Correction is cancel-then-amend into a new document that
 * links back, so the original stays on the record and the trail is intact.
 */

export const DRAFT = 0
export const SUBMITTED = 1
export const CANCELLED = 2

export type DocStatus = typeof DRAFT | typeof SUBMITTED | typeof CANCELLED

export type DocAction = 'save' | 'submit' | 'cancel' | 'delete'

const LEGAL: ReadonlyArray<readonly [DocStatus, DocAction, DocStatus | null]> = [
  [DRAFT, 'save', DRAFT],
  [DRAFT, 'submit', SUBMITTED],
  [DRAFT, 'delete', null],
  [SUBMITTED, 'cancel', CANCELLED],
]

export class DocStatusError extends Error {
  constructor(
    readonly entity: string,
    readonly from: DocStatus,
    readonly action: DocAction,
  ) {
    super(`cannot ${action} a ${label(from)} ${entity}`)
    this.name = 'DocStatusError'
  }
}

export function canApply(from: DocStatus, action: DocAction): boolean {
  return LEGAL.some(([f, a]) => f === from && a === action)
}

export function nextStatus(from: DocStatus, action: DocAction): DocStatus | null {
  const rule = LEGAL.find(([f, a]) => f === from && a === action)
  if (rule === undefined) throw new DocStatusError('document', from, action)
  return rule[2]
}

export function assertCanApply(entity: string, from: DocStatus, action: DocAction): void {
  if (!canApply(from, action)) throw new DocStatusError(entity, from, action)
}

/** Guards every write path into a document's own row. */
export function assertEditable(entity: string, status: DocStatus): void {
  if (status !== DRAFT) throw new DocStatusError(entity, status, 'save')
}

/** A document may only be amended from one that was cancelled. */
export function assertAmendable(entity: string, status: DocStatus): void {
  if (status !== CANCELLED) {
    throw new Error(`cannot amend a ${label(status)} ${entity} — cancel it first`)
  }
}

export function isDraft(status: DocStatus): boolean {
  return status === DRAFT
}

export function isSubmitted(status: DocStatus): boolean {
  return status === SUBMITTED
}

export function isCancelled(status: DocStatus): boolean {
  return status === CANCELLED
}

/** Only submitted documents post to ledgers. */
export function affectsLedgers(status: DocStatus): boolean {
  return status === SUBMITTED
}

export function label(status: DocStatus): string {
  switch (status) {
    case DRAFT:
      return 'draft'
    case SUBMITTED:
      return 'submitted'
    case CANCELLED:
      return 'cancelled'
  }
}

export function parseDocStatus(value: number): DocStatus {
  if (value === DRAFT || value === SUBMITTED || value === CANCELLED) return value
  throw new RangeError(`invalid docstatus: ${value}`)
}
