import { useState } from 'react'
import { renameBaseUnit } from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { Field } from '../../ui/components'
import type { Draft } from './draft'

/**
 * The unit an item that exists is counted in: shown, and renamable.
 *
 * Renaming is only the word -- piece as pcs -- and is saved at once, on its
 * own, because it is not part of the item's other details: its prices move
 * with it, and the old word goes on meaning one of it on older bills
 * (`renameBaseUnit`). What the item is counted *in* cannot change here; that
 * would turn 500 pieces into 500 boxes.
 */
export function RenameUnit({ draft, setDraft }: { draft: Draft; setDraft: (draft: Draft) => void }) {
  const { db } = useCore()
  const user = useUser()
  const [typing, setTyping] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    if (typing === null || !draft.id) return
    setBusy(true)
    try {
      const done = await renameBaseUnit(db, { actorId: user.id }, { productId: draft.id, name: typing })
      if (!done.ok) {
        setSaid(done.code === 'NAME_TAKEN'
          ? `This item already sells in ${done.name}. Choose another word.`
          : done.code === 'BAD_NAME' ? 'Type a word for the unit, up to 40 letters.' : 'The item is no longer in the catalogue.')
        return
      }
      setDraft({ ...draft, baseUnit: done.to })
      setTyping(null)
      setSaid(done.from === done.to ? null : `Renamed from ${done.from}. Stock and prices are unchanged.`)
    } finally {
      setBusy(false)
    }
  }

  const hint = said
    ?? (typing === null
      ? 'Stock and bills are counted in it. Rename changes only the word; add a box or pack under Units below.'
      : `Only the word changes: ${draft.baseUnit} and the new word mean the same quantity.`)

  /* The buttons sit beside the label, so the box stays the field's one control and its label names it. */
  const aside = typing === null
    ? <button className="btn ghost sm" type="button" onClick={() => { setSaid(null); setTyping(draft.baseUnit) }}>Rename</button>
    : (
      <span style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm" type="button" disabled={busy || typing.trim() === ''} onClick={() => void save()}>Save name</button>
        <button className="btn ghost sm" type="button" onClick={() => setTyping(null)}>Cancel</button>
      </span>
    )

  return (
    <Field label="Unit" hint={hint} aside={aside}>
      {typing === null
        ? <input className="input" id="p-unit" value={draft.baseUnit} readOnly disabled />
        : (
          <input className="input" id="p-unit" value={typing} autoFocus
            onChange={(e) => setTyping(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }} />
        )}
    </Field>
  )
}
