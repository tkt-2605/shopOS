import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ARTICLES, searchArticles } from '../src/help/articles'
import { RELEASE_NOTES } from '../src/help/releaseNotes'

/* The dev server's URL under jsdom, not a path: from the repo root, where Vitest runs. */
const ROOT = process.cwd()

/**
 * What the app tells a shopkeeper: help articles in English and Tamil that
 * work offline, what changed shown once after an update, and the checks that
 * say whether a shop can be helped on a bad day.
 */

const machine = new Map<string, string>()
vi.mock('../src/core/device', () => ({
  deviceSetting: (k: string) => machine.get(k) ?? null,
  setDeviceSetting: async (k: string, v: string | null) => { if (v === null) machine.delete(k); else machine.set(k, v); return true },
}))
const running = { version: '0.3.0' }
vi.mock('../src/core/version', () => ({ appVersion: async () => ({ version: running.version, schema: 72, shop: null }) }))
const { HelpArticles } = await import('../src/ui/HelpArticles')
const { WhatsNew } = await import('../src/ui/WhatsNew')

beforeEach(() => { machine.clear(); running.version = '0.3.0' })
afterEach(() => cleanup())

describe('the help articles', () => {
  it('say every step in both languages', () => {
    for (const a of ARTICLES) {
      expect(a.title.ta, a.id).not.toBe('')
      expect(a.steps.ta.length, `${a.id} has a step in one language and not the other`).toBe(a.steps.en.length)
      expect(a.steps.ta.every((s) => /[஀-௿]/.test(s)), `${a.id} Tamil is Tamil`).toBe(true)
    }
  })

  it('point at the runbook support uses for the same problem, which exists', () => {
    const runbooks = new Set(readdirSync(join(ROOT, 'docs', 'support', 'runbooks')).map((f) => f.replace(/\.md$/, '')))
    const linked = ARTICLES.filter((a) => a.runbook !== undefined)
    expect(linked.length).toBeGreaterThanOrEqual(5)
    for (const a of linked) expect(runbooks.has(a.runbook!), `${a.id} -> ${a.runbook}`).toBe(true)
  })

  it('are found by the words people use', () => {
    expect(searchArticles('paid twice', 'en').map((a) => a.id)).toContain('paid-twice')
    expect(searchArticles('anydesk', 'en').map((a) => a.id)).toEqual(['getting-help'])
    expect(searchArticles('கடவுச்சொல்', 'ta').map((a) => a.id)).toContain('forgot-password')
  })

  it('open in Tamil, and the till remembers the choice', async () => {
    render(<HelpArticles />)
    fireEvent.click(screen.getByText('தமிழ்'))
    fireEvent.click(screen.getByText('கடவுச்சொல் மறந்துவிட்டது'))
    expect(document.body.textContent).toContain('மீட்புக் குறியீட்டை')
    expect(machine.get('help_lang')).toBe('ta')
  })

  it('are in the app itself, not fetched, so they open with the line down', () => {
    const source = readFileSync(join(ROOT, 'apps', 'pos', 'src', 'ui', 'HelpArticles.tsx'), 'utf8')
    expect(source).not.toMatch(/fetch\(|invoke\(/)
  })
})

describe('what is new', () => {
  it('is shown once after an update, and not again', async () => {
    machine.set('notes_seen_version', '0.2.21')
    render(<WhatsNew />)
    expect(await screen.findByText('What is new in 0.3.0')).toBeTruthy()
    fireEvent.click(screen.getByText('Got it'))
    expect(machine.get('notes_seen_version')).toBe('0.3.0')
    cleanup()
    render(<WhatsNew />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('What is new in 0.3.0')).toBeNull()
  })

  it('is not shown on a fresh install, which only remembers its version', async () => {
    render(<WhatsNew />)
    await waitFor(() => expect(machine.get('notes_seen_version')).toBe('0.3.0'))
    expect(screen.queryByText(/What is new/)).toBeNull()
  })

  it('has notes for every version the app has been', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'apps', 'pos', 'package.json'), 'utf8')) as { version: string }).version
    expect(RELEASE_NOTES[version], `apps/pos/src/help/releaseNotes.ts has nothing for ${version}`).toBeTruthy()
    for (const [v, n] of Object.entries(RELEASE_NOTES)) {
      expect(n.points.length, v).toBeGreaterThan(0)
      expect(n.points.length, v).toBeLessThanOrEqual(6)
    }
  })
})
