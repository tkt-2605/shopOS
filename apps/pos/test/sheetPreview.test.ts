import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openSheetPreview, withToolbar } from '../src/core/sheetPreview'

/**
 * The A4 preview, and the one property that makes it worth having.
 *
 * A preview is only useful if it is the page. A preview built by re-rendering
 * the same data through a second path is a second implementation of the layout,
 * and the two drift — which is the exact shape of the bug that printed the
 * shop's own state as the place of supply on every invoice while every test of
 * the renderer passed, because each one built its document by hand.
 *
 * So what is tested here is that the sheet's own `<head>` survives untouched:
 * that is where `@page` lives, and a preview whose page box differs from the
 * print's is the one thing this must never be.
 */

const SHEET = [
  '<!doctype html><html><head><title>Invoice</title>',
  '<style>@page { size: A4; margin: 0; } .sheet { padding: 12mm; }</style>',
  '</head><body class="paper"><table class="page"><tr><td>TAX INVOICE</td></tr></table></body></html>',
].join('')

describe('the bar the preview window carries', () => {
  it('leaves the page box exactly as the printer would get it', () => {
    const shown = withToolbar(SHEET, 'BMR/2627/00023')

    expect(shown).toContain('@page { size: A4; margin: 0; }')
    expect(shown).toContain('.sheet { padding: 12mm; }')
    expect(shown).toContain('TAX INVOICE')
  })

  it('goes inside the body and not in front of the document', () => {
    /* Concatenated onto the front, the bar would sit before `<!doctype>` and
       tip the browser into quirks mode — where the page box is whatever the
       browser feels like and the preview stops being the page. */
    const shown = withToolbar(SHEET, 'BMR/2627/00023')

    expect(shown.startsWith('<!doctype html>')).toBe(true)
    expect(shown.indexOf('preview-bar')).toBeGreaterThan(shown.indexOf('<body'))
    expect(shown.indexOf('preview-bar')).toBeLessThan(shown.indexOf('TAX INVOICE'))
  })

  it('hides itself when the window is printed', () => {
    // Printing from the preview must produce the sheet and not the sheet with a
    // black bar across the top of it.
    expect(withToolbar(SHEET, 'x')).toMatch(/@media print\s*\{\s*\.preview-bar\s*\{\s*display:\s*none/)
  })

  it('names the window after the document, so two of them can be told apart', () => {
    expect(withToolbar(SHEET, 'BMR/2627/00023')).toContain('<title>BMR/2627/00023</title>')
    expect(withToolbar(SHEET, 'BMR/2627/00023')).not.toContain('<title>Invoice</title>')
  })

  it('escapes a document number rather than letting it close the tag', () => {
    expect(withToolbar(SHEET, '</title><script>bad()</script>')).not.toContain('<script>bad()')
  })

  it('still shows something when the page has no body tag at all', () => {
    const shown = withToolbar('<p>a fragment</p>', 'x')
    expect(shown).toContain('preview-bar')
    expect(shown).toContain('a fragment')
  })
})

describe('asking for a window', () => {
  const original = window.open

  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { window.open = original })

  function fakeWindow() {
    return {
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      close: vi.fn(),
    } as unknown as Window
  }

  it('writes the page into the window it was given', () => {
    const view = fakeWindow()
    window.open = vi.fn(() => view)

    expect(openSheetPreview(SHEET, 'BMR/2627/00023')).toEqual({ shown: 'window' })
    const written = (view.document.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    expect(written).toContain('@page { size: A4; margin: 0; }')
    expect(view.focus).toHaveBeenCalled()
  })

  it('says it was blocked rather than throwing when no window is given', () => {
    /* A webview is entitled to refuse, and returns null when it does. That is
       not a failure worth showing a shopkeeper an error about — the caller
       shows the page in the app instead. */
    window.open = vi.fn(() => null)
    expect(openSheetPreview(SHEET, 'x')).toEqual({ shown: 'blocked' })
  })

  it('says the same when the webview throws instead of returning null', () => {
    window.open = vi.fn(() => { throw new Error('not allowed') })
    expect(openSheetPreview(SHEET, 'x')).toEqual({ shown: 'blocked' })
  })

  it('closes a window it could not write to, rather than leaving a blank one', () => {
    const view = fakeWindow()
    ;(view.document.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('cross-origin')
    })
    window.open = vi.fn(() => view)

    expect(openSheetPreview(SHEET, 'x')).toEqual({ shown: 'blocked' })
    expect(view.close).toHaveBeenCalled()
  })

  it('does not ask for noopener, which would take the handle away', () => {
    /* `noopener` nulls the return value, and the return value is the only way
       the page gets written. Asking for it would make every preview look
       blocked while leaving an empty window on screen. */
    const view = fakeWindow()
    const open = vi.fn(() => view)
    window.open = open

    openSheetPreview(SHEET, 'x')
    expect(String(open.mock.calls[0]![2] ?? '')).not.toContain('noopener')
  })
})
