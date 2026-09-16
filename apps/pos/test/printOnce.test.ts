import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * One print dialog per press.
 *
 * Two dialogs from one press is not a cosmetic fault. The second appears after
 * the shopkeeper has dealt with the first, so it reads as the machine asking to
 * print the bill a *second* time — and the safe-looking answer to that question
 * is Cancel, which is how somebody ends up with no bill at all.
 *
 * There were two causes stacked on each other, and this covers the one that
 * cannot be seen by reading the page: a frame given `srcdoc` can fire `load`
 * more than once in a webview — for the blank document it starts on and again
 * for the real one — and every one of those used to open a dialog. The other
 * cause was the page carrying a script that printed itself, which
 * `invoiceHtml.test.ts` now pins.
 */

const { printHtml } = await import('../src/core/printHtml')

let printed = 0
let frames: HTMLIFrameElement[] = []

beforeEach(() => {
  printed = 0
  frames = []

  /* jsdom has no layout and no printer, so the frame never loads on its own and
     `contentWindow.print` is not implemented. Both are stood up here: the test
     is about how many times `print` is called, not about what printing does. */
  vi.spyOn(document.body, 'appendChild').mockImplementation(((node: Node) => {
    if (node instanceof HTMLIFrameElement) {
      frames.push(node)
      Object.defineProperty(node, 'contentWindow', {
        configurable: true,
        value: { focus: () => {}, print: () => { printed += 1 } },
      })
    }
    return node
  }) as typeof document.body.appendChild)
})

afterEach(() => { vi.restoreAllMocks() })

/** Fires the frame's load handler `times` times and lets the timers run. */
async function loads(frame: HTMLIFrameElement, times: number): Promise<void> {
  for (let i = 0; i < times; i++) frame.onload?.(new Event('load'))
  await vi.advanceTimersByTimeAsync(500)
}

describe('printing a sheet', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('opens one dialog when the frame loads once', async () => {
    const done = printHtml('<!doctype html><html><body>a bill</body></html>')
    await loads(frames[0]!, 1)

    expect(await done).toEqual({ ok: true })
    expect(printed).toBe(1)
  })

  it('opens one dialog when the frame loads twice', async () => {
    /* The bug, reproduced. A webview that reports the blank document and then
       the real one used to print for each. */
    const done = printHtml('<!doctype html><html><body>a bill</body></html>')
    await loads(frames[0]!, 2)

    expect(await done).toEqual({ ok: true })
    expect(printed).toBe(1)
  })

  it('opens one dialog however many times it loads', async () => {
    const done = printHtml('<!doctype html><html><body>a bill</body></html>')
    await loads(frames[0]!, 5)

    await done
    expect(printed).toBe(1)
  })

  it('still prints again for a second, separate press', async () => {
    /* The guard is per call and not a latch on the module. A shopkeeper
       printing two copies presses twice and must get two dialogs. */
    const first = printHtml('<!doctype html><html><body>one</body></html>')
    await loads(frames[0]!, 2)
    await first

    const second = printHtml('<!doctype html><html><body>two</body></html>')
    await loads(frames[1]!, 2)
    await second

    expect(printed).toBe(2)
  })

  it('hands the page over whole, rather than writing into the frame', async () => {
    const html = '<!doctype html><html><body>a bill</body></html>'
    const done = printHtml(html)
    expect(frames[0]!.srcdoc).toBe(html)
    await loads(frames[0]!, 1)
    await done
  })

  it('says so rather than throwing when the machine will not open a dialog', async () => {
    const done = printHtml('<!doctype html><html><body>a bill</body></html>')
    Object.defineProperty(frames[0]!, 'contentWindow', {
      configurable: true,
      value: { focus: () => {}, print: () => { throw new Error('no printer') } },
    })
    await loads(frames[0]!, 1)

    expect(await done).toEqual({
      ok: false,
      message: 'This machine would not open the print dialog.',
    })
  })
})
