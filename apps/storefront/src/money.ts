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

/** How an order is named: "Order #12", the number a customer gives at the counter. */
export const orderLabel = (orderNo: number) => `Order #${orderNo}`

/** A WhatsApp link to `number` (digits, with the country), with a message typed in ready to send. */
export function waLink(number: string, text?: string): string {
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

/**
 * The cart as a WhatsApp message to the shop: each line, the total, and who is
 * asking when they are signed in. Plain text, because it is read on a phone
 * at the counter and copied into a bill by hand.
 */
/** A price, or "Price on request" when the shop lists items without them (a quotation). */
export function priceText(paise: number): string {
  return paise > 0 ? rupees(paise) : 'Price on request'
}

export function cartMessage(shop: string, lines: readonly CartLine[], who?: { name: string | null; phone: string | null } | null): string {
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0)
  /* Prices on request: the list alone, and a quotation asked for. */
  if (total === 0) {
    return [
      `Hello ${shop || 'there'}, please send me a quotation for:`,
      '',
      ...lines.map((l, i) => `${i + 1}. ${l.name} - ${l.qty} ${l.unit}`),
      '',
      ...(who?.name ? [`Name: ${who.name}${who.phone ? `, ${who.phone}` : ''}`] : []),
    ].join('\n')
  }
  return [
    `Hello ${shop || 'there'}, I would like to order:`,
    '',
    ...lines.map((l, i) => `${i + 1}. ${l.name} - ${l.qty} ${l.unit} x ${rupees(l.price)} = ${rupees(l.price * l.qty)}`),
    '',
    `Total: ${rupees(total)} (to pay when I collect)`,
    ...(who?.name ? [`Name: ${who.name}${who.phone ? `, ${who.phone}` : ''}`] : []),
    '',
    'Please confirm when it is ready.',
  ].join('\n')
}
