import { useRef, useState, type ReactNode } from 'react'
import { Money, Quantity, scanChoices, familyVersions, type ProductListItem } from '@shopos/core'
import { Modal } from './components'
import { usePickList } from './PickList'
import { VariantChoice } from './VariantChoice'
import { useDb } from '../core/CoreProvider'

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
 *
 * When every item the code is on is a variant of one item -- the XO pen's code
 * is on all its variants (`variants.ts`) -- the question is which variant, and
 * `VariantChoice` asks it. Picking the family's own name from a search asks the
 * same (`askFamily`), since the family itself is never sold.
 *
 * `onPick` is told how many: a caller that passes `quantities` lets the person
 * type a count against each variant, and is called once per variant.
 */
/**
 * Whether the list under a search box is about to ask what `useScanChoice` asks.
 *
 * Typed or scanned, a code that is on several items brought up the list with
 * those items in it and then, on Enter, the "which one?" box with the same
 * items again -- one question, asked twice. The box is the one kept: it leads
 * with the price, takes a number key, and is what a scanner gets whether or not
 * the list had time to appear. So the list steps aside for it.
 */
export function codeOnSeveral(search: { rows: ProductListItem[]; current: boolean }): boolean {
  return search.current && scanChoices(search.rows) !== null
}

export function useScanChoice(
  onPick: (product: ProductListItem, qty: number) => unknown,
  { quantities = false }: { quantities?: boolean } = {},
): {
  /** True when `rows` hold one code on several items, and the question is now on screen. */
  ask: (rows: ProductListItem[], code: string) => boolean
  /** True when `product` is a family's name, and the variant box is now on screen. */
  askFamily: (product: ProductListItem) => boolean
  dialog: ReactNode
} {
  const db = useDb()
  const [asking, setAsking] = useState<{ code: string; items: ProductListItem[] } | null>(null)
  const [family, setFamily] = useState<{ id: string; name: string; items: ProductListItem[] } | null>(null)
  const ask = (rows: ProductListItem[], code: string): boolean => {
    const items = scanChoices(rows)
    if (items === null) return false
    const parents = new Set(items.map((p) => p.parentProductId))
    const [parent] = parents
    if (parents.size === 1 && parent) {
      const byLabel = [...items].sort((a, b) => (a.variantLabel ?? a.name).localeCompare(b.variantLabel ?? b.name, undefined, { sensitivity: 'base' }))
      setFamily({ id: parent, name: items[0]!.parentName ?? items[0]!.name, items: byLabel })
      return true
    }
    setAsking({ code, items })
    return true
  }
  const askFamily = (product: ProductListItem): boolean => {
    if (product.versions <= 0) return false
    void familyVersions(db, product.id).then((items) => {
      if (items.length > 0) setFamily({ id: product.id, name: product.name, items })
    }).catch(() => undefined)
    return true
  }
  const dialog = family ? (
    <VariantChoice
      familyId={family.id}
      name={family.name}
      items={family.items}
      quantities={quantities}
      onDone={(picks) => {
        setFamily(null)
        void (async () => { for (const p of picks) await onPick(p.product, p.qty) })()
      }}
      onClose={() => setFamily(null)}
    />
  ) : asking && (
    <ScanChoice
      code={asking.code}
      items={asking.items}
      onPick={(p) => { setAsking(null); void onPick(p, 1) }}
      onClose={() => setAsking(null)}
    />
  )
  return { ask, askFamily, dialog }
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
