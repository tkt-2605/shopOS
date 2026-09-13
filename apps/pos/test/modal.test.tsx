import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Modal } from '../src/ui/components'
import { useShortcuts } from '../src/core/useShortcuts'
import { resetModalStack, anyModalOpen } from '../src/core/modalStack'

/**
 * A dialog at a counter.
 *
 * Everything here was broken in the same way: the modal was a box drawn on top
 * of the page, and the keyboard never heard about it. These are the five things
 * a cashier does that used to go wrong.
 */

beforeEach(() => {
  // The stack marks this inert while anything is open, so it has to exist.
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
})

afterEach(() => {
  cleanup()
  resetModalStack()
  document.body.innerHTML = ''
})

/** A page with a button that opens a dialog, which is the shape of all of them. */
function Page({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(true)}>Choose a customer</button>
      <button>Behind</button>
      {open && (
        <Modal
          title="Choose a customer"
          onClose={() => setOpen(false)}
          footer={<button>Cancel</button>}
        >
          <input placeholder="Name or phone" />
          {children}
        </Modal>
      )}
    </div>
  )
}

describe('opening a dialog', () => {
  it('puts the keyboard in the first field, not on the page behind', () => {
    render(<Page />)
    fireEvent.click(screen.getByText('Choose a customer'))
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Name or phone'))
  })

  it('makes the page behind inert, so a stray click reaches nothing', () => {
    render(<Page />)
    expect(document.getElementById('root')!.hasAttribute('inert')).toBe(false)
    fireEvent.click(screen.getByText('Choose a customer'))
    expect(document.getElementById('root')!.hasAttribute('inert')).toBe(true)
  })

  it('hands the keyboard back to the button that opened it', () => {
    render(<Page />)
    const opener = screen.getByText('Choose a customer')
    // A browser focuses a button when it is clicked; jsdom does not, so the
    // starting state has to be the one a counter would actually be in.
    opener.focus()
    fireEvent.click(opener)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })

  it('lets the page go again once the last dialog closes', () => {
    render(<Page />)
    fireEvent.click(screen.getByText('Choose a customer'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.getElementById('root')!.hasAttribute('inert')).toBe(false)
    expect(anyModalOpen()).toBe(false)
  })
})

describe('Tab inside a dialog', () => {
  /* The whole complaint: Tab walked off into the page behind and the cashier
     could see it happening and not explain it. */
  it('comes back round to the first field instead of leaving', () => {
    render(<Page />)
    fireEvent.click(screen.getByText('Choose a customer'))

    const field = screen.getByPlaceholderText('Name or phone')
    const cancel = screen.getByText('Cancel')

    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Tab' })
    expect(document.activeElement).toBe(field)
  })

  it('goes backwards from the first field to the last, not out of the top', () => {
    render(<Page />)
    fireEvent.click(screen.getByText('Choose a customer'))

    const field = screen.getByPlaceholderText('Name or phone')
    fireEvent.keyDown(field, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('Cancel'))
  })
})

describe('two dialogs stacked', () => {
  /* A bill with its return sheet over it. Escape used to close both, because
     every modal bound its own listener to the window. */
  function Stacked() {
    const [outer, setOuter] = useState(true)
    const [inner, setInner] = useState(true)
    return (
      <>
        {outer && (
          <Modal title="The bill" onClose={() => setOuter(false)}>
            <button>Take goods back</button>
          </Modal>
        )}
        {inner && (
          <Modal title="Take goods back" onClose={() => setInner(false)}>
            <button>Refund</button>
          </Modal>
        )}
      </>
    )
  }

  it('closes only the one on top', () => {
    render(<Stacked />)
    expect(screen.getByText('Refund')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByText('Refund')).toBeNull()
    expect(screen.getByText('Take goods back')).toBeTruthy()
  })

  it('leaves the page covered while one is still open', () => {
    render(<Stacked />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.getElementById('root')!.hasAttribute('inert')).toBe(true)
  })
})

describe('a page shortcut with a dialog open', () => {
  /* F12 opened the payment sheet from inside the customer picker, and Ctrl+W
     cancelled the bill behind whatever was on screen. */
  function WithShortcut({ onPay }: { onPay: () => void }) {
    const [open, setOpen] = useState(false)
    useShortcuts([{ key: 'F12', whileTyping: true, run: onPay }])
    return (
      <div>
        <button onClick={() => setOpen(true)}>Choose a customer</button>
        {open && (
          <Modal title="Choose a customer" onClose={() => setOpen(false)}>
            <input placeholder="Name or phone" />
          </Modal>
        )}
      </div>
    )
  }

  it('stands down', () => {
    const pay = vi.fn()
    render(<WithShortcut onPay={pay} />)

    fireEvent.keyDown(window, { key: 'F12' })
    expect(pay).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Choose a customer'))
    fireEvent.keyDown(window, { key: 'F12' })
    expect(pay).toHaveBeenCalledTimes(1)
  })

  it('works again once the dialog is gone', () => {
    const pay = vi.fn()
    render(<WithShortcut onPay={pay} />)
    fireEvent.click(screen.getByText('Choose a customer'))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'F12' })
    expect(pay).toHaveBeenCalledTimes(1)
  })
})

describe('a shortcut while someone is typing', () => {
  it('does not fire on a key the cashier meant for the search box', () => {
    const scan = vi.fn()
    function Searching() {
      useShortcuts([{ key: '/', run: scan }])
      return <input placeholder="Search" />
    }
    render(<Searching />)

    const box = screen.getByPlaceholderText('Search')
    box.focus()
    fireEvent.keyDown(box, { key: '/' })
    expect(scan).not.toHaveBeenCalled()

    box.blur()
    fireEvent.keyDown(document.body, { key: '/' })
    expect(scan).toHaveBeenCalledTimes(1)
  })
})
