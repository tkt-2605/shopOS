import { useEffect, useRef } from 'react'
import { anyModalOpen } from './modalStack'

/**
 * Keys that belong to a page.
 *
 * These lived inside `Billing.tsx` and were bound straight to the window, which
 * had two consequences nobody intended. Nothing else in the product had a
 * shortcut at all, because there was no way to declare one. And billing's keys
 * kept firing underneath every dialog: F12 opened the payment sheet from inside
 * the customer picker, Ctrl+W cancelled the bill behind whatever was on screen.
 *
 * So a shortcut is declared rather than bound, and two questions are answered
 * once here instead of at each `if`:
 *
 *   - **Is a dialog open?** Then the key is the dialog's, not the page's.
 *   - **Is someone typing?** A cashier searching for "Tuf 1/2" is not asking for
 *     tab one.
 *
 * Both can be overridden per shortcut, because a till needs to take a payment
 * from wherever it is — but the override has to be asked for.
 */

export interface Shortcut {
  /** As `KeyboardEvent.key` gives it: 'F12', 't', '/', '1'. Matched case-insensitively. */
  key: string
  ctrl?: boolean
  /** Fires even with a dialog open. Very little should. */
  whileModalOpen?: boolean
  /** Fires with the cursor in a text field. Almost nothing should. */
  whileTyping?: boolean
  run: () => void
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
}

/**
 * Registers for as long as the page is mounted. The list is held in a ref so
 * the listener attaches once but always runs against the current handlers,
 * rather than re-binding on every render — the pattern `Billing.tsx` already
 * used and the reason its handler could not be shared.
 */
export function useShortcuts(shortcuts: Shortcut[]): void {
  const current = useRef(shortcuts)
  current.current = shortcuts

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const typing = isTyping(e.target)
      for (const s of current.current) {
        if (s.key.toLowerCase() !== e.key.toLowerCase()) continue
        if (Boolean(s.ctrl) !== e.ctrlKey) continue
        if (anyModalOpen() && !s.whileModalOpen) continue
        if (typing && !s.whileTyping) continue
        e.preventDefault()
        s.run()
        return
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
}
