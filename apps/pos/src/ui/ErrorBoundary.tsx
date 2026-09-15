import { Component, type ErrorInfo, type ReactNode } from 'react'
import { goTo } from '../core/nav'

/**
 * The screen a render crash lands on, instead of the white one.
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * In a browser that is a blank tab and a stack trace in a console somebody can
 * open; in a Tauri window at a counter it is a white rectangle, no console, no
 * text to read down a phone line, and the only move left is to close the app —
 * which for a cashier mid-sale means an abandoned cart and a customer waiting.
 *
 * So: the message stays on the screen, the sidebar around it keeps working
 * because the boundary sits inside `main` rather than around the shell, and
 * the two things the person actually needs are buttons. "Copy details" puts
 * something in the clipboard that can be pasted into a message — a stack trace
 * read aloud is a stack trace transcribed wrongly. "Back to Billing" remounts
 * a screen known to work, so the till is selling again without a restart.
 *
 * Reported through `console.error` for now; this is one of the call sites that
 * moves to the Phase 3 logger, which is what turns "it crashed once last week"
 * into a line in a file with a timestamp.
 */

interface Props {
  children: ReactNode
  /** Changes when the page does, so a new page clears a previous page's crash. */
  resetKey: string
}

interface State {
  error: Error | null
  stack: string | null
}

export class PageErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, stack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? null })
    // TODO(phase-3): through the logger, so it survives the window closing.
    console.error('A screen could not be drawn:', error, info.componentStack)
  }

  override componentDidUpdate(previous: Props): void {
    // Moving to another screen clears the last one's crash. Without this the
    // boundary keeps showing a dead Dashboard after the person has clicked
    // Billing, which reads as the whole app being broken rather than one page.
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, stack: null })
    }
  }

  private details(): string {
    const { error, stack } = this.state
    return [
      `ShopOS — a screen could not be drawn`,
      `Screen: ${this.props.resetKey}`,
      `When: ${new Date().toISOString()}`,
      ``,
      `${error?.name ?? 'Error'}: ${error?.message ?? 'unknown'}`,
      ``,
      error?.stack ?? '(no stack)',
      ``,
      `Component stack:${stack ?? ' (none)'}`,
    ].join('\n')
  }

  /**
   * Clears the crash as well as asking for the page, because the two are not
   * the same. `goTo` is silent when the person's role was never granted Billing
   * and does nothing at all when Billing is the screen that just crashed — in
   * both cases the button would sit there doing visibly nothing, which is worse
   * than the white screen it replaced. Clearing first makes it at minimum a
   * retry, and a render that throws again lands back here.
   */
  private backToBilling(): void {
    this.setState({ error: null, stack: null })
    goTo('billing')
  }

  private async copy(): Promise<void> {
    const text = this.details()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // A webview that refuses the clipboard API still has the old path, and a
      // person who cannot copy the error cannot report it.
      const box = document.createElement('textarea')
      box.value = text
      document.body.appendChild(box)
      box.select()
      document.execCommand('copy')
      box.remove()
    }
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="card" style={{ padding: 18, maxWidth: 720 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>This screen could not be drawn</h2>
        <p style={{ fontSize: 12.5, color: 'var(--ink-3)', margin: '0 0 13px' }}>
          Nothing has been lost — bills already saved are saved. Go back to Billing to
          carry on selling, and send the details so this can be fixed.
        </p>

        <pre style={{
          fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap',
          background: 'var(--surface-2)', padding: 11, margin: '0 0 13px',
          maxHeight: 220, overflow: 'auto',
        }}>
          {error.name}: {error.message}
        </pre>

        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn primary" onClick={() => this.backToBilling()}>Back to Billing</button>
          <button className="btn" onClick={() => void this.copy()}>Copy details</button>
        </div>
      </div>
    )
  }
}
