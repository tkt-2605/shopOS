import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * A backup that failed, said so.
 *
 * Every assertion in this file is about the same shape of bug: something in the
 * backup path went wrong, and the screen showed the state it shows when nothing
 * has gone wrong. An unreadable folder read as "no backups yet". A carry-off
 * command exiting 1 read as nothing at all. A machine left on for a fortnight
 * read as a shop that had taken one backup and was fine.
 *
 * None of these are crashes, so none of them would have been found by a test
 * that only checks the happy path returns something.
 */

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

const deviceSettings = new Map<string, string>()
vi.mock('../src/core/device', () => ({
  deviceSetting: (key: string) => deviceSettings.get(key) ?? null,
  setDeviceSetting: async (key: string, value: string | null) => {
    if (value === null || value === '') deviceSettings.delete(key)
    else deviceSettings.set(key, value)
    return true
  },
}))

const {
  listBackups, describeBackups, backupFolderProblem,
  runDailyBackup, recordHookRun, lastHookRun, onHookResult,
  msUntilHour, startDailyBackupTimer, LAST_HOOK_SETTING, HOOK_SETTING,
} = await import('../src/core/backup')

const db = {} as never

beforeEach(() => {
  invoke.mockReset()
  deviceSettings.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('an unreadable backup folder', () => {
  it('throws rather than answering with an empty list', async () => {
    invoke.mockRejectedValue('The system cannot find the path specified. (os error 3)')

    await expect(listBackups()).rejects.toBeTruthy()
    await expect(describeBackups()).rejects.toBeTruthy()
  })

  it('names the folder trouble rather than reporting nothing to restore', () => {
    const message = backupFolderProblem('os error 3')
    expect(message).toContain('Could not read the backup folder')
    expect(message).toContain('os error 3')
  })

  it('does not let the daily run write into a folder it cannot list', async () => {
    invoke.mockRejectedValue('os error 3')

    const result = await runDailyBackup(db, new Date('2026-03-04T09:00:00'))

    // The dangerous reading of an empty list is "no backup today, take one" —
    // which would write into a folder nobody can read and then prune from a
    // list that is missing rows.
    expect(result.created).toBeNull()
    expect(result.pruned).toEqual([])
    expect(result.error).toContain('Could not read the backup folder')
    expect(invoke).not.toHaveBeenCalledWith('backup_write_zip', expect.anything())
  })
})

describe('the carry-off command', () => {
  it('records a failure where a screen can read it back', async () => {
    invoke.mockResolvedValue({ ok: false, code: 1, output: 'directory not found' })

    const run = await recordHookRun('rclone copy {file} gdrive:shopos', '2026-03-04.zip')

    expect(run.ok).toBe(false)
    expect(run.code).toBe(1)
    expect(deviceSettings.has(LAST_HOOK_SETTING)).toBe(true)

    const stored = lastHookRun()
    expect(stored?.ok).toBe(false)
    expect(stored?.code).toBe(1)
    expect(stored?.output).toBe('directory not found')
    expect(typeof stored?.at).toBe('string')
  })

  it('records a command that could not be run at all', async () => {
    invoke.mockRejectedValue('program not found')

    const run = await recordHookRun('rclne copy {file} x:', '2026-03-04.zip')

    expect(run.ok).toBe(false)
    expect(run.code).toBeNull()
    expect(run.output).toBe('program not found')
    expect(lastHookRun()?.ok).toBe(false)
  })

  it('tells a screen that is already open', async () => {
    invoke.mockResolvedValue({ ok: false, code: 2, output: '' })
    const seen: unknown[] = []
    const off = onHookResult((run) => seen.push(run))

    await recordHookRun('x', 'y.zip')
    off()

    // The hook finishes after the screen that started it has moved on, so the
    // result cannot simply be returned to its caller.
    expect(seen).toHaveLength(1)
  })

  it('reads a corrupt setting as nothing rather than throwing on a screen', () => {
    deviceSettings.set(LAST_HOOK_SETTING, '{ not json')
    expect(lastHookRun()).toBeNull()
  })

  it('is fired by a backup, and not waited for', async () => {
    deviceSettings.set(HOOK_SETTING, 'rclone copy {file} gdrive:shopos')
    invoke.mockImplementation(async (name: string) => {
      if (name === 'run_backup_hook') return { ok: false, code: 1, output: 'no' }
      if (name === 'backup_list') return []
      return undefined
    })

    const { takeBackupNow } = await import('../src/core/backup')
    await takeBackupNow(db, '2026-03-04.zip', new Date('2026-03-04T09:00:00'))

    // Not awaited by `takeBackupNow`, so the record lands on a later tick.
    await vi.waitFor(() => expect(lastHookRun()?.ok).toBe(false))
  })
})

describe('the daily timer', () => {
  it('counts to the next 02:00 in local time, not UTC', () => {
    // 02:00 IST is 20:30 the previous day in UTC. A schedule computed on the
    // UTC hour would fire in the middle of the evening rush.
    expect(msUntilHour(2, new Date('2026-03-04T01:59:00'))).toBe(60_000)
    expect(msUntilHour(2, new Date('2026-03-04T02:00:00'))).toBe(24 * 3_600_000)
    expect(msUntilHour(2, new Date('2026-03-04T02:01:00'))).toBe(24 * 3_600_000 - 60_000)
    expect(msUntilHour(2, new Date('2026-03-04T21:30:00'))).toBe(4.5 * 3_600_000)
  })

  it('fires for a machine that is never switched off, and re-arms', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T01:59:00'))
    invoke.mockImplementation(async (name: string) => {
      if (name === 'backup_list') return []
      return undefined
    })

    const results: unknown[] = []
    const stop = startDailyBackupTimer(db, (r) => results.push(r))

    await vi.advanceTimersByTimeAsync(60_000 + 10)
    expect(results).toHaveLength(1)

    // And again the next night — the bug being guarded against is a timer that
    // fires once and is never re-armed, which looks identical for 24 hours.
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(results.length).toBeGreaterThanOrEqual(2)

    stop()
    const after = results.length
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(results).toHaveLength(after)
  })
})
