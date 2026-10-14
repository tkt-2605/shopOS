import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A search box's list, and which term it was found for.
 *
 * Every search box waits a moment before asking, so the list on screen is
 * always the answer to a slightly older question. Reading it is fine. Acting on
 * it from the keyboard is not: a scanner types thirteen digits and Enter faster
 * than the wait, and Enter took row 0 of the list for the *empty* box -- the
 * first item in the catalog -- for a barcode the shop did not have, onto a bill
 * and into a goods receipt.
 *
 * So the list carries its term, and `latest()` is the only way to act on the
 * text as typed: the rows when they are current, otherwise asked again. And an
 * answer that arrives after a newer question was asked is dropped rather than
 * shown under a box that says something else.
 */
export interface Search<T> {
  /** What to draw. May be for an older term than the box shows; empty at once when the box is cleared. */
  rows: T[]
  /** Whether `rows` were found for the term as it stands. */
  current: boolean
  /** The rows for the term as typed right now. Nothing for an empty term. */
  latest: () => Promise<T[]>
}

export function useSearch<T>(
  term: string,
  /** Read afresh on every search, so it may close over anything. */
  find: (term: string) => Promise<T[]>,
  { delayMs = 140, browse = false, matches }: {
    delayMs?: number
    /** Search an empty term too, for a list that shows everything before typing. */
    browse?: boolean
    /**
     * Whether a row already on screen fits the term being typed. Given, the
     * rows found for an older term are narrowed to those while the answer for
     * this one is on its way -- see the return below.
     */
    matches?: (row: T, term: string) => boolean
  } = {},
): Search<T> {
  const [found, setFound] = useState<{ term: string | null; rows: T[] }>({ term: null, rows: [] })
  const findRef = useRef(find)
  findRef.current = find
  const now = useRef({ term, found })
  now.current = { term, found }

  const ask = useCallback(
    (t: string): Promise<T[]> => (t.trim() === '' && !browse ? Promise.resolve([]) : findRef.current(t)),
    [browse],
  )

  useEffect(() => {
    let superseded = false
    const id = setTimeout(() => {
      void ask(term).then((rows) => { if (!superseded) setFound({ term, rows }) })
    }, term.trim() === '' ? 0 : delayMs)
    return () => { superseded = true; clearTimeout(id) }
  }, [ask, term, delayMs])

  const latest = useCallback(async (): Promise<T[]> => {
    const { term: t, found: f } = now.current
    if (t.trim() === '') return []
    return f.term === t ? f.rows : ask(t)
  }, [ask])

  const cleared = term.trim() === '' && !browse
  /* Between a keystroke and its answer the list on screen is the last term's,
     and for a list that browses that is the whole catalog, A to Z: whatever a
     cashier typed, A4 Copier Paper sat at the top for as long as they kept
     typing, and a click or an arrow and Enter put it on the bill. Narrowed to
     what fits the term, the list never shows a row the term cannot mean. */
  const current = found.term === term
  const rows = cleared ? []
    : !current && matches !== undefined && term.trim() !== ''
      ? found.rows.filter((row) => matches(row, term.trim()))
      : found.rows
  return { rows, current, latest }
}

/**
 * Whether a row already on screen fits what is being typed, for `useSearch`'s
 * `matches`: the fields each search matches on in core, and no others, so the
 * list waiting for its answer shows nothing the answer would not.
 */

const fits = (fields: ReadonlyArray<string | null | undefined>, term: string): boolean => {
  const t = term.toLowerCase()
  return fields.some((v) => v?.toLowerCase().includes(t))
}

/** `searchProducts`: name, brand, code. */
export const productMatches = (p: { name: string; brand: string | null; code: string | null }, term: string): boolean =>
  fits([p.name, p.brand, p.code], term)

/** `searchCustomers`: name, phone, code. */
export const customerMatches = (c: { name: string; phone: string | null; code: string | null }, term: string): boolean =>
  fits([c.name, c.phone, c.code], term)
