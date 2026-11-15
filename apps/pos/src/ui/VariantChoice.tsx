import { useRef, useState, type KeyboardEvent } from 'react'
import { Money, Quantity, type ProductListItem } from '@shopos/core'
import { Modal } from './components'

/**
 * Which variant, when one code is on every variant of an item (`variants.ts`).
 *
 * The rows are the variants in a fixed order, so a number always means the
 * same variant of the same pen and a cashier's fingers learn it. The highlight
 * opens on the variant picked last for this item: a run of blue pens is scan,
 * Enter, scan, Enter. A mixed handful is a quantity typed against each variant
 * and one Enter -- only where the caller can take a quantity (`quantities`).
 */

/** The variant last picked, by family, for this session at this till. */
const lastPicked = new Map<string, string>()

export interface VariantPick { product: ProductListItem; qty: number }

export function VariantChoice({ familyId, name, items, quantities, onDone, onClose }: {
  familyId: string
  name: string
  items: ProductListItem[]
  quantities: boolean
  onDone: (picks: VariantPick[]) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((p) => p.id === lastPicked.get(familyId))))
  const [typed, setTyped] = useState<Record<string, string>>({})
  const price = items[0]?.baseRate
  const samePrice = items.every((p) => p.baseRate === price)

  const finish = (picks: VariantPick[]) => {
    const kept = picks.filter((p) => p.qty > 0)
    if (kept.length === 0) return
    lastPicked.set(familyId, kept[kept.length - 1]!.product.id)
    onDone(kept)
  }
  const fromTyped = (): VariantPick[] => items
    .map((product) => ({ product, qty: Math.min(999, Math.floor(Number(typed[product.id] ?? '') || 0)) }))
    .filter((p) => p.qty > 0)
  const enter = () => {
    const many = fromTyped()
    const one = items[index]
    if (many.length > 0) finish(many)
    else if (one) finish([{ product: one, qty: 1 }])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const inBox = e.target instanceof HTMLInputElement
    if (e.key === 'Enter') { e.preventDefault(); enter(); return }
    if (inBox) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(items.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)) }
    else if (/^[1-9]$/.test(e.key)) {
      const hit = items[Number(e.key) - 1]
      if (hit) { e.preventDefault(); finish([{ product: hit, qty: 1 }]) }
    }
  }

  return (
    <Modal title={`${name} — which one?`} onClose={onClose} initialFocus={box}>
      <div ref={box} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Variants of ${name}`} style={{ outline: 'none' }}>
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 10 }}>
          {quantities
            ? 'Pick the one in the customer’s hand: its number, or Enter for the highlighted one. For a mix, type how many of each and press Enter.'
            : 'Pick one: its number, or Enter for the highlighted one.'}
        </div>
        <table>
          <tbody role="listbox" aria-activedescendant={items[index] ? `variant-${items[index]!.id}` : undefined}>
            {items.map((p, i) => (
              <tr key={p.id} id={`variant-${p.id}`} role="option" aria-selected={i === index} className="pickable"
                onMouseMove={() => setIndex(i)} onClick={() => finish([{ product: p, qty: 1 }])}>
                <td className="num" style={{ width: 28, color: 'var(--ink-3)' }}>{i < 9 ? i + 1 : ''}</td>
                <td style={{ fontWeight: 600 }}>{p.variantLabel ?? p.name}</td>
                {!samePrice && <td className="r num" style={{ width: 90 }}>{Money.formatWithSymbol(p.baseRate)}</td>}
                <td className="r num" style={{ width: 120, color: p.qtyOnHand > 0 ? undefined : 'var(--ink-3)' }}>
                  {Quantity.formatQty(p.qtyOnHand)} {p.baseUnit}
                </td>
                {quantities && (
                  <td style={{ width: 70 }} onClick={(e) => e.stopPropagation()}>
                    <input className="input num" inputMode="numeric" aria-label={`How many ${p.variantLabel ?? p.name}`}
                      value={typed[p.id] ?? ''} placeholder="0" style={{ width: 56 }}
                      onChange={(e) => setTyped({ ...typed, [p.id]: e.target.value.replace(/\D/g, '') })} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {samePrice && price !== undefined && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-3)' }}>{Money.formatWithSymbol(price)} each</div>
        )}
      </div>
    </Modal>
  )
}
