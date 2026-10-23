import { useRef, useState } from 'react'
import {
  exportLadders, planLadderImport, applyLadderImport, businessDate, LADDER_COLUMNS, Quantity,
  type LadderPlan, type LadderProblem, type PlannedLadder,
} from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { saveFile } from '../../core/exportFile'
import { useConfirm } from '../../ui/useConfirm'
import { belowCostLines } from '../../ui/belowCost'
import { Modal, Alert, Empty } from '../../ui/components'

/**
 * Special prices in and out of a spreadsheet, one row per price.
 *
 * As with the catalogue, choosing a file changes nothing: it shows what each
 * ladder will become and every row it cannot take, and only the Import button
 * writes. A price below cost is handed back rather than written, and asked
 * about once, of somebody who may allow it.
 */

const WHY: Record<LadderProblem, string> = {
  NO_ITEM: 'No item name or barcode',
  UNKNOWN_ITEM: 'No item here has that name or barcode',
  ITEM_AMBIGUOUS: 'More than one item has that name or barcode; add the barcode',
  UNKNOWN_LIST: 'No price list has that name',
  UNKNOWN_CUSTOMER: 'No customer has that name',
  CUSTOMER_AMBIGUOUS: 'More than one customer has that name',
  LIST_AND_CUSTOMER: 'A row is for a price list or a customer, not both',
  BAD_QTY: 'The quantity is not a number',
  BAD_RATE: 'The rate is not an amount',
  BAD_DATE: 'A date cannot be read; write it as 2026-12-31',
  DATES_DIFFER: 'The rows for this item give different dates',
  REPEATED_QTY: 'That quantity is given twice for this item',
  EVERYONE_NEEDS_QTY: 'With no list or customer this is the item’s own break; give a quantity above 1 (the price of one is its selling rate)',
  LADDER_SKIPPED: 'Another row for this item is wrong, so none of its rows were taken',
}

const who = (l: PlannedLadder) =>
  l.target.kind === 'everyone' ? 'Everyone (quantity breaks)' : l.target.name

export function LadderFile({ canWrite, onDone }: { canWrite: boolean; onDone: () => void | Promise<void> }) {
  const { db } = useCore()
  const user = useUser()
  const [confirmUi, ask] = useConfirm()
  const picker = useRef<HTMLInputElement>(null)
  const [plan, setPlan] = useState<LadderPlan | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function download() {
    const saved = await saveFile(`special-prices-${businessDate()}.csv`, await exportLadders(db))
    setSaid(saved.ok ? `Saved to ${saved.path}` : saved.message)
  }

  async function chosen(file: File | undefined) {
    if (!file) return
    setProblem(null)
    setSaid(null)
    setFileName(file.name)
    try {
      setPlan(await planLadderImport(db, await file.text()))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That file could not be read.')
    }
  }

  async function apply() {
    if (!plan) return
    setBusy(true)
    try {
      const ctx = { actorId: user.id }
      const first = await applyLadderImport(db, ctx, plan.ladders)
      let written = first.written
      let left = first.belowCost.length
      if (left > 0 && first.belowCost[0]!.refusal.mayAllow) {
        const lines = belowCostLines(first.belowCost.flatMap((b) => b.refusal.lines))
        if (await ask(`${left === 1 ? 'One price is' : `${left} prices are`} below cost:\n\n${lines}\n\nImport ${left === 1 ? 'it' : 'them'} anyway? It is recorded.`)) {
          written += (await applyLadderImport(db, ctx, first.belowCost.map((b) => b.ladder), { allowBelowCost: true })).written
          left = 0
        }
      }
      setPlan(null)
      setSaid(
        `${written} price${written === 1 ? '' : 's'} imported`
        + (first.cleared > 0 ? `, ${first.cleared} taken off` : '')
        + (left > 0 ? `. ${left} below cost were left as they were` : '')
        + (first.failed.length > 0 ? `. ${first.failed.length} could not be written (a unit the item does not sell in)` : '')
        + (plan.problems.length > 0 ? `. ${plan.problems.length} row${plan.problems.length === 1 ? ' was' : 's were'} skipped` : '')
        + '.',
      )
      await onDone()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The import failed.')
    } finally {
      setBusy(false)
    }
  }

  const count = (c: PlannedLadder['change']) => plan?.ladders.filter((l) => l.change === c).length ?? 0
  const toWrite = (plan?.ladders.length ?? 0) - count('same')

  return (
    <>
      {confirmUi}
      <button className="btn" onClick={() => void download()}>Export to CSV</button>
      {canWrite && <button className="btn" onClick={() => picker.current?.click()}>Import from CSV</button>}
      <input ref={picker} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
        onChange={(e) => { void chosen(e.target.files?.[0]); e.target.value = '' }} />

      {(said !== null || (problem !== null && plan === null)) && (
        <div style={{ flexBasis: '100%' }}>
          {said !== null && <Alert kind="ok">{said}</Alert>}
          {problem !== null && plan === null && <Alert>{problem}</Alert>}
        </div>
      )}

      {plan !== null && (
        <Modal
          title={`Import ${fileName}`}
          wide
          onClose={() => setPlan(null)}
          footer={<>
            <button className="btn" onClick={() => setPlan(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || toWrite === 0} onClick={() => void apply()}>
              {busy ? 'Importing…' : `Import ${toWrite} price${toWrite === 1 ? '' : 's'}`}
            </button>
          </>}
        >
          {problem !== null && <Alert>{problem}</Alert>}
          <div className="stat-row">
            <div><strong>{count('new')}</strong> new</div>
            <div><strong>{count('change')}</strong> changed</div>
            <div><strong>{count('clear')}</strong> taken off</div>
            <div><strong>{count('same')}</strong> the same</div>
            <div><strong>{plan.problems.length}</strong> rows skipped</div>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55, marginTop: 10 }}>
            Nothing has been changed yet. Each item’s rows for a list or a customer replace what it has there now;
            items the file does not mention are left alone. A row with no list and no customer is the item’s own
            quantity break.
          </div>
          {plan.unknownColumns.length > 0 && (
            <Alert kind="warn">
              These columns will be ignored: {plan.unknownColumns.join(', ')}. Understood columns are {LADDER_COLUMNS.join(', ')}.
            </Alert>
          )}
          {toWrite > 0 && (
            <>
              <div style={{ fontWeight: 600, marginTop: 14, marginBottom: 6 }}>What changes</div>
              <div className="card card-scroll" style={{ maxHeight: 220 }}>
                <table>
                  <thead><tr><th>Item</th><th>For</th><th>Unit</th><th>Prices</th></tr></thead>
                  <tbody>
                    {plan.ladders.filter((l) => l.change !== 'same').map((l) => (
                      <tr key={l.key}>
                        <td>{l.productName}</td>
                        <td>{who(l)}</td>
                        <td>{l.saleUnit}</td>
                        <td className="num" style={{ fontSize: 12 }}>
                          {l.change === 'clear' ? 'taken off' : l.rungs.map((r) => `${r.minQty > 0 ? `${Quantity.formatQty(r.minQty)}+ ` : ''}₹${(r.rate / 100).toFixed(2)}`).join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {plan.problems.length > 0 && (
            <>
              <div style={{ fontWeight: 600, marginTop: 14, marginBottom: 6 }}>Rows that will be skipped</div>
              <div className="card card-scroll" style={{ maxHeight: 220 }}>
                <table>
                  <thead><tr><th className="r">Line</th><th>Item</th><th>Why</th></tr></thead>
                  <tbody>
                    {plan.problems.map((p) => (
                      <tr key={`${p.line}-${p.problem}`}>
                        <td className="r num">{p.line}</td>
                        <td>{p.item || <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                        <td>{WHY[p.problem]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {plan.rows === 0 && <Empty>That file has no rows in it.</Empty>}
        </Modal>
      )}
    </>
  )
}
