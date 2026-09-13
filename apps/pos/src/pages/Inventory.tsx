import { useCallback, useEffect, useState } from 'react'
import {
  Money, Quantity, Tax, Permissions,
  searchProducts, productValuation, recomputeStock, newId,
  type ProductListItem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Field, Empty, Alert, Rupees } from '../ui/components'

interface Draft {
  id: string | null
  name: string
  brand: string
  barcode: string
  hsnCode: string
  taxPercent: string
  baseRate: string
  baseUnit: string
  discountBlocked: boolean
  loyaltyBlocked: boolean
  reorderLevel: string
  reorderQty: string
}

const BLANK: Draft = {
  id: null, name: '', brand: '', barcode: '', hsnCode: '', taxPercent: '12',
  baseRate: '', baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false,
  reorderLevel: '', reorderQty: '',
}

/** Blank means "not set", which is not the same as a level of zero. */
function levelOf(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return Quantity.parseQty(trimmed)
}

export default function Inventory() {
  const { db } = useCore()
  const user = useUser()
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState<ProductListItem[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [valuation, setValuation] = useState<{ name: string; qty: number; value: number; avg: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const canWrite = Permissions.can(user.permissions, 'product', 'write')

  const refresh = useCallback(async () => {
    setRows(await searchProducts(db, { term, limit: 200, includeInactive: true }))
  }, [db, term])

  useEffect(() => {
    const id = setTimeout(() => void refresh(), term === '' ? 0 : 140)
    return () => clearTimeout(id)
  }, [refresh, term])

  async function save() {
    if (!draft || draft.name.trim() === '') return
    const now = new Date().toISOString()
    const rate = Money.parseMoney(draft.baseRate) ?? 0
    const bp = Math.round((Number(draft.taxPercent) || 0) * 100)

    if (draft.id) {
      await db.execute(
        `UPDATE products SET name = ?, brand = ?, barcode = ?, hsn_code = ?, tax_rate_bp = ?, base_rate = ?,
                             discount_blocked = ?, loyalty_blocked = ?,
                             reorder_level = ?, reorder_qty = ?, updated_at = ?
         WHERE id = ?`,
        [draft.name.trim(), draft.brand.trim() || null, draft.barcode.trim() || null,
         draft.hsnCode.trim() || null, bp, rate,
         draft.discountBlocked ? 1 : 0, draft.loyaltyBlocked ? 1 : 0,
         levelOf(draft.reorderLevel), levelOf(draft.reorderQty), now, draft.id],
      )
    } else {
      await db.execute(
        `INSERT INTO products (id, name, brand, barcode, hsn_code, tax_rate_bp, base_rate, base_unit,
                               discount_blocked, loyalty_blocked, reorder_level, reorder_qty,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), draft.name.trim(), draft.brand.trim() || null, draft.barcode.trim() || null,
         draft.hsnCode.trim() || null, bp, rate, draft.baseUnit,
         draft.discountBlocked ? 1 : 0, draft.loyaltyBlocked ? 1 : 0,
         levelOf(draft.reorderLevel), levelOf(draft.reorderQty), now, now],
      )
    }
    setDraft(null)
    await refresh()
  }

  async function showValuation(p: ProductListItem) {
    const v = await productValuation(db, p.id)
    setValuation({ name: p.name, qty: v.qtyOnHand, value: v.totalValue, avg: v.averageCost })
  }

  async function checkStock() {
    const drift = await recomputeStock(db)
    setNotice(
      drift.length === 0
        ? 'Stock matches the ledger exactly — no drift.'
        : `${drift.length} product(s) drifted from the ledger. Repaired.`,
    )
    if (drift.length > 0) await recomputeStock(db, { repair: true })
    await refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Search products"
          value={term} onChange={(e) => setTerm(e.target.value)} id="product-search" />
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{rows.length} items</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => void checkStock()}>Check stock integrity</button>
        {canWrite && <button className="btn primary" onClick={() => setDraft({ ...BLANK })}>New product</button>}
      </div>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th>Item</th><th>Barcode</th><th>HSN</th>
              <th className="r">GST</th><th className="r">Rate</th><th className="r">On hand</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <div>{p.name}</div>
                  {p.brand && <div className="src">{p.brand}</div>}
                </td>
                <td className="num">{p.barcode ?? '—'}</td>
                <td className="num">{p.hsnCode ?? '—'}</td>
                <td className="r num">{Tax.bpToPercent(p.taxRateBp)}%</td>
                <td className="r"><Rupees value={p.baseRate} /></td>
                <td className="r num" style={{ color: p.qtyOnHand <= 0 ? 'var(--danger)' : undefined }}>
                  {Quantity.formatQty(p.qtyOnHand)} {p.baseUnit}
                </td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn ghost sm" onClick={() => void showValuation(p)}>Cost</button>
                  {canWrite && (
                    <button className="btn ghost sm" onClick={() => setDraft({
                      id: p.id, name: p.name, brand: p.brand ?? '', barcode: p.barcode ?? '',
                      hsnCode: p.hsnCode ?? '', taxPercent: String(Tax.bpToPercent(p.taxRateBp)),
                      baseRate: Money.format(p.baseRate), baseUnit: p.baseUnit,
                      discountBlocked: p.discountBlocked, loyaltyBlocked: p.loyaltyBlocked,
                      reorderLevel: p.reorderLevel === null ? '' : Quantity.formatQty(p.reorderLevel),
                      reorderQty: p.reorderQty === null ? '' : Quantity.formatQty(p.reorderQty),
                    })}>Edit</button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7}><Empty>No products match</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      {draft && (
        <Modal
          title={draft.id ? 'Edit product' : 'New product'}
          onClose={() => setDraft(null)}
          footer={<>
            <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn primary" disabled={draft.name.trim() === ''} onClick={() => void save()}>Save</button>
          </>}
        >
          <Field label="Name">
            <input className="input" id="p-name" autoFocus value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Brand">
              <input className="input" id="p-brand" value={draft.brand}
                onChange={(e) => setDraft({ ...draft, brand: e.target.value })} />
            </Field>
            <Field label="Barcode">
              <input className="input num" id="p-barcode" value={draft.barcode}
                onChange={(e) => setDraft({ ...draft, barcode: e.target.value })} />
            </Field>
            <Field label="HSN code">
              <input className="input num" id="p-hsn" value={draft.hsnCode}
                onChange={(e) => setDraft({ ...draft, hsnCode: e.target.value })} />
            </Field>
            <Field label="GST %">
              <input className="input num" id="p-gst" value={draft.taxPercent}
                onChange={(e) => setDraft({ ...draft, taxPercent: e.target.value })} />
            </Field>
            <Field label="Selling rate" hint="Tax inclusive.">
              <input className="input num" id="p-rate" value={draft.baseRate}
                onChange={(e) => setDraft({ ...draft, baseRate: e.target.value })} />
            </Field>
            {!draft.id && (
              <Field label="Unit">
                <input className="input" id="p-unit" value={draft.baseUnit}
                  onChange={(e) => setDraft({ ...draft, baseUnit: e.target.value })} />
              </Field>
            )}
          </div>

          <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Buying</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
              An item with a reorder level appears on the buying list once stock falls to it.
              Leave both empty for things you buy when you happen to think of them.
            </div>
            <div className="grid-res">
              <Field label="Reorder at" hint="Stock level that puts it on the buying list.">
                <input className="input" id="reorder-level" inputMode="decimal" value={draft.reorderLevel}
                  onChange={(e) => setDraft({ ...draft, reorderLevel: e.target.value })} />
              </Field>
              <Field label="Order quantity" hint="How many to buy. Empty means the reorder level itself.">
                <input className="input" id="reorder-qty" inputMode="decimal" value={draft.reorderQty}
                  onChange={(e) => setDraft({ ...draft, reorderQty: e.target.value })} />
              </Field>
            </div>
          </div>

          <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Thin margin</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
              For recharge, cigarettes, milk, gas — things the shop stocks because it must,
              not because they pay. These hold against every discount and every offer,
              including one applied to a whole bill.
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 7 }}>
              <input type="checkbox" checked={draft.discountBlocked}
                onChange={(e) => setDraft({ ...draft, discountBlocked: e.target.checked })} />
              <span style={{ fontSize: 12.5 }}>Never discount this item</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={draft.loyaltyBlocked}
                onChange={(e) => setDraft({ ...draft, loyaltyBlocked: e.target.checked })} />
              <span style={{ fontSize: 12.5 }}>Earns no loyalty points</span>
            </label>
          </div>
        </Modal>
      )}

      {valuation && (
        <Modal
          title={`Cost — ${valuation.name}`}
          onClose={() => setValuation(null)}
          footer={<button className="btn" onClick={() => setValuation(null)}>Close</button>}
        >
          <div className="total-line"><span>On hand</span><span className="num">{Quantity.formatQty(valuation.qty as never)}</span></div>
          <div className="total-line"><span>Average cost</span><Rupees value={valuation.avg} /></div>
          <div className="total-line grand"><span>Stock value</span><Rupees value={valuation.value} className="amount" /></div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            Moving average, replayed from every stock movement and what it cost at the time.
          </div>
        </Modal>
      )}
    </div>
  )
}
