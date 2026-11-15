import type { CostHint } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Alert } from '../../ui/components'
import { LadderEditor } from '../../ui/LadderEditor'
import { PriceFields } from './PriceFields'
import { TaxFields } from './TaxFields'
import { PricesElsewhere } from './PricesElsewhere'
import type { Draft } from './draft'

/**
 * The Price & tax tab: the selling rate, MRP, cost and tax, then whatever the
 * shop has switched on -- quantity breaks, the prices this item has on other
 * lists. A shop with neither on sees the price and tax boxes and nothing else.
 */
export function PriceSection({ draft, setDraft, lastCost, familyPriced }: {
  draft: Draft
  setDraft: (draft: Draft) => void
  /** The last price actually paid for this item, from a delivery or opening stock. */
  lastCost: CostHint | null
  /** The item has variants and they take its price (`variants.ts`). */
  familyPriced: boolean
}) {
  const { features } = useCore()
  return (
    <>
      {familyPriced && (
        <Alert kind="ok">One price for the family: every variant takes the price, MRP, tax and cost set here.</Alert>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <PriceFields draft={draft} setDraft={setDraft} lastCost={lastCost} />
        <TaxFields draft={draft} setDraft={setDraft} />
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
    </>
  )
}
