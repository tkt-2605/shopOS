import { useRef, useState } from 'react'
import {
  planImport, applyImport, exportCatalogue, businessDate,
  planCustomerImport, applyCustomerImport, exportCustomers, recordOpeningBalance,
  planSupplierImport, applySupplierImport, exportSuppliers,
  type ImportPlan, type RowProblem, type CustomerPlan, type CustomerRowProblem,
  type SupplierPlan, type SupplierRowProblem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { saveFile } from '../core/exportFile'
import { Modal, Alert, Empty } from './components'

/**
 * The catalogue, in and out of a spreadsheet.
 *
 * Onboarding a shop used to mean typing two thousand items at the counter.
 * That is not a slow start; it is a reason not to buy.
 *
 * ## Nothing happens until the shopkeeper has seen what will happen
 *
 * Choosing a file shows counts and the reason for every row that will be
 * skipped. It writes nothing. A second button applies it.
 *
 * The two failures worth this much ceremony are silently creating four
 * hundred duplicates, and silently changing the price of everything in the
 * shop. Both are invisible at the moment they happen and expensive a week
 * later, and neither is recoverable by a person who did not know it had
 * occurred.
 */

const WHY: Record<RowProblem, string> = {
  NO_NAME: 'No name',
  BAD_RATE: 'The rate is not a number',
  BAD_MRP: 'The MRP is not a number',
  BAD_TAX: 'The tax is not a percentage between 0 and 100',
  BAD_QTY: 'The quantity is not a number',
  BAD_HSN: 'The HSN is not 4, 6 or 8 digits',
  BARCODE_TWICE: 'That barcode is on another row of this file',
  NAME_TWICE: 'That name is on another row of this file',
  BARCODE_TAKEN: 'That barcode already belongs to a different item here',
}

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

export function CatalogueFile({ onDone }: { onDone: () => void | Promise<void> }) {
  const { db } = useCore()
  const user = useUser()
  const picker = useRef<HTMLInputElement>(null)

  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function download() {
    const csv = await exportCatalogue(db)
    const saved = await saveFile(`catalogue-${businessDate()}.csv`, csv)
    setSaid(saved.ok ? `Saved to ${saved.path}` : saved.message)
  }

  async function chosen(file: File | undefined) {
    if (!file) return
    setProblem(null)
    setSaid(null)
    setFileName(file.name)
    try {
      /* Read in the webview rather than through Rust: this is a file the
         person just picked in a dialog, it is text, and it never touches the
         database until `apply`. */
      setPlan(await planImport(db, await file.text()))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That file could not be read.')
    }
  }

  async function apply() {
    if (!plan) return
    setBusy(true)
    try {
      const result = await applyImport(db, { actorId: user.id }, plan)
      setPlan(null)
      setFileName('')
      setSaid(
        `${result.created} added, ${result.updated} updated`
        + (result.skipped > 0 ? `, ${result.skipped} skipped` : '.'),
      )
      await onDone()
    } catch (err) {
      /* One transaction, so nothing landed. Say so, because "the import
         failed" leaves somebody wondering whether half of it went in. */
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
        ref={picker}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={(e) => {
          void chosen(e.target.files?.[0])
          // Cleared, so picking the same file twice in a row still fires.
          e.target.value = ''
        }}
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
              {busy ? 'Importing…' : `Import ${plan.create + plan.update} items`}
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
            Nothing has been changed yet. Items are matched on barcode first, then on an
            exact name. <strong>A blank cell leaves what is already there alone</strong> — a
            file with only name and rate is a price update, and will not wipe your HSN codes.
          </div>

          {plan.unknownColumns.length > 0 && (
            <Alert kind="warn">
              These columns will be ignored: {plan.unknownColumns.join(', ')}.
              Understood columns are name, barcode, hsn, tax, unit, rate, mrp, openingqty.
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
                        {/* The line number Excel shows down the side, so the
                            shopkeeper can go straight to it. */}
                        <td className="r num">{row.line}</td>
                        <td>{row.name || <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                        <td>{row.problem === null ? '' : WHY[row.problem]}</td>
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
      for (const row of result.opening) {
        const outcome = await recordOpeningBalance(db, {
          customerId: row.customerId, amount: row.amount, registerId, actorId: user.id,
        })
        if (outcome.ok) posted += 1
        else already += 1
      }

      setPlan(null)
      setFileName('')
      setSaid(
        `${result.created} added, ${result.updated} updated`
        + (result.skipped > 0 ? `, ${result.skipped} skipped` : '')
        + (posted > 0 ? `, ${posted} opening balances recorded` : '')
        + (already > 0 ? `, ${already} already had one` : '')
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
