import { useEffect, useMemo, useState } from 'react'
import { buildCatalog, orderLabel, proposeChanges, type CatalogItem, type ShopWebOrder } from '@shopos/core/web'
import { useCore, useUser } from '../core/CoreProvider'
import { Alert, Field, Modal, Rupees } from './components'

/*
 * Two ways of answering an online order without taking it as it stands.
 *
 * `TurnAway`: no, with a message the customer reads on their phone.
 * `SendBackChanged`: not quite -- fewer of this, none of that, this instead --
 * sent back for the customer to take or cancel. Taken, it comes back to the
 * Waiting list to accept like any other.
 */

const REASONS = ['Out of stock', 'We are closed today', 'We cannot fill this quantity', 'Please call the shop']

export function TurnAway({ order, onCancel, onSend }: {
  order: ShopWebOrder
  onCancel: () => void
  onSend: (message: string) => void
}) {
  const [message, setMessage] = useState('')
  return (
    <Modal
      title={`Turn away ${orderLabel(order.orderNo)}`}
      onClose={onCancel}
      footer={(
        <>
          <button className="btn" onClick={onCancel}>Back</button>
          <div className="spacer" />
          <button className="btn primary" disabled={message.trim() === ''} onClick={() => onSend(message.trim())}>Turn away</button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="src">{order.contactName} reads this on their phone. If you could fill part of it, send it back changed instead.</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {REASONS.map((r) => <button key={r} type="button" className="btn" onClick={() => setMessage(r)}>{r}</button>)}
        </div>
        <Field label="Message to the customer">
          <textarea value={message} maxLength={200} rows={3} autoFocus onChange={(e) => setMessage(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

interface Row { productId: string; name: string; unit: string; qty: number; was: number | null }

export function SendBackChanged({ order, onCancel, onSent, onError }: {
  order: ShopWebOrder
  onCancel: () => void
  onSent: (message: string) => void
  onError: (message: string | null) => void
}) {
  const { db } = useCore()
  const user = useUser()
  const [rows, setRows] = useState<Row[]>(() => order.lines.map((l) => ({ productId: l.productId, name: l.name, unit: l.unit, qty: l.qty, was: l.qty })))
  const [note, setNote] = useState('')
  /* Asked with prices on request: the same items, priced, are a quotation. */
  const quoting = order.seenTotal === 0 && !order.agreedAt
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => { void buildCatalog(db).then((c) => setCatalog(c.items)).catch(() => undefined) }, [db])

  const found = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    return catalog.filter((i) => {
      const text = `${i.name} ${i.brand ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w))
    }).slice(0, 8)
  }, [catalog, search])

  const changed = rows.some((r) => r.was === null || r.qty !== r.was) || rows.length !== order.lines.length
  const kept = rows.filter((r) => r.qty > 0)

  function setQty(i: number, qty: number) {
    setRows(rows.map((r, j) => (j === i ? { ...r, qty: Math.max(0, Math.min(999, Math.floor(qty) || 0)) } : r)))
  }

  function add(item: CatalogItem) {
    const unit = item.units[0]!.unit
    const at = rows.findIndex((r) => r.productId === item.id && r.unit === unit)
    if (at >= 0) setQty(at, rows[at]!.qty + 1)
    else setRows([...rows, { productId: item.id, name: item.brand && !item.name.toLowerCase().includes(item.brand.toLowerCase()) ? `${item.name} (${item.brand})` : item.name, unit, qty: 1, was: null }])
    setSearch('')
  }

  async function send() {
    setBusy(true)
    setProblem(null)
    try {
      const r = await proposeChanges(db, {
        webOrderId: order.id, actorId: user.id, note,
        lines: kept.map((row) => ({ productId: row.productId, unit: row.unit, qty: row.qty })),
      })
      if (r.ok) { onSent(`${orderLabel(order.orderNo)} sent back to ${order.contactName} with your changes.`); return }
      setProblem(r.code === 'NO_CHANGE' ? 'Nothing has been changed yet.'
        : r.code === 'NO_LINES' ? 'Leave at least one item, or turn the order away instead.'
        : r.code === 'NOT_LISTED' ? 'One of the added items is not sold online.'
        : r.code === 'NOT_PENDING' ? 'It has already been answered.'
        : r.code === 'NOT_THE_MAIN' ? 'Answer online orders on the main till.'
        : `It could not be sent (${r.code}).`)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={quoting ? `Quotation for ${orderLabel(order.orderNo)}` : `Change ${orderLabel(order.orderNo)} and send it back`}
      onClose={onCancel}
      wide
      footer={(
        <>
          <button className="btn" onClick={onCancel}>Back</button>
          <div className="spacer" />
          <button className="btn primary" disabled={busy || (!changed && !quoting) || kept.length === 0} onClick={() => void send()}>
            {quoting ? 'Send quotation' : 'Send to customer'}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="src">
          {quoting && <>They asked without prices. Send it as it is and they see your prices, or change it first. </>}
          Change a quantity, set it to 0 to take an item off, or add another in its place. {order.contactName} sees
          what changed and the new total, and takes it or cancels. If they take it, it comes back to Waiting for you to accept.
        </div>
        {problem && <Alert>{problem}</Alert>}
        <table>
          <thead><tr><th>Item</th><th className="r">They asked</th><th className="r">Send</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.productId}-${r.unit}`} style={r.qty === 0 ? { opacity: 0.5 } : undefined}>
                <td>{r.name} <span className="src">{r.unit}</span>{r.was === null && <span className="src"> · added</span>}</td>
                <td className="r">{r.was ?? '—'}</td>
                <td className="r">
                  <input type="number" min={0} max={999} value={r.qty} style={{ width: 70, textAlign: 'right' }}
                    onChange={(e) => setQty(i, Number(e.target.value))} />
                </td>
                <td className="r">
                  {r.qty > 0
                    ? <button type="button" className="btn" onClick={() => setQty(i, 0)}>Take off</button>
                    : r.was !== null
                      ? <button type="button" className="btn" onClick={() => setQty(i, r.was!)}>Put back</button>
                      : <button type="button" className="btn" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Field label="Add an item instead" hint="Anything the storefront lists.">
          <input value={search} placeholder="Search by name or brand" onChange={(e) => setSearch(e.target.value)} />
        </Field>
        {found.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {found.map((item) => (
              <button key={item.id} type="button" className="btn" style={{ justifyContent: 'space-between', display: 'flex' }} onClick={() => add(item)}>
                <span>{item.name}{item.brand ? <span className="src"> · {item.brand}</span> : null}</span>
                <span><Rupees value={item.units[0]!.price as never} /> / {item.units[0]!.unit}</span>
              </button>
            ))}
          </div>
        )}
        <Field label="Note to the customer" hint="Say why, so they can decide: “Only 3 left, and Reynolds instead of Cello.”">
          <textarea value={note} maxLength={300} rows={2} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
