/**
 * The browser shortcuts that a till is not a browser for.
 *
 * Ctrl+Shift+R, Ctrl+R and F5 reload the webview. Nothing in a shop wants that:
 * the session lives in memory, so a reload signs whoever was at the counter
 * out, and the first anybody knows about it is a login screen in the middle of
 * a queue. It is not even a deliberate act most of the time — Ctrl+Shift+R is
 * two keys away from Ctrl+Shift+T, and a cashier reaching for a shortcut on a
 * keyboard they share with a browser will find it eventually.
 *
 * Only the reload keys. The temptation is to swallow Ctrl+P and Ctrl+F while
 * here, and both of those are somebody's habit that mostly works; a reload is
 * the one that throws work away.
 *
 * Left alone in development, where reloading is the whole loop. `import.meta.env.DEV`
 * is false in anything built for a shop.
 *
 * The bill on screen survives either way — drafts are rows in the database and
 * `useBillTabs` reads them back — so what a reload costs is the sign-in, not
 * the sale. That is the part worth keeping and the reason this is a guard on
 * the keys rather than a session that outlives the page.
 */
export function holdTheKeys(): () => void {
  if (import.meta.env.DEV) return () => undefined

  const listener = (e: KeyboardEvent) => {
    const reload = e.key === 'F5'
      || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')
    if (reload) e.preventDefault()
  }

  // Capture, so it is decided before any screen's own handler sees the key.
  window.addEventListener('keydown', listener, { capture: true })
  /* The app never calls this back — it holds these keys for as long as it is
     running. It is returned because a listener with no way off the window is
     one the tests cannot tell apart from the last test's. */
  return () => window.removeEventListener('keydown', listener, { capture: true })
}
