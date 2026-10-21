import { useEffect, useRef, useState } from 'react'
import {
  hsnProblem, isHsn, HSN_SHAPE_MESSAGE, Tax, taxLikeName, taxForHsn, type TaxLike,
} from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Field } from '../../ui/components'
import type { Draft } from './draft'

/*
 * No GST, HSN, GST and cess, and the quick way to fill them: from the items
 * the shop already has. A second pair of scissors is the first pair's HSN and
 * rate whoever made it, so the form offers what the shop's other scissors
 * carry, and a code typed in brings the rate the shop's other items with that
 * code are at. Offered or filled, never fixed: the boxes stay the person's.
 */

const percent = (bp: number) => String(Tax.bpToPercent(bp))

function withTax(draft: Draft, like: TaxLike): Draft {
  return {
    ...draft, noGst: false, hsnCode: like.hsnCode,
    taxPercent: percent(like.taxRateBp), cessPercent: like.cessRateBp === 0 ? '' : percent(like.cessRateBp),
  }
}

export function TaxFields({ draft, setDraft }: { draft: Draft; setDraft: (draft: Draft) => void }) {
  const { db } = useCore()
  const [likes, setLikes] = useState<TaxLike[]>([])
  const [filled, setFilled] = useState<string | null>(null)
  // The draft as it is now, for an answer that comes back after more typing.
  const latest = useRef(draft)
  latest.current = draft

  // Items named like this one, while it has no code yet.
  const wanted = draft.hsnCode.trim() === '' && !draft.noGst
  useEffect(() => {
    if (!wanted) { setLikes([]); return }
    let live = true
    const id = setTimeout(() => {
      void taxLikeName(db, draft.name, draft.brand, draft.id).then((found) => { if (live) setLikes(found) })
    }, 250)
    return () => { live = false; clearTimeout(id) }
  }, [db, wanted, draft.name, draft.brand, draft.id])

  function typeHsn(code: string) {
    setDraft({ ...draft, hsnCode: code })
    setFilled(null)
    if (!isHsn(code.trim())) return
    void taxForHsn(db, code, draft.id).then((like) => {
      const now = latest.current
      if (!like || now.hsnCode !== code) return
      const same = percent(like.taxRateBp) === now.taxPercent.trim()
        && (like.cessRateBp === 0 ? now.cessPercent.trim() === '' : percent(like.cessRateBp) === now.cessPercent.trim())
      if (!same) setDraft(withTax(now, like))
      setFilled(`GST ${percent(like.taxRateBp)}%${like.cessRateBp ? ` and cess ${percent(like.cessRateBp)}%` : ''}, `
        + `as on ${like.items === 1 ? like.example : `your ${like.items} other items with ${like.hsnCode}`}.`)
    })
  }

  return (
    <>
      {/* The boxes are hidden, not emptied: untick it and what was typed is
          still there. Saved, a ticked item carries no GST and no cess. */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', gridColumn: '1 / -1' }}>
        <input type="checkbox" id="p-no-gst" checked={draft.noGst}
          onChange={(e) => setDraft({ ...draft, noGst: e.target.checked })} />
        <span style={{ fontSize: 12.5 }}>
          No GST on this item
          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-3)' }}>
            Billed with no tax at all, the same as a 0% item.
          </span>
        </span>
      </label>
      {!draft.noGst && likes.length > 0 && (
        <div style={{ gridColumn: '1 / -1', fontSize: 12 }} aria-label="Like items you have">
          <div style={{ color: 'var(--ink-3)', marginBottom: 4 }}>Same as an item you already have:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {likes.map((like) => (
              <button key={`${like.hsnCode}|${like.taxRateBp}|${like.cessRateBp}`} type="button" className="btn" style={{ fontSize: 12, padding: '3px 8px', whiteSpace: 'normal', textAlign: 'left' }}
                onClick={() => { setDraft(withTax(draft, like)); setLikes([]) }}>
                HSN {like.hsnCode} · {percent(like.taxRateBp)}%{like.cessRateBp ? ` + ${percent(like.cessRateBp)}% cess` : ''}
                <span style={{ color: 'var(--ink-3)', marginLeft: 6 }}>
                  like {like.example}{like.items > 1 ? ` and ${like.items - 1} more` : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!draft.noGst && (
        <>
          {/* Warned, never blocked. Somebody entering three hundred items off
              a supplier's list is the person most likely to mistype one and
              least able to stop and look it up -- and an item that cannot be
              saved is an item that cannot be sold. */}
          <Field
            label="HSN code"
            {...(hsnProblem(draft.hsnCode) ? { hint: HSN_SHAPE_MESSAGE } : filled ? { hint: filled } : {})}
          >
            <input className="input num" id="p-hsn" value={draft.hsnCode}
              onChange={(e) => typeHsn(e.target.value)} />
          </Field>
          <Field label="GST %">
            <input className="input num" id="p-gst" value={draft.taxPercent}
              onChange={(e) => { setFilled(null); setDraft({ ...draft, taxPercent: e.target.value }) }} />
          </Field>
          {/* Compensation cess: tobacco, pan masala, aerated drinks. Blank for
              nearly everything a shop sells, which is why it says so. */}
          <Field label="Cess %" hint="Only for goods that carry compensation cess. Leave blank otherwise.">
            <input className="input num" id="p-cess" value={draft.cessPercent} placeholder="None"
              onChange={(e) => setDraft({ ...draft, cessPercent: e.target.value })} />
          </Field>
        </>
      )}
    </>
  )
}
