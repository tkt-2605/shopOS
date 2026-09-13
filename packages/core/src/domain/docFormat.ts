/**
 * Document format: the blocks a receipt or invoice is made from, their order,
 * and which ones are switched on. Not a template language — a stack of choices
 * that render the same each time, so there is nothing to break on the counter.
 */

export type BlockKind =
  | 'logo' | 'shop' | 'title' | 'party' | 'meta'
  | 'items' | 'totals' | 'tax_summary' | 'payments'
  | 'amount_in_words' | 'terms' | 'signature' | 'text' | 'space'

export interface Block {
  kind: BlockKind
  on: boolean
  opts?: Record<string, string | number | boolean>
}

export type PaperSize = 'thermal_58' | 'thermal_80' | 'a4' | 'a5'

export interface DocFormat {
  id: string
  name: string
  paper: PaperSize
  kinds: string[]
  blocks: Block[]
  createdAt: string
  updatedAt: string
}

export const PAPER_WIDTHS: Record<PaperSize, number> = {
  thermal_58: 32, // characters at 12pt monospace
  thermal_80: 48,
  a4: 80, // columns at normal print width
  a5: 60,
}

/**
 * The default thermal format, which prints exactly what buildReceipt produces.
 * Every block is on. This is what a shop sees if it never opens the designer.
 */
export const THERMAL_DEFAULT: DocFormat = {
  id: 'thermal_default',
  name: 'Standard Receipt',
  paper: 'thermal_58',
  kinds: ['bill', 'quotation', 'sales_order'],
  blocks: [
    { kind: 'logo', on: true },
    { kind: 'shop', on: true },
    { kind: 'title', on: true, opts: { label: 'BILL' } },
    { kind: 'meta', on: true },
    { kind: 'party', on: true },
    { kind: 'items', on: true, opts: { columns: 'qty,rate,total' } },
    { kind: 'totals', on: true },
    { kind: 'tax_summary', on: true },
    { kind: 'payments', on: true },
    { kind: 'amount_in_words', on: true },
    { kind: 'terms', on: true },
    { kind: 'space', on: true, opts: { lines: 2 } },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

/**
 * The default A4 format, suitable for printing an invoice on letter paper.
 * Shop and invoice details in the header; party info in a box; full item table
 * with tax; totals and signature line.
 */
export const A4_DEFAULT: DocFormat = {
  id: 'a4_default',
  name: 'A4 Invoice',
  paper: 'a4',
  kinds: ['bill', 'quotation', 'sales_order'],
  blocks: [
    { kind: 'logo', on: true, opts: { align: 'right' } },
    { kind: 'shop', on: true },
    { kind: 'title', on: true, opts: { label: 'INVOICE' } },
    { kind: 'meta', on: true },
    { kind: 'party', on: true, opts: { style: 'box' } },
    { kind: 'items', on: true, opts: { columns: 'hsn,item,qty,rate,total,tax' } },
    { kind: 'tax_summary', on: true },
    { kind: 'totals', on: true },
    { kind: 'amount_in_words', on: true },
    { kind: 'terms', on: true },
    { kind: 'signature', on: true },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

export const DEFAULT_FORMATS: DocFormat[] = [THERMAL_DEFAULT, A4_DEFAULT]

/**
 * Resolve a {{token}} in a text block against the facts available at print time.
 * Returns empty string if the token does not exist — a mistyped name silently
 * renders as nothing rather than as the literal braces.
 */
export function resolveToken(token: string, facts: Record<string, any>): string {
  const path = token.split('.')
  let value: any = facts
  for (const segment of path) {
    if (value == null) return ''
    value = value[segment]
  }
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return ''
}

/**
 * The tokens that are valid in a `text` block {{like this}}.
 * This list is for the designer UI to show what is available; at print time,
 * any token not in the facts record renders as empty.
 */
export const TEXT_TOKENS = [
  'shop.name',
  'shop.address',
  'shop.phone',
  'shop.email',
  'shop.gstin',
  'doc.no',
  'doc.date',
  'customer.name',
  'customer.phone',
  'customer.place_of_supply',
]
