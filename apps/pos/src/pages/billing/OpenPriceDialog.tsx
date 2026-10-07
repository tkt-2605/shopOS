import { useState } from 'react'
import { Money, type ProductListItem } from '@shopos/core'
import { Modal } from '../../ui/components'

/**
 * The amount for an item priced at the counter -- the loose item.
 *
 * Asked before the line exists rather than after: a line added at nothing and
 * filled in later is a line somebody can forget, and the bill refuses it at
 * nothing anyway (`OPEN_PRICE_NEEDS_AMOUNT`). Asking first means the cart never
 * holds one it would refuse.
 */
export function OpenPriceDialog({ product, onAdd, onClose }: {
  product: ProductListItem
  onAdd: (amount: Money.Money) => void
  onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  const amount = Money.parseMoney(typed.trim())
  const usable = amount !== null && amount > 0

  const add = () => { if (usable) onAdd(amount) }

  return (
    <Modal
      title={product.name}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!usable} onClick={add}>Add</button>
      </>}
    >
      <label className="label" htmlFor="open-price-amount">Amount</label>
      <input
        id="open-price-amount"
        className="input num"
        inputMode="decimal"
        autoComplete="off"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
      />
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 8 }}>
        What the customer pays for it, tax included.
      </div>
    </Modal>
  )
}
