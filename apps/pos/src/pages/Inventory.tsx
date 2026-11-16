import { useCallback, useEffect, useState } from 'react'
import {
  Quantity, Tax, Permissions, searchProducts, recomputeStock, listCategories, renameCategory, removeCategory,
  laddersFor, defaultPriceListId, Ladder, productsByIds, familyTotals, familyVersions, planRemoval, removeProducts,
  type Category, type ProductListItem, type RemovalRow,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { recordStockCheck } from '../core/maintenance'
import { Empty, Alert, Rupees } from '../ui/components'
import { useConfirm } from '../ui/useConfirm'
import { DoublePrices } from '../ui/DoublePrices'
import { useShopChanged } from '../core/useShopChanged'
import { CatalogueFile } from '../ui/CatalogueFile'
import { costOn } from './inventory/prices'
import { GstSwitch, useGstMode, COST_ENTRY } from '../ui/GstSwitch'
import { useCostHints } from './inventory/useCostHints'
import { costNote } from '../ui/costNote'
import { ExpiringCard } from './inventory/Batches'
import { ItemPage, type ItemTab } from './inventory/ItemPage'
import { NewItem } from './inventory/NewItem'
import { familyRows } from './inventory/familyRows'

/**
 * Every item, and the way into each one.
 *
 * A family -- an item with variants (`variants.ts`) -- is one row with the
 * stock its variants hold together, and its variants open under it. A
 * variant is never a row of its own and never opens a page of its own: Open
 * on one opens its family on the Variants tab with that variant marked. An
 * item opens as a page (`ItemPage`), where the long dialog used to be.
 */
export default function Inventory() {
  const { db, features } = useCore()
  const user = useUser()
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState<ProductListItem[]>([])
  const [parents, setParents] = useState<ProductListItem[]>([])
  const [totals, setTotals] = useState<Map<string, { count: number; qty: Quantity.Qty }>>(new Map())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [page, setPage] = useState<{ item: ProductListItem; tab: ItemTab; highlightId: string | null } | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirmUi, ask] = useConfirm()
  const [notice, setNotice] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [browsing, setBrowsing] = useState('')
  const [ladders, setLadders] = useState<Map<string, Ladder.Rung[]>>(new Map())
  const [priceListId, setPriceListId] = useState('')
  /** The items ticked for removing, by id: kept across searches, so a shop can gather them from several. */
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  /** Out-of-use items are a list of their own: on the main one they were rows nobody can sell. */
  const [retiredOnly, setRetiredOnly] = useState(false)
  /** Tick boxes only while choosing: the rest of the time they are a column of clutter. */
  const [selecting, setSelecting] = useState(false)

  const canWrite = Permissions.can(user.permissions, 'product', 'write')
  const canDelete = Permissions.can(user.permissions, 'product', 'delete')
  const ticking = canDelete && selecting
  const costs = useCostHints(db, rows)
  const [costMode, setCostMode] = useGstMode(COST_ENTRY) // the item page's and Stock In's switch

  const refresh = useCallback(async () => {
    const everything = await searchProducts(db, {
      term, limit: null, includeInactive: true, ...(browsing ? { categoryId: browsing } : {}),
    })
    const found = everything.filter((p) => p.isActive !== retiredOnly)
    // A search can find a variant and not its family: the family is fetched so the variant has a row to sit under.
    const missing = [...new Set(found.filter((p) => p.parentProductId && !found.some((r) => r.id === p.parentProductId))
      .map((p) => p.parentProductId!))]
    const [extra, sums] = await Promise.all([productsByIds(db, missing), familyTotals(db)])
    setRows(found)
    setParents(extra)
    setTotals(sums)
  }, [db, term, browsing, retiredOnly])

  useEffect(() => {
    const id = setTimeout(() => void refresh(), term === '' ? 0 : 140)
    return () => clearTimeout(id)
  }, [refresh, term, browsing, retiredOnly])
  // And again when the other till changes a product or a price.
  useShopChanged(refresh)

  const refreshCategories = useCallback(async () => setCategories(await listCategories(db)), [db])
  useEffect(() => { void refreshCategories() }, [refreshCategories])

  // The item's own quantity breaks, on the shop's own list. Other lists are
  // Special Prices' business; this is the answer to "what does it cost".
  const refreshLadders = useCallback(async () => {
    const listId = await defaultPriceListId(db)
    if (!listId) return
    setPriceListId(listId)
    setLadders(await laddersFor(db, listId))
  }, [db])
  useEffect(() => { void refreshLadders() }, [refreshLadders])

  /** An item asked for anywhere: a variant opens its family, with the variant marked. */
  async function openItem(p: ProductListItem, tab: ItemTab = 'item') {
    if (p.parentProductId) {
      const [family] = await productsByIds(db, [p.parentProductId])
      if (family) return setPage({ item: family, tab: 'variants', highlightId: p.id })
    }
    setPage({ item: p, tab, highlightId: null })
  }

  async function made(productId: string, withVariants: boolean) {
    setAdding(false)
    const [item] = await productsByIds(db, [productId])
    if (item) setPage({ item, tab: withVariants ? 'variants' : 'item', highlightId: null })
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
    const result = await renameCategory(db, { actorId: user.id }, { categoryId: group.id, name: name.trim() })
    if (!result.ok) {
      setNotice(result.code === 'NAME_TAKEN' ? 'There is already a group with that name.' : 'Give the group a name.')
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
      `Remove the group “${group.name}”?\n\n`
      + `Nothing is deleted: ${many} stay exactly as they are and simply stop `
      + 'being in a group. Any groups inside this one move to the top level.',
    ))) return
    await removeCategory(db, { actorId: user.id }, group.id)
    setBrowsing('')
    await refreshCategories()
    await refresh()
    setNotice(`“${group.name}” is gone. Its products are still here, in no group.`)
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

  /**
   * Removing every ticked item at once (`productRemoval.ts`).
   *
   * The plan is shown before anything happens, in the shop's words: which go
   * for good, which have bills or stock and so are only taken out of use, and
   * which stay because a family still has variants nobody ticked.
   */
  async function removeChosen() {
    const plan = await planRemoval(db, [...chosen])
    const names = (rows: RemovalRow[]) => {
      const shown = rows.slice(0, 6).map((r) => `  ${r.name}`)
      return [...shown, ...(rows.length > 6 ? [`  and ${rows.length - 6} more`] : [])].join('\n')
    }
    const of = (n: number) => (n === 1 ? '1 item' : `${n} items`)
    const retire = plan.rows.filter((r) => r.action === 'retire')
    const families = plan.rows.filter((r) => r.reason === 'HAS_VARIANTS')
    const done = plan.rows.filter((r) => r.reason === 'ALREADY_RETIRED')
    if (plan.delete + plan.retire === 0) {
      setNotice(families.length > 0
        ? 'Nothing to remove: tick a family’s variants with it, or remove the variants first.'
        : 'Nothing to remove: those items are already out of use.')
      return
    }
    const parts = [
      ...(plan.delete > 0 ? [`${of(plan.delete)} will be deleted. They were never sold, bought or counted, and their barcodes become free.`] : []),
      ...(retire.length > 0 ? [`${of(retire.length)} have bills or stock, so they cannot be deleted. They will be taken out of use instead: off the counter and the reorder list, still on old bills.\n${names(retire)}`] : []),
      ...(families.length > 0 ? [`${of(families.length)} will stay, because they still have variants you did not tick.\n${names(families)}`] : []),
      ...(done.length > 0 ? [`${of(done.length)} are already out of use and stay as they are.`] : []),
    ]
    if (!(await ask({
      title: `Remove ${of(chosen.size)}?`,
      message: parts.join('\n\n'),
      confirmLabel: plan.retire > 0 && plan.delete === 0 ? `Take ${of(plan.retire)} out of use` : 'Remove',
      cancelLabel: 'Keep them',
    }))) return
    const result = await removeProducts(db, { actorId: user.id }, [...chosen])
    setChosen(new Set())
    setSelecting(false)
    await refresh()
    setNotice([
      ...(result.deleted > 0 ? [`${of(result.deleted)} deleted.`] : []),
      ...(result.retired > 0 ? [`${of(result.retired)} taken out of use.`] : []),
      ...(result.kept > 0 ? [`${of(result.kept)} kept.`] : []),
    ].join(' '))
  }

  const tick = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  /* A family ticked is the family with every variant it has, out of use or
     not, shown or not: it can only go once they all do (`productRemoval.ts`). */
  async function tickWithVariants(ids: readonly string[], on: boolean) {
    const families = ids.filter((id) => totals.has(id) || rows.some((r) => r.parentProductId === id))
    const versions = await Promise.all(families.map((id) => familyVersions(db, id, { includeRetired: true })))
    const all = [...ids, ...versions.flat().map((v) => v.id)]
    setChosen((s) => { const n = new Set(s); for (const id of all) if (on) n.add(id); else n.delete(id); return n })
  }

  if (page) {
    return (
      <ItemPage
        key={`${page.item.id}-${page.tab}-${page.highlightId ?? ''}`}
        item={page.item} tab={page.tab} highlightId={page.highlightId}
        categories={categories} ladders={ladders} priceListId={priceListId}
        onCategoriesChanged={refreshCategories}
        onBack={() => { setPage(null); void refresh(); void refreshLadders() }}
        onOpen={(next, tab) => void openItem(next, tab)}
      />
    )
  }

  const listed = familyRows(rows, parents, term.trim() !== '')
  const cols = (features.tieredPricing ? 10 : 9) + (ticking ? 1 : 0)
  const listedIds = listed.map((l) => l.item.id)
  const allTicked = listedIds.length > 0 && listedIds.every((id) => chosen.has(id))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notice && <Alert kind="ok">{notice}</Alert>}
      {canWrite && <DoublePrices onDone={refresh} />}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Search products"
          value={term} onChange={(e) => setTerm(e.target.value)} id="product-search" />
        <select className="input" style={{ maxWidth: 140 }} value={retiredOnly ? 'retired' : 'live'}
          onChange={(e) => { setRetiredOnly(e.target.value === 'retired'); setChosen(new Set()) }} aria-label="In use or out of use">
          <option value="live">In use</option>
          <option value="retired">Out of use</option>
        </select>
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
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{listed.length} items</span>
        {/* Out of the Cost heading, where it made that column the widest in the table. */}
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Cost</span><GstSwitch mode={costMode} onChange={setCostMode} />
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => void checkStock()}>Check stock integrity</button>
        {canDelete && (
          <button className="btn" onClick={() => { setSelecting((on) => !on); setChosen(new Set()) }}>
            {selecting ? 'Done' : 'Select'}
          </button>
        )}
        {canWrite && <CatalogueFile onDone={refresh} />}
        {canWrite && <button className="btn primary" onClick={() => setAdding(true)}>Add item</button>}
      </div>

      {features.batchExpiry && <ExpiringCard />}

      {ticking && (
        <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px' }}>
          <span>{chosen.size === 0 ? 'Tick the items to remove' : chosen.size === 1 ? '1 item ticked' : `${chosen.size} items ticked`}</span>
          <span style={{ flex: 1 }} />
          {chosen.size > 0 && <button className="btn sm" onClick={() => setChosen(new Set())}>Clear</button>}
          <button className="btn sm danger" disabled={chosen.size === 0} onClick={() => void removeChosen()}>Remove…</button>
        </div>
      )}

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              {/* One heading per cell below, in the same order: the rows carried an
                  HSN cell the heading row did not, which pushed every heading after
                  it one column left of its figures. */}
              {ticking && (
                <th style={{ width: 28 }}>
                  <input type="checkbox" aria-label="Tick every item listed" checked={allTicked}
                    onChange={() => void tickWithVariants(listedIds, !allTicked)} />
                </th>
              )}
              <th>Item</th><th>Barcode</th>{features.tieredPricing && <th>Cheaper by quantity</th>}
              <th>HSN</th><th className="r">GST</th><th className="r">MRP</th><th className="r" title={`The last price paid, or your cost price if newer; ${costMode === 'with' ? 'with' : 'before'} GST`}>Cost</th><th className="r">Rate</th>
              <th className="r">On hand</th><th />
            </tr>
          </thead>
          <tbody>
            {listed.map(({ item: p, variants, marked }) => {
              const family = totals.get(p.id)
              const isFamily = family !== undefined || variants.length > 0
              const shown = open.has(p.id) || (marked.size > 0)
              const onHand = (p.qtyOnHand + (family?.qty ?? 0)) as Quantity.Qty
              const toggle = () => setOpen((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n })
              return [
                <tr key={p.id} className={isFamily ? 'family-row' : undefined}>
                  {ticking && (
                    <td><input type="checkbox" aria-label={`Tick ${p.name}`} checked={chosen.has(p.id)} onChange={() => void tickWithVariants([p.id], !chosen.has(p.id))} /></td>
                  )}
                  <td>
                    <div>
                      {isFamily && (
                        <button type="button" className="caret" aria-expanded={shown}
                          aria-label={`${shown ? 'Close' : 'Open'} the variants of ${p.name}`} onClick={toggle}>
                          {shown ? '▾' : '▸'}
                        </button>
                      )}
                      {p.name}
                      {isFamily && <span className="badge" style={{ marginLeft: 6 }}>{family?.count ?? variants.length} variants</span>}
                      {/* Said on the row, because a retired product that looks
                          exactly like a live one is a product somebody will try
                          to sell and then wonder why the counter cannot find. */}
                      {!p.isActive && <span className="badge" style={{ marginLeft: 6 }}>retired</span>}
                    </div>
                    <div className="src">{[p.categoryName, p.brand].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="num">{p.barcode ?? variants[0]?.barcode ?? <Missing />}</td>
                  {features.tieredPricing && (
                    <td className="num" style={{ fontSize: 12 }}>
                      {Ladder.describeLadder((ladders.get(p.id) ?? []).filter((r) => r.minQty > Quantity.QTY_SCALE))}
                    </td>
                  )}
                  <td className="num">{p.hsnCode ?? <Missing />}</td>
                  <td className="r num">{Tax.bpToPercent(p.taxRateBp)}%</td>
                  <td className="r">{p.mrp !== null ? <Rupees value={p.mrp} /> : <Missing />}</td>
                  <td className="r" title={costs.has(p.id) ? costNote(costs.get(p.id)!) : 'No cost known yet'}>{costs.has(p.id) ? <Rupees value={costOn(costs.get(p.id)!.unitCost, p.taxRateBp, p.cessRateBp, costMode)} /> : <Missing />}</td>
                  <td className="r"><Rupees value={p.baseRate} /></td>
                  <td className="r num" style={{ color: onHand <= 0 ? 'var(--danger)' : undefined }}>
                    {Quantity.formatQty(onHand)} {p.baseUnit}
                  </td>
                  <td className="r"><button className="btn ghost sm" onClick={() => void openItem(p)}>Open</button></td>
                </tr>,
                ...(shown ? variants.map((v) => (
                  <tr key={v.id} className={`variant-row${marked.has(v.id) ? ' marked' : ''}`}>
                    {ticking && (
                      <td><input type="checkbox" aria-label={`Tick ${v.name}`} checked={chosen.has(v.id)} onChange={() => tick(v.id)} /></td>
                    )}
                    <td>
                      {v.variantLabel ?? v.name}
                      {!v.isActive && <span className="badge" style={{ marginLeft: 6 }}>out of use</span>}
                    </td>
                    <td className="num">{v.barcode ?? <Missing />}</td>
                    {features.tieredPricing && <td />}
                    <td /><td /><td />
                    <td />
                    <td className="r">{v.baseRate === p.baseRate ? <span className="src">same</span> : <Rupees value={v.baseRate} />}</td>
                    <td className="r num" style={{ color: v.qtyOnHand <= 0 ? 'var(--danger)' : undefined }}>
                      {Quantity.formatQty(v.qtyOnHand)} {v.baseUnit}
                    </td>
                    <td className="r"><button className="btn ghost sm" onClick={() => void openItem(v)}>Open</button></td>
                  </tr>
                )) : []),
              ]
            })}
            {listed.length === 0 && <tr><td colSpan={cols}><Empty>No products match</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      {adding && <NewItem onMade={(id, withVariants) => void made(id, withVariants)} onClose={() => setAdding(false)} />}
      {confirmUi}
    </div>
  )
}

/** A cell with nothing in it, said the same quiet way in every column. */
function Missing() {
  return <span style={{ color: 'var(--ink-3)' }}>—</span>
}
