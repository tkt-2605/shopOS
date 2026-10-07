import { useRef, useState } from 'react'
import { searchProducts, scanChoices, type ProductListItem, type SqlDriver } from '@shopos/core'
import { usePickList } from '../../ui/PickList'
import { useSearch } from '../../ui/useSearch'
import type { Draft } from './draft'

/**
 * The "Version of" search: the main item a product is being grouped under.
 *
 * Held by the page rather than the form, so what was typed survives the form
 * closing and opening again, as it always has; saving clears it.
 */
export function useParentSearch(db: SqlDriver, draft: Draft | null, setDraft: (draft: Draft) => void) {
  const [parentSearch, setParentSearch] = useState('')
  const search = useSearch(parentSearch, (t) => searchProducts(db, { term: t, limit: 8 }))
  /* An item cannot be its own main item, so the row is dropped before the list
     is numbered — otherwise ↓ would land on a gap. */
  const notSelf = (rows: ProductListItem[]) => rows.filter((r) => r.id !== draft?.id)
  const parentOptions = notSelf(search.rows)
  const parentBox = useRef<HTMLInputElement>(null)

  const choose = (hit: ProductListItem | undefined) => {
    if (!hit || !draft) return
    setDraft({ ...draft, parentProductId: hit.id })
    setParentSearch('')
  }

  const parentPick = usePickList({
    count: parentOptions.length,
    resetKey: parentSearch,
    onPick: (i) => choose(parentOptions[i]),
    // A code on several items (069) is not a parent anybody chose: the list stays up to pick from.
    enter: async () => {
      const rows = notSelf(await search.latest())
      if (scanChoices(rows) === null) choose(rows[0])
    },
  })

  return { search: parentSearch, setSearch: setParentSearch, options: parentOptions, pick: parentPick, box: parentBox }
}

export type ParentSearch = ReturnType<typeof useParentSearch>
