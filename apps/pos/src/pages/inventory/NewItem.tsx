import { useState } from 'react'
import { addVersions } from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { Alert, Field, Modal } from '../../ui/components'
import { useConfirm } from '../../ui/useConfirm'
import { BLANK } from './draft'
import { saveItem } from './saveItem'

/**
 * Add item: one question first -- one thing on the shelf, or one item in
 * several kinds -- then only what an item cannot exist without. Its barcode,
 * units and everything else are on its page, which opens as soon as it is made.
 *
 * GST is asked here because an item with a rate nobody saw would be billed at
 * it; the old form started every item at 12% in a box in plain view.
 */
export function NewItem({ onMade, onClose }: {
  /** The item was made: open its page, on its Variants tab when it has them. */
  onMade: (productId: string, withVariants: boolean) => void
  onClose: () => void
}) {
  const { db, features } = useCore()
  const user = useUser()
  const [confirmUi, ask] = useConfirm()
  const [kinds, setKinds] = useState(false)
  const [name, setName] = useState('')
  const [rate, setRate] = useState('')
  const [gst, setGst] = useState(BLANK.taxPercent)
  const [labels, setLabels] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const count = labels.split(',').map((l) => l.trim()).filter((l) => l !== '').length

  async function make() {
    const id = await saveItem({
      db, actorId: user.id, features, priceListId: '', ask,
      draft: { ...BLANK, name, baseRate: rate, taxPercent: gst, noGst: gst.trim() === '0' },
      say: (text, kind) => { if (kind !== 'ok') setProblem(text) },
    })
    if (id === null) return
    if (kinds && count > 0) {
      const made = await addVersions(db, { actorId: user.id }, { parentId: id, labels: labels.split(',') })
      // The item is made either way; its page says what became of the variants.
      if (!made.ok) return onMade(id, true)
    }
    onMade(id, kinds)
  }

  return (
    <Modal
      title="Add an item"
      onClose={onClose}
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button className="btn primary" type="button" disabled={name.trim() === '' || (kinds && count === 0)} onClick={() => void make()}>
          {kinds && count > 0 ? `Add ${name.trim() || 'it'} and ${count} variant${count === 1 ? '' : 's'}` : 'Add item'}
        </button>
      </>}
    >
      {confirmUi}
      <div style={{ display: 'flex', gap: 10 }} role="radiogroup" aria-label="What kind of item">
        {[{ on: false, title: 'One item', note: 'One thing on the shelf.' },
          { on: true, title: 'Item with variants', note: 'Colours, sizes or flavours, each with its own stock.' }].map((c) => (
          <button key={c.title} type="button" role="radio" aria-checked={kinds === c.on} onClick={() => setKinds(c.on)}
            className="btn" style={{
              flex: 1, display: 'block', textAlign: 'left', padding: 14, height: 'auto', whiteSpace: 'normal',
              ...(kinds === c.on ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : {}),
            }}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>{c.title}</div>
            <div className="tab-hint">{c.note}</div>
          </button>
        ))}
      </div>
      {problem && <Alert>{problem}</Alert>}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="XO pen" />
        </Field>
        <Field label="Rate, with GST">
          <input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="10.00" />
        </Field>
        <Field label="GST %">
          <input className="input num" inputMode="decimal" value={gst} onChange={(e) => setGst(e.target.value)} />
        </Field>
      </div>
      {kinds && (
        <Field label="Variants" hint="Commas between them: Blue, Black, Red or 500 g, 1 kg.">
          <input className="input" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Blue, Black, Red" />
        </Field>
      )}
      <div className="tab-hint">Barcode, units and the rest are on the item&rsquo;s page, which opens next.</div>
    </Modal>
  )
}
