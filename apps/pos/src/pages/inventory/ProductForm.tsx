import type { Category, CostHint } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Field } from '../../ui/components'
import { LadderEditor } from '../../ui/LadderEditor'
import { Results } from '../../ui/PickList'
import type { Draft } from './draft'
import { PriceFields } from './PriceFields'
import { TaxFields } from './TaxFields'
import { PricesElsewhere } from './PricesElsewhere'
import { ProductPhotoBox } from '../../ui/ProductPhotoBox'
import { UnitRows } from './UnitRows'
import { RenameUnit } from './RenameUnit'
import type { ParentSearch } from './useParentSearch'

/**
 * Everything the product form asks, section by section: the item, its price
 * and its quantity breaks, its group and what it is a version of, the units it sells
 * in, its barcodes, when to buy more, and the switches for thin-margin goods.
 *
 * The draft and what is done with it on save belong to the page. This only
 * shows the draft and hands every change back.
 */
export function ProductForm({
  draft, setDraft, categories, newCategory, setNewCategory, onAddCategory, parentName, parent, lastCost = null,
}: {
  draft: Draft
  setDraft: (draft: Draft) => void
  categories: Category[]
  newCategory: string
  setNewCategory: (name: string) => void
  onAddCategory: () => void
  /** The main item's name, when this one is a version of something. */
  parentName: string | undefined
  parent: ParentSearch
  /** The last price actually paid for this item, from a delivery or opening stock. */
  lastCost?: CostHint | null
}) {
  const { features } = useCore()

  /* With several barcodes switched off, only the first box is shown — and the
     rest stay in the draft and are written back untouched. A screen that stops
     showing a code must not be a screen that deletes it: that code is printed on
     a packet somewhere, and the scanner still reads it. */
  const allBarcodes = draft.barcodes
  const visibleBarcodes = features.multiBarcode ? allBarcodes : allBarcodes.slice(0, 1)
  const hiddenBarcodes = allBarcodes.length - visibleBarcodes.length

  return (
    <>
      <Field label="Name">
        <input className="input" id="p-name" autoFocus value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Brand">
          <input className="input" id="p-brand" value={draft.brand}
            onChange={(e) => setDraft({ ...draft, brand: e.target.value })} />
        </Field>
        <TaxFields draft={draft} setDraft={setDraft} />
        <PriceFields draft={draft} setDraft={setDraft} lastCost={lastCost} />
        {/* On an item that exists, shown and renamable but not changeable: its
            stock, bills and valuation are all counted in it. */}
        {!draft.id ? (
          <Field label="Unit">
            <input className="input" id="p-unit" value={draft.baseUnit}
              onChange={(e) => setDraft({ ...draft, baseUnit: e.target.value })} />
          </Field>
        ) : (
          <RenameUnit draft={draft} setDraft={setDraft} />
        )}
      </div>

      {features.tieredPricing && (
        <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Cheaper by the quantity</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
            The selling rate above is the price of one. Add a row for each break: from 10{' '}
            {draft.baseUnit || 'units'}, ₹9 each. Counted in {draft.baseUnit || 'base units'}, so a box of
            twelve reaches the ten-or-more break. Leave it empty and everyone pays the selling rate.
          </div>
          <LadderEditor
            rows={draft.ladder}
            unit={draft.baseUnit || 'units'}
            firstQty="10"
            onChange={(ladder) => setDraft({ ...draft, ladder })}
          />
        </div>
      )}
      {draft.id && <PricesElsewhere productId={draft.id} />}
      {draft.id && <ProductPhotoBox productId={draft.id} name={draft.name} />}

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
              onClick={onAddCategory}>Add</button>
          </div>
        </Field>

        <Field label="Version of" hint="Leave empty unless this is one of several versions of the same item.">
          {draft.parentProductId ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ flex: 1, fontSize: 12.5 }}>
                {parentName ?? 'the chosen item'}
              </span>
              <input className="input" style={{ width: 150 }} placeholder="blue, 500g, large"
                value={draft.variantLabel}
                onChange={(e) => setDraft({ ...draft, variantLabel: e.target.value })} />
              <button className="btn ghost" type="button"
                onClick={() => setDraft({ ...draft, parentProductId: '', variantLabel: '' })}>Cut loose</button>
            </div>
          ) : (
            <div>
              <input className="input" ref={parent.box} placeholder="Search the main item"
                value={parent.search}
                onChange={(e) => parent.setSearch(e.target.value)}
                onKeyDown={parent.pick.searchKeyDown} />
              <Results anchor={parent.box} open={parent.options.length > 0}>
                <div {...parent.pick.listProps}>
                  {parent.options.map((r, i) => (
                    <div key={r.id} style={{ padding: '6px 10px' }} {...parent.pick.rowProps(i)}>
                      {r.name}
                    </div>
                  ))}
                </div>
              </Results>
            </div>
          )}
        </Field>
      </div>

      <UnitRows draft={draft} setDraft={setDraft} />

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
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 7 }}>
          <input type="checkbox" checked={draft.loyaltyBlocked}
            onChange={(e) => setDraft({ ...draft, loyaltyBlocked: e.target.checked })} />
          <span style={{ fontSize: 12.5 }}>Earns no loyalty points</span>
        </label>
        {/* `returns.ts` has refused a return on one of these since returns
            were written, and nothing could ever switch it on. */}
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={draft.returnBlocked}
            onChange={(e) => setDraft({ ...draft, returnBlocked: e.target.checked })} />
          <span style={{ fontSize: 12.5 }}>
            Cannot be returned
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-3)' }}>
              A recharge, a cut length, anything perishable. The return screen
              refuses the line and says which item it was.
            </span>
          </span>
        </label>
      </div>

      <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Counting</div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
          Most things on a shelf are counted. A delivery charge, a repair fee or
          a service is not — it has no shelf to run out of. Every item was
          counted until now whether or not that made sense, so a shop that
          refuses sales below the count could not sell a delivery charge twice.
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={draft.stockTracked}
            onChange={(e) => setDraft({ ...draft, stockTracked: e.target.checked })} />
          <span style={{ fontSize: 12.5 }}>
            Keep a count of this item
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-3)' }}>
              Off, the counter never refuses it for being short and it never
              appears on the reorder list. It changes those two things and
              nothing else — sales are still recorded against it, so the cost
              and margin reports read the same as before.
            </span>
          </span>
        </label>
      </div>

      <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Priced at the counter</div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
          A loose item: a few clips, a length cut from a roll, a bundle of
          oddments nobody will list one by one. The sales report still shows
          what went through it.
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={draft.openPrice}
            onChange={(e) => setDraft({
              ...draft,
              openPrice: e.target.checked,
              // A bundle of anything has no shelf of its own to count.
              ...(e.target.checked ? { stockTracked: false } : {}),
            })} />
          <span style={{ fontSize: 12.5 }}>
            Ask for the amount every time it is sold
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-3)' }}>
              Anyone billing types what the customer pays, including staff who
              cannot change prices — for this item only. A bill will not take it
              at nothing. Its tax rate above is charged on every amount, so keep
              one loose item for each rate you sell at.
            </span>
          </span>
        </label>
      </div>
    </>
  )
}
