import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { usePickList } from '../src/ui/PickList'

/**
 * Choosing from a list without the mouse.
 *
 * Every one of these lists used to be a `<tr onClick>` — a row the keyboard
 * could not reach at all, under a search box that was the dialog's only tab
 * stop. A cashier typed three letters and then had to let go of the keyboard.
 */

afterEach(cleanup)

const CUSTOMERS = ['Walk-in', 'Anand Stores', 'Bala Traders', 'Chithra Agencies']

function List({ onPick, items = CUSTOMERS }: { onPick: (i: number) => void; items?: string[] }) {
  const [term, setTerm] = useState('')
  const shown = items.filter((c) => c.toLowerCase().includes(term.toLowerCase()))
  const pick = usePickList({
    count: shown.length,
    resetKey: term,
    onPick: (i) => onPick(items.indexOf(shown[i]!)),
  })
  return (
    <div>
      <input
        placeholder="Name or phone"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={pick.searchKeyDown}
      />
      <ul {...pick.listProps}>
        {shown.map((c, i) => <li key={c} {...pick.rowProps(i)}>{c}</li>)}
      </ul>
    </div>
  )
}

const highlighted = () => document.querySelector('[aria-selected="true"]')?.textContent

describe('the arrow keys', () => {
  it('start on the first row, because it is the commonest answer', () => {
    render(<List onPick={vi.fn()} />)
    expect(highlighted()).toBe('Walk-in')
  })

  it('move down and back up', () => {
    render(<List onPick={vi.fn()} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(highlighted()).toBe('Bala Traders')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(highlighted()).toBe('Anand Stores')
  })

  /* Held rather than wrapped: at a counter, holding ↓ to get to the bottom is a
     thing people do, and wrapping round to the top reads as the list resetting. */
  it('stop at the ends rather than wrapping round', () => {
    render(<List onPick={vi.fn()} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(highlighted()).toBe('Walk-in')
    for (let i = 0; i < 9; i++) fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(highlighted()).toBe('Chithra Agencies')
  })

  it('jump to either end', () => {
    render(<List onPick={vi.fn()} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'End' })
    expect(highlighted()).toBe('Chithra Agencies')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(highlighted()).toBe('Walk-in')
  })
})

describe('picking', () => {
  it('takes the highlighted row on Enter', () => {
    const picked = vi.fn()
    render(<List onPick={picked} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(picked).toHaveBeenCalledWith(1)
  })

  it('still takes a click, for whoever reaches for the mouse', () => {
    const picked = vi.fn()
    render(<List onPick={picked} />)
    fireEvent.click(screen.getByText('Bala Traders'))
    expect(picked).toHaveBeenCalledWith(2)
  })
})

describe('the search box above the list', () => {
  /* Type three letters, press ↓, press Enter. This is the whole interaction the
     counter needs and the reason the list is one tab stop rather than a hundred. */
  it('hands the keyboard down into the list', () => {
    render(<List onPick={vi.fn()} />)
    const box = screen.getByPlaceholderText('Name or phone')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
  })

  it('takes the first match on Enter, without going down at all', () => {
    const picked = vi.fn()
    render(<List onPick={picked} />)
    const box = screen.getByPlaceholderText('Name or phone')
    fireEvent.change(box, { target: { value: 'bala' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(picked).toHaveBeenCalledWith(2)
  })

  /* The row highlighted a moment ago is not the same row now, and a cashier who
     does not notice picks the wrong customer. */
  it('puts the highlight back at the top when the search changes', () => {
    render(<List onPick={vi.fn()} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'End' })
    expect(highlighted()).toBe('Chithra Agencies')

    fireEvent.change(screen.getByPlaceholderText('Name or phone'), { target: { value: 'a' } })
    expect(highlighted()).toBe('Walk-in')
  })
})

describe('an empty list', () => {
  it('highlights nothing and picks nothing', () => {
    const picked = vi.fn()
    render(<List onPick={picked} items={[]} />)
    expect(highlighted()).toBeUndefined()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(picked).not.toHaveBeenCalled()
  })
})
