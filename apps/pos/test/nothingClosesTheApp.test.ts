import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Nothing in the counter may close the counter.
 *
 * This is here because of a bug that shipped for a day and could not have been
 * caught by any ordinary test.
 *
 * An A4 preview asked for a window of its own. In a browser that opens a second
 * window. Inside a Tauri WebView2 it does not: it hands back a reference to
 * **the window already there**. So writing the invoice into it replaced the
 * running application, and the Close button drawn on that invoice shut the app
 * down. A cashier halfway through a bill lost the cart to a preview.
 *
 * Every unit test passed throughout, and they were right to: mocked, the call
 * returns whatever the mock returns and the difference between a new window and
 * the current one does not exist. The failure lives entirely in the difference
 * between a browser and the webview the shop runs, so the only thing that can
 * hold the line is a rule about the source itself.
 *
 * ## What is allowed instead
 *
 * A preview goes in an `<iframe srcdoc>` — its own document, nothing of the
 * app's leaking in, and no way to close anything but itself. Printing goes
 * through `printHtml`, which does the same in a hidden frame.
 *
 * A real second window on this platform is a Tauri `WebviewWindow`, with a
 * capability of its own and a URL rather than a string of HTML. If that is ever
 * built, it will not be built out of these three calls, and this test should
 * stay exactly as it is.
 */

/* From the working directory rather than `import.meta.url`: this project runs
   in jsdom, where the module URL is the dev server's http one and not a path.
   Vitest is configured at the repo root, so this is stable. */
const SRC = join(process.cwd(), 'apps', 'pos', 'src')

/** Calls that reach outside the page's own document. */
const FORBIDDEN = [
  {
    pattern: /\bwindow\s*\.\s*open\s*\(/,
    name: 'window.open(',
    why: 'inside a Tauri webview this returns the window that is already there, not a new one',
  },
  {
    pattern: /\bwindow\s*\.\s*close\s*\(/,
    name: 'window.close(',
    why: 'the window it closes is the application',
  },
  {
    /* One step removed and the same hazard: whichever document that turns out
       to be, it is replaced — and it has been the app's. */
    pattern: /\bdocument\s*\.\s*write\s*\(/,
    name: 'document.write(',
    why: 'it replaces whatever document it is handed, and that has been the app',
  },
] as const

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return everyFile(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * The file with its comments blanked out, line numbering intact.
 *
 * The rule is about what the code *does*, and all three calls are named in
 * prose across this codebase explaining why they are not used — at length in
 * the two files this test exists because of. A scanner that could not tell the
 * difference would make those explanations unwritable, which is the wrong way
 * round: the reason a thing is forbidden belongs next to where somebody would
 * reach for it.
 *
 * Newlines survive, so a hit still reports the line it is on.
 */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length))
}

describe('the screens', () => {
  it('never reach for a window of their own', () => {
    const found: string[] = []

    for (const file of everyFile(SRC)) {
      const lines = withoutComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        for (const rule of FORBIDDEN) {
          if (!rule.pattern.test(line)) continue
          found.push(`${file.slice(file.indexOf('src'))}:${i + 1} — ${rule.name}, ${rule.why}`)
        }
      })
    }

    expect(found).toEqual([])
  })

  it('is looking at real source, so an empty result means something', () => {
    /* A scan that silently found no files would pass the test above for ever
       while the rule went unenforced. */
    const files = everyFile(SRC)
    expect(files.length).toBeGreaterThan(30)
    expect(files.some((f) => f.endsWith('SheetPreview.tsx'))).toBe(true)
  })

  it('catches the call it was written for', () => {
    const guilty = `    view = window.open('', '_blank', 'width=900,height=1000')`
    expect(FORBIDDEN.some((r) => r.pattern.test(withoutComments(guilty)))).toBe(true)
  })

  it('catches a Close button written into a page as markup', () => {
    // How the app was actually shut down: not a call in a module, but a string
    // of HTML with an onclick on it.
    const markup = `<button type="button" onclick="window.close()">Close</button>`
    expect(FORBIDDEN.some((r) => r.pattern.test(withoutComments(markup)))).toBe(true)
  })

  it('does not fire on prose describing why the call is not used', () => {
    const doc = [
      '/**',
      ' * Why this is not a second window: window.open() hands back the window',
      ' * that is already there, and window.close() then shuts the app down.',
      ' */',
      'const safe = 1',
    ].join('\n')
    const scanned = withoutComments(doc)

    expect(FORBIDDEN.some((r) => r.pattern.test(scanned))).toBe(false)
    // Line numbering intact, so a real hit still reports where it is.
    expect(scanned.split('\n')).toHaveLength(5)
    expect(scanned.split('\n')[4]).toBe('const safe = 1')
  })
})
