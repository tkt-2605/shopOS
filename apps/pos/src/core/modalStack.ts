/**
 * Which dialog the keyboard belongs to.
 *
 * A modal that does not own the keyboard is a trap at a counter. Before this
 * existed, opening the customer picker left every page shortcut live behind it:
 * F12 opened the payment dialog from inside the picker, Ctrl+W cancelled the
 * bill underneath, and Escape — bound to the window by every modal at once —
 * closed the whole stack instead of the one on top.
 *
 * So there is one stack, and two questions anyone can ask it:
 *
 *   - `isTopModal(id)` — am I the one that should answer this key?
 *   - `anyModalOpen()` — should a page shortcut stay out of the way?
 *
 * A module-level stack rather than a context, for the same reason `repeat.ts`
 * is one: the page shortcuts are registered outside any dialog's tree, so there
 * is nothing to read a provider from.
 *
 * The stack also owns what happens to the page behind, because it is the only
 * thing that knows when the last dialog closes: the app root is made `inert`
 * while anything is open, so a stray click, a screen reader and the tab order
 * all stop at the backdrop rather than the component having to guess.
 */

let stack: string[] = []
const listeners = new Set<() => void>()

/** Where the rest of the app lives. Everything else is portalled above it. */
function appRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('root')
}

/**
 * Covered or not. Called on every change rather than on a count, so a double
 * mount — React's strict mode does exactly that — cannot leave the page inert
 * with nothing on top of it.
 */
function reflect(): void {
  const root = appRoot()
  if (!root) return
  const covered = stack.length > 0
  if (covered) root.setAttribute('inert', '')
  else root.removeAttribute('inert')
  if (typeof document !== 'undefined') {
    document.body.style.overflow = covered ? 'hidden' : ''
  }
}

function announce(): void {
  reflect()
  for (const listener of listeners) listener()
}

export function pushModal(id: string): void {
  if (stack.includes(id)) return
  stack.push(id)
  announce()
}

export function popModal(id: string): void {
  const next = stack.filter((entry) => entry !== id)
  if (next.length === stack.length) return
  stack = next
  announce()
}

/** The one on top answers Escape. Everyone below it stays quiet. */
export function isTopModal(id: string): boolean {
  return stack[stack.length - 1] === id
}

/** Asked by page shortcuts before they act on a key. */
export function anyModalOpen(): boolean {
  return stack.length > 0
}

export function modalDepth(): number {
  return stack.length
}

export function onModalStackChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** For tests, which share a module between cases. */
export function resetModalStack(): void {
  stack = []
  reflect()
}
