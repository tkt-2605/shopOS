import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MERGE_BUDGET_MS } from '@shopos/core'

/**
 * A timeout must be larger than the work it is waiting for.
 *
 * The merge asks for ninety seconds because a till a fortnight behind genuinely
 * needs them, and the socket carrying the request used to give up at sixty. So
 * the one merge the budget exists for was answered `503 NOT_READY` and had its
 * connection closed while the transaction carried on and committed — the asking
 * till reported a failure for a round that had worked, backed off, and came back
 * to spend the same ninety seconds again.
 *
 * Asserted by reading the Rust source, for the reason `joiningIsNotSettingUp`
 * reads TypeScript source: the two numbers are in two languages, nothing imports
 * one into the other, and a person changing either has no way of hearing about
 * the other. A test that built both would be a bigger machine than the thing it
 * protects.
 */

/* From the working directory rather than `import.meta.url`: this project runs in
   jsdom, where the module URL is the dev server's http one and not a path.
   Vitest is configured at the repo root, so this is stable. */
const ROOT = process.cwd()
const SYNC_SERVER = 'apps/pos/src-tauri/src/sync_server.rs'

/**
 * The seconds off a `Duration::from_secs(N)` constant.
 *
 * Read by hand rather than by regular expression, because the pattern needs
 * three kinds of escaping to survive being written down and the failure mode is
 * a test that quietly matches nothing and passes.
 */
function secondsOf(constant: string, file: string): number {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const marker = `const ${constant}: Duration = Duration::from_secs(`
  const at = source.indexOf(marker)
  expect(at, `${constant} was not found in ${file}`).toBeGreaterThan(-1)

  const from = at + marker.length
  const digits = source.slice(from, source.indexOf(')', from)).replace(/_/g, '')
  expect(digits, `${constant} is not a plain number of seconds`).toMatch(/^[0-9]+$/)
  return Number(digits)
}

describe('the timeouts a sync round passes through', () => {
  it('gives the answering side longer than the merge is allowed to take', () => {
    const answer = secondsOf('ANSWER_TIMEOUT', SYNC_SERVER) * 1000

    expect(
      answer,
      'ANSWER_TIMEOUT must exceed MERGE_BUDGET_MS, or the socket closes while the merge is still committing',
    ).toBeGreaterThan(MERGE_BUDGET_MS)
  })

  it('leaves the merge enough headroom to report its own failure', () => {
    /* The watchdog ends the transaction at the budget and `handleSyncRequest`
       then throws, which `syncHost.answer` turns into a 500. That reply still has
       to get back, so "larger" on its own is not enough. */
    const answer = secondsOf('ANSWER_TIMEOUT', SYNC_SERVER) * 1000

    expect(answer - MERGE_BUDGET_MS).toBeGreaterThanOrEqual(15_000)
  })
})
