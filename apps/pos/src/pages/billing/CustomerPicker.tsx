import type { CustomerListItem } from '@shopos/core'
import { Modal, Rupees } from '../../ui/components'
import { usePickList } from '../../ui/PickList'

/**
 * Who the bill is for.
 *
 * Walk-in is row zero, so the commonest answer is the one already highlighted
 * when the dialog opens.
 */
export function CustomerPicker({ customers, term, onTerm, onChoose, onClose }: {
  customers: CustomerListItem[]
  term: string
  onTerm: (term: string) => void
  onChoose: (customer: CustomerListItem | null) => void
  onClose: () => void
}) {
  const customerPick = usePickList({
    count: customers.length + 1,
    resetKey: term,
    onPick: (i) => onChoose(i === 0 ? null : customers[i - 1] ?? null),
  })

  return (
    <Modal title="Choose a customer" onClose={onClose}>
      <input
        className="input" placeholder="Name, phone or customer code"
        value={term}
        onChange={(e) => onTerm(e.target.value)}
        onKeyDown={customerPick.searchKeyDown}
      />
      <table>
        <tbody {...customerPick.listProps}>
          <tr {...customerPick.rowProps(0)}>
            <td><span className="cart-name">Walk-in</span></td><td className="r">—</td>
          </tr>
          {customers.map((c, i) => (
            <tr key={c.id} {...customerPick.rowProps(i + 1)}>
              <td>
                <span className="cart-name">{c.name}</span>
                {c.code && <span className="cart-brand"> · {c.code}</span>}
                {c.phone && <span className="cart-brand"> · {c.phone}</span>}
              </td>
              <td className="r">
                {c.loyaltyPoints > 0 && (
                  <span className="badge ok" style={{ marginRight: 7 }}>{c.loyaltyPoints} pts</span>
                )}
                {c.outstanding > 0 ? <Rupees value={c.outstanding} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}
