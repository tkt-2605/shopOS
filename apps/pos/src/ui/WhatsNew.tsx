import { useEffect, useState } from 'react'
import { appVersion } from '../core/version'
import { deviceSetting, setDeviceSetting } from '../core/device'
import { notesFor, type ReleaseNote } from '../help/releaseNotes'
import { Modal } from './components'

/**
 * What changed, once, on each till after it updates.
 *
 * The version last shown is this machine's own, so every till shows it once
 * whoever is at it. A fresh install remembers its version without showing
 * anything: somebody setting up a shop has not been told anything that
 * changed. A version with no notes is remembered and nothing is shown.
 */

const SEEN = 'notes_seen_version'

export function WhatsNew() {
  const [shown, setShown] = useState<{ version: string; note: ReleaseNote } | null>(null)

  useEffect(() => {
    void (async () => {
      const running = (await appVersion())?.version
      if (!running) return
      const seen = deviceSetting(SEEN)
      if (seen === running) return
      const note = notesFor(running)
      // First run on this machine, or nothing to say: remember quietly.
      if (seen === null || note === null) {
        await setDeviceSetting(SEEN, running)
        return
      }
      setShown({ version: running, note })
    })()
  }, [])

  if (shown === null) return null

  const close = () => {
    void setDeviceSetting(SEEN, shown.version)
    setShown(null)
  }

  return (
    <Modal
      title={`What is new in ${shown.version}`}
      onClose={close}
      footer={<button className="btn primary" onClick={close}>Got it</button>}
    >
      <p style={{ marginTop: 0, fontWeight: 600 }}>{shown.note.title}</p>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
        {shown.note.points.map((p, i) => <li key={i} style={{ marginBottom: 6 }}>{p}</li>)}
      </ul>
    </Modal>
  )
}
