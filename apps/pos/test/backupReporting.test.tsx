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
  runScheduledBackup, recordHookRun, lastHookRun, onHookResult,
  takeBackupNow, msUntilHour, startBackupTimer, EVERY_SETTING, AT_SETTING,
  LAST_HOOK_SETTING, HOOK_SETTING, TICK_MS, RETRY_MS,
} = await import('../src/core/backup')
const { recordCopyRun, lastCopyRun, FOLDER_SETTING } = await import('../src/core/backupFolder')

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

    const result = await runScheduledBackup(db, new Date('2026-03-04T09:00:00'))

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

  /* The command is read in Rust from this machine's settings. Only the backup's
     name crosses, so `run_backup_hook` cannot be handed a shell line. */
  it('sends Rust the name of the backup and never the command', async () => {
    invoke.mockResolvedValue({ ok: true, code: 0, output: '' })

    await recordHookRun('rclone copy {file} gdrive:shopos', '2026-03-04.zip')

    expect(invoke).toHaveBeenCalledWith('run_backup_hook', { name: '2026-03-04.zip' })
  })

  it('saves the command it is testing before running it', async () => {
    deviceSettings.set(HOOK_SETTING, 'the old command {file}')
    invoke.mockResolvedValue({ ok: true, code: 0, output: '' })

    await recordHookRun('  the new command {file} ', '2026-03-04.zip')

    // What Rust will read back is what the screen showed when Test was pressed.
    expect(deviceSettings.get(HOOK_SETTING)).toBe('the new command {file}')
  })

  it('does not run anything when the command could not be saved', async () => {
    const device = await import('../src/core/device')
    const put = vi.spyOn(device, 'setDeviceSetting').mockResolvedValueOnce(false)
    invoke.mockResolvedValue({ ok: true, code: 0, output: '' })

    const run = await recordHookRun('a command that will not save', '2026-03-04.zip')
    put.mockRestore()

    expect(run.ok).toBe(false)
    expect(run.output).toContain('was not saved')
    expect(invoke).not.toHaveBeenCalledWith('run_backup_hook', expect.anything())
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

    await takeBackupNow(db, '2026-03-04.zip', new Date('2026-03-04T09:00:00'))

    // Not awaited by `takeBackupNow`, so the record lands on a later tick.
    await vi.waitFor(() => expect(lastHookRun()?.ok).toBe(false))
  })
})

describe('the 02:00 count the stock replay keeps', () => {
  it('counts to the next 02:00 in local time, not UTC', () => {
    // 02:00 IST is 20:30 the previous day in UTC. A schedule computed on the
    // UTC hour would fire in the middle of the evening rush.
    expect(msUntilHour(2, new Date('2026-03-04T01:59:00'))).toBe(60_000)
    expect(msUntilHour(2, new Date('2026-03-04T02:00:00'))).toBe(24 * 3_600_000)
    expect(msUntilHour(2, new Date('2026-03-04T02:01:00'))).toBe(24 * 3_600_000 - 60_000)
    expect(msUntilHour(2, new Date('2026-03-04T21:30:00'))).toBe(4.5 * 3_600_000)
  })
})

/** A backups folder in memory: `backup_write_zip` adds to it, `backup_list` reads it. */
function folder(fail?: (call: number) => string | null) {
  const written: string[] = []
  let writes = 0
  invoke.mockImplementation(async (cmd: string, args?: { name?: string }) => {
    if (cmd === 'backup_list') return written.map((name) => ({ name, size: 1 }))
    if (cmd === 'backup_write_zip') {
      const said = fail?.(++writes) ?? null
      if (said) throw said
      written.push(args!.name!)
    }
    return undefined
  })
  return written
}

describe('the backup timer', () => {
  it('backs up at once, and again each time the schedule comes round', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T01:58:00'))
    const written = folder()

    const results: unknown[] = []
    const stop = startBackupTimer(db, (r) => results.push(r))
    await vi.advanceTimersByTimeAsync(0)
    expect(written).toEqual(['shop-2026-03-04-0158.zip'])

    // 02:00 is a new slot, and 01:58 is before it.
    await vi.advanceTimersByTimeAsync(2 * TICK_MS)
    expect(written).toEqual(['shop-2026-03-04-0158.zip', 'shop-2026-03-04-0200.zip'])

    // And the next night -- the bug being guarded against is a timer that
    // fires once and is never re-armed, which looks identical for 24 hours.
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(written).toHaveLength(3)

    stop()
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(written).toHaveLength(3)
  })

  it('follows a schedule changed while it runs, without being told', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T09:30:00'))
    const written = folder()

    const stop = startBackupTimer(db, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(written).toEqual(['shop-2026-03-04-0930.zip'])

    deviceSettings.set(EVERY_SETTING, '3')
    deviceSettings.set(AT_SETTING, '00:00')
    // 09:00 is the slot now, and the 09:30 backup already covers it.
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(written).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(150 * 60_000)
    expect(written).toEqual(['shop-2026-03-04-0930.zip', 'shop-2026-03-04-1200.zip'])
    stop()
  })

  it('tries again the next minute, and says nothing, when a bill was being saved', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T09:30:00'))
    const written = folder((n) => (n === 1 ? 'cannot back up while a transaction is open' : null))

    const results: Array<{ error: string | null }> = []
    const stop = startBackupTimer(db, (r) => results.push(r))
    await vi.advanceTimersByTimeAsync(0)
    expect(written).toEqual([])
    expect(results).toEqual([])

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(written).toEqual(['shop-2026-03-04-0931.zip'])
    expect(results.map((r) => r.error)).toEqual([null])
    stop()
  })

  it('reports a real failure, and tries again after a while rather than every minute', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T09:30:00'))
    const written = folder((n) => (n === 1 ? 'disk full' : null))

    const results: Array<{ error: string | null }> = []
    const stop = startBackupTimer(db, (r) => results.push(r))
    await vi.advanceTimersByTimeAsync(0)
    expect(results.map((r) => r.error)).toEqual(['disk full'])

    await vi.advanceTimersByTimeAsync(RETRY_MS - TICK_MS)
    expect(written).toEqual([])

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(written).toHaveLength(1)
    expect(results.at(-1)?.error).toBeNull()
    stop()
  })
})

describe('the folder every backup is copied into', () => {
  it('gets each backup as soon as it is written, and says where it went', async () => {
    deviceSettings.set(FOLDER_SETTING, 'G:\\My Drive\\ShopOS backups')
    invoke.mockImplementation(async (cmd: string, args?: { name?: string }) => {
      if (cmd === 'backup_copy_out') return `G:\\My Drive\\ShopOS backups\\${args!.name}`
      if (cmd === 'backup_folder_list') return []
      return undefined
    })

    await takeBackupNow(db, 'shop-2026-03-04-0200.zip', new Date('2026-03-04T02:00:00'))

    expect(invoke).toHaveBeenCalledWith('backup_copy_out', { name: 'shop-2026-03-04-0200.zip' })
    await vi.waitFor(() => expect(lastCopyRun()?.ok).toBe(true))
    expect(lastCopyRun()?.output).toContain('shop-2026-03-04-0200.zip')
  })

  it('is not copied to when no folder is chosen', async () => {
    invoke.mockResolvedValue(undefined)
    await takeBackupNow(db, 'shop-2026-03-04-0200.zip', new Date('2026-03-04T02:00:00'))
    expect(invoke).not.toHaveBeenCalledWith('backup_copy_out', expect.anything())
  })

  /* The stick that is not plugged in, the Drive app that is not running. */
  it('records a copy that failed where the Backups card can read it', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'backup_copy_out') throw 'G:\\My Drive is not there.'
      return undefined
    })

    const run = await recordCopyRun('shop-2026-03-04-0200.zip')

    expect(run.ok).toBe(false)
    expect(lastCopyRun()).toMatchObject({ ok: false, output: 'G:\\My Drive is not there.' })
  })

  it('keeps the copies there for as long as the ones here, and no longer', async () => {
    const there = [
      ...Array.from({ length: 15 }, (_, i) => `shop-2026-02-${String(i + 1).padStart(2, '0')}-0200.zip`),
      'shop-2026-03-04-0200.zip',
      'my-own-notes.zip',
    ]
    const deleted: string[] = []
    invoke.mockImplementation(async (cmd: string, args?: { name?: string }) => {
      if (cmd === 'backup_copy_out') return 'ok'
      if (cmd === 'backup_folder_list') return there.map((name) => ({ name, size: 1 }))
      if (cmd === 'backup_folder_delete') deleted.push(args!.name!)
      return undefined
    })

    await recordCopyRun('shop-2026-03-04-0200.zip', new Date('2026-03-04T02:00:00'))

    // Sixteen days there, fourteen kept: the two oldest go, and a file it did
    // not write is not its to touch.
    expect(deleted).toEqual(['shop-2026-02-01-0200.zip', 'shop-2026-02-02-0200.zip'])
  })
})
