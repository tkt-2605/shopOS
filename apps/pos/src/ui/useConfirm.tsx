import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './components'

/**
 * Asking before something destructive, in the app rather than through the
 * browser.
 *
 * `window.confirm` cannot be used here and the reason is worth keeping. Tauri's
 * dialog plugin replaces it in the webview with this:
 *
 *     window.confirm = async function (m) {
 *       return await invoke('plugin:dialog|confirm', { message: m.toString() })
 *     }
 *
 * It returns a **promise**. Every call site in this app was written as
 * `if (!window.confirm(...)) return`, and a promise is always truthy, so the
 * guard never fired: cancelling a bill, cancelling a payment and reversing a
 * stock count all went ahead without asking anyone, and no dialog was ever
 * drawn. On top of that the promise rejected unheard, because `dialog:default`
 * grants `allow-message`, `allow-save` and `allow-open` and not `allow-confirm`.
 *
 * Granting the permission would have been the smaller half of a fix and the more
 * dangerous one — the dialog would appear and the answer would still be ignored.
 * So the question is asked in the app instead, which also keeps it inside the
 * focus trap and on the keyboard, where the rest of this product lives.
 *
 *     const [confirmUi, ask] = useConfirm()
 *     if (!(await ask('Throw away this count sheet?'))) return
 *     ...
 *     return <>{confirmUi}<div>…</div></>
 */

export interface ConfirmRequest {
  message: string
  /** The words on the button that goes ahead. Say what it does, not "OK". */
  confirmLabel?: string
  /** The words on the button that does not. */
  cancelLabel?: string
  title?: string
}

export type Ask = (request: string | ConfirmRequest) => Promise<boolean>

interface Pending {
  request: Required<Omit<ConfirmRequest, 'message'>> & { message: string }
  settle: (answer: boolean) => void
}

export function useConfirm(): [ReactNode, Ask] {
  const [pending, setPending] = useState<Pending | null>(null)
  const keep = useRef<HTMLButtonElement>(null)

  /* A promise that never settles leaves its caller suspended for ever, still
     holding whatever it was holding — a busy flag, a disabled button, a bill it
     meant to cancel. If this unmounts with a question open, the answer is no. */
  const live = useRef<Pending | null>(null)
  live.current = pending
  useEffect(() => () => live.current?.settle(false), [])

  const ask = useCallback<Ask>((request) => {
    const asked = typeof request === 'string' ? { message: request } : request
    return new Promise<boolean>((resolve) => {
      setPending({
        request: {
          message: asked.message,
          title: asked.title ?? 'Are you sure?',
          confirmLabel: asked.confirmLabel ?? 'Yes, go ahead',
          cancelLabel: asked.cancelLabel ?? 'No, leave it',
        },
        settle: resolve,
      })
    })
  }, [])

  function answer(value: boolean) {
    pending?.settle(value)
    setPending(null)
  }

  const ui = pending === null ? null : (
    <Modal
      title={pending.request.title}
      onClose={() => answer(false)}
      // The safe button is the one the keyboard lands on. Enter on a dialog that
      // has just appeared under someone's hands must not destroy anything, and
      // Escape already means no through the Modal's own handler.
      initialFocus={keep}
      footer={
        <>
          <button ref={keep} className="btn" onClick={() => answer(false)}>
            {pending.request.cancelLabel}
          </button>
          <button className="btn danger" onClick={() => answer(true)}>
            {pending.request.confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{pending.request.message}</div>
    </Modal>
  )

  return [ui, ask]
}
