import { Field } from '../../ui/components'
import { UnitRows } from './UnitRows'
import type { Draft } from './draft'

/** The Stock tab: the units it sells in, when to buy more, and whether it is counted at all. */
export function StockSection({ draft, setDraft }: { draft: Draft; setDraft: (draft: Draft) => void }) {
  return (
    <>
      <UnitRows draft={draft} setDraft={setDraft} />

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
    </>
  )
}
