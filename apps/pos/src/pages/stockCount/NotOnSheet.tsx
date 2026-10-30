import { useState } from 'react'
import { searchProducts, addToCount, type CountSheet, type ProductListItem, type SqlDriver } from '@shopos/core'
import { useSearch, productMatches } from '../../ui/useSearch'

/*
 * What a search finds that the open sheet does not have: an item added to the
 * catalogue after the counting began. Searching the sheet alone could never
 * show it, and the counter standing at its shelf was told "Nothing matches".
 * Added at what the system believes now (`stockCountAdd.ts`).
 */
export function NotOnSheet({ db, sheet, term, actorId, onAdded, onError }: {
  db: SqlDriver
  sheet: CountSheet
  term: string
  actorId: string
  onAdded: () => Promise<void>
  onError: (message: string) => void
}) {
  const [adding, setAdding] = useState<string | null>(null)
  const search = useSearch<ProductListItem>(term, (t) => searchProducts(db, { term: t.trim(), limit: 20 }), { matches: productMatches })
  // Filtered here rather than in the search, so an item just added drops out at once.
  const on = new Set(sheet.lines.map((l) => l.productId))
  const found = search.rows.filter((p) => p.isStockTracked && !on.has(p.id))

  async function add(productId: string) {
    setAdding(productId)
    const result = await addToCount(db, { countId: sheet.id, productId, actorId })
    setAdding(null)
    if (!result.ok && result.code !== 'ALREADY_ON_SHEET') {
      onError(result.code === 'NOT_OPEN' ? 'This count sheet has already been posted.' : 'That item cannot be counted.')
      return
    }
    await onAdded()
  }

  if (found.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 6 }}>Not on this sheet</div>
      <table>
        <tbody>
          {found.map((p) => (
            <tr key={p.id}>
              <td>
                {p.name}
                {p.variantLabel && <span className="badge" style={{ marginLeft: 6 }}>{p.variantLabel}</span>}
              </td>
              <td style={{ color: 'var(--ink-3)' }}>{p.categoryName ?? '—'}</td>
              <td className="r">
                <button className="btn sm" disabled={adding !== null} onClick={() => void add(p.id)}>
                  {adding === p.id ? 'Adding…' : 'Add to this count'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
