import { useRef, useState } from 'react'
import {
  planImport, applyImport, exportCatalogue, businessDate, mayAllowBelowCost, IMPORT_COLUMNS,
  type ImportPlan, type RowProblem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { saveFile } from '../core/exportFile'
import { Modal, Alert, Empty, Rupees } from './components'

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
  NO_FAMILY: 'Its variantof item is not here or in the file, or is a variant itself',
  NO_VARIANT: 'It names a variantof item but not which variant it is',
  BAD_RATE: 'The rate is not a number',
  BAD_MRP: 'The MRP is not a number',
  BAD_COST: 'The cost is not a number',
  BAD_TAX: 'The tax is not a percentage between 0 and 100',
  BAD_QTY: 'The quantity is not a number',
  BAD_HSN: 'The HSN is not 4, 6 or 8 digits',
  BARCODE_TWICE: 'That barcode and name are on another row of this file',
  NAME_TWICE: 'That name and brand are on another row, and without a barcode there is no telling them apart',
  BARCODE_TAKEN: 'That barcode already belongs to a different item here',
  BARCODE_SHARED: 'That barcode is on several items here, and none of them has this name',
  NAME_AMBIGUOUS: 'More than one item here has that name — add its brand or barcode',
  UNIT_DIFFERS: 'That barcode is an item sold in another unit here — change the unit on the item',
  BELOW_COST: 'The rate is below what the item costs — set it on the item, where the owner can allow it',
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
  /** Whether this person may sell below cost, and whether they have said to, for this file. */
  const [mayAllow, setMayAllow] = useState(false)
  const [allowBelow, setAllowBelow] = useState(false)

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
      setAllowBelow(false)
      setMayAllow(await mayAllowBelowCost(db, user.id))
      setPlan(await planImport(db, await file.text()))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That file could not be read.')
    }
  }

  async function apply() {
    if (!plan) return
    setBusy(true)
    try {
      const result = await applyImport(db, { actorId: user.id }, plan, { allowBelowCost: mayAllow && allowBelow })
      setPlan(null)
      setFileName('')
      setSaid(
        `${result.created} added, ${result.updated} updated`
        + (result.skipped > 0 ? `, ${result.skipped} skipped` : '')
        + (result.stocked > 0 ? `. Opening stock recorded for ${result.stocked} new item${result.stocked === 1 ? '' : 's'}` : '')
        + (result.stockIgnored > 0
          ? `. The opening quantity was not applied to ${result.stockIgnored} item${result.stockIgnored === 1 ? '' : 's'} already in the shop — use Stock Count to change what is on the shelf.`
          : '.'),
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

  /* Below cost is a warning, not a fault in the file: those rows are listed on
     their own, with the price and the cost, and may be let in. */
  const below = plan?.rows.filter((r) => r.problem === 'BELOW_COST' && r.belowCost) ?? []
  const skipped = plan?.rows.filter((r) => r.problem !== null && !below.includes(r)) ?? []
  const taking = plan ? plan.create + plan.update + (mayAllow && allowBelow ? below.length : 0) : 0

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
              disabled={busy || taking === 0}
              onClick={() => void apply()}
            >
              {busy ? 'Importing…' : `Import ${taking} items`}
            </button>
          </>}
        >
          {problem !== null && <Alert>{problem}</Alert>}

          <div className="stat-row">
            <div><strong>{plan.create}</strong> new</div>
            <div><strong>{plan.update}</strong> to update</div>
            {below.length > 0 && <div><strong>{below.length}</strong> below cost</div>}
            <div><strong>{skipped.length}</strong> skipped</div>
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55, marginTop: 10 }}>
            Nothing has been changed yet. Items are matched on barcode first, then on an
            exact name and brand. <strong>A blank cell leaves what is already there alone</strong> — a
            file with only name and rate is a price update, and will not wipe your HSN codes.
            A cost in the file becomes the item’s cost price, new item or not. Opening stock
            is recorded for new items only.
          </div>

          {plan.unknownColumns.length > 0 && (
            <Alert kind="warn">
              These columns will be ignored: {plan.unknownColumns.join(', ')}.
              Understood columns are {IMPORT_COLUMNS.join(', ')}.
            </Alert>
          )}

          {below.length > 0 && (
            <>
              <div style={{ fontWeight: 600, marginTop: 14, marginBottom: 6 }}>
                Priced below cost
              </div>
              <Alert kind="warn">
                {below.length === 1 ? 'This item would sell' : `These ${below.length} items would sell`} for less
                than {below.length === 1 ? 'it costs' : 'they cost'}, before GST.{' '}
                {mayAllow
                  ? 'They are left out unless you tick the box below.'
                  : 'They will be left out: only someone allowed to sell below cost, such as the owner, can import them.'}
              </Alert>
              <div className="card card-scroll" style={{ maxHeight: 200, marginTop: 6 }}>
                <table>
                  <thead><tr><th className="r">Line</th><th>Name</th><th className="r">Sells at</th><th className="r">Costs</th></tr></thead>
                  <tbody>
                    {below.map((row) => (
                      <tr key={row.line}>
                        <td className="r num">{row.line}</td>
                        <td>{row.name}</td>
                        <td className="r"><Rupees value={row.belowCost!.sellsAt} /></td>
                        <td className="r"><Rupees value={row.belowCost!.cost} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mayAllow && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <input type="checkbox" checked={allowBelow} onChange={(e) => setAllowBelow(e.target.checked)} />
                  Import {below.length === 1 ? 'this one' : `these ${below.length}`} below cost anyway
                </label>
              )}
            </>
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
