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
}: {
  rows: LadderRow[]
  onChange: (rows: LadderRow[]) => void
  /** What one of the quantities is — "piece", "kg", "box". */
  unit: string
  disabled?: boolean
}) {
  const patch = (index: number, change: Partial<LadderRow>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...change } : r)))

  const parsed = Ladder.rowsToRungs(rows)
  const problem = describeRowsProblem(parsed, unit)
  const rising = parsed.ok ? Ladder.risingRungs(parsed.rungs) : []

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
