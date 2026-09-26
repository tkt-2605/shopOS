import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Which update source a build gets, and what the plugin-backed one does.
 *
 * Only a release build is given a feed (`release.yml` merges it into the
 * config), and Rust says so through `updates_enabled`. Every other build must
 * never touch the plugin, and a till that cannot even ask must go on working.
 */

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('../src/core/log', () => ({ logEvent: vi.fn(), describe: String }))

const found = {
  version: '0.2.0',
  body: 'Fixes',
  date: '2026-10-01T00:00:00Z',
  download: vi.fn(async (onEvent?: (e: { event: string; data?: { chunkLength?: number; contentLength?: number } }) => void) => {
    onEvent?.({ event: 'Started', data: { contentLength: 200 } })
    onEvent?.({ event: 'Progress', data: { chunkLength: 50 } })
    onEvent?.({ event: 'Finished' })
  }),
  install: vi.fn(async () => {}),
}
const check = vi.fn(async () => found)
const relaunch = vi.fn(async () => {})
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }))

const { updateSourceForThisBuild, tauriUpdateSource } = await import('../src/core/updater')

beforeEach(() => { vi.clearAllMocks() })

describe('the source for this build', () => {
  it('finds nothing and never loads the plugin when the build has no feed', async () => {
    invoke.mockResolvedValueOnce(false)
    const source = await updateSourceForThisBuild()
    expect(await source.check()).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })

  it('finds nothing when it cannot even ask, which is a till that is working', async () => {
    invoke.mockRejectedValueOnce(new Error('command updates_enabled not found'))
    const source = await updateSourceForThisBuild()
    expect(await source.check()).toBeNull()
  })

  it('asks the plugin when the build was given a feed', async () => {
    invoke.mockResolvedValueOnce(true)
    const source = await updateSourceForThisBuild()
    expect(await source.check()).toEqual({ version: '0.2.0', notes: 'Fixes', publishedAt: '2026-10-01T00:00:00Z' })
    expect(invoke).toHaveBeenCalledWith('updates_enabled')
  })
})

describe('the plugin-backed source', () => {
  it('downloads without installing, and installs only when asked', async () => {
    const source = tauriUpdateSource({ check }, relaunch)
    const update = await source.check()
    const progress: number[] = []
    await source.download(update!, (p) => progress.push(p))

    expect(progress).toEqual([25, 100])
    expect(found.install).not.toHaveBeenCalled()

    await source.install()
    expect(found.install).toHaveBeenCalledOnce()
    expect(relaunch).toHaveBeenCalledOnce()
  })

  it('refuses to install what it never downloaded', async () => {
    const source = tauriUpdateSource({ check: async () => null }, relaunch)
    expect(await source.check()).toBeNull()
    await expect(source.install()).rejects.toThrow('nothing downloaded')
    expect(relaunch).not.toHaveBeenCalled()
  })
})
