import type { Category } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Field } from '../../ui/components'
import { ProductPhotoBox } from '../../ui/ProductPhotoBox'
import { RenameUnit } from './RenameUnit'
import type { Draft } from './draft'

/**
 * The Item tab: what the item is called, what group it is in, what it is
 * counted in, its barcodes and its photo. The rest of the old form is on the
 * page's other tabs.
 */
export function ItemSection({
  draft, setDraft, categories, newCategory, setNewCategory, onAddCategory, variantCount,
}: {
  draft: Draft
  setDraft: (draft: Draft) => void
  categories: Category[]
  newCategory: string
  setNewCategory: (name: string) => void
  onAddCategory: () => void
  /** How many variants the item has: its barcodes are then theirs, edited on the Variants tab. */
  variantCount: number
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
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 200px', gap: 24, alignItems: 'start' }}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Name">
            <input className="input" id="p-name" autoFocus value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Brand">
            <input className="input" id="p-brand" value={draft.brand}
              onChange={(e) => setDraft({ ...draft, brand: e.target.value })} />
          </Field>
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
                style={{ width: 130 }} onChange={(e) => setNewCategory(e.target.value)} />
              <button className="btn" type="button" disabled={newCategory.trim() === ''}
                onClick={onAddCategory}>Add</button>
            </div>
          </Field>
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

        <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Barcodes</div>
          {variantCount > 0 ? (
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              This item&rsquo;s barcode is on its {variantCount} variants, so scanning it asks which one.
              Change a variant&rsquo;s barcode on the Variants tab.
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>{draft.id && <ProductPhotoBox productId={draft.id} name={draft.name} compact />}</div>
    </div>
  )
}
