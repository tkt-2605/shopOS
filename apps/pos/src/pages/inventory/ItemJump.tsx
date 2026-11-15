import { useRef, useState } from 'react'
import { searchProducts, scanChoices, type ProductListItem } from '@shopos/core'
import { useDb } from '../../core/CoreProvider'
import { Results, usePickList } from '../../ui/PickList'
import { useSearch } from '../../ui/useSearch'

/**
 * "Go to another item", at the top of an item's page: a name or a scanned
 * barcode opens that item, on whichever tab is showing. Going through items one
 * by one -- fixing prices, checking stock -- no longer means the list in
 * between each one.
 *
 * Took the place of the "Version of" search, which grouped an item under
 * another by hand; variants are now made from their family.
 */
export function ItemJump({ currentId, onOpen }: {
  currentId: string | null
  onOpen: (item: ProductListItem) => void
}) {
  const db = useDb()
  const [term, setTerm] = useState('')
  const search = useSearch(term, (t) => searchProducts(db, { term: t, limit: 8, includeInactive: true }))
  const options = search.rows.filter((r) => r.id !== currentId)
  const box = useRef<HTMLInputElement>(null)

  const open = (hit: ProductListItem | undefined) => {
    if (!hit) return
    setTerm('')
    onOpen(hit)
  }
  const pick = usePickList({
    count: options.length,
    resetKey: term,
    onPick: (i) => open(options[i]),
    // A code on several items (069) is not an item anybody chose: the list stays up to pick from.
    enter: async () => {
      const rows = (await search.latest()).filter((r) => r.id !== currentId)
      if (scanChoices(rows) === null) open(rows[0])
    },
  })

  return (
    <div style={{ width: 300 }}>
      <input className="input" ref={box} placeholder="Go to another item: name or barcode"
        aria-label="Go to another item" value={term}
        onChange={(e) => setTerm(e.target.value)} onKeyDown={pick.searchKeyDown} />
      <Results anchor={box} open={term.trim() !== '' && options.length > 0}>
        <div {...pick.listProps}>
          {options.map((r, i) => (
            <div key={r.id} style={{ padding: '6px 10px' }} {...pick.rowProps(i)}>
              {r.name}
              {r.parentName && <span className="src"> · a variant of {r.parentName}</span>}
            </div>
          ))}
        </div>
      </Results>
    </div>
  )
}
