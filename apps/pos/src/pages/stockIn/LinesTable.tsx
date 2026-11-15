import type { Dispatch, SetStateAction } from 'react'
import { Money, Quantity, directionOf, signedQty, chargesTax, type StockEntryType, type TaxScheme } from '@shopos/core'
import { Empty, Rupees } from '../../ui/components'
import { GstSwitch } from '../../ui/GstSwitch'
import { costNote } from '../../ui/costNote'
import type { Side } from '../../ui/gstPair'
import { BatchCells, PriceCells, sellsBelowCost, type Line } from './cells'

/**
 * The lines of a stock entry being typed: one row per item, with its quantity,
 * batch, price, cost and tax, and what the shelf will say once it is saved.
 * Moved out of `StockIn.tsx` as it was; the arithmetic is the page's, passed in.
 */
export function LinesTable({
  lines, setLines, entryType, batched, incoming, purchase, showCess, gstMode, setGstMode, costMode,
  order, unpriced, taxScheme, outgoing, costText, shownCost, typeCost, taxOf,
}: {
  lines: Line[]
  setLines: Dispatch<SetStateAction<Line[]>>
  entryType: StockEntryType
  batched: boolean
  incoming: boolean
  purchase: boolean
  showCess: boolean
  gstMode: Side
  setGstMode: (mode: Side) => void
  costMode: Side
  order: { id: string; docNo: string } | null
  unpriced: Set<string>
  taxScheme: TaxScheme
  outgoing: (l: Line) => boolean
  costText: (l: Line) => string
  shownCost: (l: Line) => string
  typeCost: (l: Line, side: Side, text: string) => void
  taxOf: (l: Line) => number
}) {
  return (
    <div className="card card-scroll">
      <table className="entry-lines">
        <thead>
          <tr>
            <th>Item</th>
            <th className="r">{directionOf(entryType) === 'out' ? 'Quantity lost' : 'Quantity'}</th>
            {batched && <><th>Batch</th><th>Expiry</th></>}
            {incoming && <><th className="r">MRP</th><th className="r">Sell at</th></>}
            <th className="r">
              Unit cost
              {purchase && <div><GstSwitch mode={gstMode} onChange={setGstMode} /></div>}
            </th>
            {purchase && <th className="r">GST %</th>}
            {showCess && <th className="r">Cess %</th>}
            {/* The line's amount the way the switch reads, so the column
                never says the same thing twice; the GST itself is in the
                totals below, once for the bill. */}
            <th className="r">{!purchase ? 'Value' : costMode === 'with' ? 'Amount incl. GST' : 'Amount excl. GST'}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const typed = Number(l.qty) || 0
            const value = Math.round(Math.abs(typed) * (Money.parseMoney(costText(l)) ?? 0))
            /* The answer rather than the convention. Whatever the sign rule
               is, a shopkeeper can see what the shelf will say afterwards
               before pressing save. */
            const after = Quantity.addQty(
              l.product.qtyOnHand, signedQty(entryType, Quantity.fromUnits(typed)),
            )
            return (
              <tr key={l.key}>
                <td>
                  {l.product.name}
                  {/* What the shelf says now and after, in one line rather than a column of its own. */}
                  <div className="src">
                    on hand {Quantity.formatQty(l.product.qtyOnHand)} → {Quantity.formatQty(after)} {l.product.baseUnit}
                  </div>
                  {order && (
                    <div className="src">
                      {l.orderLine ? `on the order: ${Quantity.formatQty(l.orderLine.left)} open` : 'not on the order'}
                    </div>
                  )}
                </td>
                <td className="r">
                  <input className="qty-input num" value={l.qty}
                    onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, qty: e.target.value } : x))} />
                </td>
                {batched && <BatchCells line={l} outgoing={outgoing(l)}
                  onChange={(change) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, ...change } : x))} />}
                {incoming && <PriceCells line={l} belowCost={sellsBelowCost(l, costText(l), chargesTax(taxScheme))}
                  onChange={(change) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, ...change } : x))} />}
                <td className="r">
                  {/* One box, read the way the switch in the header says. Flip
                      it and the same cost is shown the other way; only on a
                      purchase, since nothing else carries GST. */}
                  <input className="qty-input num" placeholder="0.00" aria-label="Unit cost"
                    value={shownCost(l)} onChange={(e) => typeCost(l, costMode, e.target.value)} />
                  {/* Where the figure in the box came from, so a cost that was
                      filled in is never mistaken for one that was typed. */}
                  {l.hint && !outgoing(l) && (
                    <div className="src">{l.costFilled ? '' : 'was '}{costNote(l.hint)}</div>
                  )}
                  {/* Said, not enforced. A shopkeeper holding a delivery note
                      they cannot read must still be able to record the stock;
                      a save that refuses here is a shelf that goes uncounted.

                      But a blank cost is not nothing. It falls back to the
                      last rate known for the item, which is usually close
                      enough — and where there has never been one the item
                      enters at zero, and every sale of it reads as pure
                      profit for ever with nothing saying so. Those are two
                      different sentences and only one of them is alarming. */}
                  {directionOf(entryType) === 'in' && Money.parseMoney(costText(l)) === null && (
                    <div className="src warn-note">
                      {unpriced.has(l.product.id)
                        ? 'no cost ever recorded — profit on this item will read as 100%'
                        : 'no cost — the last rate paid will be assumed'}
                    </div>
                  )}
                </td>
                {purchase && (
                  <td className="r">
                    <input className="qty-input num" style={{ width: 56 }} value={l.gst}
                      onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, gst: e.target.value } : x))} />
                  </td>
                )}
                {showCess && (
                  <td className="r">
                    <input className="qty-input num" style={{ width: 56 }} value={l.cess}
                      onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, cess: e.target.value } : x))} />
                  </td>
                )}
                <td className="r"><Rupees value={purchase && costMode === 'with' ? value + taxOf(l) : value} /></td>
                <td className="r">
                  <button className="btn ghost sm" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>✕</button>
                </td>
              </tr>
            )
          })}
          {lines.length === 0 && (
            <tr><td colSpan={(batched ? 7 : 5) + (incoming ? 2 : 0) + (purchase ? 1 : 0) + (showCess ? 1 : 0)}><Empty>Nothing added yet</Empty></td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
