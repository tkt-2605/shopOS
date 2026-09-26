import type { DocumentStatus, DocumentListItem } from '@shopos/core'

/* What the list calls a document's state, and how far an order has got. */

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  /* "Open" rather than "Issued", because issued is what they all are and it
     therefore told a shopkeeper nothing. The list they actually want is the one
     with something still to do on it — a quotation won and billed last month
     sat in "Issued" for ever, beside the ones still waiting for an answer. */
  open: 'Open', completed: 'Completed', draft: 'Drafts',
  cancelled: 'Cancelled', all: 'All', issued: 'Issued',
}

/** Against a submitted document, how much of it has been acted on. */
export const PROGRESS: Record<DocumentListItem['progress'], string> = {
  open: 'nothing yet', part: 'part done', done: 'done',
}

/* ---------------------------------------------------------- the drafting --- */
