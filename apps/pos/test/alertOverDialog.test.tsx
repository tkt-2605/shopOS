import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { useState } from 'react'
import { Alert, Modal } from '../src/ui/components'
import { resetModalStack } from '../src/core/modalStack'

/**
 * A page's message, raised while a dialog is open over it.
 *
 * Found on the item form: a barcode another item has was refused, and the
 * refusal appeared on the Inventory page behind the form, where nothing can be
 * seen or clicked -- so saving looked like it did nothing. The message has to
 * be in the dialog while the dialog is open, and back on the page after.
 */

afterEach(() => { cleanup(); resetModalStack() })

function Page({ open, notice }: { open: boolean; notice: string | null }) {
  const [, rerender] = useState(0)
  return (
    <div data-testid="page">
      {notice && <Alert kind="warn">{notice}</Alert>}
      <button type="button" onClick={() => rerender((n) => n + 1)}>again</button>
      {open && (
        <Modal title="Edit item" onClose={() => undefined}>
          <input aria-label="Name" />
          <Alert>Written inside the dialog</Alert>
        </Modal>
      )}
    </div>
  )
}

const inDialog = (text: string) => Boolean(screen.getByText(text).closest('[role="dialog"]'))

describe('a page message while a dialog is open', () => {
  it('shows in the dialog on top, not on the page behind it', () => {
    render(<Page open notice="That barcode is on Gel pen. Nothing was saved." />)
    expect(inDialog('That barcode is on Gel pen. Nothing was saved.')).toBe(true)
  })

  it('goes back to the page when the dialog closes', () => {
    const { rerender } = render(<Page open notice="Saved." />)
    rerender(<Page open={false} notice="Saved." />)
    expect(inDialog('Saved.')).toBe(false)
    expect(screen.getByTestId('page').textContent).toContain('Saved.')
  })

  it('stays where it is when it was written inside the dialog', () => {
    render(<Page open notice={null} />)
    const own = screen.getByText('Written inside the dialog')
    expect(own.closest('.modal-notices')).toBeNull()
    expect(inDialog('Written inside the dialog')).toBe(true)
  })

  it('stays on the page when no dialog is open', () => {
    render(<Page open={false} notice="Saved." />)
    expect(inDialog('Saved.')).toBe(false)
  })
})
