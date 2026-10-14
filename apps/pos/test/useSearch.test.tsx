import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import { useSearch } from '../src/ui/useSearch'

/**
 * A search box's list, and which term it belongs to.
 *
 * The bug this exists for: a scanner typed 4001234567891 and Enter inside the
 * search's wait, Enter took row 0 of the list still showing for the empty box,
 * and A4 Copier Paper went on the bill for a barcode the shop did not have.
 */

afterEach(cleanup)

/** A search whose answers arrive when the test says, in whatever order. */
function controlled() {
  const pending = new Map<string, (rows: string[]) => void>()
  const find = vi.fn((term: string) => new Promise<string[]>((resolve) => { pending.set(term, resolve) }))
  const answer = (term: string, rows: string[]) => act(async () => { pending.get(term)!(rows) })
  return { find, answer, asked: (term: string) => pending.has(term) }
}

describe('the rows', () => {
  it('know when they were found for an older term', async () => {
    const find = vi.fn(async (t: string) => [`row for "${t}"`])
    const { result, rerender } = renderHook(({ term }) => useSearch(term, find, { browse: true }), {
      initialProps: { term: '' },
    })
    await waitFor(() => expect(result.current.rows).toEqual(['row for ""']))
    expect(result.current.current).toBe(true)

    rerender({ term: '4001234567891' })
    expect(result.current.rows).toEqual(['row for ""'])
    expect(result.current.current).toBe(false)
  })

  it('drop an answer that arrives after a newer question', async () => {
    const s = controlled()
    const { result, rerender } = renderHook(({ term }) => useSearch(term, s.find, { delayMs: 0 }), {
      initialProps: { term: 'p' },
    })
    await waitFor(() => expect(s.asked('p')).toBe(true))
    rerender({ term: 'pen' })
    await waitFor(() => expect(s.asked('pen')).toBe(true))

    await s.answer('pen', ['Pen, blue'])
    await s.answer('p', ['Paper', 'Pen, blue', 'Pencil'])
    expect(result.current.rows).toEqual(['Pen, blue'])
    expect(result.current.current).toBe(true)
  })

  it('empty at once when the box is cleared, without waiting to ask', async () => {
    const find = vi.fn(async (t: string) => [t])
    const { result, rerender } = renderHook(({ term }) => useSearch(term, find), { initialProps: { term: 'pen' } })
    await waitFor(() => expect(result.current.rows).toEqual(['pen']))
    rerender({ term: '' })
    expect(result.current.rows).toEqual([])
  })
})

describe('latest', () => {
  it('asks again when the rows on screen are for an older term', async () => {
    const find = vi.fn(async (t: string) => (t === '' ? ['A4 Copier Paper', 'Ball Pen'] : []))
    const { result, rerender } = renderHook(({ term }) => useSearch(term, find, { browse: true }), {
      initialProps: { term: '' },
    })
    await waitFor(() => expect(result.current.rows).toHaveLength(2))

    // The scanner: thirteen digits and Enter, before the search has run.
    rerender({ term: '4001234567891' })
    const rows = await result.current.latest()
    expect(rows).toEqual([])
    expect(find).toHaveBeenLastCalledWith('4001234567891')
  })

  it('uses the rows on screen when they are for this term', async () => {
    const find = vi.fn(async (t: string) => [t.toUpperCase()])
    const { result } = renderHook(() => useSearch('pen', find))
    await waitFor(() => expect(result.current.current).toBe(true))
    find.mockClear()
    expect(await result.current.latest()).toEqual(['PEN'])
    expect(find).not.toHaveBeenCalled()
  })

  it('is nothing for an empty box, even one that lists everything', async () => {
    const find = vi.fn(async () => ['A4 Copier Paper'])
    const { result } = renderHook(() => useSearch('  ', find, { browse: true }))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(await result.current.latest()).toEqual([])
  })
})

describe('the list while the answer for a new term is on its way', () => {
  /* What a cashier saw: the empty box browses the whole catalog A to Z, and
     for as long as they kept typing the list stayed that -- A4 Copier Paper
     at the top, whatever they typed, and a click or arrow-and-Enter took it. */
  const catalog = ['A4 Copier Paper', 'Ball Pen Black', 'Gel Pen 0.5mm', 'Stapler']
  const byName = (row: string, t: string) => row.toLowerCase().includes(t.toLowerCase())

  it('shows only what the term can mean, not the whole catalog', async () => {
    const s = controlled()
    const { result, rerender } = renderHook(
      ({ term }) => useSearch(term, s.find, { browse: true, delayMs: 0, matches: byName }),
      { initialProps: { term: '' } },
    )
    await waitFor(() => expect(s.asked('')).toBe(true))
    await s.answer('', catalog)

    rerender({ term: 'pen' })
    expect(result.current.current, 'the answer for "pen" has not come yet').toBe(false)
    expect(result.current.rows).toEqual(['Ball Pen Black', 'Gel Pen 0.5mm'])

    await waitFor(() => expect(s.asked('pen')).toBe(true))
    await s.answer('pen', ['Ball Pen Black', 'Gel Pen 0.5mm', 'Pencil HB'])
    expect(result.current.rows, 'and then the real answer').toEqual(['Ball Pen Black', 'Gel Pen 0.5mm', 'Pencil HB'])
  })

  it('shows nothing rather than something the term cannot mean', async () => {
    const s = controlled()
    const { result, rerender } = renderHook(
      ({ term }) => useSearch(term, s.find, { browse: true, delayMs: 0, matches: byName }),
      { initialProps: { term: '' } },
    )
    await waitFor(() => expect(s.asked('')).toBe(true))
    await s.answer('', catalog)
    rerender({ term: 'rice' })
    expect(result.current.rows).toEqual([])
  })
})
