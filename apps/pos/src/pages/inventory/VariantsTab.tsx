import { useCallback, useEffect, useState } from 'react'
import {
  Money, Quantity, addVersions, editVersion, familyPriced, familyVersions, listBarcodes, productsByIds,
  setBarcodes, setFamilyPrice, splitIntoVersions, type ProductListItem,
} from '@shopos/core'
import { useDb, useUser } from '../../core/CoreProvider'
import { Alert } from '../../ui/components'
import type { Draft } from './draft'

/**
 * The Variants tab: one item in several kinds -- the XO pen in blue, black
 * and red, all on the pen's one barcode (`variants.ts`).
 *
 * The only place a variant is edited. A variant has no page of its own: opening
 * one anywhere opens its family here with that row marked, so there is nowhere
 * to give a variant variants. Each change is written as the box is left, as a
 * photo is -- the variants are items of their own, not fields of this one, and
 * do not wait for the page's Save. Making variants hands the item's barcodes to
 * them, so the draft forgets the codes too: saving the item afterwards must not
 * give them back to it.
 */
export function VariantsTab({ draft, setDraft, highlightId, onHistory, onChanged }: {
  draft: Draft
  setDraft: (draft: Draft) => void
  /** The variant the person came looking for, marked in the table. */
  highlightId: string | null
  onHistory: (variant: ProductListItem) => void
  /** Something the page's header shows has changed: stock, the count of variants. */
  onChanged: () => void
}) {
  const db = useDb()
  const user = useUser()
  const ctx = { actorId: user.id }
  const [rows, setRows] = useState<ProductListItem[]>([])
  const [shared, setShared] = useState(false)
  const [held, setHeld] = useState<ProductListItem | null>(null)
  const [labels, setLabels] = useState('')
  const [split, setSplit] = useState<Record<string, string>>({})
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)
  const familyId = draft.id

  /* `live` is false once the page has closed: an answer that comes back after
     that has nowhere to go, and a database already closed is not an error. */
  const load = useCallback(async (live: () => boolean = () => true) => {
    if (!familyId) return
    const [priced, variants, own] = await Promise.all([
      familyPriced(db, familyId),
      familyVersions(db, familyId, { includeRetired: true }),
      productsByIds(db, [familyId]),
    ])
    if (!live()) return
    setShared(priced)
    setRows(variants)
    setHeld(own[0] ?? null)
  }, [db, familyId])
  useEffect(() => {
    let live = true
    void load(() => live).catch(() => undefined)
    return () => { live = false }
  }, [load])

  if (!familyId) {
    return <div className="tab-hint">Save the item first, then make its variants here.</div>
  }

  const done = async (text: string) => {
    setNote({ kind: 'ok', text })
    await load()
    onChanged()
  }
  const refused = (text: string) => setNote({ kind: 'bad', text })

  async function add() {
    const made = await addVersions(db, ctx, { parentId: familyId!, labels: labels.split(',') })
    if (!made.ok) {
      refused(made.code === 'LABEL_TAKEN' ? `${draft.name} already has ${made.label}.`
        : made.code === 'NO_LABELS' ? 'Type the variants, with commas between them: Blue, Black, Red.'
        : 'A variant cannot have variants of its own.')
      return
    }
    setLabels('')
    setDraft({ ...draft, barcodes: [{ barcode: '', label: '' }] })
    await done(`Added ${made.created.map((c) => c.label).join(', ')}. Scanning the barcode now asks which one.`)
  }

  async function share(on: boolean) {
    await setFamilyPrice(db, ctx, familyId!, on)
    await done(on ? 'Every variant now has this item’s price.' : 'Each variant can now be priced on its own.')
  }

  async function relabel(v: ProductListItem, label: string) {
    if (label.trim() === (v.variantLabel ?? '')) return
    const r = await editVersion(db, ctx, { productId: v.id, label })
    if (!r.ok) return refused(r.code === 'LABEL_TAKEN' ? `${draft.name} already has ${r.label}.` : 'A variant needs a name.')
    await done(`Renamed to ${label.trim()}.`)
  }

  async function recode(v: ProductListItem, code: string) {
    const typed = code.trim()
    if (typed === (v.barcode ?? '')) return
    // The first code is the one shown; any others the variant answers to are kept.
    const others = (await listBarcodes(db, v.id)).filter((b) => b.barcode !== v.barcode)
      .map((b) => ({ barcode: b.barcode, label: b.label }))
    const r = await setBarcodes(db, ctx, v.id, typed === '' ? others : [{ barcode: typed }, ...others])
    if (!r.ok) return refused(`${r.taken.map((t) => `${t.barcode} is already on ${t.productName}`).join('; ')}. Nothing was changed.`)
    await done(`${v.variantLabel}’s barcode is ${typed || 'gone'}.`)
  }

  async function reprice(v: ProductListItem, text: string) {
    const rate = Money.parseMoney(text)
    if (rate === null || rate < 0) return refused('That price is not an amount. Nothing was changed.')
    if (rate === v.baseRate) return
    const r = await editVersion(db, ctx, { productId: v.id, baseRate: rate })
    if (!r.ok) return refused('The price could not be changed.')
    await done(`${v.variantLabel} is now ${Money.formatWithSymbol(rate)}.`)
  }

  async function inUse(v: ProductListItem, on: boolean) {
    await editVersion(db, ctx, { productId: v.id, active: on })
    await done(on ? `${v.variantLabel} is back on sale.` : `${v.variantLabel} is out of use. Its sales and stock are kept.`)
  }

  async function move() {
    const lines = rows
      .map((c) => ({ productId: c.id, qty: Quantity.parseQty(split[c.id] ?? '') ?? Quantity.qty(0) }))
      .filter((l) => l.qty > 0)
    const moved = await splitIntoVersions(db, ctx, { parentId: familyId!, lines })
    if (!moved.ok) {
      return refused(moved.code === 'MORE_THAN_HELD' ? `That is more than the ${Quantity.formatQty(held?.qtyOnHand ?? Quantity.qty(0))} in stock.`
        : moved.code === 'NO_LINES' ? 'Type how many of each.'
        : 'The stock could not be moved. Nothing was changed.')
    }
    setSplit({})
    await done(`Moved onto the variants as ${moved.docNo}, at the cost they were held at.`)
  }

  const unsplit = held !== null && rows.length > 0 && held.qtyOnHand > 0 ? held.qtyOnHand : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="tab-hint">
        For one item in several kinds — colours, sizes, flavours — on one barcode. Each variant keeps
        its own stock, and the scan asks which one.
        {rows.length > 0 && ` ${draft.name} itself is not sold once it has variants.`}
      </div>
      {note && <Alert kind={note.kind}>{note.text}</Alert>}

      {rows.length > 0 && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={shared} onChange={(e) => void share(e.target.checked)} />
            Same price for every variant
            <span style={{ color: 'var(--ink-3)' }}>
              {shared ? '— set on the Price & tax tab' : '— each priced in the table below'}
            </span>
          </label>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 30 }} /><th>Variant</th><th>Barcode</th>
                  <th className="r">In stock</th><th className="r">Price</th><th style={{ width: 70 }}>In use</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((v, i) => (
                  <tr key={v.id} style={highlightId === v.id ? { background: 'var(--accent-soft)' } : undefined}>
                    {/* The key at the counter's box (`VariantChoice`), which numbers them the same way. */}
                    <td className="num" style={{ color: 'var(--ink-3)' }}>{v.isActive && i < 9 ? i + 1 : ''}</td>
                    <td>
                      <input className="input" defaultValue={v.variantLabel ?? ''} aria-label={`Name of ${v.variantLabel}`}
                        style={{ maxWidth: 180 }} onBlur={(e) => void relabel(v, e.target.value)} />
                    </td>
                    <td>
                      <input className="input num" defaultValue={v.barcode ?? ''} aria-label={`Barcode of ${v.variantLabel}`}
                        style={{ maxWidth: 170 }} onBlur={(e) => void recode(v, e.target.value)} />
                    </td>
                    <td className="r num" style={{ color: v.qtyOnHand <= 0 ? 'var(--danger)' : undefined }}>
                      {Quantity.formatQty(v.qtyOnHand)} {v.baseUnit}
                    </td>
                    <td className="r">
                      {shared ? (
                        <span className="num" style={{ color: 'var(--ink-3)' }}>{Money.formatWithSymbol(v.baseRate)}</span>
                      ) : (
                        <input className="input num" defaultValue={Money.format(v.baseRate)} aria-label={`Price of ${v.variantLabel}`}
                          style={{ maxWidth: 100, textAlign: 'right' }} onBlur={(e) => void reprice(v, e.target.value)} />
                      )}
                    </td>
                    <td>
                      <input type="checkbox" checked={v.isActive} aria-label={`${v.variantLabel} in use`}
                        onChange={(e) => void inUse(v, e.target.checked)} />
                    </td>
                    <td className="r"><button className="btn ghost sm" type="button" onClick={() => onHistory(v)}>History</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <input className="input" style={{ flex: 1, minWidth: 0, maxWidth: 360 }} placeholder="Blue, Black, Red  or  500 g, 1 kg"
          aria-label="Variants to add" value={labels} onChange={(e) => setLabels(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add() } }} />
        <button className="btn" type="button" disabled={labels.trim() === ''} onClick={() => void add()}>
          {rows.length > 0 ? 'Add variants' : 'Make variants'}
        </button>
      </div>

      {unsplit !== null && (
        <Alert kind="warn">
          <div style={{ marginBottom: 6 }}>
            {Quantity.formatQty(unsplit)} {held!.baseUnit} were in stock before the variants. How many of each?
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {rows.filter((v) => v.isActive).map((v) => (
              <label key={v.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12.5 }}>
                {v.variantLabel ?? v.name}
                <input className="input num" inputMode="decimal" style={{ width: 56 }} placeholder="0"
                  aria-label={`How many are ${v.variantLabel ?? v.name}`} value={split[v.id] ?? ''}
                  onChange={(e) => setSplit({ ...split, [v.id]: e.target.value })} />
              </label>
            ))}
            <button className="btn sm" type="button" onClick={() => void move()}>Split</button>
          </div>
        </Alert>
      )}
    </div>
  )
}
