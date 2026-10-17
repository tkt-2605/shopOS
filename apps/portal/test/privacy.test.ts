import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { handle } from '../src/http.js'
import { PRIVACY } from '../src/legal/privacy.js'
import { KEEP_DAYS, ABANDONED_DAYS } from '../src/data/store.js'
import { KEEP_PER_TILL } from '../src/health/store.js'
import { testPortal } from './support.js'

/**
 * What the owner is told, held to what the code does: the periods in the
 * notice are the code's own, the repository's copy is the portal's text, and
 * the page is served.
 */

const doc = (name: string) => readFileSync(new URL(`../../../docs/legal/${name}`, import.meta.url), 'utf8')

describe('the privacy notice', () => {
  it('says the periods the code keeps things for', () => {
    const text = PRIVACY.flatMap((s) => s.paragraphs).join(' ')
    expect(text).toContain(`last ${KEEP_PER_TILL} reports`)
    expect(text).toContain(`${KEEP_DAYS} days after they arrive`)
    expect(text).toContain(`${ABANDONED_DAYS} days after an upload`)
  })

  it('is the same in the repository as on the portal', () => {
    const md = doc('privacy-notice.md')
    for (const s of PRIVACY) {
      expect(md, `regenerate with apps/portal/src/legal/write-notice.ts`).toContain(`## ${s.heading}`)
      for (const p of s.paragraphs) expect(md).toContain(p)
    }
  })

  it('agrees with the processing agreement on how long data sent to support is kept', () => {
    expect(doc('data-processing.md')).toContain(`Deleted ${KEEP_DAYS} days after it arrives; ${ABANDONED_DAYS} days`)
  })

  it('is served at /privacy, to anybody', async () => {
    const p = await testPortal()
    try {
      const page = await handle(p, { method: 'GET', path: '/privacy', query: new URLSearchParams(), headers: {}, body: null })
      expect(page.status).toBe(200)
      expect(String(page.body)).toContain('The daily health report')
    } finally {
      await p.close()
    }
  })
})
