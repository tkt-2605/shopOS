import { useRef, useState, type ReactNode } from 'react'
import { Batches, Money, Quantity, priceChoicesFor, type ProductListItem, type SqlDriver } from '@shopos/core'
import { Modal } from './components'
import { usePickList } from './PickList'

/**
 * Which price a scan meant, when the item is on the shelf at more than one
 * (070) -- last month's packs at MRP 12 beside this month's at MRP 14.
 *
 * The MRP leads each row because it is printed on the pack in the customer's
 * hand; the cashier reads it off the pack and picks the row that says the
 * same. Cheapest first, so the old stock is the top row and Enter sells it.
 * Arrows and Enter, like every other list, and Escape to put the scan aside.
 * A hook, the way `useScanChoice` asks which item.
 */
export function usePriceChoice(
  db: SqlDriver,
  onPick: (product: ProductListItem, choice: Batches.PriceChoice) => void,
  onCancel: () => void,
): {
  /** True when the item is on the shelf at more than one price, and the question is now on screen. */
  asks: (product: ProductListItem) => Promise<boolean>
  dialog: ReactNode
} {
  const [asking, setAsking] = useState<{ product: ProductListItem; choices: Batches.PriceChoice[] } | null>(null)
  const dialog = asking && (
    <PriceChoice
      product={asking.product}
      choices={asking.choices}
      onPick={(choice) => { setAsking(null); onPick(asking.product, choice) }}
      onClose={() => { setAsking(null); onCancel() }}
    />
  )
  const asks = async (product: ProductListItem): Promise<boolean> => {
    const choices = await priceChoicesFor(db, product.id)
    if (choices.length === 0) return false
    setAsking({ product, choices })
    return true
  }
  return { asks, dialog }
}

function PriceChoice({ product, choices, onPick, onClose }: {
  product: ProductListItem
  choices: Batches.PriceChoice[]
  onPick: (choice: Batches.PriceChoice) => void
  onClose: () => void
}) {
  const body = useRef<HTMLElement | null>(null)
  const pick = usePickList({ count: choices.length, onPick: (i) => { const c = choices[i]; if (c) onPick(c) } })
  return (
    <Modal title={`${product.name} is on the shelf at ${choices.length} prices`} onClose={onClose} initialFocus={body}>
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 10 }}>
        Pick the MRP printed on the pack in the customer’s hand.
      </div>
      <table>
        <thead>
          <tr>
            <th className="r" style={{ width: 100 }}>MRP</th>
            <th className="r" style={{ width: 100 }}>Rate</th>
            <th className="r" style={{ width: 110 }}>In stock</th>
            <th>Batch</th>
          </tr>
        </thead>
        <tbody {...pick.listProps} ref={(el) => { pick.listProps.ref(el); body.current = el }}>
          {choices.map((c, i) => (
            <tr key={c.pick} {...pick.rowProps(i)}>
              <td className="r num" style={{ fontWeight: 600 }}>{c.mrp !== null ? Money.formatWithSymbol(c.mrp) : '—'}</td>
              <td className="r num">{Money.formatWithSymbol(c.rate)}</td>
              <td className="r num">{Quantity.formatQty(c.balance)} {product.baseUnit}</td>
              <td className="cart-brand">
                {c.batchNos.length === 0 ? 'Earlier stock' : c.batchNos.join(', ')}
                {c.expiryDate && ` · exp ${Batches.formatExpiry(c.expiryDate)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}
