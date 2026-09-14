import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { moveSettingsToDevice, type DeviceStore } from '../src/services/deviceSettings.js'
import { setSetting, getSetting } from '../src/services/bootstrap.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Moving a setting off the shop's table and onto the machine it describes.
 *
 * The first version of this read-and-deleted the shared row in one transaction
 * and then wrote to the device — and the device write is the one that can fail.
 * `device.json` sits on a real disk that can be full, read-only, or held open by
 * a scanner, and the write returns false rather than throwing on purpose so that
 * a till which cannot record its own name can still sell.
 *
 * Together those lost data in silence: a shop whose device.json could not be
 * written upgraded once and permanently lost its printer, its backup command and
 * which counter it was — then fell back to the first active register, so a
 * second till began minting the first one's invoice numbers.
 */

const KEYS = ['thermal_printer', 'backup_hook', 'ui_theme'] as const

/** A machine that takes what it is given. */
function machine(initial: Record<string, string> = {}): DeviceStore & { held: Record<string, string> } {
  const held = { ...initial }
  return {
    held,
    has: (key) => held[key] ?? null,
    put: async (key, value) => { held[key] = value; return true },
  }
}

/** A machine whose device.json cannot be written. */
function readOnlyMachine(): DeviceStore {
  return { has: () => null, put: async () => false }
}

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

describe('a machine taking over its own settings', () => {
  it('carries the value across and clears the shared row', async () => {
    await setSetting(fx.db, 'thermal_printer', 'EPSON TM-T82')
    const device = machine()

    const result = await moveSettingsToDevice(fx.db, KEYS, device)

    expect(device.held['thermal_printer']).toBe('EPSON TM-T82')
    expect(await getSetting(fx.db, 'thermal_printer')).toBeNull()
    expect(result.moved).toEqual(['thermal_printer'])
    expect(result.stranded).toEqual([])
  })

  it('keeps the shared row when the machine cannot take it', async () => {
    // The bug this file exists for: the row was deleted first and the write then
    // failed, so the shop's printer was gone from both places for good.
    await setSetting(fx.db, 'thermal_printer', 'EPSON TM-T82')

    const result = await moveSettingsToDevice(fx.db, KEYS, readOnlyMachine())

    expect(await getSetting(fx.db, 'thermal_printer')).toBe('EPSON TM-T82')
    expect(result.moved).toEqual([])
    expect(result.stranded).toEqual(['thermal_printer'])
  })

  it('tries again on the next start, and succeeds once the disk lets it', async () => {
    await setSetting(fx.db, 'backup_hook', 'copy-to-usb.bat')

    await moveSettingsToDevice(fx.db, KEYS, readOnlyMachine())
    expect(await getSetting(fx.db, 'backup_hook')).toBe('copy-to-usb.bat')

    const device = machine()
    await moveSettingsToDevice(fx.db, KEYS, device)
    expect(device.held['backup_hook']).toBe('copy-to-usb.bat')
    expect(await getSetting(fx.db, 'backup_hook')).toBeNull()
  })

  it('does not let one stranded key hold up the others', async () => {
    await setSetting(fx.db, 'thermal_printer', 'EPSON TM-T82')
    await setSetting(fx.db, 'ui_theme', 'khata')

    let refuse = true
    const device: DeviceStore & { held: Record<string, string> } = {
      held: {},
      has: (key) => device.held[key] ?? null,
      put: async (key, value) => {
        if (key === 'thermal_printer' && refuse) { refuse = false; return false }
        device.held[key] = value
        return true
      },
    }

    const result = await moveSettingsToDevice(fx.db, KEYS, device)

    expect(result.stranded).toEqual(['thermal_printer'])
    expect(result.moved).toEqual(['ui_theme'])
    expect(await getSetting(fx.db, 'thermal_printer')).toBe('EPSON TM-T82')
    expect(await getSetting(fx.db, 'ui_theme')).toBeNull()
  })
})

describe('a machine that already has an answer of its own', () => {
  it('keeps it, so the second till never adopts the first one’s printer', async () => {
    await setSetting(fx.db, 'thermal_printer', 'The other till’s printer')
    const device = machine({ thermal_printer: 'This till’s printer' })

    await moveSettingsToDevice(fx.db, KEYS, device)

    expect(device.held['thermal_printer']).toBe('This till’s printer')
  })

  it('still clears the shared row, because it is a leftover either way', async () => {
    await setSetting(fx.db, 'thermal_printer', 'The other till’s printer')
    const device = machine({ thermal_printer: 'This till’s printer' })

    await moveSettingsToDevice(fx.db, KEYS, device)

    expect(await getSetting(fx.db, 'thermal_printer')).toBeNull()
  })
})

describe('what is not worth carrying', () => {
  it('clears a blank shared value rather than storing it as an answer', async () => {
    // An empty backup_hook means "no command", not "run nothing".
    await setSetting(fx.db, 'backup_hook', '   ')
    const device = machine()

    await moveSettingsToDevice(fx.db, KEYS, device)

    expect(device.held['backup_hook']).toBeUndefined()
    expect(await getSetting(fx.db, 'backup_hook')).toBeNull()
  })

  it('leaves a key the shop never set alone', async () => {
    const device = machine()
    const result = await moveSettingsToDevice(fx.db, KEYS, device)

    expect(result.moved).toEqual([])
    expect(result.stranded).toEqual([])
    expect(device.held).toEqual({})
  })

  it('never touches a setting that is genuinely the shop’s', async () => {
    await setSetting(fx.db, 'shop_name', 'TRT Stationery')
    await setSetting(fx.db, 'stock_policy', 'warn')

    await moveSettingsToDevice(fx.db, KEYS, machine())

    expect(await getSetting(fx.db, 'shop_name')).toBe('TRT Stationery')
    expect(await getSetting(fx.db, 'stock_policy')).toBe('warn')
  })
})
