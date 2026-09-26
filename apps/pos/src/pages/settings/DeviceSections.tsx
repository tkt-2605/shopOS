import { useEffect, useState } from 'react'
import { deviceSetting, setDeviceSetting } from '../../core/device'
import { listPrinters, defaultPrinter } from '../../core/print'
import { Card, Field } from '../../ui/components'
import { Group, Intro } from './parts'

/*
 * The two sections that belong to this computer rather than to the shop: which
 * printer this till uses, and how its screen looks. Both are device settings,
 * so another till is never changed by what is chosen here.
 */

type Theme = 'daylight' | 'khata' | 'night'
type Density = 'comfortable' | 'compact' | 'dense'

const THEMES: { id: Theme; name: string; note: string; swatch: [string, string, string] }[] = [
  { id: 'daylight', name: 'Daylight', note: 'Light and soft. Default.', swatch: ['#f7f8fa', '#eef1f6', '#3b6fd4'] },
  { id: 'khata', name: 'Khata', note: 'Warm paper, red ink.', swatch: ['#f7f2e8', '#efe6d6', '#a8452c'] },
  { id: 'night', name: 'Night counter', note: 'Dark, for late hours.', swatch: ['#1c2430', '#2a3442', '#6f9fe8'] },
]

const DENSITIES: { id: Density; name: string }[] = [
  { id: 'comfortable', name: 'Comfortable' },
  { id: 'compact', name: 'Compact' },
  { id: 'dense', name: 'Very compact' },
]

export function PrinterSection() {
  const [printers, setPrinters] = useState<string[]>([])
  const [printer, setPrinter] = useState('')
  const [systemDefault, setSystemDefault] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setPrinters(await listPrinters())
      setSystemDefault(await defaultPrinter())
      setPrinter(deviceSetting('thermal_printer') ?? '')
    })()
  }, [])

  return (
    <>
      <Intro>
        The printer this computer sends receipts to. Each till chooses its own, so
        a change here leaves the other counters as they are.
      </Intro>
      <Card title="Receipt printer">
        <Field
          label="Thermal printer"
          hint={systemDefault ? `Windows default is ${systemDefault}.` : 'No Windows default printer is set.'}
        >
          <select
            className="select" id="printer" value={printer}
            onChange={(e) => { setPrinter(e.target.value); void setDeviceSetting('thermal_printer', e.target.value) }}
          >
            <option value="">Use the Windows default</option>
            {printers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <div className="settings-group-why">
          {printers.length === 0
            ? 'No printers found on this machine.'
            : 'Receipts are sent as raw ESC/POS, so the driver cannot reinterpret them. The A4 sheet goes through the Windows print dialog instead, where any printer can be chosen.'}
        </div>
      </Card>
    </>
  )
}

export function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>(() => (deviceSetting('ui_theme') as Theme) ?? 'daylight')
  const [density, setDensity] = useState<Density>(() => (deviceSetting('ui_density') as Density) ?? 'compact')

  // Applied immediately so the choice is visible while still on this screen.
  function chooseTheme(next: Theme) {
    setTheme(next)
    document.documentElement.dataset['theme'] = next
    void setDeviceSetting('ui_theme', next)
  }

  function chooseDensity(next: Density) {
    setDensity(next)
    document.documentElement.dataset['density'] = next
    void setDeviceSetting('ui_density', next)
  }

  return (
    <>
      <Intro>How this computer's screen looks. The layout stays the same, and other tills keep their own.</Intro>
      <Card title="Appearance">
        <Group title="Colours">
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button key={t.id} type="button" className="theme-tile" aria-pressed={theme === t.id}
                onClick={() => chooseTheme(t.id)}>
                <div className="theme-swatch">
                  <div style={{ width: 26, background: t.swatch[1] }} />
                  <div style={{ flex: 1, background: t.swatch[0] }} />
                  <div style={{ width: 30, background: t.swatch[2] }} />
                </div>
                <div className="theme-label">
                  <div className="settings-option-title">{t.name}</div>
                  <div className="settings-option-note">{t.note}</div>
                </div>
              </button>
            ))}
          </div>
        </Group>
        <Group title="Row density" why="How much fits on a screen of bills or items.">
          <div className="segment">
            {DENSITIES.map((d) => (
              <button key={d.id} type="button" aria-pressed={density === d.id} onClick={() => chooseDensity(d.id)}>
                {d.name}
              </button>
            ))}
          </div>
        </Group>
      </Card>
    </>
  )
}
