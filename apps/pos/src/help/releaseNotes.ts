/*
 * What changed in each version, in the words of the people who use it.
 *
 * Shown once on each till after it updates (`ui/WhatsNew.tsx`), never after a
 * fresh install. `tools/release.ts check` refuses to tag a version that has no
 * entry here, so a release cannot go out without saying what it does.
 *
 * Written for a shopkeeper: what they will notice and what to do differently,
 * not what the code does. Three to six points; the first is the one that
 * matters most.
 */

export interface ReleaseNote {
  /** One line: the headline of this release. */
  title: string
  points: string[]
}

export const RELEASE_NOTES: Record<string, ReleaseNote> = {
  '0.3.0': {
    title: 'One main till, and help when something goes wrong',
    points: [
      'One till is now the main till, and the other counters sync through it. Keep the main till switched on while the shop is open.',
      'A counter can change which counter it bills on only while the main till is on, so two tills can never give out the same bill number.',
      'When a till opens, it catches up with the main till first, and shows a short wait while it does.',
      'If something is done twice on two counters, such as a bill paid twice, Needs Attention now has a button to cancel the one that should not have happened.',
      'Get help, at the bottom of the menu, shows your support code and lets you message support on WhatsApp or let them see the screen.',
      'An owner can now send the shop\'s records to support, locked so only support can open them, and apply a fix support sends, from Settings, Help.',
    ],
  },
  '0.2.21': {
    title: 'Fixes for tills that were apart',
    points: [
      'A return entered on one counter before the sale reached it is no longer lost when the two meet again.',
      'Reports sent to Telegram now carry the shop\'s health for support, and never customer details.',
    ],
  },
}

export function notesFor(version: string): ReleaseNote | null {
  return RELEASE_NOTES[version] ?? null
}
