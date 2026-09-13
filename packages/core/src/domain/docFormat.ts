/**
 * What a printed document is made of.
 *
 * A stack of blocks, each switchable and reorderable, rather than a template
 * language. The trade is deliberate: a shop cannot produce a layout we have not
 * thought about, and in exchange there is no way to type a broken bill. One
 * mistyped brace printing rubbish at a counter, mid-queue, with a customer
 * waiting, is not a trade worth offering.
 *
 * Pure: no IO, no database, no printer. The same reason `billTotals.ts` and
 * `receipt.ts` are pure — the rules can be tested without standing a shop up.
 */

export type BlockKind =
  | 'logo' | 'shop' | 'title' | 'meta' | 'party'
  | 'items' | 'totals' | 'tax_summary' | 'payments' | 'loyalty'
  | 'amount_in_words' | 'terms' | 'signature' | 'text' | 'space'

/** Per-kind settings. Narrow on purpose — every option here has a renderer. */
export interface BlockOpts {
  /** `title`: the words across the top. */
  label?: string
  /** `text`: the line itself, which may carry {{tokens}}. */
  body?: string
  /** `space`: how many blank lines. */
  lines?: number
}

export interface Block {
  kind: BlockKind
  on: boolean
  opts?: BlockOpts
}

export type PaperSize = 'thermal_58' | 'thermal_80'

export interface DocFormat {
  /** Stable across renames; what the print path stores and looks up. */
  id: string
  name: string
  paper: PaperSize
  /** Which documents this may print: `bill` today, orders in the next round. */
  kinds: string[]
  blocks: Block[]
}

/**
 * Printable columns per paper size, in Font A.
 *
 * Hardware facts, not preferences. A 43rd character on 80mm paper wraps and
 * takes the whole column alignment with it, which is why every pad and every
 * rule in `receipt.ts` is computed from this number rather than guessed.
 */
export const PAPER_COLUMNS: Record<PaperSize, number> = {
  thermal_58: 32,
  thermal_80: 42,
}

export const PAPER_LABEL: Record<PaperSize, string> = {
  thermal_58: '58mm roll, 32 columns',
  thermal_80: '80mm roll, 42 columns',
}

/**
 * Blocks with no renderer behind them yet.
 *
 * Kept in the type so the designer can list them greyed out with a reason,
 * rather than the shop finding out at the printer. A switch that is on and does
 * nothing is worse than one that is visibly not ready — the first teaches a
 * shopkeeper that the switches are not to be trusted.
 */
export const NOT_YET: Partial<Record<BlockKind, string>> = {
  logo: 'Needs the logo upload, which lands with the A4 designer.',
  amount_in_words: 'Needs rupees spelled out, which is its own job.',
}

export const BLOCK_LABEL: Record<BlockKind, string> = {
  logo: 'Logo',
  shop: 'Shop name and address',
  title: 'Title line',
  meta: 'Bill number and date',
  party: 'Customer block',
  items: 'Items',
  totals: 'Totals',
  tax_summary: 'Tax summary',
  payments: 'How it was paid',
  loyalty: 'Points',
  amount_in_words: 'Amount in words',
  terms: 'Footer note',
  signature: 'Signature line',
  text: 'Your own line',
  space: 'Blank space',
}

/** One line each, shown under the switch, saying what turning it off costs. */
export const BLOCK_NOTE: Partial<Record<BlockKind, string>> = {
  meta: 'The bill number. A receipt without one cannot be looked up again.',
  items: 'What was sold. Switching this off leaves only a total.',
  totals: 'Subtotal, tax, and the amount due.',
  tax_summary: 'Repeats the tax lines on their own. Off to begin with, because the totals block already carries them.',
  party: 'The customer on their own line. Off to begin with, because the bill-number line already carries the name.',
  terms: 'The note along the bottom, set on the Settings screen.',
  loyalty: 'Points earned and the running balance, when the shop runs a scheme.',
}

/**
 * What the product has always printed.
 *
 * Every block here is set so that rendering this format is byte-for-byte what
 * `buildReceipt` produced before formats existed — 80mm, taxes inside the
 * totals, the customer on the bill-number line. A shop that never opens the
 * designer must see no change at all, and `receiptFormat.test.ts` holds that.
 *
 * The blocks left off are off for a reason, not by oversight: `tax_summary` and
 * `party` would print a second copy of something already on the paper, and
 * `logo` and `amount_in_words` have no renderer yet.
 */
export const STANDARD_RECEIPT: DocFormat = {
  id: 'standard_receipt',
  name: 'Standard receipt',
  paper: 'thermal_80',
  kinds: ['bill'],
  blocks: [
    { kind: 'logo', on: false },
    { kind: 'shop', on: true },
    { kind: 'title', on: false, opts: { label: 'TAX INVOICE' } },
    { kind: 'meta', on: true },
    { kind: 'party', on: false },
    { kind: 'items', on: true },
    { kind: 'totals', on: true },
    { kind: 'tax_summary', on: false },
    { kind: 'payments', on: true },
    { kind: 'loyalty', on: true },
    { kind: 'amount_in_words', on: false },
    { kind: 'terms', on: true },
    { kind: 'signature', on: false },
  ],
}

/**
 * Fill in any block a stored format does not mention.
 *
 * A format saved by an older build will not carry a block added since. Reading
 * it back as "that block is off" would silently drop something from the paper,
 * so a block nobody has expressed an opinion about takes the standard's.
 *
 * It lands where the standard puts it rather than at the end, which is the
 * difference between a logo appearing above the shop name and a logo appearing
 * below the footer. The shop's own ordering of the blocks it does have is left
 * exactly as it arranged them.
 */
export function withEveryBlock(format: DocFormat): DocFormat {
  const named = new Set(format.blocks.map((b) => b.kind))
  const blocks = format.blocks.slice()

  STANDARD_RECEIPT.blocks.forEach((fallback, standardIndex) => {
    if (named.has(fallback.kind)) return

    // The nearest block above this one in the standard that the shop also has.
    const above = STANDARD_RECEIPT.blocks
      .slice(0, standardIndex)
      .reverse()
      .find((b) => named.has(b.kind))

    const at = above ? blocks.findIndex((b) => b.kind === above.kind) + 1 : 0
    blocks.splice(at, 0, { ...fallback })
    named.add(fallback.kind)
  })

  return { ...format, blocks }
}

/** Moves one block, and answers unchanged rather than throwing at either end. */
export function moveBlock(blocks: Block[], from: number, to: number): Block[] {
  if (from === to) return blocks
  if (from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) return blocks
  const next = blocks.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/* ------------------------------------------------------------- tokens --- */

/** The facts a `text` block can reach. Flat on purpose: one lookup, no walk. */
export type Facts = Record<string, string>

const TOKEN = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi

/**
 * Substitutes {{tokens}} in a line.
 *
 * A name nobody recognises renders as nothing rather than as the braces
 * themselves. Printing `{{shop.nmae}}` on a customer's bill is the failure this
 * avoids: the shopkeeper typed it, never saw it, and the customer did.
 */
export function fillTokens(line: string, facts: Facts): string {
  return line.replace(TOKEN, (_, name: string) => facts[name.toLowerCase()] ?? '')
}

/** What the designer lists beside the text field, so tokens are not guessed. */
export const TOKENS: ReadonlyArray<{ token: string; means: string }> = [
  { token: 'shop.name', means: 'The shop name' },
  { token: 'shop.address', means: 'The shop address' },
  { token: 'shop.phone', means: 'The shop phone number' },
  { token: 'shop.gstin', means: 'The shop GSTIN' },
  { token: 'doc.no', means: 'The bill number' },
  { token: 'doc.date', means: 'The date on the bill' },
  { token: 'customer.name', means: 'The customer, when the bill names one' },
  { token: 'total', means: 'The amount due' },
]

/* --------------------------------------------------------- validation --- */

export type FormatProblem =
  | { code: 'NAME_REQUIRED' }
  | { code: 'NOTHING_ON' }
  | { code: 'NO_ITEMS_BLOCK' }
  | { code: 'NOT_IMPLEMENTED'; kind: BlockKind }

/**
 * What a format has to satisfy before it is allowed near a printer.
 *
 * The items rule is the one worth naming: a receipt with no item lines is a
 * slip of paper with a total on it, which is not a bill, and no shop means to
 * print one. Caught here rather than at the counter.
 */
export function checkFormat(format: Pick<DocFormat, 'name' | 'blocks'>): FormatProblem[] {
  const problems: FormatProblem[] = []

  if (format.name.trim() === '') problems.push({ code: 'NAME_REQUIRED' })

  const on = format.blocks.filter((b) => b.on)
  if (on.length === 0) problems.push({ code: 'NOTHING_ON' })
  if (!on.some((b) => b.kind === 'items')) problems.push({ code: 'NO_ITEMS_BLOCK' })

  for (const block of on) {
    if (NOT_YET[block.kind]) problems.push({ code: 'NOT_IMPLEMENTED', kind: block.kind })
  }

  return problems
}
