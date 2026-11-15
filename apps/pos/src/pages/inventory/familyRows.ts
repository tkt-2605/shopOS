import type { ProductListItem } from '@shopos/core'

export interface ListedItem {
  item: ProductListItem
  /** Its variants among what was found, in label order. */
  variants: ProductListItem[]
  /** Variants a search found by their own name or code: shown open and marked. */
  marked: Set<string>
}

/**
 * The Inventory list's rows: every item that is not a variant, each with the
 * variants of it that were found. A variant found without its family -- a
 * search for "black" -- sits under the family fetched for it (`parents`), and
 * is marked, so the list opens on what was asked for.
 */
export function familyRows(rows: readonly ProductListItem[], parents: readonly ProductListItem[], searching: boolean): ListedItem[] {
  const tops = [...rows.filter((r) => r.parentProductId === null), ...parents.filter((p) => !rows.some((r) => r.id === p.id))]
  const byLabel = (a: ProductListItem, b: ProductListItem) =>
    (a.variantLabel ?? a.name).localeCompare(b.variantLabel ?? b.name, undefined, { sensitivity: 'base' })
  return tops
    .map((item) => {
      const variants = rows.filter((r) => r.parentProductId === item.id).sort(byLabel)
      // The family's own name matching is not a variant found: only a hit the family did not explain is marked.
      const familyFound = rows.some((r) => r.id === item.id)
      const marked = new Set(searching && !familyFound ? variants.map((v) => v.id) : [])
      return { item, variants, marked }
    })
    .sort((a, b) => a.item.name.localeCompare(b.item.name, undefined, { sensitivity: 'base' }))
}
