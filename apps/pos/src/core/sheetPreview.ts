/**
 * The A4 sheet, shown before it is printed, without losing the counter.
 *
 * ## What this replaces
 *
 * "Print sheet" went straight to the operating system's print dialog. That is
 * right for printing and wrong for looking: a shopkeeper who wants to check
 * what a customer is about to be handed had to open a dialog built for choosing
 * trays, read the thumbnail in it, and cancel. And there was nowhere at all to
 * do it from the billing screen, where the question is asked most.
 *
 * ## Why a window rather than a panel
 *
 * The bill that is half rung up is the thing that must not be disturbed. A
 * preview taking over the screen means the cashier's cart is gone from in front
 * of them while a customer waits, and going "back" from a preview is a
 * navigation nobody should have to think about mid-sale. A separate window can
 * be pushed aside, left open beside the till, or closed — and the counter never
 * moved.
 *
 * ## Why the same HTML, and not a drawing of it
 *
 * `buildInvoiceHtml` is handed to the printer verbatim. A preview that rebuilt
 * the page from the same data would be a second implementation of the layout,
 * and the two would drift — which is the exact shape of the bug that put the
 * shop's own state on every invoice as the place of supply while every test of
 * the renderer passed. So this shows the page itself. What is on the screen is
 * what comes out of the printer, because it is the same document.
 *
 * ## When a window cannot be had
 *
 * A webview may refuse `window.open` outright, and returns null when it does.
 * That is not a failure worth showing a shopkeeper an error about, so the
 * caller is told which way it went and falls back to a panel inside the app.
 * Both paths render the identical string.
 */

export type PreviewOutcome =
  /** A separate window is showing it. */
  | { shown: 'window' }
  /** No window could be opened; the caller should show it in the app instead. */
  | { shown: 'blocked' }

/**
 * A small bar above the page, so the window is worth having open.
 *
 * Inside the previewed document rather than around it, because there is no
 * "around it" — the window holds one document. `@media print` hides it, so
 * printing from here produces the sheet and nothing else.
 */
const TOOLBAR = `
<style>
  .preview-bar {
    position: sticky; top: 0; z-index: 9;
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    font: 13px/1.4 'Segoe UI', system-ui, sans-serif;
    color: #f4f2ec; background: #1d2a28;
  }
  .preview-bar button {
    font: inherit; font-weight: 600;
    padding: 5px 14px; color: #1d2a28; background: #f4f2ec;
    border: 1px solid #f4f2ec; border-radius: 0; cursor: pointer;
  }
  .preview-bar .spacer { flex: 1; }
  .preview-bar .what { opacity: 0.75; }
  @media print { .preview-bar { display: none; } }
</style>
<div class="preview-bar">
  <button type="button" onclick="window.print()">Print</button>
  <button type="button" onclick="window.close()">Close</button>
  <span class="spacer"></span>
  <span class="what">This is the page itself, not a drawing of it.</span>
</div>`

/**
 * Opens `html` in a window of its own and returns which way it went.
 *
 * `document.write` rather than a `srcdoc` or a blob URL: the window has to be
 * the app's own document for `window.print()` inside it to be reachable, and a
 * blob URL is a separate origin that a strict CSP will refuse to navigate to.
 */
export function openSheetPreview(html: string, title: string): PreviewOutcome {
  let view: Window | null = null
  try {
    // `noopener` is deliberately *not* passed: it nulls the handle, and the
    // handle is how the page gets written.
    view = window.open('', '_blank', 'width=900,height=1000')
  } catch {
    // Some webviews throw rather than returning null. Same answer either way.
    view = null
  }
  if (!view) return { shown: 'blocked' }

  try {
    view.document.open()
    view.document.write(withToolbar(html, title))
    view.document.close()
    view.focus()
    return { shown: 'window' }
  } catch {
    try { view.close() } catch { /* it may already be gone */ }
    return { shown: 'blocked' }
  }
}

/**
 * The printed page with a bar on top of it.
 *
 * Injected after `<body>` rather than concatenated, so the sheet's own
 * `<head>` — which carries the `@page` size and every rule that makes it A4 —
 * is untouched. A preview whose page box differed from the print's would be the
 * one thing this must never be.
 */
export function withToolbar(html: string, title: string): string {
  const titled = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeHtml(title)}</title>`,
  )
  const at = titled.search(/<body[^>]*>/i)
  if (at < 0) return TOOLBAR + titled

  const after = at + titled.slice(at).indexOf('>') + 1
  return titled.slice(0, after) + TOOLBAR + titled.slice(after)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  ))
}
