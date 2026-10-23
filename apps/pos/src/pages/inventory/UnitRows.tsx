import { useCore } from '../../core/CoreProvider'
import type { Draft, UnitDraft } from './draft'

/**
 * The units an item also sells in, and -- with "Box prices and MRP" on --
 * what each is printed and sold at.
 *
 * An empty MRP or price says so in its placeholder: the box reads as its
 * pieces, and the price box shows what that comes to, so nobody is surprised
 * by ₹90 for a box of ten pens at ₹10 that reach the ten-or-more break.
 */
export function UnitRows({ draft, setDraft }: { draft: Draft; setDraft: (draft: Draft) => void }) {
  const { features } = useCore()
  const base = draft.baseUnit || 'units'
  const change = (index: number, patch: Partial<UnitDraft>) => setDraft({
    ...draft,
    units: draft.units.map((u, i) => (i === index ? { ...u, ...patch } : u)),
  })

  return (
    <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>
        Units it also sells in
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
        Stock is counted in {draft.baseUnit || 'the base unit'}. A bigger unit says how many of
        those it holds — a ream is 500 sheets, a pack of pens is 10. The cashier then picks the
        unit at the counter.{' '}
        {features.unitPrices
          ? <>Give a unit its own MRP and price when they are printed on it; leave them empty and it is its {base}.</>
          : <>It is priced as its {base}: the selling rate times how many it holds.</>}
      </div>
      {features.unitPrices && draft.units.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 4, fontSize: 11.5, color: 'var(--ink-3)' }}>
          <span style={{ flex: 1 }}>Unit</span>
          <span style={{ width: 90 + 6 + 40 }}>Holds</span>
          <span style={{ width: 90 }}>MRP</span>
          <span style={{ width: 110 }}>Sells at</span>
          <span style={{ width: 30 }} />
        </div>
      )}
      {draft.units.map((unit, index) => (
        <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder="ream, pack, dozen, box"
            aria-label="Unit"
            value={unit.saleUnit}
            onChange={(e) => change(index, { saleUnit: e.target.value })}
          />
          <span style={{ fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>=</span>
          <input
            className="input num"
            style={{ width: 90 }}
            inputMode="decimal"
            placeholder="500"
            aria-label={`How many ${base} in a ${unit.saleUnit || 'unit'}`}
            value={unit.baseUnits}
            onChange={(e) => change(index, { baseUnits: e.target.value })}
          />
          <span style={{ fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap', width: features.unitPrices ? 34 : undefined }}>
            {base}
          </span>
          {features.unitPrices && (
            <>
              <input
                className="input num"
                style={{ width: 90 }}
                inputMode="decimal"
                placeholder="none"
                aria-label={`MRP of a ${unit.saleUnit || 'unit'}`}
                value={unit.mrp ?? ''}
                onChange={(e) => change(index, { mrp: e.target.value })}
              />
              <input
                className="input num"
                style={{ width: 110 }}
                inputMode="decimal"
                placeholder={unit.asPieces ? `${unit.asPieces} as ${base}` : `as its ${base}`}
                aria-label={`Price of a ${unit.saleUnit || 'unit'}`}
                value={unit.rate ?? ''}
                onChange={(e) => change(index, { rate: e.target.value })}
              />
            </>
          )}
          <button className="btn ghost" type="button" title="Remove this unit"
            onClick={() => setDraft({ ...draft, units: draft.units.filter((_, i) => i !== index) })}
          >✕</button>
        </div>
      ))}
      <button className="btn ghost sm" type="button"
        onClick={() => setDraft({ ...draft, units: [...draft.units, { saleUnit: '', baseUnits: '' }] })}
      >Another unit</button>
    </div>
  )
}
