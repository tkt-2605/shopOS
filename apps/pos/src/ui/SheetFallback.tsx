import { useRef } from 'react'
import { Modal } from './components'

/**
 * The A4 sheet shown inside the app, for a webview that will not open a window.
 *
 * `previewBillSheet` asks for a window first, because a window is the better
 * answer: it can be pushed aside or left open beside the till, and the counter
 * behind it never moves. A webview is entitled to refuse, and refusing is not
 * something to show a shopkeeper an error about — so this is what they get
 * instead, and the only thing they lose is being able to keep it open while
 * they carry on billing.
 *
 * The frame is handed the identical string the printer would be handed. Not a
 * re-render from the same data: that would be a second implementation of the
 * layout, and the two would drift. `srcdoc` rather than a blob so the page is
 * its own document and the app's stylesheet cannot leak into what is meant to
 * be the printed sheet.
 */
export function SheetFallback({ html, docNo, onClose }: {
  html: string
  docNo: string
  onClose: () => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)

  function print() {
    /* Printed from inside the frame, so what goes to the printer is the sheet
       and not the application around it. A frame that failed to load leaves
       nothing to print, and saying nothing is better than printing the app. */
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
        is handed.
      </p>
      <iframe ref={frame} className="sheet-preview" title={`${docNo} preview`} srcDoc={html} />
    </Modal>
  )
}
