import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The button that writes a file meant to be forwarded.
 *
 * The redaction itself is Rust's and is tested there. What is tested here is
 * the promise the screen makes around it: that nothing leaves this machine, and
 * that a shopkeeper who changes their mind at the folder picker is not shown an
 * error for having done so.
 */

const invoke = vi.fn()
const chooseFolder = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('../src/core/backup', () => ({ chooseFolder: () => chooseFolder() }))

const { writeDiagnosticsBundle } = await import('../src/core/diagnostics')

beforeEach(() => {
  invoke.mockReset()
  chooseFolder.mockReset()
  chooseFolder.mockResolvedValue('D:\\reports')
  invoke.mockResolvedValue('D:\\reports\\shopos-diagnostics-2026-09-16-1704.zip')
})

describe('saving a report', () => {
  it('writes it where the shopkeeper chose, and says where', async () => {
    const result = await writeDiagnosticsBundle(new Date('2026-09-16T17:04:11Z'))

    expect(invoke).toHaveBeenCalledWith('diagnostics_bundle', {
      destination: 'D:\\reports',
      now: '2026-09-16T17:04:11.000Z',
    })
    expect(result).toEqual({
      ok: true,
      path: 'D:\\reports\\shopos-diagnostics-2026-09-16-1704.zip',
    })
  })

  it('asks where to put it before it builds anything', async () => {
    /* A file full of a shop's history must not be written to a folder nobody
       picked. There is no default location on purpose. */
    chooseFolder.mockResolvedValue(null)

    await writeDiagnosticsBundle()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('treats a closed picker as a decision, not a failure', async () => {
    chooseFolder.mockResolvedValue(null)

    /* Somebody who thought better of it gets no error message. The screen
       distinguishes these so it can say nothing at all. */
    expect(await writeDiagnosticsBundle()).toEqual({ ok: false, cancelled: true })
  })

  it('sends nothing anywhere', async () => {
    await writeDiagnosticsBundle()

    /* The card promises this in so many words, and the promise is worth a test:
       the only call is the one that writes a local file. A future edit that
       posted the bundle somewhere would fail here, which is the point. */
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0]![0]).toBe('diagnostics_bundle')
  })

  it('reports a refusal in the words Rust used', async () => {
    invoke.mockRejectedValue('D:\\reports is not a folder')

    expect(await writeDiagnosticsBundle()).toEqual({
      ok: false, cancelled: false, error: 'D:\\reports is not a folder',
    })
  })

  it('has something to say when the failure is not a string', async () => {
    invoke.mockRejectedValue(new Error('disk full'))

    const result = await writeDiagnosticsBundle()
    expect(result).toMatchObject({ ok: false, cancelled: false })
    if (!result.ok && !result.cancelled) {
      expect(result.error).toBe('The report could not be written.')
    }
  })
})
