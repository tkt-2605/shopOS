import { Money, Quantity, Pricing, type Totals } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import type { CartLine } from '../../core/useBillTabs'
import { Empty, Rupees } from '../../ui/components'
import { aboveMrp, mrpOf, type ShortLine } from './cart'
import { LineBatch } from './LineBatch'

/**
 * The lines of the bill on screen: unit, quantity and rate editable in place,
 * and a line the shelf cannot cover said on the line itself.
 */
export function CartTable({ lines, totals, short, canOverridePrice, onEdit, onRate, onRemove }: {
  lines: CartLine[]
  totals: Totals.ComputedTotals
  short: Map<string, ShortLine>
  canOverridePrice: boolean
  onEdit: (key: string, change: (line: CartLine) => CartLine) => void
  onRate: (key: string, value: string) => void
  onRemove: (key: string) => void
}) {
  const { stockPolicy, features } = useCore()
  return (
      <div className="cart">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 100 }}>Unit</th>
              <th className="r" style={{ width: 96 }}>Qty</th>
              <th className="r" style={{ width: 96 }}>MRP</th>
              <th className="r" style={{ width: 110 }}>Rate</th>
              <th className="r" style={{ width: 110 }}>Amount</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.key}>
                <td>
                  <div>
                    {line.product.name}
                    {line.product.discountBlocked && (
                      <span className="badge" style={{ marginLeft: 7 }} title="Sold on too thin a margin to discount">
                        no discount
                      </span>
                    )}
                  </div>
                  <div className="src">{Pricing.describeSource(line.source)}</div>
                  {features.batchExpiry && line.qty > 0 && (
                    <LineBatch
                      productId={line.product.id}
                      baseQty={baseQtyOf(line)}
                      pick={line.batchPick ?? null}
                      onPick={(batchPick) => onEdit(line.key, (l) => ({ ...l, batchPick, batchMrp: null }))}
                    />
                  )}
                  {/* Said where the mistake is being made, not at the end. A
                      cashier who learns at the payment screen has a queue
                      waiting while they work out which line to change. */}
                  {stockPolicy !== 'allow' && short.has(line.product.id) && (
                    <div className="src warn-note">
                      Only {Quantity.formatQty(line.product.qtyOnHand)} {line.product.baseUnit} in stock
                    </div>
                  )}
                </td>
                <td>
                  <select
                    className="select unit-select"
                    value={line.saleUnit}
                    onChange={(e) => onEdit(line.key, (l) => ({ ...l, saleUnit: e.target.value }))}
                  >
                    {line.units.map((u) => <option key={u.saleUnit} value={u.saleUnit}>{u.saleUnit}</option>)}
                  </select>
                </td>
                <td className="r">
                  {/* `step="any"` rather than a step against a fractional
                      `min`: a number input counts from its minimum, so min
                      0.0001 step 1 made the arrows produce 1.0001, 2.0001,
                      3.0001. Fractional quantities are still typed freely — a
                      shop sells 0.3 kg — the arrows just stop inventing them. */}
                  <input
                    className="qty-input num"
                    type="number" min="0" step="any"
                    value={line.qty}
                    onChange={(e) => onEdit(line.key, (l) => ({ ...l, qty: Math.max(0, Number(e.target.value) || 0) }))}
                  />
                </td>
                {/* The printed price on the packet, for the unit being sold. A rate above it is said in red: the law caps a sale at MRP. */}
                <td className="r num" style={{ color: aboveMrp(line) ? 'var(--danger)' : undefined }}
                  title={aboveMrp(line) ? 'The rate is above the MRP' : undefined}>
                  {mrpOf(line) === null ? '' : Money.format(mrpOf(line) as Money.Money)}
                </td>
                <td className="r">
                  {canOverridePrice || line.product.openPrice ? (
                    <input
                      key={`${line.key}-${line.rate}`}
                      className="qty-input num"
                      defaultValue={Money.format(line.rate as never)}
                      onBlur={(e) => onRate(line.key, e.target.value)}
                    />
                  ) : (
                    <span className="num" title="Changing a price needs permission">
                      {Money.format(line.rate as never)}
                    </span>
                  )}
                  {/* A wholesale rate is before tax, so the amount beside it is
                      more than rate times quantity. Said, so nobody thinks the
                      till added wrong. */}
                  {line.includesTax === false && (
                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>+ tax</div>
                  )}
                </td>
                <td className="r"><Rupees value={totals.lines[i]?.net ?? 0} /></td>
                <td>
                  <button
                    className="btn ghost sm"
                    aria-label="Remove"
                    onClick={() => onRemove(line.key)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr><td colSpan={7}><Empty>Scan an item to start a bill</Empty></td></tr>
            )}
          </tbody>
        </table>
      </div>
  )
}

/** The line in base units, as the batches hold it. */
function baseQtyOf(line: CartLine): Quantity.Qty {
  const factor = line.units.find((u) => u.saleUnit === line.saleUnit)?.baseUnits ?? Quantity.fromUnits(1)
  return Quantity.toBaseUnits(Quantity.fromUnits(line.qty), factor)
}
