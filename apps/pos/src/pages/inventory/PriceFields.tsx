import type { CostHint } from '@shopos/core'
import { costNote } from '../../ui/costNote'
import { Field } from '../../ui/components'
import { GstSwitch, useGstMode, COST_ENTRY, RATE_ENTRY } from '../../ui/GstSwitch'
import type { Side } from '../../ui/gstPair'
import type { Draft } from './draft'
import { otherSide, shown } from './prices'

/*
 * The selling rate and the cost price, each with its own Excl. GST / Incl. GST
 * switch: a shelf price is said with GST and a supplier's quote often without,
 * and the one person types both off different papers. The cost switch is the
 * one Stock In and purchase orders use, so a desk that types costs with GST
 * there types them with GST here too.
 *
 * Flipping a switch shows the figure the other way and changes nothing; typing
 * in a box keeps what was typed and on which side (`prices.ts`).
 */
export function PriceFields({ draft, setDraft, lastCost }: {
  draft: Draft
  setDraft: (draft: Draft) => void
  lastCost: CostHint | null
}) {
  const [rateMode, setRateMode] = useGstMode(RATE_ENTRY)
  const [costMode, setCostMode] = useGstMode(COST_ENTRY)
  const unit = draft.baseUnit || 'unit'
  const side = (mode: Side) => (mode === 'with' ? 'with GST' : 'before GST')
  const rateOther = otherSide(draft, draft.baseRate, draft.rateSide, rateMode)
  const costOther = otherSide(draft, draft.costPrice, draft.costSide, costMode)

  return (
    <>
      <Field
        label="Selling rate"
        aside={<GstSwitch mode={rateMode} onChange={setRateMode} label="Selling rate is" />}
        hint={`Per ${unit}, ${side(rateMode)}.${rateOther ? ` ${rateOther}.` : ''}`}
      >
        <input className="input num" id="p-rate" value={shown(draft, draft.baseRate, draft.rateSide, rateMode)}
          onChange={(e) => setDraft({ ...draft, baseRate: e.target.value, rateSide: rateMode })} />
      </Field>
      <Field
        label="MRP"
        hint="The price printed on the packet, with GST. Leave blank if there is none. When it is
              above the selling rate, the receipt shows it and what the customer saved."
      >
        <input className="input num" id="p-mrp" value={draft.mrp}
          onChange={(e) => setDraft({ ...draft, mrp: e.target.value })} />
      </Field>
      {/* A default for whoever types a cost next, not the item's value: stock
          is valued from what each delivery cost, so a wrong figure here can
          only ever be a wrong suggestion. */}
      <Field
        label="Cost price"
        aside={<GstSwitch mode={costMode} onChange={setCostMode} label="Cost price is" />}
        hint={(lastCost
          ? `Per ${unit}, ${side(costMode)}. Latest, before GST: ${costNote(lastCost)}.`
          : `What one ${unit} costs you, ${side(costMode)}. Fills in Stock In and purchase orders until you have bought it in.`)
          + (costOther ? ` ${costOther}.` : '')}
      >
        <input className="input num" id="p-cost" placeholder="Not set"
          value={shown(draft, draft.costPrice, draft.costSide, costMode)}
          onChange={(e) => setDraft({ ...draft, costPrice: e.target.value, costSide: costMode })} />
      </Field>
    </>
  )
}
