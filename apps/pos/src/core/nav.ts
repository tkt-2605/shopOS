/**
 * Asking the shell to change pages.
 *
 * Most screens never need this — the sidebar is how a person moves around. It
 * exists for the few places where one screen hands off to another as part of a
 * job already in progress: Settings listing the setup screens that used to
 * crowd the sidebar, and anything else that would otherwise have to say "now go
 * and open Counters yourself".
 *
 * A module-level slot rather than a context, for the same reason `repeat.ts` is
 * one: the shell owns `current` and the pages that want to change it are its
 * children, so a context would mean threading a provider through `App.tsx`
 * purely to pass one function downwards.
 */

import type { Page } from '@shopos/core'

const listeners = new Set<(page: Page) => void>()

/**
 * Goes to a page. Silent if nothing is listening or the signed-in person may
 * not see it — the shell decides, because it is the shell that knows which
 * pages this person's role was granted.
 */
export function goTo(page: Page): void {
  for (const listener of listeners) listener(page)
}

export function onGoTo(listener: (page: Page) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
