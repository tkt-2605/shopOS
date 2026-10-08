import { Receipt, type DocFormat } from '@shopos/core'

type Raster = Receipt.Raster

/**
 * The shop's logo as the thermal printer's dots.
 *
 * Here and not in core because it needs a canvas to turn the uploaded PNG or
 * JPEG into pixels; everything after the pixels is `Receipt.rasterize`. Sized
 * to the height the logo block asks for, and never wider than the paper prints,
 * keeping its proportions.
 *
 * Remembered per image, size and paper: a bill is printed in the middle of a
 * queue, and decoding the same logo for every one of them is time the cashier
 * waits for. Answers null for anything that cannot be drawn -- no canvas, an
 * image that will not decode, a logo that is all white -- and the bill then
 * prints without one, never not at all.
 */
const made = new Map<string, Promise<Raster | null>>()

export function logoRaster(dataUri: string, paper: DocFormat.PaperSize, heightMm?: number): Promise<Raster | null> {
  const key = `${paper}|${heightMm ?? ''}|${dataUri.length}|${dataUri.slice(-96)}`
  let pending = made.get(key)
  if (!pending) {
    pending = draw(dataUri, paper, heightMm).catch(() => null)
    made.set(key, pending)
    // Only the latest logo is worth holding; a replaced one would sit here for ever.
    if (made.size > 8) made.delete(made.keys().next().value!)
  }
  return pending
}

async function draw(dataUri: string, paper: DocFormat.PaperSize, heightMm?: number): Promise<Raster | null> {
  if (typeof document === 'undefined') return null
  const image = new Image()
  image.src = dataUri
  await image.decode()
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return null

  let height = Receipt.logoDots(heightMm)
  let width = Math.round((image.naturalWidth * height) / image.naturalHeight)
  const widest = Receipt.rollDots(paper)
  if (width > widest) {
    height = Math.max(1, Math.round((height * widest) / width))
    width = widest
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(image, 0, 0, width, height)
  const raster = Receipt.rasterize(ctx.getImageData(0, 0, width, height).data, width, height)
  return Receipt.isBlank(raster) ? null : raster
}

/** The logo block of a format, when it is switched on. */
export function logoBlockOf(format: DocFormat.DocFormat): DocFormat.Block | null {
  return format.blocks.find((b) => b.kind === 'logo' && b.on) ?? null
}
