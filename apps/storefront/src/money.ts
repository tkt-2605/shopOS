/** Integer paise as ₹, with paise only when there are some. */
export function rupees(paise: number): string {
  const whole = paise % 100 === 0
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/** A line of the cart: one item, one unit, how many, at the price shown. */
export interface CartLine {
  productId: string
  name: string
  unit: string
  qty: number
  price: number
}

export function cartTotal(lines: readonly CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0)
}

/** Adds to a line already in the cart for the same item and unit, else a new line. */
export function addToCart(lines: readonly CartLine[], add: CartLine): CartLine[] {
  const at = lines.findIndex((l) => l.productId === add.productId && l.unit === add.unit)
  if (at < 0) return [...lines, add]
  return lines.map((l, i) => (i === at ? { ...l, qty: Math.min(999, l.qty + add.qty) } : l))
}

export function setQty(lines: readonly CartLine[], index: number, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((_, i) => i !== index)
  return lines.map((l, i) => (i === index ? { ...l, qty: Math.min(999, Math.floor(qty)) } : l))
}

/** An item as the customer reads it: "Pen (Cello)", unless the name already says the brand. */
export function shownName(item: { name: string; brand: string | null }): string {
  const brand = item.brand?.trim()
  if (!brand || item.name.toLowerCase().includes(brand.toLowerCase())) return item.name
  return `${item.name} (${brand})`
}
