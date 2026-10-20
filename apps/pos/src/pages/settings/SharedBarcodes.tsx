import { useCallback, useEffect, useState } from 'react'
import { listBarcodes, setBarcodes, sharedBarcodes, Permissions, type BarcodeOnSeveral } from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { Alert } from '../../ui/components'
import { useConfirm } from '../../ui/useConfirm'

/**
 * The codes still on more than one item, shown under One item per barcode.
 *
 * Turning the switch on changes nothing already saved, so a shop that shared
 * codes before goes on sharing them until somebody decides which item keeps
 * each. This is where that is decided: take the code off the item that should
 * not have it, and a scan of it finds the other. The item keeps its other
 * codes; one left with none is found by name.
 */
export function SharedBarcodes() {
  const { db } = useCore()
  const user = useUser()
  const [ui, ask] = useConfirm()
  const [onSeveral, setOnSeveral] = useState<BarcodeOnSeveral[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const canWrite = Permissions.can(user.permissions, 'product', 'write')

  const refresh = useCallback(async () => { setOnSeveral(await sharedBarcodes(db)) }, [db])
  useEffect(() => {
    let live = true
    void sharedBarcodes(db).then((s) => { if (live) setOnSeveral(s) })
    return () => { live = false }
  }, [db])

  async function takeOff(code: string, item: { productId: string; productName: string }, others: string[]) {
    const yes = await ask({
      title: `Take ${code} off ${item.productName}?`,
      message: `Scanning ${code} will then find ${others.join(', ')}. ${item.productName} keeps any other barcodes it has.`,
      confirmLabel: 'Take it off',
      cancelLabel: 'Keep it on',
    })
    if (!yes) return
    const kept = (await listBarcodes(db, item.productId))
      .filter((b) => b.barcode !== code)
      .map((b) => ({ barcode: b.barcode, label: b.label }))
    const done = await setBarcodes(db, { actorId: user.id }, item.productId, kept)
    setNotice(done.ok
      ? `${code} is off ${item.productName}.${kept.length === 0 ? ' It has no barcode now, and is found by name.' : ''}`
      : `${code} could not be taken off ${item.productName}.`)
    await refresh()
  }

  if (onSeveral.length === 0) return notice ? <Alert kind="ok">{notice}</Alert> : null
  return (
    <>
      {ui}
      <Alert kind="warn">
        <p>
          {onSeveral.length === 1 ? 'One code is' : `${onSeveral.length} codes are`} still on more than one item.
          {canWrite ? ' Take each off the item that should not have it.' : ''}
        </p>
        <ul className="shared-codes">
          {onSeveral.slice(0, 50).map((s) => (
            <li key={s.barcode}>
              <span className="num">{s.barcode}</span>
              {s.items.map((item) => (
                <span key={item.productId} className="shared-code-item">
                  {item.productName}
                  {canWrite && (
                    <button
                      className="btn ghost sm"
                      aria-label={`Take ${s.barcode} off ${item.productName}`}
                      onClick={() => void takeOff(
                        s.barcode, item, s.items.filter((i) => i.productId !== item.productId).map((i) => i.productName),
                      )}
                    >Take off</button>
                  )}
                </span>
              ))}
            </li>
          ))}
        </ul>
        {onSeveral.length > 50 && <p>and {onSeveral.length - 50} more; they appear here as these are sorted.</p>}
      </Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
    </>
  )
}
