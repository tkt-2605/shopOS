/**
 * Putting text on the clipboard, in a webview that may refuse to.
 *
 * `navigator.clipboard` needs a secure context and a user gesture, and WebView2
 * withholds it often enough that a copy button which only tries the modern API
 * is a button that silently does nothing. The old `execCommand` path still
 * works everywhere and costs a hidden textarea.
 *
 * The same shape `ErrorBoundary.tsx` has carried since Phase 0 — it is left
 * alone there deliberately, because it is the crash path and an import that
 * could fail is the last thing it needs.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Falls through rather than reporting: a person who cannot copy their
    // licence code cannot send it to support, and that is worth one more try.
  }

  try {
    const box = document.createElement('textarea')
    box.value = text
    /* Off-screen rather than hidden: `display: none` and `visibility: hidden`
       both make the selection empty, so the copy succeeds and copies nothing. */
    box.style.position = 'fixed'
    box.style.left = '-9999px'
    document.body.appendChild(box)
    box.select()
    const done = document.execCommand('copy')
    box.remove()
    return done
  } catch {
    return false
  }
}
