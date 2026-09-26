import { useEffect, useState } from 'react'
import type { FailureKind } from '../core/CoreProvider'
import { advice } from '../core/startupAdvice'
import { Alert } from '../ui/components'
import { RestorePanel } from '../ui/RestorePanel'
import { abandonRestore } from '../core/restore'
import { appVersion, versionLine, type AppVersion } from '../core/version'

/**
 * The way out of a shop that will not open.
 *
 * Restore lives here as well as in Settings, because a database this build
 * cannot read fails before sign-in — and a fix that sits behind the screen that
 * will not load is not a fix.
 */

export function CouldNotStart({ error, kind }: { error: string; kind: FailureKind }) {
  const [restoring, setRestoring] = useState(false)
  const said = advice(kind)
  // The one screen where the version matters most and was hardest to get: a
  // shop that cannot start cannot open Settings to read it.
  const [version, setVersion] = useState<AppVersion | null>(null)
  useEffect(() => { void appVersion().then(setVersion) }, [])

  return (
    <div className="centre">
      <div className="panel" style={{ maxWidth: restoring ? 620 : undefined }}>
        <div className="panel-head">
          <h1>{said.title}</h1>
        </div>
        <div className="panel-body">
          <Alert>{error}</Alert>
          {said.says && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              {said.says}
            </div>
          )}
          {!restoring && (
            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <button
                className={said.restore === 'first' ? 'btn primary' : said.restore === 'last' ? 'btn ghost' : 'btn'}
                onClick={() => setRestoring(true)}
              >
                Restore a backup…
              </button>
              <button className="btn ghost" onClick={() => { void abandonRestore().then(() => window.location.reload()) }}>
                Cancel a pending restore
              </button>
            </div>
          )}
          {restoring && (
            <div style={{ marginTop: 14 }}>
              <RestorePanel standalone />
              <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setRestoring(false)}>
                Back
              </button>
            </div>
          )}
          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--ink-3)' }}>
            ShopOS {versionLine(version)}
          </div>
        </div>
      </div>
    </div>
  )
}
