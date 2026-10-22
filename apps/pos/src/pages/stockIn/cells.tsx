import {
  Batches, CostFloor, Money, Quantity, Tax, businessDate, type BatchRow, type CostHint, type ProductListItem,
} from '@shopos/core'
import { bpOf, pairOf, type Side } from '../../ui/gstPair'

/*
 * The cells of a stock-in line that need more than an input box: its batch
 * and expiry, and the price the goods arrive at.
 */

export interface Line {
  key: string
  product: ProductListItem
  qty: string
  /** The unit cost as typed, on whichever side `costSide` says. */
  cost: string
  /**
   * Which box the cost was typed in: before GST, or with it, off a bill that
   * prints it that way. The other box is worked out (`gstPair.ts`); what is
   * posted is always the cost before GST.
   */
  costSide: Side
  /**
   * Where the cost the line was given came from: the last price paid, or the
   * item's cost price (`costHints`). Null when nothing was known.
   */
  hint: CostHint | null
  /**
   * The cost is still the one filled in, not one somebody typed. It only
   * counts on goods coming in: on goods going out a cost values the loss at
   * that figure instead of at what the shelf holds, so a filled-in one is
   * dropped there (`costOf`).
   */
  costFilled: boolean
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
  /**
   * The purchase order line these goods came against, when Stock In is
   * receiving an order, and what that line still had open. Absent on a line
   * the order never asked for, which comes in as goods on the same bill.
   */
  orderLine?: { id: string; left: Quantity.Qty }
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

/** The line's cost both ways, at its own GST and cess. */
export function costPair(line: Line) {
  return pairOf(line.cost, line.costSide, bpOf(line.gst), bpOf(line.cess))
}

/**
 * The cost a line carries before GST, which is what is posted: blank for goods
 * going out whose cost was only ever filled in, so they leave at what the shelf
 * holds, as they always have.
 */
export function costOf(line: Line, outgoing: boolean): string {
  return outgoing && line.costFilled ? '' : costPair(line).before
}

/**
 * What the line's Sell at comes to against its own cost, per unit and before
 * GST, when it is below: said under the price as it is typed. A price set for
 * these goods is refused at posting (`ownPriceUnderCost`); the item's usual
 * price going in under a dearer delivery is only said, and the counter
 * refuses the sale. `cost` is the line's cost before GST, as it will post.
 */
export function sellsBelowCost(line: Line, cost: string, charges: boolean): string | null {
  const sellAt = Money.parseMoney(line.sellAt)
  const paid = Money.parseMoney(cost)
  if (sellAt === null || sellAt <= 0 || paid === null || paid <= 0) return null
  const rateBp = bpOf(line.gst)
  const cessBp = bpOf(line.cess)
  const net = CostFloor.netPerBase({
    rate: sellAt, includesTax: true, taxRateBp: rateBp, cessRateBp: cessBp, baseUnits: Quantity.fromUnits(1), charges,
  })
  const floor = CostFloor.floorOf(paid, Tax.addTax(paid, rateBp, 'intra_state', cessBp).taxTotal, charges)
  return net < floor ? `below this cost (₹${Money.format(floor)})` : null
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
export function PriceCells({ line, onChange, belowCost = null }: {
  line: Line
  onChange: (change: Partial<Line>) => void
  /** Said under Sell at when it is below what these goods cost. */
  belowCost?: string | null
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
        {belowCost && <div className="src warn-note">{belowCost}</div>}
      </td>
    </>
  )
}
