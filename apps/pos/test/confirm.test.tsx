import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useConfirm } from '../src/ui/useConfirm'
import { resetModalStack } from '../src/core/modalStack'

/**
 * Asking before something destructive.
 *
 * Five call sites cancelled bills, cancelled payments and reversed stock counts
 * behind `if (!window.confirm(...)) return`. Tauri's dialog plugin replaces
 * `window.confirm` in the webview with an **async** function, so every one of
 * those guards was testing a promise for truthiness — which it always is. No
 * dialog was drawn and the destructive action went ahead every time.
 *
 * That is the worst failure this product has: a switch that is on and does
 * nothing. These tests exist so it cannot come back quietly.
 */

beforeEach(() => {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
})

afterEach(() => {
  cleanup()
  resetModalStack()
  document.body.innerHTML = ''
})

/** The shape every call site has: a destructive action behind a question. */
function Page({ onDone }: { onDone: (answer: boolean) => void }) {
  const [confirmUi, ask] = useConfirm()
  return (
    <div>
      {confirmUi}
      <button
        onClick={() => {
          void (async () => {
            if (!(await ask('Cancel this bill? 3 items will be discarded.'))) {
              onDone(false)
              return
            }
            onDone(true)
          })()
        }}
      >
        Cancel this bill
      </button>
    </div>
  )
}

describe('a question before something that cannot be undone', () => {
  it('is actually asked, and the words are the ones the caller chose', async () => {
    const answers: boolean[] = []
    render(<Page onDone={(a) => answers.push(a)} />)

    fireEvent.click(screen.getByText('Cancel this bill'))

    expect(await screen.findByText(/3 items will be discarded/)).toBeTruthy()
    // Nothing has happened yet, which is the entire point.
    expect(answers).toEqual([])
  })

  it('goes ahead only when the person says so', async () => {
    const answers: boolean[] = []
    render(<Page onDone={(a) => answers.push(a)} />)

    fireEvent.click(screen.getByText('Cancel this bill'))
    await screen.findByText(/3 items will be discarded/)

    await act(async () => {
      fireEvent.click(screen.getByText('Yes, go ahead'))
    })
    expect(answers).toEqual([true])
  })

  it('stops when they say no, rather than leaving the caller waiting', async () => {
    const answers: boolean[] = []
    render(<Page onDone={(a) => answers.push(a)} />)

    fireEvent.click(screen.getByText('Cancel this bill'))
    await screen.findByText(/3 items will be discarded/)

    await act(async () => {
      fireEvent.click(screen.getByText('No, leave it'))
    })
    expect(answers).toEqual([false])
  })

  it('treats Escape as no, like every other dialog in the product', async () => {
    const answers: boolean[] = []
    render(<Page onDone={(a) => answers.push(a)} />)

    fireEvent.click(screen.getByText('Cancel this bill'))
    await screen.findByText(/3 items will be discarded/)

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(answers).toEqual([false])
  })

  it('lands the keyboard on the safe button, not the destructive one', async () => {
    render(<Page onDone={() => undefined} />)

    fireEvent.click(screen.getByText('Cancel this bill'))
    await screen.findByText(/3 items will be discarded/)

    // Enter on a dialog that has just appeared under someone's hands must not
    // destroy anything.
    expect(document.activeElement?.textContent).toBe('No, leave it')
  })

  it('answers no when the screen goes away with the question still open', async () => {
    // A promise that never settles leaves its caller suspended for ever, still
    // holding a busy flag and a disabled button.
    const answers: boolean[] = []
    const view = render(<Page onDone={(a) => answers.push(a)} />)

    fireEvent.click(screen.getByText('Cancel this bill'))
    await screen.findByText(/3 items will be discarded/)

    await act(async () => {
      view.unmount()
    })
    expect(answers).toEqual([false])
  })

  it('asks again the next time, rather than remembering the last answer', async () => {
    const answers: boolean[] = []
    render(<Page onDone={(a) => answers.push(a)} />)

    for (const [click, expected] of [['Yes, go ahead', true], ['No, leave it', false]] as const) {
      fireEvent.click(screen.getByText('Cancel this bill'))
      await screen.findByText(/3 items will be discarded/)
      await act(async () => {
        fireEvent.click(screen.getByText(click))
      })
      expect(answers[answers.length - 1]).toBe(expected)
    }
    expect(answers).toEqual([true, false])
  })
})
