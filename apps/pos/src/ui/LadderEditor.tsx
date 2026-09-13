import { Ladder } from '@shopos/core'

/**
 * A quantity ladder, one rung per row, two boxes each.
 *
 * There was a single text box here that took `1=15, 10=12, 20=11`. It was
 * quicker to type and wrong for the job: the person setting prices in a shop is
 * often not the one who invented the notation, and a misplaced comma is a week
 * of selling at the wrong price with nothing on screen to say so. Two labelled
 * boxes cannot be mistyped into a different shape — at worst a number is wrong,
 * and a wrong number is visible.
 *
 * With `breaks` off — a shop that has not turned quantity breaks on — this is
 * one price box and nothing else. Any rungs above the first stay in the array
 * untouched and are saved back as they were, so switching the feature off and
 * editing an item does not quietly throw a ladder away.
 *
 * What the rows mean, and what is wrong with them, is decided in
 * `domain/ladder.ts` where it can be tested. This is the boxes.
 */

export type LadderRow = Ladder.LadderRow

export function describeRowsProblem(result: Ladder.RowsResult, unit: string): string | null {
  if (result.ok) return null
  const row = result.index + 1
  switch (result.code) {
    case 'HALF_ROW':
      return `Row ${row} needs both a quantity and a price.`
    case 'BAD_QTY':
      return `Row ${row} does not have a usable quantity of ${unit}.`
    case 'BAD_RATE':
      return `Row ${row} does not have a usable price.`
    case 'REPEATED_QTY':
      return `Row ${row} repeats a quantity that is already there.`
  }
}

export function LadderEditor({
  rows,
  onChange,
  unit,
  disabled = false,
  breaks = true,
}: {
  rows: LadderRow[]
  onChange: (rows: LadderRow[]) => void
  /** What one of the quantities is — "piece", "kg", "box". */
  unit: string
  disabled?: boolean
  /** Whether this shop prices by the quantity at all. */
  breaks?: boolean
}) {
  const patch = (index: number, change: Partial<LadderRow>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...change } : r)))

  const parsed = Ladder.rowsToRungs(rows)
  const problem = describeRowsProblem(parsed, unit)
  const rising = parsed.ok ? Ladder.risingRungs(parsed.rungs) : []

  if (!breaks) return <OnePrice rows={rows} onChange={onChange} disabled={disabled} />

  return (
    <div>
      {rows.length > 0 && (
        <div className="ladder-head">
          <span>Buy this many or more</span>
          <span>Price each</span>
          <span />
        </div>
      )}

      {rows.map((row, index) => (
        <div className="ladder-row" key={index}>
          <div className="ladder-cell">
            <input
              className="input num"
              inputMode="decimal"
              placeholder={index === 0 ? '1' : ''}
              value={row.minQty}
              disabled={disabled}
              onChange={(e) => patch(index, { minQty: e.target.value })}
            />
            <span className="ladder-unit">{unit}</span>
          </div>
          <div className="ladder-cell">
            <span className="ladder-unit">₹</span>
            <input
              className="input num"
              inputMode="decimal"
              value={row.rate}
              disabled={disabled}
              onChange={(e) => patch(index, { rate: e.target.value })}
            />
          </div>
          <button
            className="btn ghost"
            type="button"
            title="Remove this price break"
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >✕</button>
        </div>
      ))}

      <button
        className="btn ghost sm"
        type="button"
        disabled={disabled}
        onClick={() => onChange([...rows, { minQty: rows.length === 0 ? '1' : '', rate: '' }])}
      >
        {rows.length === 0 ? 'Add a price' : 'Add a price break'}
      </button>

      {problem && <div className="ladder-note bad">{problem}</div>}

      {!problem && rising.length > 0 && (
        <div className="ladder-note warn">
          This charges more for buying more. Check it is what you meant.
        </div>
      )}

      {!problem && rising.length === 0 && parsed.ok && parsed.rungs.length > 0 && (
        <div className="ladder-note">{Ladder.describeLadder(parsed.rungs)}</div>
      )}
    </div>
  )
}

/**
 * One box, for a shop that prices a thing at one price.
 *
 * It edits the first rung and leaves any others exactly where they are: a shop
 * that turns quantity breaks off and then edits an item has not asked to lose
 * the ladder it wrote, only to stop being shown it.
 */
function OnePrice({
  rows, onChange, disabled,
}: { rows: LadderRow[]; onChange: (rows: LadderRow[]) => void; disabled: boolean }) {
  const first = rows[0] ?? { minQty: '1', rate: '' }
  const hidden = Math.max(0, rows.length - 1)

  const set = (rate: string) =>
    onChange(rows.length === 0
      ? (rate.trim() === '' ? [] : [{ minQty: '1', rate }])
      : rows.map((r, i) => (i === 0 ? { ...r, rate } : r)))

  return (
    <div>
      <div className="ladder-cell">
        <span className="ladder-unit">₹</span>
        <input
          className="input num"
          inputMode="decimal"
          placeholder="Leave empty for the base rate"
          value={first.rate}
          disabled={disabled}
          onChange={(e) => set(e.target.value)}
        />
      </div>
      {hidden > 0 && (
        <div className="ladder-note">
          {hidden === 1 ? 'One price break is' : `${hidden} price breaks are`} saved against this item
          and kept. Turn on quantity price breaks in Settings to see {hidden === 1 ? 'it' : 'them'}.
        </div>
      )}
    </div>
  )
}
