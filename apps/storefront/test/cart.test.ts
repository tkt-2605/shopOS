import { describe, it, expect } from 'vitest'
import { addToCart, cartTotal, rupees, setQty, shownName, type CartLine } from '../src/money'

/** The cart on the phone: money in paise, whole units, one line per item and unit. */

const pen: CartLine = { productId: 'p1', name: 'Pen', unit: 'piece', qty: 2, price: 1000 }
const box: CartLine = { productId: 'p1', name: 'Pen', unit: 'box', qty: 1, price: 8500 }

describe('the cart', () => {
  it('adds to the line already there for the same item and unit, and keeps a box apart', () => {
    const once = addToCart([], pen)
    const twice = addToCart(once, { ...pen, qty: 3 })
    expect(twice).toEqual([{ ...pen, qty: 5 }])
    expect(addToCart(twice, box)).toHaveLength(2)
  })

  it('totals in paise and drops a line taken to nothing', () => {
    const lines = [pen, box]
    expect(cartTotal(lines)).toBe(10500)
    expect(setQty(lines, 0, 0)).toEqual([box])
    expect(setQty(lines, 1, 1000)[1]!.qty).toBe(999)
  })

  it('shows rupees, with paise only when there are some', () => {
    expect(rupees(10000)).toBe('₹100')
    expect(rupees(1050)).toBe('₹10.50')
    expect(rupees(12345600)).toBe('₹1,23,456')
  })
})

describe('an item’s name', () => {
  it('carries its brand in brackets, once', () => {
    expect(shownName({ name: 'Pen', brand: 'Cello' })).toBe('Pen (Cello)')
    expect(shownName({ name: 'Cello Gripper pen', brand: 'Cello' })).toBe('Cello Gripper pen')
    expect(shownName({ name: 'Notebook', brand: null })).toBe('Notebook')
    expect(shownName({ name: 'Notebook', brand: '  ' })).toBe('Notebook')
  })
})
