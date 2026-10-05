import { useRef, useState } from 'react'
import {
  businessDate, planCustomerImport, applyCustomerImport, exportCustomers, recordOpeningBalance,
  type CustomerPlan, type CustomerRowProblem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { saveFile } from '../core/exportFile'
import { Modal, Alert, Empty } from './components'

const WHY_CUSTOMER: Record<CustomerRowProblem, string> = {
  NO_NAME: 'No name',
  BAD_GSTIN: 'That is not a GSTIN',
  BAD_STATE: 'That is not a state code',
  BAD_LIMIT: 'The credit limit is not a number',
  BAD_OPENING: 'The opening balance is not a number',
  CODE_TWICE: 'That code is on another row of this file',
  PHONE_TWICE: 'That phone number is on another row of this file',
  NAME_TWICE: 'That name is on another row, and neither row has a code or a phone',
  CODE_TAKEN: 'That code and that phone belong to two different people here',
}

/**
 * The customer book, in and out of a spreadsheet.
 *
 * The same shape as the catalogue above and deliberately not generalised into
 * one component: the wording differs on every line that matters, the matching
 * rules are different, and one of them has an opening balance to post
 * afterwards. A shared version would be a component with two of everything
 * and a flag, which is harder to read than both of these.
 */
export function CustomerFile({ onDone }: { onDone: () => void | Promise<void> }) {
  const { db, registerId } = useCore()
  const user = useUser()
  const picker = useRef<HTMLInputElement>(null)

  const [plan, setPlan] = useState<CustomerPlan | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function download() {
    const saved = await saveFile(`customers-${businessDate()}.csv`, await exportCustomers(db))
    setSaid(saved.ok ? `Saved to ${saved.path}` : saved.message)
  }

  async function chosen(file: File | undefined) {
    if (!file) return
    setProblem(null)
    setSaid(null)
    setFileName(file.name)
    try {
      setPlan(await planCustomerImport(db, await file.text()))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That file could not be read.')
    }
  }

  async function apply() {
    if (!plan) return
    setBusy(true)
    try {
      const result = await applyCustomerImport(db, { actorId: user.id }, plan)

      /* Posted here rather than inside the import, because an opening balance
         is a document and raising one needs a register -- which this screen
         has and a service reading a file does not. Each is its own call, so
         one that is refused because the customer already has one does not
         take the rest of the file with it. */
      let posted = 0
      let already = 0
      let closed = 0
      for (const row of result.opening) {
        const outcome = await recordOpeningBalance(db, {
          customerId: row.customerId, amount: row.amount, registerId, actorId: user.id,
        })
        if (outcome.ok) posted += 1
        else if (outcome.code === 'PERIOD_CLOSED') closed += 1
        else already += 1
      }

      setPlan(null)
      setFileName('')
      setSaid(
        `${result.created} added, ${result.updated} updated`
        + (result.skipped > 0 ? `, ${result.skipped} skipped` : '')
        + (posted > 0 ? `, ${posted} opening balances recorded` : '')
        + (already > 0 ? `, ${already} already had one` : '')
        + (closed > 0 ? `, ${closed} not recorded because the books are closed for today` : '')
        + '.',
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
              {busy ? 'Importing…' : `Import ${plan.create + plan.update} customers`}
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
            Nothing has been changed yet. People are matched on customer code first, then
            phone, then an exact name — and on name only when the row has neither of the
            others, because two people called Kumar are two people.{' '}
            <strong>A blank cell leaves what is already there alone.</strong>
          </div>

          {plan.withOpening > 0 && (
            <Alert kind="warn">
              {plan.withOpening} {plan.withOpening === 1 ? 'row carries' : 'rows carry'} an
              opening balance, which will be recorded against this counter. A minus means the
              shop is holding their money. Anyone who already has one is left alone.
            </Alert>
          )}

          {plan.unknownColumns.length > 0 && (
            <Alert kind="warn">
              These columns will be ignored: {plan.unknownColumns.join(', ')}.
              Understood columns are name, code, phone, email, gstin, address, state,
              creditlimit, opening.
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
                        <td>{row.problem === null ? '' : WHY_CUSTOMER[row.problem]}</td>
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
