import { useCallback, useEffect, useState } from 'react'
import {
  Money, Quantity, Tax, Permissions,
  searchProducts, productValuation, recomputeStock, newId,
  listBarcodes, setBarcodes, listUnits, setUnits,
  listCategories, createCategory, setProductCategory, setVariantOf,
  setLadder, laddersFor, defaultPriceListId, Ladder,
  type Category,
  type ProductListItem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Field, Empty, Alert, Rupees } from '../ui/components'
import { LadderEditor, describeRowsProblem, type LadderRow } from '../ui/LadderEditor'
import { usePickList } from '../ui/PickList'

interface BarcodeDraft {
  barcode: string
  label: string
}

interface UnitDraft {
  saleUnit: string
  /** How many base units one of these is: a ream is 500 sheets. */
  baseUnits: string
}

interface Draft {
  id: string | null
  name: string
  brand: string
  /** First is the primary — the one printed on a shelf tag and shown in lists. */
  barcodes: BarcodeDraft[]
  /** Bigger units this item also sells in. The base unit is not one of them. */
  units: UnitDraft[]
  categoryId: string
  /** The item this one is a version of, and what makes it different. */
  parentProductId: string
  variantLabel: string
  /** One rung per row: buy this many or more, pay this each. */
  ladder: LadderRow[]
  hsnCode: string
  taxPercent: string
  baseRate: string
  /** The printed price on the packet. Blank when there is none. */
  mrp: string
  baseUnit: string
  discountBlocked: boolean
  loyaltyBlocked: boolean
  reorderLevel: string
  reorderQty: string
}

const BLANK: Draft = {
  id: null, name: '', brand: '', barcodes: [{ barcode: '', label: '' }], units: [],
  categoryId: '', parentProductId: '', variantLabel: '', ladder: [], hsnCode: '', taxPercent: '12',
  baseRate: '', mrp: '', baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false,
  reorderLevel: '', reorderQty: '',
}

/** Blank means "not set", which is not the same as a level of zero. */
function levelOf(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return Quantity.parseQty(trimmed)
}

export default function Inventory() {
  const { db, features } = useCore()
  const user = useUser()
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState<ProductListItem[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [valuation, setValuation] = useState<{ name: string; qty: number; value: number; avg: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [newCategory, setNewCategory] = useState('')
  const [parentSearch, setParentSearch] = useState('')
  const [parentResults, setParentResults] = useState<ProductListItem[]>([])
  /* An item cannot be its own main item, so the row is dropped before the list
     is numbered — otherwise ↓ would land on a gap. */
  const parentOptions = parentResults.filter((r) => r.id !== draft?.id)
  const parentPick = usePickList({
    count: parentOptions.length,
    resetKey: parentSearch,
    onPick: (i) => {
      const hit = parentOptions[i]
      if (!hit || !draft) return
      setDraft({ ...draft, parentProductId: hit.id })
      setParentSearch('')
    },
  })
  const [browsing, setBrowsing] = useState('')
  const [ladders, setLadders] = useState<Map<string, Ladder.Rung[]>>(new Map())
  const [priceListId, setPriceListId] = useState('')

  const canWrite = Permissions.can(user.permissions, 'product', 'write')

  /* With several barcodes switched off, only the first box is shown — and the
     rest stay in the draft and are written back untouched. A screen that stops
     showing a code must not be a screen that deletes it: that code is printed on
     a packet somewhere, and the scanner still reads it. */
  const allBarcodes = draft?.barcodes ?? []
  const visibleBarcodes = features.multiBarcode ? allBarcodes : allBarcodes.slice(0, 1)
  const hiddenBarcodes = allBarcodes.length - visibleBarcodes.length

  const refresh = useCallback(async () => {
    setRows(await searchProducts(db, {
      term, limit: 200, includeInactive: true, ...(browsing ? { categoryId: browsing } : {}),
    }))
  }, [db, term, browsing])

  useEffect(() => {
    const id = setTimeout(() => void refresh(), term === '' ? 0 : 140)
    return () => clearTimeout(id)
  }, [refresh, term, browsing])

  const refreshCategories = useCallback(async () => setCategories(await listCategories(db)), [db])
  useEffect(() => { void refreshCategories() }, [refreshCategories])

  // The ladder column reads the shop's own price list. Other lists are the
  // Prices screen's business; this one is the answer to "what does it cost".
  const refreshLadders = useCallback(async () => {
    const listId = await defaultPriceListId(db)
    if (!listId) return
    setPriceListId(listId)
    setLadders(await laddersFor(db, listId))
  }, [db])
  useEffect(() => { void refreshLadders() }, [refreshLadders])

  useEffect(() => {
    const id = setTimeout(async () => {
      setParentResults(parentSearch.trim() === '' ? [] : await searchProducts(db, { term: parentSearch, limit: 8 }))
    }, 140)
    return () => clearTimeout(id)
  }, [db, parentSearch])

  async function save() {
    if (!draft || draft.name.trim() === '') return
    const now = new Date().toISOString()
    const rate = Money.parseMoney(draft.baseRate) ?? 0
    /* Null, not zero. A packet with no printed price is not a packet printed
       with ₹0, and the receipt only shows the MRP line when there is one. */
    const mrp = draft.mrp.trim() === '' ? null : Money.parseMoney(draft.mrp)
    const bp = Math.round((Number(draft.taxPercent) || 0) * 100)

    // The barcode column is not written here. setBarcodes owns the pair of
    // products.barcode and the product_barcodes rows, and two writers would be
    // how they come apart.
    let productId = draft.id
    if (productId) {
      await db.execute(
        `UPDATE products SET name = ?, brand = ?, hsn_code = ?, tax_rate_bp = ?, base_rate = ?, mrp = ?,
                             discount_blocked = ?, loyalty_blocked = ?,
                             reorder_level = ?, reorder_qty = ?, updated_at = ?
         WHERE id = ?`,
        [draft.name.trim(), draft.brand.trim() || null,
         draft.hsnCode.trim() || null, bp, rate, mrp,
         draft.discountBlocked ? 1 : 0, draft.loyaltyBlocked ? 1 : 0,
         levelOf(draft.reorderLevel), levelOf(draft.reorderQty), now, productId],
      )
    } else {
      productId = newId()
      await db.execute(
        `INSERT INTO products (id, name, brand, hsn_code, tax_rate_bp, base_rate, mrp, base_unit,
                               discount_blocked, loyalty_blocked, reorder_level, reorder_qty,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [productId, draft.name.trim(), draft.brand.trim() || null,
         draft.hsnCode.trim() || null, bp, rate, mrp, draft.baseUnit,
         draft.discountBlocked ? 1 : 0, draft.loyaltyBlocked ? 1 : 0,
         levelOf(draft.reorderLevel), levelOf(draft.reorderQty), now, now],
      )
    }

    const codes = await setBarcodes(db, { actorId: user.id }, productId, draft.barcodes)
    if (!codes.ok) {
      setNotice(`${codes.barcode} is already ${codes.productName}'s barcode. The rest was saved.`)
      setDraft(null)
      await refresh()
      return
    }

    const units = await setUnits(db, { actorId: user.id }, productId, draft.units
      .filter((u) => u.saleUnit.trim() !== '')
      .map((u) => ({ saleUnit: u.saleUnit, baseUnits: Quantity.parseQty(u.baseUnits) ?? Quantity.qty(0) })))
    if (!units.ok) {
      setNotice(
        units.code === 'IN_USE'
          ? `${units.saleUnit} is on ${units.billCount} bill(s) and cannot be removed. The rest was saved.`
          : units.code === 'CLASHES_WITH_BASE'
            ? `This item is already counted in ${units.saleUnit}. The rest was saved.`
            : `${units.saleUnit} needs how many ${draft.baseUnit} it holds. The rest was saved.`,
      )
      setDraft(null)
      await refresh()
      return
    }

    const parsed = Ladder.rowsToRungs(draft.ladder)
    if (!parsed.ok) {
      setNotice(describeRowsProblem(parsed, draft.baseUnit || 'units') ?? 'The prices need checking.')
      return
    }
    if (priceListId) {
      const written = await setLadder(db, { actorId: user.id }, {
        productId, priceListId, saleUnit: draft.baseUnit, rungs: parsed.rungs,
      })
      if (!written.ok) setNotice('The ladder could not be saved against this item.')
    }

    await setProductCategory(db, { actorId: user.id }, productId, draft.categoryId || null)

    const variant = await setVariantOf(db, { actorId: user.id }, {
      productId,
      parentProductId: draft.parentProductId || null,
      variantLabel: draft.variantLabel,
    })
    if (!variant.ok) {
      setNotice(
        variant.code === 'PARENT_IS_A_VARIANT'
          ? 'That item is already a version of something else. Group this one under the original.'
          : variant.code === 'HAS_VARIANTS'
            ? `This item already has ${variant.count} version(s), so it cannot become a version of another.`
            : 'An item cannot be a version of itself.',
      )
    }

    setDraft(null)
    setParentSearch('')
    await refresh()
    await refreshLadders()
  }

  async function addCategory() {
    if (!draft) return
    const made = await createCategory(db, { actorId: user.id }, { name: newCategory })
    if (!made.ok) {
      setNotice(made.code === 'NAME_TAKEN' ? 'There is already a group with that name.' : 'Give the group a name.')
      return
    }
    setNewCategory('')
    await refreshCategories()
    setDraft({ ...draft, categoryId: made.categoryId })
  }

  async function edit(p: ProductListItem) {
    const [codes, units] = await Promise.all([listBarcodes(db, p.id), listUnits(db, p.id)])
    setDraft({
      id: p.id, name: p.name, brand: p.brand ?? '',
      barcodes: codes.length > 0
        ? codes.map((c) => ({ barcode: c.barcode, label: c.label ?? '' }))
        : [{ barcode: '', label: '' }],
      units: units.map((u) => ({ saleUnit: u.saleUnit, baseUnits: Quantity.formatQty(u.baseUnits) })),
      ladder: Ladder.rungsToRows(ladders.get(p.id) ?? []),
      categoryId: p.categoryId ?? '',
      parentProductId: p.parentProductId ?? '',
      variantLabel: p.variantLabel ?? '',
      hsnCode: p.hsnCode ?? '', taxPercent: String(Tax.bpToPercent(p.taxRateBp)),
      baseRate: Money.format(p.baseRate), mrp: p.mrp === null ? '' : Money.format(p.mrp),
      baseUnit: p.baseUnit,
      discountBlocked: p.discountBlocked, loyaltyBlocked: p.loyaltyBlocked,
      reorderLevel: p.reorderLevel === null ? '' : Quantity.formatQty(p.reorderLevel),
      reorderQty: p.reorderQty === null ? '' : Quantity.formatQty(p.reorderQty),
    })
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
        <select className="input" style={{ maxWidth: 200 }} value={browsing}
          onChange={(e) => setBrowsing(e.target.value)} aria-label="Group">
          <option value="">Every group</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.parentName ? `${c.parentName} — ${c.name}` : c.name} ({c.productCount})
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{rows.length} items</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => void checkStock()}>Check stock integrity</button>
        {canWrite && <button className="btn primary" onClick={() => setDraft({ ...BLANK })}>New product</button>}
      </div>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th>Item</th><th>Barcode</th><th>{features.tieredPricing ? 'Quantity ladder' : 'Price list'}</th>
              <th className="r">GST</th><th className="r">Rate</th><th className="r">On hand</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <div>
                    {p.name}
                    {p.variantLabel && <span className="badge" style={{ marginLeft: 6 }}>{p.variantLabel}</span>}
                  </div>
                  <div className="src">
                    {[p.parentName ? `version of ${p.parentName}` : null, p.categoryName, p.brand]
                      .filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="num">{p.barcode ?? '—'}</td>
                <td className="num" style={{ fontSize: 12 }}>
                  {ladders.has(p.id)
                    ? Ladder.describeLadder(ladders.get(p.id)!)
                    : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                </td>
                <td className="num">{p.hsnCode ?? '—'}</td>
                <td className="r num">{Tax.bpToPercent(p.taxRateBp)}%</td>
                <td className="r"><Rupees value={p.baseRate} /></td>
                <td className="r num" style={{ color: p.qtyOnHand <= 0 ? 'var(--danger)' : undefined }}>
                  {Quantity.formatQty(p.qtyOnHand)} {p.baseUnit}
                </td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn ghost sm" onClick={() => void showValuation(p)}>Cost</button>
                  {canWrite && (
                    <button className="btn ghost sm" onClick={() => void edit(p)}>Edit</button>
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
            <Field
              label="MRP"
              hint="The price printed on the packet. Leave blank if there is none. When it is
                    above the selling rate, the receipt shows it and what the customer saved."
            >
              <input className="input num" id="p-mrp" value={draft.mrp}
                onChange={(e) => setDraft({ ...draft, mrp: e.target.value })} />
            </Field>
            {!draft.id && (
              <Field label="Unit">
                <input className="input" id="p-unit" value={draft.baseUnit}
                  onChange={(e) => setDraft({ ...draft, baseUnit: e.target.value })} />
              </Field>
            )}
          </div>

          <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>
              {features.tieredPricing ? 'Quantity ladder' : 'Price on the shop’s list'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
              {features.tieredPricing ? (
                <>
                  Cheaper by the quantity. One row per price break: buy one or more at one price, ten
                  or more at another. Counted in {draft.baseUnit || 'base units'}, so a bigger unit
                  gets the rate its contents have earned — a box of twelve reaches the ten-or-more
                  break. Leave it empty and everyone pays the base rate. Other price lists, a price
                  for the box itself, and a ladder for one customer are on the Prices screen.
                </>
              ) : (
                <>
                  What this item sells for on the shop’s own price list, per{' '}
                  {draft.baseUnit || 'unit'}. Leave it empty and everyone pays the base rate above.
                  Turn on cheaper-by-the-quantity in Settings to price by how much is bought.
                </>
              )}
            </div>
            <LadderEditor
              rows={draft.ladder}
              unit={draft.baseUnit || 'units'}
              breaks={features.tieredPricing}
              onChange={(ladder) => setDraft({ ...draft, ladder })}
            />
          </div>

          <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Grouping</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
              A group is what the item is — stationery, cold drinks. A version is what it is a
              version of: the same pen in six colours stays six items, because there really are six
              on the shelf, but searching the main item&rsquo;s name finds all of them.
            </div>

            <Field label="Group">
              <div style={{ display: 'flex', gap: 6 }}>
                <select className="input" value={draft.categoryId} style={{ flex: 1, minWidth: 0 }}
                  onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}>
                  <option value="">Not grouped</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.parentName ? `${c.parentName} — ${c.name}` : c.name}
                    </option>
                  ))}
                </select>
                <input className="input" placeholder="Or a new one" value={newCategory}
                  style={{ width: 150 }} onChange={(e) => setNewCategory(e.target.value)} />
                <button className="btn" type="button" disabled={newCategory.trim() === ''}
                  onClick={() => void addCategory()}>Add</button>
              </div>
            </Field>

            <Field label="Version of" hint="Leave empty unless this is one of several versions of the same item.">
              {draft.parentProductId ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ flex: 1, fontSize: 12.5 }}>
                    {rows.find((r) => r.id === draft.parentProductId)?.name ?? 'the chosen item'}
                  </span>
                  <input className="input" style={{ width: 150 }} placeholder="blue, 500g, large"
                    value={draft.variantLabel}
                    onChange={(e) => setDraft({ ...draft, variantLabel: e.target.value })} />
                  <button className="btn ghost" type="button"
                    onClick={() => setDraft({ ...draft, parentProductId: '', variantLabel: '' })}>Cut loose</button>
                </div>
              ) : (
                <div className="results-anchor">
                  <input className="input" placeholder="Search the main item" value={parentSearch}
                    onChange={(e) => setParentSearch(e.target.value)}
                    onKeyDown={parentPick.searchKeyDown} />
                  {parentOptions.length > 0 && (
                    <div className="results" {...parentPick.listProps}>
                      {parentOptions.map((r, i) => (
                        <div key={r.id} style={{ padding: '6px 10px' }} {...parentPick.rowProps(i)}>
                          {r.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Field>
          </div>

          <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>
              Units it also sells in
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
              Stock is counted in {draft.baseUnit || 'the base unit'}. A bigger unit says how many of
              those it holds — a ream is 500 sheets, a pack of pens is 10. The cashier then picks the
              unit at the counter, and each one can carry its own price on the Prices screen.
            </div>
            {draft.units.map((unit, index) => (
              <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder="ream, pack, dozen, box"
                  value={unit.saleUnit}
                  onChange={(e) => setDraft({
                    ...draft,
                    units: draft.units.map((u, i) => (i === index ? { ...u, saleUnit: e.target.value } : u)),
                  })}
                />
                <span style={{ fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>=</span>
                <input
                  className="input num"
                  style={{ width: 90 }}
                  inputMode="decimal"
                  placeholder="500"
                  value={unit.baseUnits}
                  onChange={(e) => setDraft({
                    ...draft,
                    units: draft.units.map((u, i) => (i === index ? { ...u, baseUnits: e.target.value } : u)),
                  })}
                />
                <span style={{ fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                  {draft.baseUnit || 'units'}
                </span>
                <button className="btn ghost" type="button" title="Remove this unit"
                  onClick={() => setDraft({ ...draft, units: draft.units.filter((_, i) => i !== index) })}
                >✕</button>
              </div>
            ))}
            <button className="btn ghost sm" type="button"
              onClick={() => setDraft({ ...draft, units: [...draft.units, { saleUnit: '', baseUnits: '' }] })}
            >Another unit</button>
          </div>

          <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Barcodes</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
              {features.multiBarcode ? (
                <>
                  An item can answer to several — the manufacturer’s code on the packet, your own
                  printed label, the one from the old packaging still on the back shelf. Scanning
                  any of them finds this item. The first is the one shown in lists.
                </>
              ) : (
                <>The code on the packet, or the one you print and stick on the shelf.</>
              )}
            </div>
            {visibleBarcodes.map((code, index) => (
              <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input
                  className="input num"
                  id={index === 0 ? 'p-barcode' : `p-barcode-${index}`}
                  style={{ flex: 2, minWidth: 0 }}
                  placeholder={index === 0 ? 'Main barcode' : 'Another barcode'}
                  value={code.barcode}
                  onChange={(e) => setDraft({
                    ...draft,
                    barcodes: draft.barcodes.map((c, i) => (i === index ? { ...c, barcode: e.target.value } : c)),
                  })}
                />
                {features.multiBarcode && (
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 0 }}
                    placeholder="What it is"
                    value={code.label}
                    onChange={(e) => setDraft({
                      ...draft,
                      barcodes: draft.barcodes.map((c, i) => (i === index ? { ...c, label: e.target.value } : c)),
                    })}
                  />
                )}
                {features.multiBarcode && (
                  <button
                    className="btn ghost"
                    type="button"
                    title="Remove this barcode"
                    disabled={draft.barcodes.length === 1}
                    onClick={() => setDraft({ ...draft, barcodes: draft.barcodes.filter((_, i) => i !== index) })}
                  >✕</button>
                )}
              </div>
            ))}
            {features.multiBarcode ? (
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => setDraft({ ...draft, barcodes: [...draft.barcodes, { barcode: '', label: '' }] })}
              >Another barcode</button>
            ) : hiddenBarcodes > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                {hiddenBarcodes === 1 ? 'One other code is' : `${hiddenBarcodes} other codes are`} saved
                against this item and still {hiddenBarcodes === 1 ? 'scans' : 'scan'} at the counter.
                Turn on several barcodes per item in Settings to see{' '}
                {hiddenBarcodes === 1 ? 'it' : 'them'}.
              </div>
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
