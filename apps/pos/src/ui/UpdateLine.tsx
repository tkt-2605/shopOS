import { useEffect, useRef, useState } from 'react'
import type { UpdateSource, UpdateStage } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { createUpdater, tauriUpdateSource, type Updater } from '../core/updater'

/**
 * The one line in the sidebar about a new version, and the button to take it.
 *
 * The updater is made here, once, for as long as the sidebar is up: it checks
 * at start and once a day, fetches in the background, and installs only when a
 * person presses the button and the drawer is closed -- `canInstall` decides,
 * and says why not in the same line. Never a dialog: an update is not a thing
 * to interrupt a sale for.
 *
 * Until the updater plugin and its feed exist (`updater.ts` lists the steps),
 * the source reports nothing available and this line stays empty.
 */
export function UpdateLine({ source }: { source?: UpdateSource }) {
  const { db } = useCore()
  const updater = useRef<Updater | null>(null)
  const [stage, setStage] = useState<UpdateStage>({ stage: 'idle', checkedAt: null })
  const [words, setWords] = useState('')

  useEffect(() => {
    const made = createUpdater({ db, source: source ?? tauriUpdateSource() })
    updater.current = made
    const off = made.onChange((next) => {
      setStage(next)
      setWords(made.words())
      // A found update is fetched straight away: fetching never blocks a sale.
      if (next.stage === 'available') void made.fetch()
    })
    void made.poll(true)
    return () => { off(); made.stop(); updater.current = null }
  }, [db, source])

  if (words === '') return null
  return (
    <div className="update-line" role="status">
      <span>{words}</span>
      {stage.stage === 'ready' && (
        <button className="link-btn" onClick={() => { void updater.current?.apply() }}>Install now</button>
      )}
    </div>
  )
}
