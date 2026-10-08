import { type Money, format as fmtMoney } from '../../money.js'
import { rollColumns } from '../docFormat.js'
import { readRaster, type Raster } from './raster.js'
export { formatDate, titleCase } from '../docText.js'

/*
 * The printer's own language, and the column arithmetic every roll shares.
 *
 * ESC/POS control codes, the padding that keeps a line at exactly the paper's
 * width, and the reverse -- turning a roll back into lines a person or a test
 * can read. Nothing here knows what a bill or a statement is.
 */

export const ESC = '\x1B'
export const GS = '\x1D'

export const INIT = `${ESC}@`
export const LF = '\n'
export const ALIGN_LEFT = `${ESC}a\x00`
export const ALIGN_CENTER = `${ESC}a\x01`
export const BOLD_ON = `${ESC}E\x01`
export const BOLD_OFF = `${ESC}E\x00`
export const MODE_NORMAL = `${ESC}!\x00`
/** Double width + double height + bold. */
export const MODE_BANNER = `${ESC}!\x38`
/** Double height + bold. */
export const MODE_TALL = `${ESC}!\x18`
/** Font B, condensed — small print only. */
export const MODE_SMALL = `${ESC}!\x01`
export const CUT = `${GS}V\x01`

export const feed = (n: number) => `${ESC}d${String.fromCharCode(n)}`

/** The 80mm roll, which is what the statement and every legacy caller assume. */
export const WIDTH = rollColumns('thermal_80')

/**
 * Punctuation a keyboard or a word processor puts in, as the ASCII a thermal
 * printer has. One character for one, so the columns laid out above still meet
 * the edge of the paper.
 */
export const FOLD: Record<string, string> = {
  '\u2014': '-', '\u2013': '-', '\u2012': '-', '\u2212': '-', '\u2010': '-', '\u2011': '-',
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u2033': '"',
  '\u00A0': ' ', '\u2009': ' ', '\u202F': ' ', '\u2026': '.', '\u00D7': 'x', '\u2022': '*', '\u00B7': '.',
}

/**
 * The roll as the printer can print it.
 *
 * A thermal printer reads each byte against its own code page, which is not
 * UTF-8 and has no rupee sign, no Tamil and no long dash. This used to be sent
 * as UTF-8, so a shop called "Sri Café — Stores" printed two or three bytes of
 * rubbish for each of those characters and pushed every column after them out
 * of line. Accented Latin letters lose the accent; anything with no ASCII form
 * becomes `?`, which at least keeps its column. Every command byte this file
 * writes is below 0x7F, so they pass through untouched.
 *
 * Printing Tamil on the roll means sending it as a picture, which is a feature
 * and not a fix; the A4 sheet prints it today.
 */
export function forThermal(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x7F) { out += ch; continue }
    const folded = FOLD[ch]
    if (folded !== undefined) { out += folded; continue }
    const base = ch.normalize('NFD')[0]!
    out += base.charCodeAt(0) < 0x7F && /[A-Za-z]/.test(base) ? base : '?'
  }
  return out
}

export function rule(ch = '-', width = WIDTH): string {
  return ch.repeat(width) + LF
}

/** Left text, right text, padded apart to exactly `width` columns. */
export function kv(left: string, right: string, width = WIDTH): string {
  const gap = Math.max(1, width - left.length - right.length)
  return `${left}${' '.repeat(gap)}${right}${LF}`
}

/**
 * How many characters fit on a line of the condensed face.
 *
 * Font B is 9 dots wide where font A is 12, so it fits a third more: 56 columns
 * on an 80mm roll against 42, and 42 on a 58mm roll against 32.
 */
export function smallColumns(width: number): number {
  return Math.floor((width * 4) / 3)
}

export function cut(text: string, max: number): string {
  return String(text ?? '').slice(0, max)
}

export function wrap(text: string, width = WIDTH): string {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line !== '') lines.push(line)
  return lines.join(LF) + LF
}

export type PreviewAlign = 'left' | 'centre' | 'right'

/** How a line is set on the paper, for a preview that is not lying about it. */
export interface PreviewLine {
  text: string
  align: PreviewAlign
  bold: boolean
  /** Double width and height: the shop name across the top. */
  banner: boolean
  /** Double height only. */
  tall: boolean
  /** Font B, condensed. */
  small: boolean
  /** A picture -- the logo -- as the dots the printer was sent. `text` is empty. */
  raster?: Raster
}

/**
 * The receipt as a person would see it come out of the printer.
 *
 * `visibleLines` throws the alignment and emphasis away, which is right for
 * measuring column widths and wrong for showing someone their own receipt: a
 * centred double-width shop name rendered flush left reads as a gap in the
 * layout rather than as the banner it is.
 *
 * The column arithmetic is untouched — `text` is the same characters
 * `visibleLines` gives. Only the styling is carried alongside instead of
 * discarded.
 */
export function previewLines(receipt: string): PreviewLine[] {
  const lines: PreviewLine[] = []

  let align: PreviewAlign = 'left'
  let bold = false
  let banner = false
  let tall = false
  let small = false
  let text = ''

  /* The style as it was when the line's first character was written, not as it
     is at the newline. `BOLD_OFF` comes before the line break, so reading the
     state at the end would report every fully-bold line as not bold. */
  let started: Omit<PreviewLine, 'text'> | null = null

  const endLine = () => {
    lines.push({ text, ...(started ?? { align, bold, banner, tall, small }) })
    text = ''
    started = null
  }

  for (let i = 0; i < receipt.length; i++) {
    const ch = receipt[i]!

    if (ch === LF) {
      endLine()
      continue
    }

    if (ch === ESC) {
      const code = receipt[i + 1]
      const arg = receipt.charCodeAt(i + 2)

      if (code === '@') { i += 1; continue }
      if (code === 'a') {
        align = arg === 1 ? 'centre' : arg === 2 ? 'right' : 'left'
        i += 2
        continue
      }
      if (code === 'E') { bold = arg === 1; i += 2; continue }
      if (code === 'd') { i += 2; continue }
      if (code === '!') {
        /* The mode byte is a set of flags: 0x01 font B, 0x08 emphasis,
           0x10 double height, 0x20 double width. */
        small = (arg & 0x01) !== 0
        const wide = (arg & 0x20) !== 0
        const high = (arg & 0x10) !== 0
        banner = wide && high
        tall = high && !wide
        bold = (arg & 0x08) !== 0
        i += 2
        continue
      }
      i += 1
      continue
    }

    if (ch === GS) {
      // GS v 0, a picture: a line of its own, with the very dots it will print.
      const image = readRaster(receipt, i)
      if (image) {
        if (text !== '') endLine()
        lines.push({ text: '', align, bold: false, banner: false, tall: false, small: false, raster: image.raster })
        i += image.length - 1
        continue
      }
      // GS V, the cut. Nothing a person sees.
      i += 2
      continue
    }

    if (text === '') started = { align, bold, banner, tall, small }
    text += ch
  }

  // Unconditional, so the line count matches `visibleLines`, which splits on the
  // final newline and therefore ends with an empty line of its own.
  endLine()
  return lines
}

/** Strips ESC/POS control sequences, so a test can measure printed width. */
export function visibleLines(receipt: string): string[] {
  return withoutRasters(receipt)
    .replace(/\x1B@/g, '')
    .replace(/\x1B![\s\S]/g, '')
    .replace(/\x1Ba[\s\S]/g, '')
    .replace(/\x1BE[\s\S]/g, '')
    .replace(/\x1Bd[\s\S]/g, '')
    .replace(/\x1DV[\s\S]/g, '')
    .split('\n')
}

/** An amount that means something different when it is negative. */
export function signed(amount: Money): string {
  return amount < 0 ? `-${fmtMoney(Math.abs(amount) as Money)}` : `+${fmtMoney(amount)}`
}

/** The roll with every picture taken out, so what is left is text and its codes. */
function withoutRasters(receipt: string): string {
  let out = ''
  for (let i = 0; i < receipt.length; i++) {
    const image = receipt.charCodeAt(i) === 0x1D ? readRaster(receipt, i) : null
    if (image) { i += image.length - 1; continue }
    out += receipt[i]
  }
  return out
}
