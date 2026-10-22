import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DocFormat as Fmt, HtmlTemplate as Tpl, Receipt, buildInvoiceHtml, listFormats, saveFormat,
  deleteFormat, chooseFormat, chosenFormatId, type Block, type PaperSize, type StoredFormat,
  type FormatProblem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Alert, Field, Empty } from '../ui/components'
import { useShopChanged } from '../core/useShopChanged'
import { logoRaster } from '../core/logoRaster'
import { RasterLine } from './formats/RasterLine'
import { BlockOptions } from './formats/BlockOptions'
import { TemplateEditor } from './formats/TemplateEditor'
import { type Draft, KIND_LABELS, PRINTABLE, draftOf, problemText, sampleDoc, templateProblemText } from './formats/draft'

/**
 * Designing what gets printed.
 *
 * One block list, two papers. A roll and a sheet are laid out by completely
 * different renderers — ESC/POS columns against HTML and CSS — but they are
 * driven by the same switches in the same order, so a shop that turns the
 * footer off turns it off on both.
 *
 * Neither preview is a drawing of the output. The roll shows the bytes the
 * printer is sent, with the control codes read rather than discarded; the sheet
 * shows the very page the print dialog would be handed. That is the only reason
 * a shopkeeper can be asked to make these choices without burning a test roll
 * after each one.
 */

export function Formats() {
  const { db, shop } = useCore()
  const user = useUser()

  const [formats, setFormats] = useState<StoredFormat[]>([])
  /* One per machine: what the till prints, and what the sheet prints. */
  const [chosen, setChosen] = useState<Record<string, string | null>>({})
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
      /* Keyed by kind as well as channel, because the till's roll format and
         the quotation's sheet format are separate choices and always were —
         the screen simply never asked about anything but bills. */
      const picks: Record<string, string | null> = {}
      for (const kind of PRINTABLE) {
        for (const channel of ['roll', 'sheet'] as Fmt.Channel[]) {
          picks[`${kind}:${channel}`] = await chosenFormatId(db, kind, channel)
        }
      }
      setChosen(picks)

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
  // And again whenever the other till sends something this list shows.
  useShopChanged(refresh)

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  )

  /* The logo as the roll will print it, reduced once per image, size and paper.
     Asked for whenever the logo block is on, so the switch is seen to work. */
  const logoBlock = draft?.blocks.find((b) => b.kind === 'logo' && b.on)
  const [raster, setRaster] = useState<Receipt.Raster | null>(null)
  useEffect(() => {
    if (!draft || !Fmt.isRoll(draft.paper) || !logoBlock || !shop.logo) { setRaster(null); return }
    let live = true
    void logoRaster(shop.logo, draft.paper, logoBlock.opts?.height).then((r) => { if (live) setRaster(r) })
    return () => { live = false }
  }, [draft?.paper, logoBlock?.opts?.height, Boolean(logoBlock), shop.logo])

  /* Recomputed on every keystroke, which is free: no IO, no printer, and either
     document is a few kilobytes. A roll previews as the printer's own bytes; a
     sheet previews as the very page that would be printed, in a frame. */
  const preview = useMemo(() => {
    if (!draft) return null

    const format = {
      id: draft.id ?? 'preview',
      name: draft.name,
      paper: draft.paper,
      kinds: draft.kinds,
      blocks: draft.blocks,
      template: draft.template,
    }
    /* The real logo, not a placeholder. A preview that leaves it out makes the
       logo switch look like a switch that does nothing, which is the one thing
       this screen must never do. */
    const doc = {
      ...sampleDoc({ name: shop.name, address: shop.address, phone: shop.phone, gstin: shop.gstin, logo: shop.logo, signature: shop.signature }),
      logoRaster: raster,
    }

    return Fmt.isRoll(draft.paper)
      ? { kind: 'roll' as const, lines: Receipt.previewLines(Receipt.buildReceipt(doc, format)) }
      : { kind: 'sheet' as const, html: buildInvoiceHtml(doc, format, { preview: true }) }
  }, [draft, shop, raster])

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
      template: draft.template,
    })

    if (!result.ok) {
      setProblems(result.problems)
      return
    }
    setProblems([])
    setNote('Saved.')
    await refresh(result.id)
  }

  /**
   * Start printing with this one.
   *
   * Applied to every document the format says it prints, not to bills alone.
   * A shop that designs its own A4 sheet and ticks "quotations" expects a
   * quotation to come out on it, and before this the choice was recorded
   * against bills and nothing else ever found it.
   */
  async function use() {
    if (!draft?.id) return
    if (draft.kinds.length === 0) {
      setError('Tick at least one kind of document for this format to print.')
      return
    }

    for (const kind of draft.kinds) {
      const result = await chooseFormat(db, { actorId: user.id }, kind, draft.id)
      if (!result.ok) {
        setError(result.code === 'WRONG_KIND'
          ? `This format is not set up to print ${KIND_LABELS[kind] ?? kind}.`
          : 'That format could not be found.')
        return
      }
    }

    const named = draft.kinds.map((k) => KIND_LABELS[k] ?? k).join(', ')
    setNote(`${named} will print with this from now on.`)
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

  /**
   * Whether this format is the one that machine currently prints with.
   *
   * Nothing chosen means the print path takes the first format for that
   * channel, so the marker has to say the same thing rather than showing every
   * format as unused until someone presses the button once.
   */
  function isInUse(format: { id: string; paper: PaperSize; kinds: string[] }): boolean {
    const channel = Fmt.channelOf(format.paper)
    const first = format.kinds[0]
    if (!first) return false

    const pick = chosen[`${first}:${channel}`]
    if (pick) return pick === format.id
    // Nothing chosen: the print path takes the first format that can print it.
    return formats.find(
      (f) => Fmt.channelOf(f.paper) === channel && f.kinds.includes(first),
    )?.id === format.id
  }

  if (error && formats.length === 0) return <Alert>{error}</Alert>
  if (!draft) return <Empty>Loading the formats…</Empty>

  const builtIn = formats.find((f) => f.id === draft.id)?.builtIn ?? false
  const inUse = draft.id !== null && isInUse({ ...draft, id: draft.id })
  const usingTemplate = Fmt.usesTemplate(draft)
  /* Checked as it is typed, not at the save. The preview quietly falls back to
     the blocks when the markup will not render, so without this the shop would
     see the standard sheet appear and have no idea why. */
  const templateFaults = usingTemplate ? Tpl.checkTemplate(draft.template ?? '') : []

  return (
    <div className="formats">
      <div className="formats-edit">
        <Card title="Formats">
          <div className="side-list">
            {formats.map((f) => (
              <button
                key={f.id}
                type="button"
                className="pickable"
                // What the side list is styled by. A class of `on` was set here and nothing drew it.
                aria-current={f.id === draft.id}
                onClick={() => { setDraft(draftOf(f)); setSaved(draftOf(f)); setProblems([]); setNote('') }}
              >
                <span>{f.name}</span>
                <span className="format-meta">
                  {Fmt.paperLabel(f.paper)}
                  {isInUse(f) ? ' · in use' : ''}
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
                <button type="button" className="btn" onClick={() => void use()}>
                  {Fmt.isRoll(draft.paper) ? "Use on the till printer" : "Use for A4 bills"}
                </button>
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
          {problems.map((p, i) => <Alert key={i}>{problemText(p, draft.paper)}</Alert>)}

          {inUse && (
            <p className="format-note">
              {Fmt.isRoll(draft.paper)
                ? 'The till printer uses this format.'
                : 'Print A4 on a bill uses this format.'}
              {' '}Changes take effect on the next bill printed — bills already on
              paper are unaffected.
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
                {Fmt.PAPER_SIZES.map((paper) => (
                  <option key={paper} value={paper}>{Fmt.paperLabel(paper)}</option>
                ))}
              </select>
            </Field>
          </div>

          {/* Which documents this design is for. Before this the answer was
              always "bills", so a shop could lay out an A4 sheet and never see
              it on a quotation — the print path looks for a format that says it
              prints one. */}
          <Field
            label="Prints"
            hint="Tick what this design is for. Use it, and each of these prints with it."
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {PRINTABLE.map((kind) => (
                <label key={kind} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={draft.kinds.includes(kind)}
                    onChange={(e) => patch({
                      kinds: e.target.checked
                        ? [...draft.kinds, kind]
                        : draft.kinds.filter((k) => k !== kind),
                    })}
                  />
                  {KIND_LABELS[kind]}
                </label>
              ))}
            </div>
          </Field>

          {/* A sheet may be laid out either way; a roll only one way, because a
              till printer is sent characters and never markup. */}
          {!Fmt.isRoll(draft.paper) && (
            <Field
              label="How this sheet is laid out"
              hint={
                usingTemplate
                  ? 'Your own page. The blocks below are kept, so switching back restores them exactly.'
                  : 'Switches, in order, with a preview. Enough for most shops and impossible to break.'
              }
            >
              <div className="segment">
                <button
                  type="button"
                  aria-pressed={!usingTemplate}
                  onClick={() => patch({ template: null })}
                >
                  Blocks
                </button>
                <button
                  type="button"
                  aria-pressed={usingTemplate}
                  onClick={() => patch({ template: draft.template ?? Tpl.STARTER_TEMPLATE })}
                >
                  My own HTML
                </button>
              </div>
            </Field>
          )}

          {usingTemplate && (
            <TemplateEditor
              value={draft.template ?? ''}
              onChange={(template) => patch({ template })}
            />
          )}

          <div className="block-list" hidden={usingTemplate}>
            {draft.blocks.map((block, i) => {
              /* Per paper, for a block one paper can carry and the other cannot. */
              const unfinished = Fmt.notYet(block.kind, draft.paper)
              /* A logo block switched on with no logo uploaded prints nothing,
                 and a switch that appears to do nothing is how a shopkeeper
                 learns not to trust the switches. Say where the logo is set. */
              const missing = block.kind === 'logo' && !unfinished && !shop.logo
                ? 'No logo uploaded yet — choose one under Settings, on the Shop card.'
                : undefined
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

                  {(unfinished || missing || Fmt.BLOCK_NOTE[block.kind]) && (
                    <p className="block-note">
                      {unfinished ?? missing ?? Fmt.BLOCK_NOTE[block.kind]}
                    </p>
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

      <Card title={`Preview — ${Fmt.paperLabel(draft.paper)}`}>
        {preview?.kind === 'roll' && (
          <>
            <p className="format-note">
              The characters and the columns are exactly what the printer will
              produce. Type size is shown close to it rather than to the
              millimetre. Tamil and the ₹ sign are not available on a thermal
              receipt — the printer carries neither.
            </p>
            <div className={`receipt-preview paper-${draft.paper}`}>
              {preview.lines.map((line, i) => (
                <div
                  key={i}
                  className={[
                    'receipt-line',
                    `align-${line.align}`,
                    line.banner ? 'banner' : '',
                    line.tall ? 'tall' : '',
                    line.small ? 'small' : '',
                    line.bold ? 'bold' : '',
                  ].filter(Boolean).join(' ')}
                >
                  {line.raster ? <RasterLine raster={line.raster} paper={draft.paper} /> : (line.text || ' ')}
                </div>
              ))}
            </div>
          </>
        )}

        {preview?.kind === 'sheet' && templateFaults.length > 0 && (
          <>
            {templateFaults.map((fault, i) => <Alert key={i}>{templateProblemText(fault)}</Alert>)}
            <p className="format-note">
              Until that is fixed the preview below shows the built-in design —
              which is also what would print, rather than a broken page.
            </p>
          </>
        )}

        {preview?.kind === 'sheet' && (
          <>
            <p className="format-note">
              This is the page itself, not a drawing of it — the same HTML the
              printer is handed. A sheet goes through the print dialog, where it
              can be sent to a printer or saved as a PDF. Tamil and the ₹ sign
              work here, unlike on the thermal roll.
            </p>
            {/* srcdoc, so the page is its own document and the app's own
                styling cannot leak into what is meant to be the printed sheet. */}
            <iframe
              className={`sheet-preview paper-${draft.paper}`}
              title="Invoice preview"
              srcDoc={preview.html}
            />
          </>
        )}
      </Card>
    </div>
  )
}

