import { Permissions, type Page } from '@shopos/core'
import { useUser } from '../../core/CoreProvider'
import { goTo } from '../../core/nav'
import { Card } from '../../ui/components'
import { Intro } from './parts'

/**
 * The screens set up once and then left alone for months: the counters, the
 * people, and what each role may do.
 *
 * They are unchanged pages with their own permissions -- this is a way in, not
 * a new home, and a role that was never granted one is not shown it.
 */
const SCREENS: { page: Page; title: string; what: string }[] = [
  { page: 'registers', title: 'Counters', what: 'The tills this shop bills from, and the number series each one uses.' },
  { page: 'users', title: 'Staff', what: 'Who can sign in, and which role each of them has.' },
  { page: 'roles', title: 'Roles & Permissions', what: 'What each role is allowed to see and to change.' },
]

export function TeamSection() {
  const user = useUser()
  const allowed = Permissions.visiblePages(user.permissions)
  const shown = SCREENS.filter((item) => allowed.includes(item.page))

  return (
    <>
      <Intro>Who works here, and at which counter. Each opens its own screen.</Intro>
      <Card title="Counters and staff">
        {shown.length === 0 ? (
          <div className="settings-group-why">This role has not been given any of these screens.</div>
        ) : (
          <div className="settings-links">
            {shown.map((item) => (
              <button key={item.page} type="button" className="settings-link" onClick={() => goTo(item.page)}>
                <span className="settings-option-title">{item.title}</span>
                <span className="settings-option-note">{item.what}</span>
                <span className="settings-link-go" aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}

/** Whether this role would see anything in the section, so the nav can leave it out. */
export function hasTeamScreens(pages: readonly Page[]): boolean {
  return SCREENS.some((item) => pages.includes(item.page))
}
