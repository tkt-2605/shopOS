import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

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
}

/**
 * A list with a search box above it. Only a list given `enter` has one, so a
 * search box cannot be wired up without saying what Enter does.
 */
export interface SearchPickList extends PickList {
  /** Put on a search input: ↓ enters the list, Enter calls `enter`. */
  searchKeyDown: (e: KeyboardEvent<HTMLElement>) => void
}

interface PickOptions {
  count: number
  onPick: (index: number) => void
  /**
   * Enter in the search box. Not "row 0": the rows on screen were found for
   * an older term (see `useSearch`), and a scanner presses Enter before the
   * new ones arrive.
   */
  enter?: () => unknown
  /** Whatever makes the rows mean something else — usually the search term. */
  resetKey?: unknown
  as?: PickShape
}

/** How far PageUp and PageDown move. A screenful, near enough. */
const PAGE = 10

export function usePickList(options: PickOptions & { enter: () => unknown }): SearchPickList
export function usePickList(options: Omit<PickOptions, 'enter'>): PickList
export function usePickList({ count, onPick, enter, resetKey, as = 'listbox' }: PickOptions): SearchPickList {
  const base = useId()
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLElement | null>(null)
  const pick = useRef(onPick)
  pick.current = onPick
  const enterRef = useRef(enter)
  enterRef.current = enter

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
    if (e.key === 'Enter' && enterRef.current) { e.preventDefault(); void enterRef.current() }
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

/* ------------------------------------------------- the floating list --- */

/**
 * The panel a search list drops into.
 *
 * It is portalled to the body and positioned in viewport coordinates, which is
 * not decoration — it is the only arrangement that survives this app's own
 * layout. A dropdown rendered where it is written has to escape every ancestor
 * that clips, and there are two of them everywhere: `.card` sets
 * `overflow: hidden` so its header rule meets its border cleanly, and `.modal`
 * sets `overflow-y: auto` so a tall dialog scrolls. Either one slices an
 * absolutely-positioned child off at the box edge.
 *
 * That is what the Special Prices screen was doing: the customer list rendered
 * correctly, six pixels below the search box, and the card cut all but the top
 * of the first row. Anchoring it (`.results-anchor`) had fixed *where* it
 * appeared without fixing *that it was being cut*, because the clip is the
 * ancestor's, not the anchor's.
 *
 * Out here nothing clips it. The cost is that it no longer moves with the page
 * on its own, so it is re-measured on resize and on any scroll anywhere —
 * captured, because the scroll that matters is a container's, not the window's,
 * and a container's scroll event does not bubble.
 */
export function Results({ anchor, open, children }: {
  /** The box it hangs from — the search input, or the bar holding it. */
  anchor: RefObject<HTMLElement | null>
  open: boolean
  children: ReactNode
}) {
  const [box, setBox] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) { setBox(null); return }

    const place = () => {
      const el = anchor.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const room = { below: window.innerHeight - r.bottom - GAP - EDGE, above: r.top - GAP - EDGE }

      /* Upwards when there is not enough room below and more of it above. The
         last row of a list at the foot of the window is the one a cashier
         reaches for, so "it fits, mostly" is not good enough. */
      const up = room.below < MIN_DROP && room.above > room.below
      const height = Math.max(MIN_DROP, Math.min(up ? room.above : room.below, window.innerHeight * 0.46))

      setBox({
        left: Math.round(r.left),
        width: Math.round(r.width),
        maxHeight: Math.round(height),
        ...(up
          ? { bottom: Math.round(window.innerHeight - r.top + GAP) }
          : { top: Math.round(r.bottom + GAP) }),
      })
    }

    place()
    window.addEventListener('resize', place)
    // Capture: a scrolling `.content` or `.modal` does not bubble its scroll.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, children])

  if (!open || !box) return null

  /* Tab hands the keyboard back to the search box and then carries on, so the
     next stop is the one after the box rather than wherever the body happens to
     put this panel. Not prevented: Tab has to keep meaning Tab. */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Tab') anchor.current?.focus()
  }

  return createPortal(
    <div className="results" style={box} onKeyDown={onKeyDown}>{children}</div>,
    document.body,
  )
}

/** The gap between the box and its list, and the paper edge it will not touch. */
const GAP = 6
const EDGE = 10
/** Less room than this below and the list would rather open upwards. */
const MIN_DROP = 170
