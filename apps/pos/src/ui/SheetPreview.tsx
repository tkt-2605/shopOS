import { useRef } from 'react'
import { Modal } from './components'

/**
 * The A4 sheet, shown before it is printed.
 *
 * ## Why this is not a second window
 *
 * It was, for about a day, and the way it failed is the reason it never will be
 * again without a real one.
 *
 * `window.open('', '_blank')` inside a Tauri WebView2 does not open a second
 * window. It hands back a reference to **the window that is already there** —
 * so `document.write` replaced the running application with the invoice, and
 * the Close button on it called `window.close()` and shut the app down. A
 * cashier halfway through a bill would have lost the cart to a preview.
 *
 * A genuine second window on this platform means a Tauri `WebviewWindow`, which
 * needs a capability of its own and a URL to load rather than a string of HTML.
 * That is a real piece of work and it is not this one. Until it exists, the
 * preview lives here — over the screen that asked for it, with the counter
 * intact behind it, and with no way to close anything but itself.
 *
 * ## It is the page, not a picture of the page
 *
 * The frame is handed the identical string the printer is handed. Not a
 * re-render from the same data: that would be a second implementation of the
 * layout, and the two would drift — which is the exact shape of the bug that
 * printed the shop's own state as the place of supply on every invoice while
 * every test of the renderer passed, because each one built its document by
 * hand.
 *
 * `srcdoc` rather than a blob or a written document, so the sheet is its own
 * document and the app's stylesheet cannot leak into what is meant to be the
 * printed page.
 */
export function SheetPreview({ html, docNo, onClose }: {
  html: string
  docNo: string
  onClose: () => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)

  function print() {
    /* Printed from inside the frame, so what reaches the printer is the sheet
       and not the application around it. A frame that failed to load leaves
       nothing to print, and printing nothing is better than printing the app. */
    const view = frame.current?.contentWindow
    if (!view) return
    view.focus()
    view.print()
  }

  return (
    <Modal
      title={`${docNo} — A4 sheet`}
      wide
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" onClick={print}>Print</button>
      </>}
    >
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
        This is the page itself, not a drawing of it — the same HTML the printer
        is handed. Closing this leaves the bill exactly as it is.
      </p>
      <iframe ref={frame} className="sheet-preview tall" title={`${docNo} preview`} srcDoc={html} />
    </Modal>
  )
}
