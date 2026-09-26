import type { FailureKind } from './CoreProvider'

/**
 * What the "could not start" screen says, per reason, in one place.
 *
 * Its own module and a pure function for the same reason as `syncNotice`: it is
 * easy to get wrong, and getting it wrong here costs a shop a day's billing.
 *
 * Five ways of not starting land on one screen and they want opposite things
 * done. The dangerous pair is `schema_too_new` against `corrupt`. A till that is
 * merely *behind* — its database written by a newer ShopOS — must not be handed
 * a Restore button, because using it would replace what the newer version wrote
 * and destroy whatever was billed on it, while the shopkeeper follows the
 * screen's own instructions. A till whose file is *damaged* must not be told to
 * go and update itself, because updating does nothing for a JPEG somebody
 * renamed to shop.db.
 *
 * `locked` is the quieter trap. Nothing is damaged at all; another program has
 * the file, usually a second copy of ShopOS started by double-clicking twice. A
 * shop that restores a backup here throws away everything billed since that
 * backup to fix a problem that would have gone away by itself.
 *
 * So the button is always present — a screen that hides the fix is worse than
 * one that ranks it — and only its prominence changes.
 */
export interface Advice {
  title: string
  /**
   * How hard to push the Restore button.
   *
   * `first` is the primary action, `offered` is neutral, `last` is a ghost
   * button next to text telling them not to use it.
   */
  restore: 'first' | 'offered' | 'last'
  /** The paragraph under the error, or null when there is nothing to add. */
  says: string | null
}

export function advice(kind: FailureKind): Advice {
  switch (kind) {
    case 'schema_too_new':
      return {
        title: 'This till needs updating',
        restore: 'last',
        says: 'Nothing is wrong with the database — it was written by a newer ShopOS '
          + 'than this machine has. Update this till and it will open as it was. '
          + 'Do not restore an older backup to get past this: it would replace what '
          + 'the newer version has written, and whatever was billed on it would be gone.',
      }
    case 'locked':
      return {
        title: 'Something else is using this till',
        restore: 'last',
        says: 'Nothing is damaged. Another program has the database file open — usually '
          + 'a second copy of ShopOS started by double-clicking twice, sometimes a '
          + 'backup or antivirus program. Close the other one and start this again. '
          + 'Do not restore a backup: it would throw away everything billed since that '
          + 'backup to fix something that will go away on its own.',
      }
    case 'io':
      return {
        title: 'Could not reach the database',
        restore: 'offered',
        says: 'The file could not be opened. If this till keeps its data on a USB disk or '
          + 'a network drive, check that it is plugged in and switched on before '
          + 'restoring anything.',
      }
    case 'corrupt':
      return {
        title: 'This till’s database is damaged',
        restore: 'first',
        says: 'The file is there but SQLite cannot read it safely — most often a power cut '
          + 'while it was being written to, or a failing disk. Restoring the most recent '
          + 'backup is the right move here, and it is what this button does.',
      }
    case 'restore_incomplete':
      return {
        title: 'A restore did not finish',
        /* Restoring again is a fine answer, but so is cancelling -- which puts
           back exactly what was there -- and neither should look like the one
           obvious button while a person is working out which they want. */
        restore: 'offered',
        says: 'Nothing has been lost. The data from before the restore is still there, and so '
          + 'is the backup that was being put in. '
          + 'Starting again usually finishes it; an antivirus scan holding the file is the '
          + 'common cause. To go back to the data as it was instead, press "Cancel a pending restore".',
      }
    case 'invalid_shop':
      return {
        title: 'This shortcut names a shop that cannot exist',
        restore: 'last',
        says: 'Nothing was opened, so nothing is at risk. The shop name on this shortcut is not '
          + 'one ShopOS can use: letters, digits, hyphens and underscores only, up to 40 of them. '
          + 'Fix the name in the shortcut and start again. Do not restore a backup — there is '
          + 'nothing wrong with any shop’s data.',
      }
    case 'schema_unversioned':
    case 'other':
    default:
      /* No paragraph rather than a guess. Something unaccounted for has gone
         wrong, the error itself is on the screen above this, and inventing
         advice for a cause nobody has identified is how a shop gets told to
         restore a backup it did not need. */
      return { title: 'Could not start', restore: 'offered', says: null }
  }
}
