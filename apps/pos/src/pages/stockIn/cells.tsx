import { Batches, Money, Quantity, businessDate, type BatchRow, type ProductListItem } from '@shopos/core'

/*
 * The cells of a stock-in line that need more than an input box: its batch
 * and expiry, and the price the goods arrive at.
 */

export interface Line {
  key: string
  product: ProductListItem
  qty: string
  cost: string
  /** Typed for goods coming in, chosen from `held` for goods going out. */
  batchNo: string
  expiry: string
  /** The item's batches with stock, soonest expiry first, read when the line was added. */
  held: BatchRow[]
  /** On a purchase: the GST and cess percentages the supplier billed, filled in from the item. */
  gst: string
  cess: string
  /**
   * The MRP printed on these packs and the price they sell at, filled in from
   * the item. Changed, the goods go in a batch of their own at that price, and
   * the counter asks which when both are on the shelf (070).
   */
  mrp: string
  sellAt: string
}

/**
 * A line's batch and expiry. Coming in, both are typed off the pack; going
 * out, the batch is chosen from what is held, soonest expiry first, because
 * what is written off is nearly always what has gone past its date.
 */
export function BatchCells({ line, outgoing, onChange }: {
  line: Line
  outgoing: boolean
  onChange: (change: Partial<Line>) => void
}) {
  if (outgoing) {
    const chosen = line.held.find((b) => b.batchNo === line.batchNo)
    return (
      <>
        <td>
          {line.held.length === 0 ? <span className="src">no batches</span> : (
            <select className="select unit-select" aria-label="Batch" value={line.batchNo}
              onChange={(e) => onChange({ batchNo: e.target.value })}>
              <option value="">No batch</option>
              {line.held.map((b) => (
                <option key={b.batchId} value={b.batchNo}>{b.batchNo} · {Quantity.formatQty(b.balance)} left</option>
              ))}
            </select>
          )}
        </td>
        <td className="num">
          {chosen?.expiryDate ? Batches.formatExpiry(chosen.expiryDate) : ''}
          {chosen && Batches.expiryState(chosen.expiryDate, businessDate()) === 'expired' && (
            <div className="src warn-note">expired</div>
          )}
        </td>
      </>
    )
  }
  const parsed = Batches.parseExpiry(line.expiry)
  return (
    <>
      <td>
        <input className="input" style={{ width: 110 }} aria-label="Batch number" placeholder="B1234"
          value={line.batchNo} onChange={(e) => onChange({ batchNo: e.target.value })} />
      </td>
      <td>
        <input className="input num" style={{ width: 90 }} aria-label="Expiry" placeholder="MM/YYYY"
          value={line.expiry} onChange={(e) => onChange({ expiry: e.target.value })} />
        {!parsed.ok && <div className="src warn-note">not a date</div>}
        {parsed.ok && line.expiry !== '' && line.batchNo.trim() === '' && (
          <div className="src warn-note">needs a batch number</div>
        )}
      </td>
    </>
  )
}

/** The price a line gives its goods, sent only when it is not the item's own. See `incomingPrice`. */
export function ownPrice(line: Line): { mrp?: Money.Money; saleRate?: Money.Money } {
  const mrp = Money.parseMoney(line.mrp)
  const sellAt = Money.parseMoney(line.sellAt)
  return {
    ...(mrp !== null && mrp !== line.product.mrp ? { mrp } : {}),
    ...(sellAt !== null && sellAt !== line.product.baseRate ? { saleRate: sellAt } : {}),
  }
}

/**
 * The MRP on the pack and the price to sell at. Left as the item's, the goods
 * are ordinary stock; changed, they are kept apart at that price, and the
 * counter asks which when a scan finds both on the shelf.
 */
export function PriceCells({ line, onChange }: {
  line: Line
  onChange: (change: Partial<Line>) => void
}) {
  const changed = Object.keys(ownPrice(line)).length > 0
  return (
    <>
      <td className="r">
        <input className="qty-input num" placeholder="0.00" value={line.mrp} aria-label="MRP"
          onChange={(e) => onChange({ mrp: e.target.value })} />
        {changed && <div className="src">new price — kept apart</div>}
      </td>
      <td className="r">
        <input className="qty-input num" placeholder="0.00" value={line.sellAt} aria-label="Sell at"
          onChange={(e) => onChange({ sellAt: e.target.value })} />
      </td>
    </>
  )
}
