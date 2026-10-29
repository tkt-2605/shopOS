import { useEffect, useState } from 'react'
import { getSetting } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { deviceSetting } from '../../core/device'
import { backupFolderLeavesMachine } from '../../core/backupFolder'
import { healthGoesDaily } from '../../core/reportOut'
import { supportContact } from '../../core/support'
import { supportDataReady } from '../../core/supportData'
import { Card } from '../../ui/components'

/**
 * Whether this shop can be helped on a bad day, checked from what is set up.
 *
 * The things support finds missing at the worst moment -- no recovery code
 * when the owner is locked out, backups only on the PC that died, nothing
 * telling support anything is wrong -- each a tick, from the shop's own
 * settings, so there is nothing to mark and nothing to forget to mark.
 */

interface Check {
  label: string
  done: boolean
  fix: string
}

export function ReadyCard() {
  const { db } = useCore()
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [phone, setPhone] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const [recovery, reports, sealed, contact, leaves] = await Promise.all([
        getSetting(db, 'recovery_code_hash').catch(() => null),
        healthGoesDaily(),
        supportDataReady(),
        supportContact(),
        backupFolderLeavesMachine(),
      ])
      if (!live) return
      setPhone(contact?.phone ?? null)
      setChecks([
        {
          label: 'A recovery code is written down',
          done: recovery !== null,
          fix: 'Without it, a forgotten owner password cannot be reset at the shop. Make one from the banner at the top, and keep the paper away from the till.',
        },
        {
          label: 'Backups go somewhere off this computer',
          done: leaves === true || deviceSetting('backup_hook') !== null,
          fix: leaves === false
            ? 'The backup folder is on this computer\'s own disk, so it is lost with it. Choose a pen drive, another disk, or a Google Drive or OneDrive folder on Backups.'
            : 'A backup only on this PC is lost with it. Choose a pen drive or a Drive folder on Backups.',
        },
        {
          label: 'Support hears when something goes wrong',
          done: reports || deviceSetting('mail_user') !== null,
          fix: 'This copy sends no daily health report. Add the shop’s email login under Shop details, or ask for an updated copy.',
        },
        {
          label: 'The shop\'s records can be sent to support safely',
          done: sealed,
          fix: 'This copy was built without the support key. Ask for an updated copy.',
        },
      ])
    })()
    return () => { live = false }
  }, [db])

  if (checks === null) return null
  const missing = checks.filter((c) => !c.done).length

  return (
    <Card title={missing === 0 ? 'Ready for a bad day' : `Ready for a bad day: ${missing} to do`}>
      <ul className="ready-list">
        {checks.map((c) => (
          <li key={c.label} className={c.done ? 'ok' : 'todo'}>
            <span aria-hidden>{c.done ? '✓' : '○'}</span>
            <span>
              {c.label}
              {!c.done && <span className="settings-option-note" style={{ display: 'block' }}>{c.fix}</span>}
            </span>
          </li>
        ))}
        <li className="info">
          <span aria-hidden>☎</span>
          <span>
            {phone ? `Save support's number in the shop's phone: ${phone}` : 'Save support\'s number in the shop\'s phone.'}
          </span>
        </li>
      </ul>
    </Card>
  )
}
