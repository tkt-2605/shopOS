import { useEffect, useRef, useState } from 'react'
import { searchProducts, type ProductListItem, type SqlDriver } from '@shopos/core'
import { usePickList } from '../../ui/PickList'
import type { Draft } from './draft'

/**
 * The "Version of" search: the main item a product is being grouped under.
 *
 * Held by the page rather than the form, so what was typed survives the form
 * closing and opening again, as it always has; saving clears it.
 */
export function useParentSearch(db: SqlDriver, draft: Draft | null, setDraft: (draft: Draft) => void) {
  const [parentSearch, setParentSearch] = useState('')
  const [parentResults, setParentResults] = useState<ProductListItem[]>([])
  /* An item cannot be its own main item, so the row is dropped before the list
     is numbered — otherwise ↓ would land on a gap. */
  const parentOptions = parentResults.filter((r) => r.id !== draft?.id)
  const parentBox = useRef<HTMLInputElement>(null)

  const parentPick = usePickList({
    count: parentOptions.length,
    resetKey: parentSearch,
    onPick: (i) => {
      const hit = parentOptions[i]
      if (!hit || !draft) return
      setDraft({ ...draft, parentProductId: hit.id })
      setParentSearch('')
    },
  })

  useEffect(() => {
    const id = setTimeout(async () => {
      setParentResults(parentSearch.trim() === '' ? [] : await searchProducts(db, { term: parentSearch, limit: 8 }))
    }, 140)
    return () => clearTimeout(id)
  }, [db, parentSearch])

  return { search: parentSearch, setSearch: setParentSearch, options: parentOptions, pick: parentPick, box: parentBox }
}

export type ParentSearch = ReturnType<typeof useParentSearch>
