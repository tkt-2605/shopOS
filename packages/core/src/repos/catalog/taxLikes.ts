import { and, eq, ne, or, like, isNotNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'

/**
 * The HSN and GST an item probably has, from the items the shop already has.
 *
 * A pair of scissors is HSN 8213 at 18% whoever made it, so the second pair
 * entered should not mean looking the code up again. This asks the shop's own
 * catalogue, never a table of its own: `domain/hsn.ts` says why software that
 * guessed at a code would be confidently wrong, and the shop's items are codes
 * somebody at the shop chose. Every answer is a suggestion a person picks.
 */
export interface TaxLike {
  hsnCode: string
  taxRateBp: number
  cessRateBp: number
  /** How many items carry this code at these rates. */
  items: number
  /** One of them, to show what it is like. */
  example: string
}

/** Words of a name worth matching on: no brand, no sizes, a plural taken back to one. */
export function nameWords(name: string, brand = ''): string[] {
  const skip = new Set(brand.toLowerCase().split(/[^a-z]+/).filter(Boolean))
  const words = name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !skip.has(w))
  return [...new Set(words.map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)))]
}

const shape = {
  id: schema.products.id,
  name: schema.products.name,
  hsnCode: schema.products.hsnCode,
  taxRateBp: schema.products.taxRateBp,
  cessRateBp: schema.products.cessRateBp,
}

function others(excludeId: string | null) {
  return and(
    isNotNull(schema.products.hsnCode),
    ne(schema.products.hsnCode, ''),
    eq(schema.products.isActive, 1),
    ...(excludeId ? [ne(schema.products.id, excludeId)] : []),
  )
}

/**
 * Codes on items named like this one, best first: the most words in common,
 * then the most items. Up to three, since a person reads them.
 */
export async function taxLikeName(
  db: SqlDriver, name: string, brand = '', excludeId: string | null = null,
): Promise<TaxLike[]> {
  const words = nameWords(name, brand)
  if (words.length === 0) return []
  const rows = await q(db).select(shape).from(schema.products)
    .where(and(others(excludeId), or(...words.map((w) => like(sql`lower(${schema.products.name})`, `%${w}%`)))))
    .limit(300)

  const found = new Map<string, TaxLike & { score: number }>()
  for (const r of rows) {
    const lower = r.name.toLowerCase()
    const score = words.filter((w) => lower.includes(w)).length
    const key = `${r.hsnCode}|${r.taxRateBp}|${r.cessRateBp}`
    const had = found.get(key)
    if (!had) {
      found.set(key, { hsnCode: r.hsnCode!, taxRateBp: r.taxRateBp, cessRateBp: r.cessRateBp, items: 1, example: r.name, score })
    } else {
      had.items++
      if (score > had.score) { had.score = score; had.example = r.name }
    }
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || b.items - a.items || a.hsnCode.localeCompare(b.hsnCode))
    .slice(0, 3)
    .map(({ score: _score, ...like }) => like)
}

/** The rates most of the shop's items with this code carry, or null when none has it. */
export async function taxForHsn(db: SqlDriver, hsnCode: string, excludeId: string | null = null): Promise<TaxLike | null> {
  const code = hsnCode.trim()
  if (code === '') return null
  const rows = await q(db).select(shape).from(schema.products)
    .where(and(others(excludeId), eq(schema.products.hsnCode, code)))
    .limit(300)
  const counts = new Map<string, TaxLike>()
  for (const r of rows) {
    const key = `${r.taxRateBp}|${r.cessRateBp}`
    const had = counts.get(key)
    if (had) had.items++
    else counts.set(key, { hsnCode: code, taxRateBp: r.taxRateBp, cessRateBp: r.cessRateBp, items: 1, example: r.name })
  }
  return [...counts.values()].sort((a, b) => b.items - a.items || b.taxRateBp - a.taxRateBp)[0] ?? null
}
