import { useState, type ReactNode } from 'react'
import { Money, Quantity, addDays, businessDate, createDocument, submitDocument, type CustomerListItem } from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { printDocumentSheet } from '../../core/printHtml'
import type { Cart, CartLine } from '../../core/useBillTabs'
import { Modal, Alert, Field, Rupees } from '../../ui/components'

/**
 * The quotation question as a hook: `open` to ask it about the bill on
 * screen, `dialog` to render. `clear` discards the bill once it is quoted.
 */
export function useQuote(
  cart: Cart, total: number, onPickCustomer: () => void, clear: () => Promise<void>,
): { open: () => void; dialog: ReactNode } {
  const [open, setOpen] = useState(false)
  const dialog = open && (
    <QuoteDialog
      lines={cart.lines}
      customer={cart.customer}
      total={total}
      onPickCustomer={onPickCustomer}
      onClear={() => { setOpen(false); void clear() }}
      onClose={() => setOpen(false)}
    />
  )
  return { open: () => setOpen(true), dialog }
}

/** How long a quotation made at the counter holds its prices, unless the cashier says otherwise. */
const VALID_DAYS = 15

/**
 * The bill on screen, saved as a quotation instead of paid for.
 *
 * A customer at the counter asks "what would all this come to?" -- for a
 * school's order, or to show someone at home. The cashier has already rung
 * it up; making them type it again on the Quotations page is the reason
 * nobody would. The rates go across as they are on screen, so the quotation
 * says what the customer was just told, and it is issued straight away and
 * printed on A4, which is what a quotation is handed over on.
 *
 * The bill is left alone until the cashier says: the customer may well buy
 * some of it now.
 */
export function QuoteDialog({ lines, customer, total, onPickCustomer, onClear, onClose }: {
  lines: CartLine[]
  customer: CustomerListItem | null
  total: number
  onPickCustomer: () => void
  onClear: () => void
  onClose: () => void
}) {
  const { db, registerId } = useCore()
  const user = useUser()
  const [validUntil, setValidUntil] = useState(() => addDays(businessDate(), VALID_DAYS))
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ docNo: string; printed: string | null } | null>(null)

  async function save() {
    if (!customer) return
    setBusy(true)
    setError(null)
    try {
      const made = await createDocument(db, {
        kind: 'quotation',
        registerId,
        customerId: customer.id,
        lines: lines.map((l) => ({
          productId: l.product.id,
          saleUnit: l.saleUnit,
          qty: Quantity.fromUnits(l.qty),
          rateOverride: l.rate as Money.Money,
          rateIncludesTax: l.includesTax !== false,
        })),
        validUntil: validUntil || null,
        notes: notes.trim() || null,
        actorId: user.id,
      })
      if (!made.ok) {
        setError(made.code === 'NO_LINES' ? 'There is nothing on the bill to quote.' : 'The quotation could not be saved.')
        return
      }
      const issued = await submitDocument(db, { documentId: made.documentId, actorId: user.id })
      if (!issued.ok) {
        setError(`Saved as ${made.docNo} but not issued — open it on the Quotations page to issue it.`)
        return
      }
      const printed = await printDocumentSheet(db, made.documentId)
      setSaved({ docNo: made.docNo, printed: printed.ok ? null : printed.message })
    } catch (err) {
      setError(`The quotation could not be saved: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <Modal
        title={`Quotation ${saved.docNo}`}
        onClose={onClose}
        footer={<>
          <button className="btn" onClick={onClose}>Keep the bill</button>
          <button className="btn primary" onClick={onClear}>Clear the bill</button>
        </>}
      >
        <Alert kind="ok">Issued and sent to the printer. It is on the Quotations page, where it can be billed when the customer comes back.</Alert>
        {saved.printed && <Alert kind="warn">{saved.printed} Print it again from the Quotations page.</Alert>}
      </Modal>
    )
  }

  return (
    <Modal
      title="Save as quotation"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !customer || lines.length === 0} onClick={() => void save()}>
          Save and print
        </button>
      </>}
    >
      <div style={{ fontSize: 13 }}>
        {lines.length} {lines.length === 1 ? 'line' : 'lines'}, <Rupees value={total} />, at the rates on the bill.
      </div>
      <Field label="Customer">
        <button className="btn" style={{ width: '100%', justifyContent: 'space-between' }} onClick={onPickCustomer}>
          <span>{customer?.name ?? 'Choose a customer — a quotation is made out to someone'}</span>
          <span style={{ color: 'var(--ink-3)' }}>{customer ? 'Change' : 'Choose'}</span>
        </button>
      </Field>
      <Field label="Prices hold until">
        <input className="input" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      </Field>
      <Field label="Note on the quotation">
        <input className="input" value={notes} placeholder="Delivery in a week" onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {error && <Alert>{error}</Alert>}
    </Modal>
  )
}
