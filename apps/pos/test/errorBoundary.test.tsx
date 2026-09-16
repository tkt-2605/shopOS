import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PageErrorBoundary } from '../src/ui/ErrorBoundary'
import { onGoTo } from '../src/core/nav'

/**
 * The white screen, ended.
 *
 * A render that throws with nothing above it catching unmounts the entire tree.
 * In a Tauri window that is a white rectangle: no console to open, no text to
 * read down a phone line, and the only remaining move is closing the app —
 * which for a cashier halfway through a sale is an abandoned cart and a
 * customer standing at the counter.
 */

function Boom(): never {
  throw new Error('bill total is not a number')
}

let quiet: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // React logs the caught error itself; the boundary logs it again on purpose.
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  quiet.mockRestore()
})

describe('a screen that will not draw', () => {
  it('shows the failure instead of unmounting everything around it', () => {
    render(
      <div>
        <nav>Sidebar</nav>
        <PageErrorBoundary resetKey="dashboard"><Boom /></PageErrorBoundary>
      </div>,
    )

    expect(screen.getByText('This screen could not be drawn')).toBeTruthy()
    expect(screen.getByText(/bill total is not a number/)).toBeTruthy()
    // The sidebar is outside the boundary, so the till is still navigable.
    expect(screen.getByText('Sidebar')).toBeTruthy()
  })

  it('asks the shell for Billing', () => {
    const asked: string[] = []
    const off = onGoTo((page) => asked.push(page))

    render(<PageErrorBoundary resetKey="dashboard"><Boom /></PageErrorBoundary>)
    fireEvent.click(screen.getByText('Back to Billing'))
    off()

    expect(asked).toEqual(['billing'])
  })

  it('lands back on itself when the screen throws every time', () => {
    // The button clears the crash as well as asking for the page, because
    // `goTo` is silent when the person's role was never granted Billing and
    // does nothing at all when Billing is the screen that just crashed. For a
    // one-off failure that clearing is a working screen again; for a screen
    // that throws on every render it is this — which is the point being
    // asserted, that the retry cannot strand anyone on a blank rectangle.
    render(<PageErrorBoundary resetKey="billing"><Boom /></PageErrorBoundary>)
    fireEvent.click(screen.getByText('Back to Billing'))

    // Not a white screen and not a loop the person cannot leave: the same
    // message, with the same two buttons, still inside a working sidebar.
    expect(screen.getByText('This screen could not be drawn')).toBeTruthy()
    expect(screen.getByText('Copy details')).toBeTruthy()
  })

  it('puts something in the clipboard that can be pasted into a message', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text) } },
    })

    render(<PageErrorBoundary resetKey="dashboard"><Boom /></PageErrorBoundary>)
    fireEvent.click(screen.getByText('Copy details'))
    await vi.waitFor(() => expect(written).toHaveLength(1))

    expect(written[0]).toContain('bill total is not a number')
    expect(written[0]).toContain('Screen: dashboard')
  })

  it('clears when the person moves to another screen', () => {
    const { rerender } = render(
      <PageErrorBoundary resetKey="dashboard"><Boom /></PageErrorBoundary>,
    )
    expect(screen.getByText('This screen could not be drawn')).toBeTruthy()

    // Without this, a dead Dashboard keeps showing after Billing is clicked,
    // which reads as the whole app being broken rather than one screen.
    rerender(<PageErrorBoundary resetKey="billing"><div>Billing</div></PageErrorBoundary>)
    expect(screen.getByText('Billing')).toBeTruthy()
    expect(screen.queryByText('This screen could not be drawn')).toBeNull()
  })
})
