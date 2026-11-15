import type { Draft } from './draft'

/** The Rules tab: what a discount, loyalty or a return may not do to this item, and pricing it at the counter. */
export function RulesSection({ draft, setDraft }: { draft: Draft; setDraft: (draft: Draft) => void }) {
  return (
    <>
      <div>
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
