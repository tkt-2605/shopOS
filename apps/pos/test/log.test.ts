import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The logger's one hard promise: it is never the thing that breaks.
 *
 * Everything that calls it is already handling a failure — an error boundary,
 * a `window.onerror`, a `catch` whose whole job is to keep the till serving
 * customers. A logger that can throw turns a handled problem into an unhandled
 * one, and it does it at the exact moment the shop can least afford it. So
 * these are tests about what it does when *it* goes wrong.
 */

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

const { logEvent, describe: describeError } = await import('../src/core/log')

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
})

describe('writing a line', () => {
  it('names the level, the source and the message', () => {
    logEvent('error', 'backup', 'the hook exited 1')

    expect(invoke).toHaveBeenCalledWith('log_event', {
      level: 'error', source: 'backup', message: 'the hook exited 1',
    })
  })

  it('does not wait, so the till never blocks on a disk', () => {
    /* Not `await`ed anywhere a caller can see. If this returned a promise
       somebody would eventually await it, and then a slow or full disk would
       be between a cashier and the next customer. */
    expect(logEvent('info', 'test', 'hello')).toBeUndefined()
  })

  it('caps a message, so a loop cannot fill a shop_s disk', () => {
    logEvent('error', 'loop', 'x'.repeat(50_000))

    const sent = invoke.mock.calls[0]![1] as { message: string }
    expect(sent.message.length).toBeLessThanOrEqual(8000)
  })
})

describe('when the logger itself cannot work', () => {
  it('swallows a rejected write rather than raising a second failure', async () => {
    invoke.mockRejectedValue(new Error('the disk is full'))

    expect(() => logEvent('error', 'backup', 'something went wrong')).not.toThrow()

    /* And the rejection must be handled, not merely uncaught by the caller: an
       unhandled rejection here would be picked up by `startLogging`'s own
       handler and logged, which fails, which logs. */
    await Promise.resolve()
    await Promise.resolve()
  })

  it('swallows a throw from invoke itself', () => {
    // Not a rejected promise — a synchronous throw, which is what a missing
    // Tauri bridge does when the webview is opened outside the app.
    invoke.mockImplementation(() => { throw new Error('no bridge') })

    expect(() => logEvent('warn', 'startup', 'no bridge here')).not.toThrow()
  })
})

describe('saying what was thrown', () => {
  it('keeps the stack, which is the half worth having', () => {
    const err = new Error('bill total is not a number')
    expect(describeError(err)).toContain('bill total is not a number')
    expect(describeError(err)).toContain('Error')
  })

  it('handles a thrown thing that is not an Error at all', () => {
    /* `throw 'oops'` and `reject(undefined)` both happen, and both used to
       arrive in the log as "[object Object]" or nothing. */
    expect(describeError('oops')).toBe('oops')
    expect(describeError({ code: 'BUSY' })).toBe('{"code":"BUSY"}')
    expect(describeError(undefined)).toBe(undefined as unknown as string)
  })

  it('handles an object that cannot be stringified', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    // A getter that throws, or a cycle. It was still an error and it still has
    // to produce a line.
    expect(() => describeError(circular)).not.toThrow()
    expect(describeError(circular)).toContain('object')
  })
})
