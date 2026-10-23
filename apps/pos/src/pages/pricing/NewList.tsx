import { useState } from 'react'
import { createPriceList } from '@shopos/core'
import { useDb, useUser } from '../../core/CoreProvider'
import { Alert } from '../../ui/components'

/** A new price list: its name, and whether its prices are quoted before GST, as a wholesaler quotes. */
export function NewList({ onClose, onMade }: {
  onClose: () => void
  onMade: (priceListId: string) => void | Promise<void>
}) {
  const db = useDb()
  const user = useUser()
  const [name, setName] = useState('')
  const [beforeTax, setBeforeTax] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    const result = await createPriceList(db, { actorId: user.id }, { name, ratesIncludeTax: !beforeTax })
    if (!result.ok) {
      /* The removed clash has its own answer: the name is still taken, by a
         list the shop cannot see until it asks for removed lists. */
      setError(
        result.code === 'NO_NAME' ? 'Give the list a name.'
        : result.code === 'NAME_TAKEN_ARCHIVED'
          ? `There is a removed list called “${name.trim()}”. Tick “Show removed lists” and bring it back; its prices are all still on it.`
        : 'There is already a list with that name.',
      )
      return
    }
    await onMade(result.priceListId)
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--rule-soft)', maxWidth: 460 }}>
      {error && <div style={{ marginBottom: 8 }}><Alert>{error}</Alert></div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="input" autoFocus placeholder="Name — Wholesale, School, Staff" aria-label="New list name"
          value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() !== '') void add() }} />
        <button className="btn primary" disabled={name.trim() === ''} onClick={() => void add()}>Add list</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
      <label style={{ fontSize: 12.5, color: 'var(--ink-2)', display: 'flex', gap: 5, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={beforeTax} onChange={(e) => setBeforeTax(e.target.checked)} />
        Its prices are before GST, as a wholesaler quotes — GST is added at the counter
      </label>
    </div>
  )
}
