import { useCallback, useRef, useState } from 'react'

/**
 * One press, one write, and a way back if it fails.
 *
 * Every screen that moves stock or money had written this by hand, and each
 * copy was missing a piece of it. Stock In and the drawer had no guard at all,
 * so a double click received a delivery twice or closed a drawer twice. The
 * others set a `busy` flag and cleared it after the `await` -- which an error
 * skips, leaving the button on "Working…" for good with the error nowhere on
 * the screen.
 *
 * The guard is a ref, not the state: state set in one click handler is not yet
 * what the next one reads. The state is only what greys the button.
 */
export function useAction(onError: (message: string) => void): {
  busy: boolean
  run: (work: () => Promise<void>) => Promise<void>
} {
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const report = useRef(onError)
  report.current = onError

  const run = useCallback(async (work: () => Promise<void>) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    try {
      await work()
    } catch (err) {
      report.current(`That did not go through: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [])

  return { busy, run }
}
