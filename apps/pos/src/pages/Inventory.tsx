import { useCallback, useEffect, useState } from 'react'
import {
  Money, Quantity, Tax, Permissions, searchProducts, recomputeStock, listBarcodes, setBarcodes,
  listUnits, setUnits, listCategories, createCategory, renameCategory, removeCategory,
  setProductCategory, setVariantOf, setLadder, laddersFor, defaultPriceListId, Ladder,
  setProductActive, saveProductDetails, type Category, type ProductListItem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { recordStockCheck } from '../core/maintenance'
import { Modal, Empty, Alert, Rupees } from '../ui/components'
import { ProductHistory } from '../ui/ProductHistory'
import { useConfirm } from '../ui/useConfirm'
import { describeRowsProblem } from '../ui/LadderEditor'
import { useShopChanged } from '../core/useShopChanged'
import { CatalogueFile } from '../ui/CatalogueFile'
import { BLANK, levelOf, type Draft } from './inventory/draft'
import { useParentSearch } from './inventory/useParentSearch'
import { ProductForm } from './inventory/ProductForm'
import { ExpiringCard, ProductBatches } from './inventory/Batches'

export default function Inventory() {
  const { db, features } = useCore()
  const user = useUser()
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState<ProductListItem[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  /* The whole product rather than four numbers copied out of it: the panel
     reads the ledger itself, and a snapshot taken here would be one more
     thing to keep in step with it. */
  const [history, setHistory] = useState<ProductListItem | null>(null)
  const [batchesFor, setBatchesFor] = useState<ProductListItem | null>(null)
  const [confirmUi, ask] = useConfirm()
  const [notice, setNotice] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [newCategory, setNewCategory] = useState('')
  const parent = useParentSearch(db, draft, setDraft)
  const [browsing, setBrowsing] = useState('')
  const [ladders, setLadders] = useState<Map<string, Ladder.Rung[]>>(new Map())
  const [priceListId, setPriceListId] = useState('')

  const canWrite = Permissions.can(user.permissions, 'product', 'write')

  const refresh = useCallback(async () => {
    setRows(await searchProducts(db, {
      term, limit: 200, includeInactive: true, ...(browsing ? { categoryId: browsing } : {}),
    }))
  }, [db, term, browsing])

  useEffect(() => {
    const id = setTimeout(() => void refresh(), term === '' ? 0 : 140)
    return () => clearTimeout(id)
  }, [refresh, term, browsing])
  // And again when the other till changes a product or a price.
  useShopChanged(refresh)

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

  async function save() {
    if (!draft || draft.name.trim() === '') return

    /* Said, not assumed. A price typed as "12.3.4" used to save the item at
       ₹0, and a tax rate that was not a number saved it untaxed. */
    const rate = draft.baseRate.trim() === '' ? Money.ZERO : Money.parseMoney(draft.baseRate)
    if (rate === null || rate < 0) { setNotice('The price is not an amount. Nothing was saved.'); return }
    /* Null, not zero. A packet with no printed price is not a packet printed
       with ₹0, and the receipt only shows the MRP line when there is one. */
    const mrp = draft.mrp.trim() === '' ? null : Money.parseMoney(draft.mrp)
    if (mrp !== null && mrp < 0) { setNotice('The MRP cannot be below zero. Nothing was saved.'); return }
    if (draft.mrp.trim() !== '' && mrp === null) { setNotice('The MRP is not an amount. Nothing was saved.'); return }
    const percent = draft.taxPercent.trim() === '' ? 0 : Number(draft.taxPercent)
    if (!Number.isFinite(percent)) { setNotice('The tax rate is not a number. Nothing was saved.'); return }
    const cessPercent = draft.cessPercent.trim() === '' ? 0 : Number(draft.cessPercent)
    if (!Number.isFinite(cessPercent)) { setNotice('The cess rate is not a number. Nothing was saved.'); return }

    // Through the core, which checks the figures and writes the change to the
    // history. The barcode column is not written here: setBarcodes owns the pair
    // of products.barcode and the product_barcodes rows.
    const saved = await saveProductDetails(db, { actorId: user.id }, {
      id: draft.id,
      name: draft.name,
      brand: draft.brand,
      hsnCode: draft.hsnCode,
      taxRateBp: Math.round(percent * 100),
      cessRateBp: Math.round(cessPercent * 100),
      baseRate: rate,
      mrp,
      baseUnit: draft.baseUnit,
      discountBlocked: draft.discountBlocked,
      loyaltyBlocked: draft.loyaltyBlocked,
      returnBlocked: draft.returnBlocked,
      isStockTracked: draft.stockTracked,
      openPrice: draft.openPrice,
      reorderLevel: levelOf(draft.reorderLevel),
      reorderQty: levelOf(draft.reorderQty),
    })
    if (!saved.ok) {
      setNotice(
        saved.code === 'BAD_TAX' ? 'GST is between 0 and 100 per cent, and cess between 0 and 300. Nothing was saved.'
        : saved.code === 'BAD_LEVEL' ? 'The reorder figures have to be quantities, zero or more. Nothing was saved.'
        : saved.code === 'UNKNOWN_PRODUCT' ? 'This item is no longer in the catalogue.'
        : 'The item could not be saved. Check its name and price.',
      )
      return
    }
    const productId = saved.productId
    // A code another item has is saved too (069); the scan will ask which, and the owner is told so.
    const { shared } = await setBarcodes(db, { actorId: user.id }, productId, draft.barcodes)

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
    if (shared.length > 0) {
      const also = shared.map((s) => `${s.barcode} is also on ${s.productName}`).join('; ')
      setNotice(`Saved. ${also} — scanning it will ask which item.`)
    }

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
    parent.setSearch('')
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

  /**
   * Renaming a group, and getting rid of one.
   *
   * Both services have been in `grouping.ts` since groups existed and neither
   * had a caller: a group typed with a spelling mistake was a spelling mistake
   * for ever, and one made by accident could not be got rid of. `removeCategory`
   * is careful -- it moves the products to no group rather than deleting them,
   * and unparents its children -- which is worth having reachable.
   */
  async function renameGroup() {
    const group = categories.find((c) => c.id === browsing)
    if (!group) return

    const name = window.prompt(`Rename “${group.name}” to what?`, group.name)
    if (name === null || name.trim() === '' || name.trim() === group.name) return

    const result = await renameCategory(db, { actorId: user.id }, {
      categoryId: group.id, name: name.trim(),
    })
    if (!result.ok) {
      setNotice(result.code === 'NAME_TAKEN'
        ? 'There is already a group with that name.'
        : 'Give the group a name.')
      return
    }
    await refreshCategories()
    setNotice(`Renamed to ${name.trim()}.`)
  }

  async function removeGroup() {
    const group = categories.find((c) => c.id === browsing)
    if (!group) return

    /* Said in full, because "delete" beside a group holding two hundred items
       reads like it takes the items with it, and it does not. */
    const many = group.productCount === 1 ? '1 product' : `${group.productCount} products`
    if (!(await ask(
      `Remove the group “${group.name}”?

`
      + `Nothing is deleted: ${many} stay exactly as they are and simply stop `
      + 'being in a group. Any groups inside this one move to the top level.',
    ))) return

    await removeCategory(db, { actorId: user.id }, group.id)
    setBrowsing('')
    await refreshCategories()
    await refresh()
    setNotice(`“${group.name}” is gone. Its products are still here, in no group.`)
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
      cessPercent: p.cessRateBp === 0 ? '' : String(Tax.bpToPercent(p.cessRateBp)),
      baseRate: Money.format(p.baseRate), mrp: p.mrp === null ? '' : Money.format(p.mrp),
      baseUnit: p.baseUnit,
      discountBlocked: p.discountBlocked, loyaltyBlocked: p.loyaltyBlocked,
      returnBlocked: p.returnBlocked, stockTracked: p.isStockTracked, openPrice: p.openPrice,
      reorderLevel: p.reorderLevel === null ? '' : Quantity.formatQty(p.reorderLevel),
      reorderQty: p.reorderQty === null ? '' : Quantity.formatQty(p.reorderQty),
    })
  }

  /**
   * Taking a product out of use, and putting it back.
   *
   * `is_active` has been read by the counter's search, the reorder list and
   * this screen since the catalogue was written, and nothing could ever set it.
   * What a shop did instead was rename the thing to "OLD - do not use".
   *
   * Nothing is deleted and nothing is hidden from history: the stock stays
   * counted, old bills still reprint and the reports still name it. It stops
   * appearing where a live product belongs.
   */
  async function retire(p: ProductListItem) {
    if (p.isActive && !(await ask(
      `Retire “${p.name}”?

`
      + 'It stops appearing at the counter and on the reorder list. Nothing is '
      + 'deleted: the stock on hand stays counted, old bills still show it, and '
      + 'it can be brought back from this screen at any time.',
    ))) return

    await setProductActive(db, { actorId: user.id }, p.id, !p.isActive)
    await refresh()
    setNotice(p.isActive
      ? `“${p.name}” is retired. The counter will not find it.`
      : `“${p.name}” is back on sale.`)
  }

  /**
   * The full replay, on purpose and by hand.
   *
   * One pass, not two. This used to replay the ledger to count the drift and
   * then replay it again to fix it — twice the longest table in the shop, for
   * one button. `repair` reports what it changed as it changes it.
   *
   * The result is written down where the Dashboard reads it, so the warning
   * there clears the moment this is dealt with instead of at the next weekly
   * run. Nothing else on either screen connects the two.
   */
  async function checkStock() {
    const drift = await recomputeStock(db, { repair: true })
    setNotice(
      drift.length === 0
        ? 'Stock matches the ledger exactly — no drift.'
        : `${drift.length} product(s) drifted from the ledger. Repaired.`,
    )
    await recordStockCheck({ at: new Date().toISOString(), drift: 0 })
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
        {canWrite && browsing !== '' && (
          <>
            <button className="btn sm" onClick={() => void renameGroup()}>Rename group</button>
            <button className="btn sm" onClick={() => void removeGroup()}>Remove group</button>
          </>
        )}
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{rows.length} items</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => void checkStock()}>Check stock integrity</button>
        {canWrite && <CatalogueFile onDone={refresh} />}
        {canWrite && <button className="btn primary" onClick={() => setDraft({ ...BLANK })}>New product</button>}
      </div>

      {features.batchExpiry && <ExpiringCard />}

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              {/* One heading per cell below, in the same order: the rows carried an
                  HSN cell the heading row did not, which pushed every heading after
                  it one column left of its figures. */}
              <th>Item</th><th>Barcode</th><th>{features.tieredPricing ? 'Quantity ladder' : 'Price list'}</th>
              <th>HSN</th><th className="r">GST</th><th className="r">MRP</th><th className="r">Rate</th>
              <th className="r">On hand</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <div>
                    {p.name}
                    {p.variantLabel && <span className="badge" style={{ marginLeft: 6 }}>{p.variantLabel}</span>}
                    {/* Said on the row, because a retired product that looks
                        exactly like a live one is a product somebody will try
                        to sell and then wonder why the counter cannot find. */}
                    {!p.isActive && <span className="badge" style={{ marginLeft: 6 }}>retired</span>}
                  </div>
                  <div className="src">
                    {[p.parentName ? `version of ${p.parentName}` : null, p.categoryName, p.brand]
                      .filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="num">{p.barcode ?? <Missing />}</td>
                <td className="num" style={{ fontSize: 12 }}>
                  {ladders.has(p.id)
                    ? Ladder.describeLadder(ladders.get(p.id)!)
                    : <Missing />}
                </td>
                <td className="num">{p.hsnCode ?? <Missing />}</td>
                <td className="r num">{Tax.bpToPercent(p.taxRateBp)}%</td>
                <td className="r">{p.mrp !== null ? <Rupees value={p.mrp} /> : <Missing />}</td>
                <td className="r"><Rupees value={p.baseRate} /></td>
                <td className="r num" style={{ color: p.qtyOnHand <= 0 ? 'var(--danger)' : undefined }}>
                  {Quantity.formatQty(p.qtyOnHand)} {p.baseUnit}
                </td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  {/* Was "Cost", and gave one number with no way to see how it
                      got there. The average is derived, so the rows it is
                      derived from are the answer to any question about it. */}
                  <button className="btn ghost sm" onClick={() => setHistory(p)}>History</button>
                  {features.batchExpiry && (
                    <button className="btn ghost sm" onClick={() => setBatchesFor(p)}>Batches</button>
                  )}
                  {canWrite && (
                    <button className="btn ghost sm" onClick={() => void edit(p)}>Edit</button>
                  )}
                  {canWrite && (
                    <button className="btn ghost sm" onClick={() => void retire(p)}>
                      {p.isActive ? 'Retire' : 'Bring back'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9}><Empty>No products match</Empty></td></tr>}
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
          <ProductForm
            draft={draft}
            setDraft={setDraft}
            categories={categories}
            newCategory={newCategory}
            setNewCategory={setNewCategory}
            onAddCategory={() => void addCategory()}
            parentName={rows.find((r) => r.id === draft.parentProductId)?.name}
            parent={parent}
          />
        </Modal>
      )}

      {confirmUi}
      {history && (
        <ProductHistory
          productId={history.id}
          name={history.name}
          baseUnit={history.baseUnit}
          onClose={() => setHistory(null)}
        />
      )}
      {batchesFor && (
        <ProductBatches
          productId={batchesFor.id}
          name={batchesFor.name}
          baseUnit={batchesFor.baseUnit}
          onHand={batchesFor.qtyOnHand}
          onClose={() => setBatchesFor(null)}
        />
      )}
    </div>
  )
}

/** A cell with nothing in it, said the same quiet way in every column. */
function Missing() {
  return <span style={{ color: 'var(--ink-3)' }}>—</span>
}
