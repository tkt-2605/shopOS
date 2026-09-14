/**
 * What a document calls itself, its number, and the two parties.
 *
 * A module of its own rather than a corner of `receipt.ts`, because three
 * renderers need it and one of them must not depend on the other two. Pulling
 * these two declarations out is what breaks the cycle that otherwise runs
 * `docFormat → htmlTemplate → receipt → docFormat` — and that cycle is not
 * theoretical: `receipt.ts` computes its column widths at module load, so
 * entering the ring from the wrong side leaves `PAPER` undefined and every
 * format test fails on a line that has nothing to do with the change.
 *
 * Nothing is imported here, deliberately. This is a leaf.
 */
export interface DocWording {
  /** Across the head of the sheet: TAX INVOICE, QUOTATION, PURCHASE ORDER. */
  title: string
  /** Beside the number: "Invoice no.", "Quotation no.". */
  docNo: string
  /** On the party box: "Billed to", "Ordered from". */
  party: string
  /** On whoever raised it: "Billed by", "Raised by". */
  by: string
}

/** What a document with nothing to say about itself is: a bill. */
export const BILL_WORDING: DocWording = {
  title: 'Tax Invoice', docNo: 'Invoice no.', party: 'Billed to', by: 'Billed by',
}
