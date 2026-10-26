import { useCallback, useEffect, useRef, useState } from 'react'
import { productPhoto, setProductPhoto, removeProductPhoto, whyNotServing, type ProductPhoto } from '@shopos/core/web'
import { useCore, useUser } from '../core/CoreProvider'
import { deleteFile, readFile, storeFile, type StoredResult } from '../core/attachments'
import { Alert } from './components'

/**
 * The photo the storefront shows for an item.
 *
 * One picture in, two out: the till shrinks it to about 600 pixels across for
 * the item's page and 200 for lists, as WebP, with a canvas -- so a customer's
 * phone never downloads a camera's full picture to show a thumbnail, and the
 * main never sends one. Saved at once, not with the rest of the form: it is a
 * file, and the form's Save is about the item's fields.
 *
 * Only on the main. The files stay on the till they were added on (only the
 * row travels), and the main is the till that serves them.
 */

const BIG = 600
const SMALL = 200

async function shrink(file: Blob, width: number): Promise<Blob> {
  const image = await createImageBitmap(file)
  const scale = Math.min(1, width / image.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.width * scale)
  canvas.height = Math.round(image.height * scale)
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
  image.close()
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('That picture could not be read.'))), 'image/webp', 0.82)
  })
}

export function ProductPhotoBox({ productId }: { productId: string }) {
  const { db } = useCore()
  const user = useUser()
  const [shown, setShown] = useState<'hidden' | 'elsewhere' | 'here'>('hidden')
  const [photo, setPhoto] = useState<ProductPhoto | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    const held = await productPhoto(db, productId)
    setPhoto(held)
    setPreview(held ? await readFile(held.photo.storedPath).catch(() => null) : null)
  }, [db, productId])

  useEffect(() => {
    void whyNotServing(db).then((why) => {
      setShown(why === 'NOT_THIS_SHOP' ? 'hidden' : why === 'NOT_THE_MAIN' ? 'elsewhere' : 'here')
    })
    void refresh()
  }, [db, refresh])

  async function take(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const [big, small] = await Promise.all([shrink(file, BIG), shrink(file, SMALL)])
      const stored = await Promise.all([storeFile(big, 'photo.webp'), storeFile(small, 'photo-small.webp')])
      const kept = (s: StoredResult) => ({
        fileName: s.fileName, mime: s.mime, sizeBytes: s.sizeBytes, sha256: s.sha256, storedPath: s.storedPath,
      })
      const { orphaned } = await setProductPhoto(db, { actorId: user.id }, {
        productId, photo: kept(stored[0]), thumb: kept(stored[1]),
      })
      for (const path of orphaned) await deleteFile(path).catch(() => undefined)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      const { orphaned } = await removeProductPhoto(db, { actorId: user.id }, productId)
      for (const path of orphaned) await deleteFile(path).catch(() => undefined)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (shown === 'hidden') return null

  return (
    <div
      style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (shown === 'here') void take(e.dataTransfer.files[0]) }}
      onPaste={(e) => { if (shown === 'here') void take(e.clipboardData.files[0]) }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Photo for the storefront</div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
        {shown === 'elsewhere'
          ? 'Add photos on the main till: it is the till that shows them to customers, and a photo stays on the computer it was added on.'
          : 'Pick, drop or paste a picture. It is made small for phones before it is kept.'}
      </div>
      {error && <Alert>{error}</Alert>}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {preview
          ? <img src={preview} alt="" style={{ width: 96, height: 96, objectFit: 'contain', border: '1px solid var(--rule-soft)' }} />
          : photo && <span className="src">The photo is on another till.</span>}
        {shown === 'here' && (
          <>
            <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" hidden
              onChange={(e) => { void take(e.target.files?.[0]); e.target.value = '' }} />
            <button type="button" className="btn" disabled={busy} onClick={() => picker.current?.click()}>
              {photo ? 'Change photo' : 'Add photo'}
            </button>
            {photo && <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>Remove</button>}
          </>
        )}
      </div>
    </div>
  )
}
