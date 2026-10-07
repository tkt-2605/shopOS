import { useRef, useState, type ReactNode } from 'react'
import { Money, Quantity, scanChoices, type ProductListItem } from '@shopos/core'
import { Modal } from './components'
import { usePickList } from './PickList'

/**
 * Which item a scan meant, when its code is on more than one (069).
 *
 * A manufacturer puts one EAN on two pack sizes, and the shop keeps them as two
 * items. Taking the first of them would be choosing for the cashier -- the
 * order a search returns is not a decision anybody made -- so every screen that
 * turns a scan into an item asks here instead. The price leads each row, since
 * it is the thing printed on the pack in the customer's hand.
 *
 * Arrows and Enter, like every other list, and Escape to put the scan aside.
 */
export function useScanChoice(onPick: (product: ProductListItem) => void): {
  /** True when `rows` hold one code on several items, and the question is now on screen. */
  ask: (rows: ProductListItem[], code: string) => boolean
  dialog: ReactNode
} {
  const [asking, setAsking] = useState<{ code: string; items: ProductListItem[] } | null>(null)
  const ask = (rows: ProductListItem[], code: string): boolean => {
    const items = scanChoices(rows)
    if (items === null) return false
    setAsking({ code, items })
    return true
  }
  const dialog = asking && (
    <ScanChoice
      code={asking.code}
      items={asking.items}
      onPick={(p) => { setAsking(null); onPick(p) }}
      onClose={() => setAsking(null)}
    />
  )
  return { ask, dialog }
}

function ScanChoice({ code, items, onPick, onClose }: {
  code: string
  items: ProductListItem[]
  onPick: (product: ProductListItem) => void
  onClose: () => void
}) {
  const body = useRef<HTMLElement | null>(null)
  const pick = usePickList({ count: items.length, onPick: (i) => { const p = items[i]; if (p) onPick(p) } })
  return (
    <Modal title={`${code} is on ${items.length} items`} onClose={onClose} initialFocus={body}>
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 10 }}>
        Pick the one in the customer’s hand — the price on the pack tells them apart.
      </div>
      <table>
        <tbody {...pick.listProps} ref={(el) => { pick.listProps.ref(el); body.current = el }}>
          {items.map((p, i) => (
            <tr key={p.id} {...pick.rowProps(i)}>
              <td className="r num" style={{ width: 96, fontWeight: 600 }}>{Money.formatWithSymbol(p.baseRate)}</td>
              <td>
                <span className="cart-name">{p.name}</span>
                {p.brand && <span className="cart-brand"> · {p.brand}</span>}
                {p.mrp !== null && p.mrp !== p.baseRate && (
                  <span className="cart-brand"> · MRP {Money.formatWithSymbol(p.mrp)}</span>
                )}
              </td>
              <td className="r num" style={{ width: 110 }}>{Quantity.formatQty(p.qtyOnHand)} {p.baseUnit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}
