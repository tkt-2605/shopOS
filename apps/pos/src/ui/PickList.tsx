import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

/**
 * A list you can choose from without the mouse.
 *
 * Every chooseable list in this product was a `<tr onClick>`: a row that the
 * keyboard could not reach at all, in a dialog whose only tab stop was the
 * search box above it. A cashier who types three letters then has to let go of
 * the keyboard to pick the customer, which at a counter with a queue is the
 * whole cost of the feature.
 *
 * So: type, press ↓, press Enter. The search box hands off downward, the list
 * is one tab stop rather than two hundred, and the highlight goes back to the
 * top whenever the search changes — because the row that was highlighted a
 * moment ago is not the same row now.
 *
 * A hook rather than a component, because these lists are tables with different
 * columns everywhere and the markup is not the part worth sharing. The
 * behaviour is.
 */

/**
 * What the rows are.
 *
 * `listbox` is a chooser — a search dropdown, a customer picker — where the row
 * *is* the value. `grid` is a table of real columns whose rows happen to open
 * something: the bills list reads as data, and calling its rows options would
 * describe it wrongly to anyone not looking at the screen.
 *
 * The keyboard is identical either way. Only the announcement changes.
 */
export type PickShape = 'listbox' | 'grid'

export interface PickList {
  /** The highlighted row, or -1 when the list is empty. */
  index: number
  /** Props for the element that holds the rows — usually a `<tbody>`. */
  listProps: {
    role: PickShape
    tabIndex: 0
    'aria-activedescendant': string | undefined
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
    ref: (el: HTMLElement | null) => void
  }
  /** Props for each row, by position. */
  rowProps: (i: number) => {
    id: string
    role: 'option' | 'row'
    'aria-selected': boolean
    className: string
    onClick: () => void
    onMouseMove: () => void
  }
  /** Moves the keyboard into the list. For a search box's ↓. */
  focusList: () => void
  /** Put on a search input: ↓ enters the list, Enter takes the first row. */
  searchKeyDown: (e: KeyboardEvent<HTMLElement>) => void
}

/** How far PageUp and PageDown move. A screenful, near enough. */
const PAGE = 10

export function usePickList({
  count, onPick, resetKey, as = 'listbox',
}: {
  count: number
  onPick: (index: number) => void
  /** Whatever makes the rows mean something else — usually the search term. */
  resetKey?: unknown
  as?: PickShape
}): PickList {
  const base = useId()
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLElement | null>(null)
  const pick = useRef(onPick)
  pick.current = onPick

  // A new search is a new list. Holding position would leave the highlight on
  // whichever row happened to land in that slot, which is how a cashier picks
  // the wrong customer.
  useEffect(() => { setIndex(0) }, [resetKey])

  const here = count === 0 ? -1 : Math.min(index, count - 1)
  const rowId = useCallback((i: number) => `${base}-row-${i}`, [base])

  /* Keep the highlight on screen. A list that is scrolled by the arrow keys but
     does not follow them is worse than one that cannot be arrowed at all. */
  useEffect(() => {
    if (here < 0 || !list.current) return
    const row = list.current.ownerDocument.getElementById(rowId(here))
    // Guarded: not every environment that renders this implements it, and a
    // list that cannot scroll itself should still be usable.
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [here, rowId])

  const move = useCallback((to: number) => {
    if (count === 0) return
    setIndex(Math.max(0, Math.min(to, count - 1)))
  }, [count])

  const focusList = useCallback(() => { list.current?.focus() }, [])

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(here + 1); return
      case 'ArrowUp': e.preventDefault(); move(here - 1); return
      case 'PageDown': e.preventDefault(); move(here + PAGE); return
      case 'PageUp': e.preventDefault(); move(here - PAGE); return
      case 'Home': e.preventDefault(); move(0); return
      case 'End': e.preventDefault(); move(count - 1); return
      case 'Enter':
      case ' ':
        if (here < 0) return
        e.preventDefault()
        pick.current(here)
        return
      default:
    }
  }

  /* Escape is deliberately not handled here. It belongs to the dialog, which
     closes; a list that swallowed it would leave the cashier pressing it twice. */
  function searchKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(0); focusList(); return }
    if (e.key === 'Enter' && count > 0) { e.preventDefault(); pick.current(0) }
  }

  return {
    index: here,
    listProps: {
      role: as,
      tabIndex: 0,
      'aria-activedescendant': here >= 0 ? rowId(here) : undefined,
      onKeyDown,
      ref: (el) => { list.current = el },
    },
    rowProps: (i) => ({
      id: rowId(i),
      role: as === 'grid' ? 'row' : 'option',
      'aria-selected': i === here,
      className: 'pickable',
      onClick: () => pick.current(i),
      // Following the mouse keeps one highlight rather than two disagreeing ones.
      onMouseMove: () => { if (i !== here) setIndex(i) },
    }),
    focusList,
    searchKeyDown,
  }
}
