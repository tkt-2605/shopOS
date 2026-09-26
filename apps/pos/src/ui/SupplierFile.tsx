import { useRef, useState } from 'react'
import {
  businessDate, planSupplierImport, applySupplierImport, exportSuppliers, type SupplierPlan,
  type SupplierRowProblem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { saveFile } from '../core/exportFile'
import { Modal, Alert, Empty } from './components'

const WHY_SUPPLIER: Record<SupplierRowProblem, string> = {
  NO_NAME: 'No name',
  BAD_GSTIN: 'That is not a GSTIN',
  BAD_OPENING: 'The balance carried over is not a number',
  BAD_DATE: 'The date is not YYYY-MM-DD',
  GSTIN_TWICE: 'That GSTIN is on another row of this file',
  PHONE_TWICE: 'That phone number is on another row of this file',
  NAME_TWICE: 'That name is on another row of this file',
  GSTIN_TAKEN: 'That GSTIN and that phone belong to two different suppliers here',
}

/**
 * The supplier list, in and out of a spreadsheet.
 *
 * The one real difference from the other two: the balance carried over is
 * written by the import itself, because a supplier's is a column rather than
 * a document. No register to choose, nothing to post afterwards.
 */
export function SupplierFile({ onDone }: { onDone: () => void | Promise<void> }) {
  const { db } = useCore()
  const user = useUser()
  const picker = useRef<HTMLInputElement>(null)

  const [plan, setPlan] = useState<SupplierPlan | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function download() {
    const saved = await saveFile(`suppliers-${businessDate()}.csv`, await exportSuppliers(db))
    setSaid(saved.ok ? `Saved to ${saved.path}` : saved.message)
  }

  async function chosen(file: File | undefined) {
    if (!file) return
    setProblem(null)
    setSaid(null)
    setFileName(file.name)
    try {
      setPlan(await planSupplierImport(db, await file.text()))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That file could not be read.')
    }
  }

  async function apply() {
    if (!plan) return
    setBusy(true)
    try {
      const result = await applySupplierImport(db, { actorId: user.id }, plan)
      setPlan(null)
      setFileName('')
      setSaid(
        `${result.created} added, ${result.updated} updated`
        + (result.skipped > 0 ? `, ${result.skipped} skipped` : '') + '.',
      )
      await onDone()
    } catch (err) {
      setProblem(
        `${err instanceof Error ? err.message : 'The import failed'} — nothing was changed.`,
      )
    } finally {
      setBusy(false)
    }
  }

  const skipped = plan?.rows.filter((r) => r.problem !== null) ?? []

  return (
    <>
      <button className="btn" onClick={() => void download()}>Export to CSV</button>
      <button className="btn" onClick={() => picker.current?.click()}>Import from CSV</button>
      <input
        ref={picker} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
        onChange={(e) => { void chosen(e.target.files?.[0]); e.target.value = '' }}
      />

      {said !== null && <Alert kind="ok">{said}</Alert>}
      {problem !== null && plan === null && <Alert>{problem}</Alert>}

      {plan !== null && (
        <Modal
          title={`Import ${fileName}`}
          wide
          onClose={() => { setPlan(null); setProblem(null) }}
          footer={<>
            <button className="btn" onClick={() => { setPlan(null); setProblem(null) }}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || plan.create + plan.update === 0}
              onClick={() => void apply()}
            >
              {busy ? 'Importing…' : `Import ${plan.create + plan.update} suppliers`}
            </button>
          </>}
        >
          {problem !== null && <Alert>{problem}</Alert>}

          <div className="stat-row">
            <div><strong>{plan.create}</strong> new</div>
            <div><strong>{plan.update}</strong> to update</div>
            <div><strong>{plan.skip}</strong> skipped</div>
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55, marginTop: 10 }}>
            Nothing has been changed yet. Suppliers are matched on GSTIN first, then phone,
            then an exact name. <strong>A blank cell leaves what is already there alone.</strong>
          </div>

          {plan.withOpening > 0 && (
            <Alert kind="warn">
              {plan.withOpening} {plan.withOpening === 1 ? 'row sets' : 'rows set'} a balance
              carried over. A minus means they are holding the shop&rsquo;s money, from an
              advance already paid. This replaces whatever is recorded now.
            </Alert>
          )}

          {plan.unknownColumns.length > 0 && (
            <Alert kind="warn">
              These columns will be ignored: {plan.unknownColumns.join(', ')}.
              Understood columns are name, phone, gstin, address, opening, openingasof.
            </Alert>
          )}

          {skipped.length > 0 && (
            <>
              <div style={{ fontWeight: 600, marginTop: 14, marginBottom: 6 }}>
                Rows that will be skipped
              </div>
              <div className="card card-scroll" style={{ maxHeight: 240 }}>
                <table>
                  <thead><tr><th className="r">Line</th><th>Name</th><th>Why</th></tr></thead>
                  <tbody>
                    {skipped.map((row) => (
                      <tr key={row.line}>
                        <td className="r num">{row.line}</td>
                        <td>{row.name || <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                        <td>{row.problem === null ? '' : WHY_SUPPLIER[row.problem]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {plan.rows.length === 0 && <Empty>That file has no rows in it.</Empty>}
        </Modal>
      )}
    </>
  )
}
