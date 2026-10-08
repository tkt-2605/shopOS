

/*
 * A picture as a thermal printer takes one: one bit per dot, sent as the
 * raster command every ESC/POS printer since the TM-T88 understands.
 *
 * Pure. Turning a PNG into pixels needs a decoder, which the webview has and
 * this package does not want, so the app draws the logo onto a canvas and
 * hands the pixels here. Everything after the pixels -- the threshold, the
 * packing, the printer's command and reading it back for the preview -- is
 * arithmetic, and lives here where it can be tested.
 */

/** Dots per millimetre on a 203 dpi head, which is every counter printer in this market. */
export const DOTS_PER_MM = 8

/**
 * One bit per dot. `width` is a multiple of eight; `bits` holds `height` rows
 * of `width / 8` bytes, the leftmost dot in the highest bit, 1 burnt black.
 */
export interface Raster {
  width: number
  height: number
  bits: Uint8Array
}

/**
 * How many dots wide the printable part of the roll is. An 80mm roll prints
 * 72mm of it and a 58mm roll 48mm; a wider image is cut off by the printer,
 * not scaled.
 */
export function rollDots(paper: string): number {
  return paper === 'thermal_58' ? 384 : 576
}

/** The logo's height on paper when the shop has not said: about the size of a shop name in the banner, twice over. */
export const LOGO_DEFAULT_MM = 16
/** As tall as the logo is allowed to print. A taller one is a picture, not a mark, and costs the shop paper on every bill. */
export const LOGO_MAX_MM = 40

/** The height a logo block asks for, in dots, held between sensible bounds. */
export function logoDots(heightMm: number | undefined): number {
  const mm = Math.min(Math.max(heightMm ?? LOGO_DEFAULT_MM, 5), LOGO_MAX_MM)
  return mm * DOTS_PER_MM
}

/**
 * Pixels, as a canvas gives them (RGBA, four bytes a pixel), into dots.
 *
 * Laid over white first, so a logo with a transparent background prints as a
 * logo and not as a black box. Then a plain threshold rather than dithering:
 * a shop's mark is flat colour and lettering, which dithering turns into a
 * grey fuzz at 203 dpi; a threshold keeps the edges.
 */
export function rasterize(rgba: ArrayLike<number>, width: number, height: number, threshold = 128): Raster {
  const padded = Math.ceil(width / 8) * 8
  const rowBytes = padded / 8
  const bits = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const alpha = (rgba[i + 3] ?? 255) / 255
      const over = (c: number) => c * alpha + 255 * (1 - alpha)
      // Rec. 601 luma: what the eye calls dark, not the average of three numbers.
      const luma = 0.299 * over(rgba[i]!) + 0.587 * over(rgba[i + 1]!) + 0.114 * over(rgba[i + 2]!)
      if (luma < threshold) bits[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7)
    }
  }
  return { width: padded, height, bits }
}

/** Whether a raster has anything on it. An all-white logo prints a blank strip. */
export function isBlank(raster: Raster): boolean {
  return raster.bits.every((b) => b === 0)
}

/**
 * `GS v 0`: print this raster, normal size. Each byte of the result is one
 * character code below 256 -- the print path sends them as bytes, as they are.
 */
export function rasterCommand(raster: Raster): string {
  const rowBytes = raster.width / 8
  const head = [0x1D, 0x76, 0x30, 0x00, rowBytes & 0xFF, rowBytes >> 8, raster.height & 0xFF, raster.height >> 8]
  let out = String.fromCharCode(...head)
  // In slices: spreading a whole logo's bytes into one call can exceed the argument limit.
  for (let i = 0; i < raster.bits.length; i += 4096) {
    out += String.fromCharCode(...raster.bits.subarray(i, i + 4096))
  }
  return out
}

/**
 * The raster command starting at `at`, read back -- or null when what is there
 * is not one. The preview draws the image from this, so what it shows is the
 * very dots the printer was sent.
 */
export function readRaster(text: string, at: number): { raster: Raster; length: number } | null {
  if (text.charCodeAt(at) !== 0x1D || text[at + 1] !== 'v' || text[at + 2] !== '0') return null
  const rowBytes = text.charCodeAt(at + 4) | (text.charCodeAt(at + 5) << 8)
  const height = text.charCodeAt(at + 6) | (text.charCodeAt(at + 7) << 8)
  const size = rowBytes * height
  if (at + 8 + size > text.length) return null
  const bits = new Uint8Array(size)
  for (let i = 0; i < size; i++) bits[i] = text.charCodeAt(at + 8 + i)
  return { raster: { width: rowBytes * 8, height, bits }, length: 8 + size }
}

/**
 * The roll as bytes. Every character on it is below 256 by the time it gets
 * here -- `forThermal` folds the text to ASCII and a raster is bytes already --
 * so each one is sent as itself. UTF-8 would turn a raster byte of 0xFF into
 * two bytes and shift every row of the image after it.
 */
export function toBytes(roll: string): number[] {
  const out = new Array<number>(roll.length)
  for (let i = 0; i < roll.length; i++) out[i] = roll.charCodeAt(i) & 0xFF
  return out
}
