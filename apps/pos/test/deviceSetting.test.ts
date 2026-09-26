import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Saving a setting about this machine, when a person can say no.
 *
 * A new backup command is shown in a Windows dialog before it is saved. Cancel
 * came back as an error like any other, and every error here means "this till
 * cannot write its own file" -- so pressing Cancel raised the banner saying the
 * till would print on the wrong printer and name no counter on its bills.
 */

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

const { setDeviceSetting, deviceProblem } = await import('../src/core/device')

const saved = { id: '0190a0c0-0000-7000-8000-000000000001', label: 'Till', registerId: null, settings: { backup_hook: 'rclone copy {file} x:' }, minted: false }

beforeEach(() => { invoke.mockReset() })

describe('a backup command the person cancelled', () => {
  it('is not saved, and is not reported as a machine that cannot save', async () => {
    invoke.mockRejectedValue('DECLINED')
    expect(await setDeviceSetting('backup_hook', 'rclone copy {file} x:')).toBe(false)
    expect(deviceProblem()).toBeNull()
  })

  it('is still told apart from a file that could not be written', async () => {
    invoke.mockRejectedValue('Access is denied. (os error 5)')
    expect(await setDeviceSetting('thermal_printer', 'EPSON')).toBe(false)
    expect(deviceProblem()).toContain('os error 5')
  })
})

describe('the same save asked twice while the dialog is open', () => {
  it('asks once, so there is one dialog and not two', async () => {
    let answer: (v: unknown) => void = () => {}
    invoke.mockImplementation(() => new Promise((r) => { answer = r }))

    const onBlur = setDeviceSetting('backup_hook', 'rclone copy {file} x:')
    const onTest = setDeviceSetting('backup_hook', 'rclone copy {file} x:')
    answer(saved)

    expect(await onBlur).toBe(true)
    expect(await onTest).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('asks again once the first has answered', async () => {
    invoke.mockResolvedValue(saved)
    await setDeviceSetting('backup_hook', 'rclone copy {file} x:')
    await setDeviceSetting('backup_hook', 'rclone copy {file} x:')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
