import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { Modal } from './components'
import { centred, clamp, sourceSquare, zoomTo, type Placement, type Size } from './photoCrop'

/**
 * Choosing which square of a picture becomes an item's photo.
 *
 * The picture sits behind a square frame; drag it to move it, and the slider
 * or the mouse wheel zooms. It always covers the frame, so a photo never has
 * an empty edge. What the frame shows is drawn at exactly the sizes asked
 * for -- every photo on the storefront the same shape and size -- on white,
 * so a picture with a transparent background does not come out black.
 */

const FRAME = 320

export function CropPhoto({ file, sizes, onDone, onCancel, name }: {
  file: Blob
  /** The item's name, for the preview card. */
  name?: string | undefined
  /** Square sizes to make, in pixels, largest first. */
  sizes: readonly number[]
  onDone: (squares: Blob[]) => void
  onCancel: () => void
}) {
  const [image, setImage] = useState<{ bitmap: ImageBitmap; url: string } | null>(null)
  const [place, setPlace] = useState<Placement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const drag = useRef<{ x: number; y: number; from: Placement } | null>(null)

  useEffect(() => {
    let live = true
    const url = URL.createObjectURL(file)
    void createImageBitmap(file).then((bitmap) => {
      if (!live) { bitmap.close(); return }
      setImage({ bitmap, url })
      setPlace(centred(bitmap, FRAME))
    }).catch(() => setError('That picture could not be read. Try a JPEG or PNG.'))
    return () => { live = false; URL.revokeObjectURL(url) }
  }, [file])

  useEffect(() => () => image?.bitmap.close(), [image])

  const size: Size | null = image ? { width: image.bitmap.width, height: image.bitmap.height } : null

  function zoomBy(next: number) {
    if (!size || !place) return
    const z = Math.min(4, Math.max(1, next))
    setZoom(z)
    setPlace(zoomTo(place, size, FRAME, z))
  }

  function down(e: PointerEvent<HTMLDivElement>) {
    if (!place) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, from: place }
  }

  function move(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current || !size) return
    const { x, y, from } = drag.current
    setPlace(clamp({ ...from, x: from.x + e.clientX - x, y: from.y + e.clientY - y }, size, FRAME))
  }

  function wheel(e: WheelEvent<HTMLDivElement>) {
    zoomBy(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))
  }

  async function save() {
    if (!image || !place) return
    setBusy(true)
    try {
      const { sx, sy, size: side } = sourceSquare(place, FRAME)
      const squares = await Promise.all(sizes.map((n) => new Promise<Blob>((resolve, reject) => {
        const canvas = document.createElement('canvas')
        canvas.width = n
        canvas.height = n
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, n, n)
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(image.bitmap, sx, sy, side, side, 0, 0, n, n)
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That picture could not be saved.'))), 'image/webp', 0.85)
      })))
      onDone(squares)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Crop the photo"
      wide
      onClose={onCancel}
      footer={(
        <>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <div className="spacer" />
          <button type="button" className="btn primary" disabled={!place || busy} onClick={() => void save()}>Use this square</button>
        </>
      )}
    >
      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
          Drag to move, scroll or use the slider to zoom. The square is what customers see.
        </div>
        {error && <div style={{ color: 'var(--bad, #a33)' }}>{error}</div>}
        <div
          role="img"
          aria-label="The photo inside the crop frame"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={() => { drag.current = null }}
          onPointerCancel={() => { drag.current = null }}
          onWheel={wheel}
          style={{
            width: FRAME, height: FRAME, position: 'relative', overflow: 'hidden', background: '#fff',
            outline: '2px solid var(--ink, #222)', cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none',
          }}
        >
          {image && place && (
            <img
              src={image.url}
              alt=""
              draggable={false}
              style={{
                position: 'absolute', left: 0, top: 0, maxWidth: 'none', userSelect: 'none', pointerEvents: 'none',
                width: image.bitmap.width * place.scale, height: image.bitmap.height * place.scale,
                transform: `translate(${place.x}px, ${place.y}px)`,
              }}
            />
          )}
          {/* Thirds, to line the item up by. */}
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            backgroundImage: 'linear-gradient(to right, rgba(0,0,0,.15) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,.15) 1px, transparent 1px)',
            backgroundSize: `${FRAME / 3}px ${FRAME / 3}px`,
          }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: FRAME }}>
          <span style={{ fontSize: 12.5 }}>Zoom</span>
          <input type="range" min={1} max={4} step={0.01} value={zoom} style={{ flex: 1 }}
            onChange={(e) => zoomBy(Number(e.target.value))} />
        </label>
      </div>
      {image && place && <Preview url={image.url} size={size!} place={place} name={name} />}
      </div>
    </Modal>
  )
}

/**
 * The square as the storefront will show it, moving as the frame does: a card
 * in the shop's grid, the top of the item's page, and the little picture in
 * the cart. Drawn by scaling the frame's own placement, so it is exactly what
 * "Use this square" will save. Rounded, because the storefront is.
 */
function Preview({ url, size, place, name }: { url: string; size: Size; place: Placement; name: string | undefined }) {
  const shot = (side: number, radius: number) => {
    const k = side / FRAME
    return (
      <div style={{ width: side, height: side, borderRadius: radius, overflow: 'hidden', position: 'relative', background: '#fff', flex: 'none' }}>
        <img src={url} alt="" draggable={false} style={{
          position: 'absolute', left: 0, top: 0, maxWidth: 'none', pointerEvents: 'none',
          width: size.width * place.scale * k, height: size.height * place.scale * k,
          transform: `translate(${place.x * k}px, ${place.y * k}px)`,
        }} />
      </div>
    )
  }
  const label = name?.trim() || 'Item name'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 220 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>How customers see it</div>
      <div style={{ background: '#f6f8fc', padding: 12, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>In the shop</div>
        <div style={{ width: 150, background: '#fff', border: '1px solid #e8edf5', borderRadius: 18, padding: 5 }}>
          {shot(138, 14)}
          <div style={{ padding: '7px 5px 4px', fontSize: 12, fontWeight: 600, lineHeight: 1.25, color: '#0f172a' }}>{label}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 5px 4px' }}>
            <span style={{ fontWeight: 700, fontSize: 12.5, color: '#0f172a' }}>₹ —</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#2563eb', border: '1px solid #2563eb', borderRadius: 99, padding: '2px 9px' }}>ADD</span>
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>On the item’s page and in the cart</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          {shot(110, 16)}
          {shot(44, 9)}
        </div>
      </div>
    </div>
  )
}
