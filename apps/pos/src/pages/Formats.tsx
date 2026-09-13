import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DocFormat as Fmt, Receipt,
  listFormats, saveFormat, deleteFormat, chooseFormat, chosenFormatId,
  type Block, type PaperSize, type StoredFormat, type FormatProblem,
  type ReceiptDoc,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Alert, Field, Empty } from '../ui/components'

/**
 * Designing the receipt.
 *
 * The preview on the right is not an approximation: it is the bytes that would
 * go to the printer with the ESC/POS control codes stripped out, laid into a
 * monospace box at the paper's own column count. What is on screen is what comes
 * out of the machine, character for character — which is the only reason a
 * shopkeeper can be asked to make these choices without printing a test roll
 * after each one.
 */

/** A believable bill, so the preview shows the shape rather than empty columns. */
function sampleDoc(shop: ReceiptDoc['shop']): ReceiptDoc {
  const money = (rupees: number) => Math.round(rupees * 100) as ReceiptDoc['subtotal']
  const qty = (units: number) => Math.round(units * 10_000) as ReceiptDoc['items'][number]['qty']

  return {
    shop,
    docNo: 'INV/MR/26-27/00023',
    postingDate: new Date().toISOString().slice(0, 10),
    cashier: 'admin',
    customerName: 'Sri Vidya School',
    items: [
      { name: 'A4 Copier Paper 500 sheets', qty: qty(2), saleUnit: 'ream', rate: money(340), lineTotal: money(680) },
      { name: 'Ball Pen Blue', qty: qty(12), saleUnit: 'piece', rate: money(10), lineTotal: money(120), mrp: money(12) },
    ],
    subtotal: money(800),
    discount: money(0),
    taxableTotal: money(677.97),
    cgst: money(61.01),
    sgst: money(61.01),
    igst: money(0),
    grandTotal: money(800),
    payments: [{ method: 'cash', amount: money(800) }],
    pointsEarned: 8,
    pointsBalance: 120,
  }
}

function problemText(problem: FormatProblem): string {
  switch (problem.code) {
    case 'NAME_REQUIRED': return 'Give the format a name, so it can be told apart in the list.'
    case 'NOTHING_ON': return 'Every block is switched off, which would print a blank slip.'
    case 'NO_ITEMS_BLOCK':
      return 'Switch the items block on. A receipt with no items on it is a total on a piece of paper.'
    case 'NOT_IMPLEMENTED':
      return `${Fmt.BLOCK_LABEL[problem.kind]} is not ready yet. ${Fmt.NOT_YET[problem.kind] ?? ''}`
  }
}

interface Draft {
  id: string | null
  name: string
  paper: PaperSize
  kinds: string[]
  blocks: Block[]
}

function draftOf(format: StoredFormat): Draft {
  return { id: format.id, name: format.name, paper: format.paper, kinds: format.kinds, blocks: format.blocks }
}

export function Formats() {
  const { db, shop } = useCore()
  const user = useUser()

  const [formats, setFormats] = useState<StoredFormat[]>([])
  const [chosen, setChosen] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState<Draft | null>(null)
  const [problems, setProblems] = useState<FormatProblem[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  /* Which format to leave open is passed in rather than read off the current
     draft: a callback that closed over the draft would have to be rebuilt on
     every keystroke, and the preview recomputes on every keystroke already. */
  const refresh = useCallback(async (keepOpen?: string) => {
    try {
      const all = await listFormats(db)
      setFormats(all)
      setChosen(await chosenFormatId(db, 'bill'))

      const open = all.find((f) => f.id === keepOpen) ?? all[0]
      if (open) {
        setDraft(draftOf(open))
        setSaved(draftOf(open))
      }
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  )

  /* The bytes that would go to the printer, with the control codes taken out.
     Recomputed on every keystroke, which is free: no IO, no printer, and the
     whole receipt is a few hundred characters. */
  const preview = useMemo(() => {
    if (!draft) return []
    const format = { id: draft.id ?? 'preview', name: draft.name, paper: draft.paper, kinds: draft.kinds, blocks: draft.blocks }
    const doc = sampleDoc({ name: shop.name, address: shop.address, phone: shop.phone, gstin: shop.gstin })
    return Receipt.visibleLines(Receipt.buildReceipt(doc, format))
  }, [draft, shop])

  function patch(change: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...change } : d))
    setProblems([])
    setNote('')
  }

  function setBlock(index: number, change: Partial<Block>) {
    if (!draft) return
    patch({ blocks: draft.blocks.map((b, i) => (i === index ? { ...b, ...change } : b)) })
  }

  function move(index: number, by: -1 | 1) {
    if (!draft) return
    patch({ blocks: Fmt.moveBlock(draft.blocks, index, index + by) })
  }

  async function save(asNew: boolean) {
    if (!draft) return

    const editing = !asNew && draft.id !== null
    const result = await saveFormat(db, { actorId: user.id }, {
      ...(editing ? { id: draft.id! } : {}),
      name: asNew ? `${draft.name} (copy)` : draft.name,
      paper: draft.paper,
      kinds: draft.kinds,
      blocks: draft.blocks,
    })

    if (!result.ok) {
      setProblems(result.problems)
      return
    }
    setProblems([])
    setNote('Saved.')
    await refresh(result.id)
  }

  async function use() {
    if (!draft?.id) return
    const result = await chooseFormat(db, { actorId: user.id }, 'bill', draft.id)
    if (!result.ok) {
      setError(result.code === 'WRONG_KIND'
        ? 'This format is not set up to print bills.'
        : 'That format could not be found.')
      return
    }
    setNote('Bills will print with this from now on.')
    await refresh(draft.id)
  }

  async function remove() {
    if (!draft?.id) return
    const result = await deleteFormat(db, { actorId: user.id }, draft.id)
    if (!result.ok) {
      setError(result.code === 'BUILT_IN'
        ? 'The format the product came with cannot be deleted. It is what printing falls back to.'
        : 'That format could not be found.')
      return
    }
    await refresh(formats.find((f) => f.id !== draft.id)?.id)
  }

  if (error && formats.length === 0) return <Alert>{error}</Alert>
  if (!draft) return <Empty>Loading the formats…</Empty>

  const builtIn = formats.find((f) => f.id === draft.id)?.builtIn ?? false
  const inUse = draft.id !== null && (chosen === draft.id || (chosen === null && builtIn))

  return (
    <div className="formats">
      <div className="formats-edit">
        <Card title="Formats">
          <div className="side-list">
            {formats.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`pickable ${f.id === draft.id ? 'on' : ''}`}
                onClick={() => { setDraft(draftOf(f)); setSaved(draftOf(f)); setProblems([]); setNote('') }}
              >
                <span>{f.name}</span>
                <span className="format-meta">
                  {Fmt.PAPER_LABEL[f.paper]}
                  {(chosen === f.id || (chosen === null && f.builtIn)) ? ' · in use' : ''}
                </span>
              </button>
            ))}
          </div>
        </Card>

        <Card
          title={draft.name || 'Untitled format'}
          actions={
            <>
              {!inUse && draft.id && !dirty && (
                <button type="button" className="btn" onClick={() => void use()}>Print bills with this</button>
              )}
              <button type="button" className="btn" onClick={() => void save(true)}>Save as a copy</button>
              <button type="button" className="btn primary" disabled={!dirty} onClick={() => void save(false)}>
                {dirty ? 'Save' : 'Saved'}
              </button>
            </>
          }
        >
          {error && <Alert>{error}</Alert>}
          {note && <Alert kind="ok">{note}</Alert>}
          {problems.map((p, i) => <Alert key={i}>{problemText(p)}</Alert>)}

          {inUse && (
            <p className="format-note">
              Bills print with this format. Changes take effect on the next bill printed —
              bills already on paper are unaffected.
            </p>
          )}

          <div className="filter-bar">
            <Field label="Name">
              <input
                className="input"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field label="Paper">
              <select
                className="select"
                value={draft.paper}
                onChange={(e) => patch({ paper: e.target.value as PaperSize })}
              >
                {(Object.keys(Fmt.PAPER_COLUMNS) as PaperSize[]).map((paper) => (
                  <option key={paper} value={paper}>{Fmt.PAPER_LABEL[paper]}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="block-list">
            {draft.blocks.map((block, i) => {
              const unfinished = Fmt.NOT_YET[block.kind]
              return (
                <div key={`${block.kind}-${i}`} className={`block-row ${block.on ? 'on' : ''}`}>
                  <label className="block-switch">
                    <input
                      type="checkbox"
                      checked={block.on}
                      disabled={Boolean(unfinished)}
                      onChange={(e) => setBlock(i, { on: e.target.checked })}
                    />
                    <span>{Fmt.BLOCK_LABEL[block.kind]}</span>
                  </label>

                  <div className="block-move">
                    <button type="button" className="btn sm" disabled={i === 0} onClick={() => move(i, -1)}>
                      Up
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={i === draft.blocks.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      Down
                    </button>
                  </div>

                  {(unfinished || Fmt.BLOCK_NOTE[block.kind]) && (
                    <p className="block-note">{unfinished ?? Fmt.BLOCK_NOTE[block.kind]}</p>
                  )}

                  {block.on && <BlockOptions block={block} onChange={(opts) => setBlock(i, { opts })} />}
                </div>
              )
            })}
          </div>

          {!builtIn && draft.id && (
            <div className="format-danger">
              <button type="button" className="btn danger" onClick={() => void remove()}>
                Delete this format
              </button>
              <span className="block-note">
                {inUse ? 'Bills would go back to the standard receipt.' : 'Bills are not printed with it.'}
              </span>
            </div>
          )}
        </Card>
      </div>

      <Card title={`Preview — ${Fmt.PAPER_LABEL[draft.paper]}`}>
        <p className="format-note">
          Exactly what the printer will produce. Tamil and the ₹ sign are not
          available on a thermal receipt — the printer carries neither.
        </p>
        <pre className={`receipt-preview paper-${draft.paper}`}>{preview.join('\n')}</pre>
      </Card>
    </div>
  )
}

/** Only the blocks that have something to set say anything here. */
function BlockOptions({ block, onChange }: {
  block: Block
  onChange: (opts: Fmt.BlockOpts) => void
}) {
  switch (block.kind) {
    case 'title':
      return (
        <Field label="Words across the top">
          <input
            className="input"
            value={block.opts?.label ?? ''}
            placeholder="TAX INVOICE"
            onChange={(e) => onChange({ ...block.opts, label: e.target.value })}
          />
        </Field>
      )

    case 'text':
      return (
        <div className="block-opts">
          <Field label="Your line">
            <input
              className="input"
              value={block.opts?.body ?? ''}
              placeholder="Queries: {{shop.phone}}"
              onChange={(e) => onChange({ ...block.opts, body: e.target.value })}
            />
          </Field>
          <p className="block-note">
            {Fmt.TOKENS.map((t) => `{{${t.token}}}`).join('  ')}
          </p>
        </div>
      )

    case 'space':
      return (
        <Field label="Blank lines">
          <input
            className="input num"
            type="number"
            min={1}
            max={6}
            value={block.opts?.lines ?? 1}
            onChange={(e) => onChange({ ...block.opts, lines: Number(e.target.value) })}
          />
        </Field>
      )

    default:
      return null
  }
}
