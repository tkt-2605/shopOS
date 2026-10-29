import { useCallback, useEffect, useRef, useState } from 'react'
import { productPhoto, setProductPhoto, removeProductPhoto, whyNotServing, type ProductPhoto } from '@shopos/core/web'
import { useCore, useUser } from '../core/CoreProvider'
import { deleteFile, readFile, storeFile, type StoredResult } from '../core/attachments'
import { Alert } from './components'
import { CropPhoto } from './CropPhoto'

/**
 * The photo the storefront shows for an item.
 *
 * One picture in, two out. The person cropping chooses a square of it
 * (`CropPhoto`), and the till draws that square at exactly 600 pixels for the
 * item's page and 200 for lists, as WebP -- every photo on the storefront the
 * same shape and size, and no phone ever downloads a camera's full picture. Saved at once, not with the rest of the form: it is a
 * file, and the form's Save is about the item's fields.
 *
 * Only on the main. The files stay on the till they were added on (only the
 * row travels), and the main is the till that serves them.
 */

const BIG = 600
const SMALL = 200
/** Attachments stop at 10 MB; a bigger picture is cropped but not kept to crop again. */
const MAX_ORIGINAL = 10 * 1024 * 1024

/** A `data:` URL back into the picture it holds, without `fetch` (the till's CSP keeps that to itself). */
function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (!m) return null
  const bytes = m[2] ? Uint8Array.from(atob(m[3]!), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]!))
  return new Blob([bytes], { type: m[1] ?? '' })
}

export function ProductPhotoBox({ productId, name }: { productId: string; name?: string }) {
  const { db } = useCore()
  const user = useUser()
  const [shown, setShown] = useState<'hidden' | 'elsewhere' | 'here'>('hidden')
  const [photo, setPhoto] = useState<ProductPhoto | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What is being cropped, and whether it is a new picture (kept as the original) or the kept one again. */
  const [cropping, setCropping] = useState<{ file: Blob; isNew: boolean } | null>(null)
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

  function take(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('That is not a picture.'); return }
    setError(null)
    setCropping({ file, isNew: true })
  }

  /** The kept original when there is one; else the saved square, which can only be moved and zoomed within. */
  async function adjust() {
    setError(null)
    const url = photo?.original ? await readFile(photo.original.storedPath).catch(() => null) : preview
    const file = url ? dataUrlToBlob(url) : null
    if (file) setCropping({ file, isNew: false })
    else setError('The saved photo could not be opened.')
  }

  async function keep([big, small]: Blob[]) {
    const source = cropping
    setCropping(null)
    if (!big || !small || !source) return
    setBusy(true)
    setError(null)
    try {
      const stored = await Promise.all([storeFile(big, 'photo.webp'), storeFile(small, 'photo-small.webp')])
      const original = source.isNew && source.file.size <= MAX_ORIGINAL
        ? await storeFile(source.file, source.file instanceof File ? source.file.name : 'photo-original')
        : null
      const kept = (s: StoredResult) => ({
        fileName: s.fileName, mime: s.mime, sizeBytes: s.sizeBytes, sha256: s.sha256, storedPath: s.storedPath,
      })
      const { orphaned } = await setProductPhoto(db, { actorId: user.id }, {
        productId, photo: kept(stored[0]), thumb: kept(stored[1]), ...(original ? { original: kept(original) } : {}),
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
  const crop = cropping && (
    <CropPhoto file={cropping.file} name={name} sizes={[BIG, SMALL]} onDone={(b) => void keep(b)} onCancel={() => setCropping(null)} />
  )

  return (
    <div
      style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (shown === 'here') take(e.dataTransfer.files[0]) }}
      onPaste={(e) => { if (shown === 'here') take(e.clipboardData.files[0]) }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Photo for the storefront</div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
        {shown === 'elsewhere'
          ? 'Add photos on the main till: it is the till that shows them to customers, and a photo stays on the computer it was added on.'
          : 'Pick, drop or paste a picture, then choose the square to show; the crop window shows it as customers will see it. Every photo is kept at the same size.'}
      </div>
      {crop}
      {error && <Alert>{error}</Alert>}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {preview
          ? <img src={preview} alt="" style={{ width: 96, height: 96, objectFit: 'contain', border: '1px solid var(--rule-soft)' }} />
          : photo && <span className="src">The photo is on another till.</span>}
        {shown === 'here' && (
          <>
            <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" hidden
              onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
            <button type="button" className="btn" disabled={busy} onClick={() => picker.current?.click()}>
              {photo ? 'Change photo' : 'Add photo'}
            </button>
            {photo && preview && (
              <button type="button" className="btn" disabled={busy} onClick={() => void adjust()}
                title={photo.original ? 'Move or zoom the square again, from the whole picture.' : 'Move or zoom within the saved square. Add the picture again to widen it.'}>
                Adjust crop
              </button>
            )}
            {photo && <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>Remove</button>}
          </>
        )}
      </div>
    </div>
  )
}
