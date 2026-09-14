import { useEffect, useState } from 'react'
import { Alert } from './components'
import { deviceTrouble, onDeviceTrouble, type DeviceTrouble } from '../core/device'

/**
 * Says, on every screen, when this machine could not record who it is.
 *
 * The failure it reports is quiet in a way that makes it worth a banner rather
 * than a line on the Settings page. `device.json` going unreadable — a damaged
 * file, a folder turned read-only, a scanner holding the handle — does not stop
 * the till and must not: a shop losing a Saturday evening to a JSON file would
 * be far worse than an unattributed bill. But five other things change with it,
 * and until now not one of them said so:
 *
 * * the theme and the density go back to their defaults, so the app looks
 *   different for no reason anyone can see;
 * * the receipt printer falls back to whatever Windows calls default, so bills
 *   come out of the wrong machine, or nothing;
 * * `backup_hook` reads as nothing, so **the nightly copy to the USB stick
 *   stops running** and the backup that matters is the one nobody notices is
 *   missing;
 * * the counter this machine bills on is no longer its own answer, so it falls
 *   back to the first one in the list;
 * * every audit row for the session is written with no machine against it,
 *   which is the column migration 019 exists to fill.
 *
 * Three symptoms with one cause and nothing on screen connecting them is the
 * shape of a fault that takes a week to work out. A desktop app has no console
 * for a shopkeeper to open.
 */
export function DeviceTroubleBanner() {
  const [trouble, setTrouble] = useState<DeviceTrouble>(deviceTrouble)

  useEffect(() => onDeviceTrouble(setTrouble), [])

  if (trouble.problem === null && trouble.stranded.length === 0) return null

  /* Between the topbar and the page rather than inside it: the Billing screen's
     content is flush to the edges, and this has to be readable there too — it is
     the screen where printing silently going elsewhere matters most. */
  return (
    <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
      <Alert>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <strong>This machine could not save what it knows about itself.</strong>

        {trouble.problem !== null && (
          <div>
            Billing is unaffected and nothing has been lost. Until it is fixed, this
            till prints on the Windows default printer rather than its own, the
            after-backup command does not run, and its bills are recorded without
            naming which counter raised them.
          </div>
        )}

        {trouble.stranded.length > 0 && (
          <div>
            Still waiting to be moved onto this machine: {trouble.stranded.join(', ')}.
            They are safe where they are and will move across on the next start
            that can write the file.
          </div>
        )}

        {trouble.problem !== null && (
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{trouble.problem}</div>
        )}
      </div>
      </Alert>
    </div>
  )
}
