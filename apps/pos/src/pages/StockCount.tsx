import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  openCount, loadCount, listCounts, setCounted, submitCount, cancelCount,
  Quantity, Permissions,
  type CountSheet, type CountSummary, type SubmitCountResult,
} from '@shopos/core'
import { useCore, useDb, useUser } from '../core/CoreProvider'
import { Card, Modal, Empty, Alert, Rupees } from '../ui/components'

/**
 * Counting the shelves.
 *
 * The screen is built around one uncomfortable fact: a counter who can see that
 * the system says fourteen will write fourteen. So the expected quantity is
 * hidden while the counting happens and the difference appears the moment a
 * number is entered — blind where it matters, and immediate feedback where that
 * helps, so a wrong line can be recounted while the person is still standing at
 * the shelf.
 *
 * The shop does not stop selling meanwhile. What is posted is the difference
 * found, not the number counted; see `stockCount.ts`.
 */

type Phase = { kind: 'none' } | { kind: 'sheet'; sheet: CountSheet } | { kind: 'done'; result: SubmitCountResult }

export default function StockCount() {
  const db = useDb()
  const user = useUser()
  const { registerName } = useCore()
  const [phase, setPhase] = useState<Phase>({ kind: 'none' })
  const [history, setHistory] = useState<CountSummary[]>([])
  const [term, setTerm] = useState('')
  const [showExpected, setShowExpected] = useState(false)
  const [onlyPending, setOnlyPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canCount = Permissions.can(user.permissions, 'stock_entry', 'submit')

  const refresh = useCallback(async () => {
    const counts = await listCounts(db, 30)
    setHistory(counts)
    const open = counts.find((c) => c.docstatus === 0)
    if (open) {
      const sheet = await loadCount(db, open.id)
      if (sheet) { setPhase({ kind: 'sheet', sheet }); return }
    }
    setPhase((p) => (p.kind === 'done' ? p : { kind: 'none' }))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  async function start() {
    setBusy(true)
    setError(null)
    const result = await openCount(db, {
      // By category once categories are something a shop actually fills in; the
      // service already takes that scope.
      scope: { kind: 'all' },
      actorId: user.id,
    })
    setBusy(false)
    if (!result.ok) {
      setError(
        result.code === 'NOTHING_TO_COUNT'
          ? 'There is nothing in stock to count.'
          : 'A count sheet is already open.',
      )
      await refresh()
      return
    }
    await refresh()
  }

  async function record(productId: string, raw: string) {
    if (phase.kind !== 'sheet') return
    const parsed = raw.trim() === '' ? null : Quantity.parseQty(raw)
    if (raw.trim() !== '' && parsed === null) return

    await setCounted(db, { countId: phase.sheet.id, productId, countedQty: parsed })
    // Kept in local state rather than reloading the sheet: a counter types down a
    // shelf and a reload between keystrokes would lose the cursor.
    setPhase({
      kind: 'sheet',
      sheet: {
        ...phase.sheet,
        lines: phase.sheet.lines.map((l) => (l.productId === productId ? { ...l, countedQty: parsed } : l)),
      },
    })
  }

  async function finish() {
    if (phase.kind !== 'sheet') return
    setBusy(true)
    setError(null)
    const result = await submitCount(db, { countId: phase.sheet.id, actorId: user.id })
    setBusy(false)
    setConfirming(false)

    if (!result.ok) {
      setError(
        result.code === 'NOTHING_COUNTED'
          ? 'Nothing has been counted yet.'
          : 'That would take an item below zero. Check the quantities.',
      )
      return
    }
    setPhase({ kind: 'done', result })
    await listCounts(db, 30).then(setHistory)
  }

  async function abandon() {
    if (phase.kind !== 'sheet') return
    if (!window.confirm('Throw away this count sheet? Nothing will be posted.')) return
    await cancelCount(db, { countId: phase.sheet.id, actorId: user.id })
    setPhase({ kind: 'none' })
    await refresh()
  }

  async function undo(countId: string) {
    if (!window.confirm('Reverse this count? The stock it corrected goes back to what it was.')) return
    await cancelCount(db, { countId, reason: 'reversed from the count screen', actorId: user.id })
    await refresh()
  }

  const sheet = phase.kind === 'sheet' ? phase.sheet : null

  const stats = useMemo(() => {
    if (!sheet) return null
    let counted = 0
    let differing = 0
    let shortValue = 0
    let overValue = 0
    for (const line of sheet.lines) {
      if (line.countedQty === null) continue
      counted += 1
      const change = line.countedQty - line.expectedQty
      if (change === 0) continue
      differing += 1
      const value = Math.round((change * (line.unitCost ?? 0)) / Quantity.QTY_SCALE)
      if (value < 0) shortValue += value
      else overValue += value
    }
    return { counted, differing, shortValue, overValue, total: sheet.lines.length }
  }, [sheet])

  const visible = useMemo(() => {
    if (!sheet) return []
    const needle = term.trim().toLowerCase()
    return sheet.lines.filter((l) => {
      if (onlyPending && l.countedQty !== null) return false
      if (!needle) return true
      return (
        l.productName.toLowerCase().includes(needle) ||
        (l.code ?? '').toLowerCase().includes(needle) ||
        (l.barcode ?? '').toLowerCase().includes(needle)
      )
    })
  }, [sheet, term, onlyPending])

  if (!canCount) {
    return <Empty>Counting stock needs permission to submit stock entries.</Empty>
  }

  if (phase.kind === 'done') {
    return <Finished result={phase.result} onClose={() => void refresh().then(() => setPhase({ kind: 'none' }))} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1000 }}>
      {error && <Alert>{error}</Alert>}

      {!sheet && (
        <Card title="Count the shelves">
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
            Stock drifts — breakage, a mis-typed entry, something walking out of the shop. A count
            puts the figures back where they belong. The shop can keep selling while you count:
            what gets recorded is the difference you found, not the total you wrote down.
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
            The sheet covers everything the system currently holds stock of. You do not have to
            count it all in one go — count a shelf, leave the rest, and post when you are done.
            Uncounted lines are never touched.
          </div>
          <button className="btn primary" disabled={busy} onClick={() => void start()}>
            {busy ? 'Opening…' : 'Open a count sheet'}
          </button>
        </Card>
      )}

      {sheet && stats && (
        <>
          <Card
            title={`${sheet.docNo} — ${stats.counted} of ${stats.total} counted`}
            actions={
              <>
                <button className="btn ghost sm" onClick={() => void abandon()}>Throw away</button>
                <button className="btn primary sm" disabled={stats.counted === 0} onClick={() => setConfirming(true)}>
                  Post the count
                </button>
              </>
            }
          >
            <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              <input className="input" id="count-search" style={{ flex: 1, minWidth: 200 }}
                placeholder="Jump to an item — name, code or barcode"
                value={term} onChange={(e) => setTerm(e.target.value)} />
              <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
                Only what is left
              </label>
              <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}
                title="A counter who can see the system figure will write the system figure.">
                <input type="checkbox" checked={showExpected} onChange={(e) => setShowExpected(e.target.checked)} />
                Show system quantity
              </label>
            </div>

            {stats.differing > 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 11 }}>
                {stats.differing} {stats.differing === 1 ? 'item differs' : 'items differ'} so far
                {stats.shortValue < 0 && <> · short <Rupees value={-stats.shortValue} /></>}
                {stats.overValue > 0 && <> · found <Rupees value={stats.overValue} /></>}
              </div>
            )}

            <div className="card card-scroll" style={{ maxHeight: '58vh' }}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    {showExpected && <th className="r">System</th>}
                    <th className="r" style={{ width: 130 }}>Counted</th>
                    <th className="r" style={{ width: 110 }}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((line) => {
                    const change = line.countedQty === null ? null : line.countedQty - line.expectedQty
                    return (
                      <tr key={line.id}>
                        <td>
                          {line.productName}
                          {line.code && <div className="src">{line.code}</div>}
                        </td>
                        <td style={{ color: 'var(--ink-3)' }}>{line.categoryName ?? '—'}</td>
                        {showExpected && (
                          <td className="r num">{Quantity.formatQty(line.expectedQty)}</td>
                        )}
                        <td className="r">
                          <input
                            className="input qty-input"
                            inputMode="decimal"
                            style={{ textAlign: 'right' }}
                            defaultValue={line.countedQty === null ? '' : Quantity.formatQty(line.countedQty)}
                            onBlur={(e) => void record(line.productId, e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                          />
                        </td>
                        <td className="r num">
                          {change === null ? (
                            <span style={{ color: 'var(--ink-3)' }}>—</span>
                          ) : change === 0 ? (
                            <span style={{ color: 'var(--ok)' }}>agrees</span>
                          ) : (
                            <span className={change < 0 ? 'badge bad' : 'badge warn'}>
                              {change > 0 ? '+' : ''}{Quantity.formatQty(Quantity.qty(change))} {line.baseUnit}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {visible.length === 0 && (
                    <tr><td colSpan={showExpected ? 5 : 4}><Empty>Nothing matches</Empty></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {confirming && (
            <Modal
              title="Post this count"
              onClose={() => setConfirming(false)}
              footer={
                <>
                  <button className="btn" onClick={() => setConfirming(false)}>Not yet</button>
                  <button className="btn primary" disabled={busy} onClick={() => void finish()}>
                    {busy ? 'Posting…' : 'Post the count'}
                  </button>
                </>
              }
            >
              <p style={{ fontSize: 13 }}>
                {stats.counted} of {stats.total} lines counted, {stats.differing} differing. An
                adjustment is recorded against {registerName} for the differences only; the lines
                that agree, and the ones you did not reach, are left alone.
              </p>
              {stats.shortValue < 0 && (
                <p style={{ fontSize: 13 }}>
                  Stock worth <Rupees value={-stats.shortValue} /> is missing and will be written off.
                </p>
              )}
              {stats.counted < stats.total && (
                <Alert kind="warn">
                  {stats.total - stats.counted} lines were not counted. They stay exactly as they are —
                  an uncounted shelf is not an empty one.
                </Alert>
              )}
            </Modal>
          )}
        </>
      )}

      <Card title="Earlier counts">
        {history.filter((h) => h.docstatus !== 0).length === 0 ? (
          <Empty>No counts posted yet</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Number</th><th>Date</th><th className="r">Counted</th>
                <th className="r">Differed</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {history.filter((h) => h.docstatus !== 0).map((h) => (
                <tr key={h.id}>
                  <td className="num">{h.docNo}</td>
                  <td className="num">{h.postingDate}</td>
                  <td className="r num">{h.countedCount}</td>
                  <td className="r num">{h.differenceCount}</td>
                  <td>{h.docstatus === 2 ? <span className="badge bad">reversed</span> : <span className="badge ok">posted</span>}</td>
                  <td className="r">
                    {h.docstatus === 1 && (
                      <button className="btn ghost sm" onClick={() => void undo(h.id)}>Reverse</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function Finished({ result, onClose }: { result: SubmitCountResult; onClose: () => void }) {
  if (!result.ok) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
      <Card title={`${result.docNo} posted`}>
        {result.adjusted === 0 ? (
          <Alert kind="ok">Everything counted agreed with the system. Nothing needed correcting.</Alert>
        ) : (
          <Alert kind="ok">
            {result.adjusted} {result.adjusted === 1 ? 'item' : 'items'} corrected
            {result.shortages > 0 && ` — ${result.shortages} short`}
            {result.surpluses > 0 && `${result.shortages > 0 ? ',' : ' —'} ${result.surpluses} more than expected`}
            . Recorded as {result.entryDocNo}.
          </Alert>
        )}

        {result.moved.length > 0 && (
          <div style={{ marginTop: 13 }}>
            <Alert kind="warn">
              These were sold or received while you were counting. Their totals include those
              movements — only the difference you found was applied, so nothing was lost.
            </Alert>
            <table style={{ marginTop: 9 }}>
              <thead>
                <tr><th>Item</th><th className="r">When you started</th><th className="r">Now</th></tr>
              </thead>
              <tbody>
                {result.moved.map((m) => (
                  <tr key={m.productId}>
                    <td>{m.productName}</td>
                    <td className="r num">{Quantity.formatQty(m.expectedQty)}</td>
                    <td className="r num">{Quantity.formatQty(m.currentQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 15 }}>
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </Card>
    </div>
  )
}
