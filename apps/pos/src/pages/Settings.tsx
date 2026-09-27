import { useState, type ReactNode } from 'react'
import { Permissions, type Page } from '@shopos/core'
import { useUser } from '../core/CoreProvider'
import { goTo } from '../core/nav'
import { SyncCard } from '../ui/SyncCard'
import { LicenceCard } from '../ui/LicenceCard'
import { Formats } from './Formats'
import { ShopSection } from './settings/ShopSection'
import { TaxSection } from './settings/TaxSection'
import { FeaturesSection } from './settings/FeaturesSection'
import { LoyaltySection } from './settings/LoyaltySection'
import { PrinterSection, AppearanceSection } from './settings/DeviceSections'
import { BackupsSection } from './settings/BackupsSection'
import { TeamSection, hasTeamScreens } from './settings/TeamSection'
import { HelpSection } from './settings/HelpSection'
import { Intro } from './settings/parts'

/**
 * Settings, in sections.
 *
 * It was one column of twelve cards, from the shop's name down to the version
 * number, and the setting a shop came for was found by scrolling past the ones
 * it did not. Grouped by what the owner is doing -- describing the business,
 * deciding what the paper looks like, adding people and tills, keeping the data
 * safe -- with one section on screen at a time.
 *
 * Each section is its own module under `settings/` and owns its own state, so a
 * section can be moved, replaced or dropped without the others noticing.
 *
 * Bill format lives here now rather than in the sidebar. The argument for the
 * sidebar was that a design tool nobody can find is a design tool nobody uses;
 * a section named in this list is found, and it sits beside the shop details and
 * the printer that decide the rest of what a bill looks like.
 */

export type SettingsSection =
  | 'shop' | 'tax' | 'format' | 'printer'
  | 'features' | 'loyalty'
  | 'team' | 'sync' | 'licence'
  | 'backups'
  | 'appearance' | 'help'

interface SectionDef {
  id: SettingsSection
  label: string
  /** Absent means every role that reached Settings sees it. */
  needs?: (pages: readonly Page[]) => boolean
}

const GROUPS: { label: string; sections: SectionDef[] }[] = [
  {
    label: 'Business',
    sections: [
      { id: 'shop', label: 'Shop details' },
      { id: 'tax', label: 'Tax & billing' },
      { id: 'loyalty', label: 'Loyalty' },
      { id: 'features', label: 'Features' },
    ],
  },
  {
    label: 'Documents',
    sections: [
      { id: 'format', label: 'Bill format', needs: (pages) => pages.includes('formats') },
      { id: 'printer', label: 'Receipt printer' },
    ],
  },
  {
    label: 'People & tills',
    sections: [
      { id: 'team', label: 'Counters & staff', needs: hasTeamScreens },
      { id: 'sync', label: 'Other tills' },
      { id: 'licence', label: 'Licence' },
    ],
  },
  {
    label: 'Data',
    sections: [{ id: 'backups', label: 'Backups & restore' }],
  },
  {
    label: 'This computer',
    sections: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'help', label: 'Help & about' },
    ],
  },
]

/**
 * Where this person last was, for the life of the process. Module-level because
 * the page unmounts whenever somebody looks at another screen, and coming back
 * to Settings should not mean finding the section again.
 */
let lastSection: SettingsSection = 'shop'

/** Opens Settings at one section, for a screen that hands a job over to it. */
export function openSettings(section: SettingsSection): void {
  lastSection = section
  goTo('settings')
}

export default function Settings({ initial }: { initial?: SettingsSection } = {}) {
  const user = useUser()
  const pages = Permissions.visiblePages(user.permissions)
  const groups = GROUPS
    .map((g) => ({ ...g, sections: g.sections.filter((s) => !s.needs || s.needs(pages)) }))
    .filter((g) => g.sections.length > 0)
  const available = groups.flatMap((g) => g.sections.map((s) => s.id))

  const [chosen, setChosen] = useState<SettingsSection>(() => {
    const wanted = initial ?? lastSection
    return available.includes(wanted) ? wanted : 'shop'
  })

  function open(section: SettingsSection) {
    lastSection = section
    setChosen(section)
  }

  const canFormat = available.includes('format')

  return (
    <div className="settings" data-wide={chosen === 'format'}>
      <nav className="settings-nav" aria-label="Settings sections">
        {groups.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <div className="settings-nav-label">{group.label}</div>
            <div className="side-list">
              {group.sections.map((s) => (
                <button key={s.id} type="button" aria-current={s.id === chosen} onClick={() => open(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <section className="settings-body" aria-label={labelOf(chosen)}>
        <h2 className="settings-title">{labelOf(chosen)}</h2>
        {body(chosen, canFormat ? () => open('format') : null)}
      </section>
    </div>
  )
}

function body(section: SettingsSection, openFormat: (() => void) | null): ReactNode {
  switch (section) {
    case 'shop': return <ShopSection onOpenFormat={openFormat} />
    case 'tax': return <TaxSection />
    case 'features': return <FeaturesSection />
    case 'loyalty': return <LoyaltySection />
    case 'format': return (
      <>
        <Intro>
          What a bill looks like on the thermal roll and on an A4 sheet. The preview
          is the page itself — the same HTML the printer is handed.
        </Intro>
        <Formats />
      </>
    )
    case 'printer': return <PrinterSection />
    case 'team': return <TeamSection />
    case 'sync': return (
      <>
        <Intro>Other counters in this shop, and how they keep each other up to date.</Intro>
        <SyncCard />
      </>
    )
    case 'licence': return (
      <>
        <Intro>What this shop has bought. A licence never stops a shop billing.</Intro>
        <LicenceCard />
      </>
    )
    case 'backups': return <BackupsSection />
    case 'appearance': return <AppearanceSection />
    case 'help': return <HelpSection />
  }
}

function labelOf(section: SettingsSection): string {
  for (const group of GROUPS) {
    const found = group.sections.find((s) => s.id === section)
    if (found) return found.label
  }
  return 'Settings'
}
