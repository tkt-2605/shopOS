import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { holdTheKeys } from '../src/core/holdTheKeys'

/**
 * The keys that reload the webview, and therefore sign the counter out.
 *
 * Asserted through `defaultPrevented`, which is the whole of what this does:
 * the reload itself belongs to the webview and there is nothing here to watch
 * it not happen.
 */

function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { ...init, cancelable: true, bubbles: true })
  window.dispatchEvent(e)
  return e
}

describe('holding the reload keys', () => {
  let release: () => void
  beforeEach(() => { vi.stubEnv('DEV', false); release = holdTheKeys() })
  afterEach(() => { release(); vi.unstubAllEnvs() })

  it('stops the one a cashier hits by accident', () => {
    // Ctrl+Shift+R is two keys from Ctrl+Shift+T and shares a keyboard with a
    // browser. It was signing people out mid-queue.
    expect(press({ key: 'R', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
  })

  it('stops the other ways to reload', () => {
    expect(press({ key: 'r', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: 'F5' }).defaultPrevented).toBe(true)
    expect(press({ key: 'F5', ctrlKey: true }).defaultPrevented).toBe(true)
    // A Mac keyboard on the counter is unlikely and costs one clause.
    expect(press({ key: 'r', metaKey: true }).defaultPrevented).toBe(true)
  })

  it('leaves every other key alone', () => {
    /* The temptation is to swallow Ctrl+P and Ctrl+F while here. Both are
       somebody's habit that mostly works; only a reload throws work away. */
    for (const init of [
      { key: 'r' },
      { key: 'R', shiftKey: true },
      { key: 'p', ctrlKey: true },
      { key: 'f', ctrlKey: true },
      { key: 'F12' },
      { key: 'Enter' },
    ]) {
      expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(false)
    }
  })
})

describe('in development', () => {
  it('leaves reloading alone, because that is the loop', () => {
    vi.stubEnv('DEV', true)
    const release = holdTheKeys()
    expect(press({ key: 'r', ctrlKey: true }).defaultPrevented).toBe(false)
    release()
    vi.unstubAllEnvs()
  })
})
