import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Quantity, Permissions, costHint, createCategory, familyPriced, familyVersions, productsByIds, setProductActive,
  type Category, type CostHint, type Ladder, type ProductListItem,
} from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { Alert, Rupees } from '../../ui/components'
import { ProductHistory } from '../../ui/ProductHistory'
import { useConfirm } from '../../ui/useConfirm'
import { ProductBatches } from './Batches'
import { ItemJump } from './ItemJump'
import { ItemSection } from './ItemSection'
import { PriceSection } from './PriceSection'
import { StockSection } from './StockSection'
import { RulesSection } from './RulesSection'
import { VariantsTab } from './VariantsTab'
import { loadDraft } from './loadDraft'
import { saveItem, type Say } from './saveItem'
import type { Draft } from './draft'

export type ItemTab = 'item' | 'price' | 'variants' | 'stock' | 'rules'

const TABS: { key: ItemTab; label: string }[] = [
  { key: 'item', label: 'Item' }, { key: 'price', label: 'Price & tax' }, { key: 'variants', label: 'Variants' },
  { key: 'stock', label: 'Stock' }, { key: 'rules', label: 'Rules' },
]

/**
 * One item, as a page with tabs, in place of the long dialog it was.
 *
 * The header keeps the figures in view -- stock, rate, cost, margin -- and
 * "Go to another item" opens the next one on the same tab. The tabs are the
 * old form's sections, unchanged, grouped by what a person came to do. A
 * variant is never opened here on its own: Inventory opens its family on the
 * Variants tab with that row marked (`VariantsTab`).
 */
export function ItemPage({ item, tab: startTab, highlightId, categories, ladders, priceListId, onCategoriesChanged, onBack, onOpen }: {
  item: ProductListItem
  tab: ItemTab
  highlightId: string | null
  categories: Category[]
  ladders: Map<string, Ladder.Rung[]>
  priceListId: string
  onCategoriesChanged: () => Promise<void>
  /** Back to the list, which reloads what it shows. */
  onBack: () => void
  /** Another item asked for from the jump box; its family when it is a variant. */
  onOpen: (item: ProductListItem, tab: ItemTab) => void
}) {
  const { db, features } = useCore()
  const user = useUser()
  const canWrite = Permissions.can(user.permissions, 'product', 'write')
  const [tab, setTab] = useState<ItemTab>(startTab)
  const [row, setRow] = useState<ProductListItem>(item)
  const [draft, setDraft] = useState<Draft | null>(null)
  const loaded = useRef<string>('')
  const [lastCost, setLastCost] = useState<CostHint | null>(null)
  const [cost, setCost] = useState<CostHint | null>(null)
  const [variants, setVariants] = useState<ProductListItem[]>([])
  const [shared, setShared] = useState(false)
  const [newCategory, setNewCategory] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad' | 'warn'; text: string } | null>(null)
  const [history, setHistory] = useState<ProductListItem | null>(null)
  const [batches, setBatches] = useState(false)
  const [confirmUi, ask] = useConfirm()
  const say: Say = (text, kind = 'ok') => setNotice({ text, kind })

  /** The figures and the family, read again after anything that moves them. */
  const refreshHead = useCallback(async () => {
    const [fresh, family, priced, hint] = await Promise.all([
      productsByIds(db, [item.id]), familyVersions(db, item.id), familyPriced(db, item.id), costHint(db, item.id),
    ])
    if (fresh[0]) setRow(fresh[0])
    setVariants(family)
    setShared(priced)
    setCost(hint)
  }, [db, item.id])

  useEffect(() => {
    let live = true
    void (async () => {
      const { draft: d, lastCost: l } = await loadDraft(db, item, ladders.get(item.id) ?? [])
      if (!live) return
      setDraft(d)
      loaded.current = JSON.stringify(d)
      setLastCost(l)
      await refreshHead()
    })().catch(() => undefined)
    return () => { live = false }
  }, [db, item, ladders, refreshHead])

  const dirty = draft !== null && JSON.stringify(draft) !== loaded.current
  const leave = async (go: () => void) => {
    if (dirty && !(await ask(`Leave ${draft?.name || 'this item'} without saving?\n\nWhat you changed here is lost.`))) return
    go()
  }

  async function save() {
    if (!draft) return
    const id = await saveItem({ db, actorId: user.id, draft, features, priceListId, ask, say })
    if (id === null) return
    loaded.current = JSON.stringify(draft)
    setNewCategory('')
    await refreshHead()
  }

  async function addCategory() {
    if (!draft) return
    const made = await createCategory(db, { actorId: user.id }, { name: newCategory })
    if (!made.ok) return say(made.code === 'NAME_TAKEN' ? 'There is already a group with that name.' : 'Give the group a name.', 'bad')
    setNewCategory('')
    await onCategoriesChanged()
    setDraft({ ...draft, categoryId: made.categoryId })
  }

  async function retire() {
    if (row.isActive && !(await ask(
      `Retire “${row.name}”?\n\nIt stops appearing at the counter and on the reorder list. Nothing is `
      + 'deleted: the stock on hand stays counted, old bills still show it, and it can be brought back at any time.',
    ))) return
    await setProductActive(db, { actorId: user.id }, row.id, !row.isActive)
    await refreshHead()
    say(row.isActive ? `“${row.name}” is retired. The counter will not find it.` : `“${row.name}” is back on sale.`)
  }

  // A family's stock is its own (held before it had variants) and its variants' together.
  const stock = (row.qtyOnHand + variants.reduce((sum, v) => sum + v.qtyOnHand, 0)) as Quantity.Qty
  const beforeTax = Math.round((row.baseRate * 10_000) / (10_000 + row.taxRateBp + row.cessRateBp))
  const margin = cost && beforeTax > 0 ? Math.round(((beforeTax - cost.unitCost) / beforeTax) * 100) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1080 }}>
      {confirmUi}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn ghost sm" type="button" onClick={() => void leave(onBack)}>&larr; Inventory</button>
        <span style={{ flex: 1 }} />
        <ItemJump currentId={row.id} onOpen={(next) => void leave(() => onOpen(next, tab))} />
      </div>

      <div className="card"><div className="card-body item-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 600 }}>
            {row.name}
            {!row.isActive && <span className="badge" style={{ marginLeft: 8 }}>retired</span>}
          </div>
          <div className="src" style={{ fontSize: 12 }}>
            {[row.brand, row.categoryName, variants.length > 0 ? `${variants.length} variants on one barcode` : null]
              .filter(Boolean).join(' · ') || ' '}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div className="item-figs">
          <div><span className="k">In stock</span><span className="v">{Quantity.formatQty(stock)} {row.baseUnit}</span></div>
          <div><span className="k">Rate</span><span className="v"><Rupees value={row.baseRate} /></span></div>
          <div><span className="k">Cost</span><span className="v">{cost ? <Rupees value={cost.unitCost} /> : '—'}</span></div>
          <div><span className="k">Margin</span><span className="v">{margin === null ? '—' : `${margin}%`}</span></div>
        </div>
        <button className="btn ghost sm" type="button" onClick={() => setHistory(row)}>History</button>
        {features.batchExpiry && <button className="btn ghost sm" type="button" onClick={() => setBatches(true)}>Batches</button>}
        {canWrite && <button className="btn ghost sm" type="button" onClick={() => void retire()}>{row.isActive ? 'Retire' : 'Bring back'}</button>}
        {canWrite && <button className="btn primary" type="button" disabled={!draft || draft.name.trim() === ''} onClick={() => void save()}>Save</button>}
      </div></div>

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      <div className="card"><div className="card-body">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}{t.key === 'variants' && variants.length > 0 && <span className="n">{variants.length}</span>}
            </button>
          ))}
        </div>
        {!draft ? null : tab === 'item' ? (
          <ItemSection draft={draft} setDraft={setDraft} categories={categories} newCategory={newCategory}
            setNewCategory={setNewCategory} onAddCategory={() => void addCategory()} variantCount={variants.length} />
        ) : tab === 'price' ? (
          <PriceSection draft={draft} setDraft={setDraft} lastCost={lastCost} familyPriced={shared && variants.length > 0} />
        ) : tab === 'variants' ? (
          <VariantsTab draft={draft} setDraft={setDraft} highlightId={highlightId} onHistory={setHistory}
            onChanged={() => void refreshHead()} />
        ) : tab === 'stock' ? (
          <StockSection draft={draft} setDraft={setDraft} />
        ) : (
          <RulesSection draft={draft} setDraft={setDraft} />
        )}
      </div></div>

      {history && (
        <ProductHistory productId={history.id} name={history.name} baseUnit={history.baseUnit} onClose={() => setHistory(null)} />
      )}
      {batches && (
        <ProductBatches productId={row.id} name={row.name} baseUnit={row.baseUnit} onHand={row.qtyOnHand} onClose={() => setBatches(false)} />
      )}
    </div>
  )
}
