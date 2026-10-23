import { useCallback, useEffect, useState } from 'react'
import { itemsPricedTwice, settleDoublePrice, type DoublePrice } from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Alert, Rupees } from './components'

/**
 * Items with two normal prices, and the one question that settles them.
 *
 * Before 24 October an item had a selling rate and, separately, a "price on
 * the shop's list" that the counter charged instead -- so Inventory could say
 * ₹10 while every bill said ₹9. Each item now has one. Where the two already
 * agree there is nothing to ask and one press tidies them all; where they
 * differ, a person says which is right, item by item. The list rate is what
 * the counter has been charging, so keeping it changes nothing for customers.
 *
 * Shown on Inventory and on Special Prices until there is nothing left to ask.
 */
export function DoublePrices({ onDone }: { onDone?: () => void | Promise<void> }) {
  const { db } = useCore()
  const user = useUser()
  const [found, setFound] = useState<DoublePrice[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => setFound(await itemsPricedTwice(db)), [db])
  useEffect(() => { load().catch(() => undefined) }, [load])

  async function settle(items: DoublePrice[], keep: 'selling' | 'list') {
    setBusy(true)
    for (const d of items) await settleDoublePrice(db, { actorId: user.id }, { productId: d.productId, keep })
    setBusy(false)
    await load()
    await onDone?.()
  }

  if (found.length === 0) return null
  const differ = found.filter((d) => !d.same)
  const agree = found.filter((d) => d.same)

  return (
    <>
      <Alert kind="warn">
        {found.length === 1 ? 'One item has' : `${found.length} items have`} two normal prices: its selling rate
        and an older “price on the shop’s list”, which is what the counter charges.{' '}
        <button className="btn sm" onClick={() => setOpen(true)}>Choose one price each</button>
      </Alert>
      {open && (
        <Modal
          title="One normal price per item"
          wide
          onClose={() => setOpen(false)}
          footer={<button className="btn" onClick={() => setOpen(false)}>Done</button>}
        >
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55, marginBottom: 10 }}>
            An item now has one normal price, its selling rate. The shop list price is what the counter has
            been charging, so keeping it changes nothing for customers. Choose per item.
          </div>
          {agree.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 12.5 }}>
                {agree.length === 1 ? 'One item has' : `${agree.length} items have`} the same price twice.
              </span>
              <button className="btn sm" disabled={busy} onClick={() => void settle(agree, 'selling')}>
                Tidy {agree.length === 1 ? 'it' : 'them'}
              </button>
            </div>
          )}
          {differ.length > 0 && (
            <div className="card card-scroll" style={{ maxHeight: 360 }}>
              <table>
                <thead>
                  <tr><th>Item</th><th className="r">Selling rate</th><th className="r">Shop list (charged now)</th><th /></tr>
                </thead>
                <tbody>
                  {differ.map((d) => (
                    <tr key={d.productId}>
                      <td>{d.name}</td>
                      <td className="r"><Rupees value={d.sellingRate} /></td>
                      <td className="r"><Rupees value={d.listRate} /></td>
                      <td className="r" style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn sm" disabled={busy} onClick={() => void settle([d], 'list')}>
                          Keep <Rupees value={d.listRate} />
                        </button>{' '}
                        <button className="btn ghost sm" disabled={busy} onClick={() => void settle([d], 'selling')}>
                          Keep <Rupees value={d.sellingRate} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {differ.length > 1 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button className="btn" disabled={busy} onClick={() => void settle(differ, 'list')}>
                Keep every shop list price
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => void settle(differ, 'selling')}>
                Keep every selling rate
              </button>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
