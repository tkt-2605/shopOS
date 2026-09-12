import { useCallback, useEffect, useState } from 'react'
import { Alert, Modal } from './components'
import { describeBackups, type BackupEntry } from '../core/backup'
import { beginRestore, inspectBackup, type RestoreCheck } from '../core/restore'

/**
 * The only destructive button in the product.
 *
 * It lives in its own component because it is needed in two places that share
 * nothing else: Settings, and the screen shown when the app cannot start — which
 * is exactly where someone with a broken database ends up, and where a restore
 * that sits behind signing in would be no use at all.
 *
 * Nothing is replaced from here. The backup is validated, a copy of the current
 * data is parked, the replacement is staged and the app restarts.
 */
export function RestorePanel({ standalone = false }: { standalone?: boolean }) {
  const [files, setFiles] = useState<BackupEntry[]>([])
  const [chosen, setChosen] = useState<BackupEntry | null>(null)
  const [check, setCheck] = useState<RestoreCheck | { failed: string } | null>(null)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => setFiles(await describeBackups()), [])
  useEffect(() => { void refresh() }, [refresh])

  async function open(file: BackupEntry) {
    setChosen(file)
    setCheck(null)
    setConfirm('')
    setError(null)
    setCheck(await inspectBackup(file.name))
  }

  function close() {
    setChosen(null)
    setCheck(null)
    setConfirm('')
    setError(null)
  }

  async function go() {
    if (!chosen) return
    setBusy(true)
    setError(null)
    // Returns only on failure: on success the app restarts under us.
    const failure = await beginRestore(chosen.name)
    setBusy(false)
    if (failure) setError(failure)
  }

  const usable = check !== null && !('failed' in check) && check.ok
  const armed = usable && confirm.trim().toUpperCase() === 'RESTORE'

  return (
    <>
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
        Restoring replaces everything in the shop with what the backup held. Bills, payments
        and stock recorded since it was taken are gone. A copy of the current data is saved
        first, so a restore can itself be undone.
      </div>

      {files.length === 0 && <Alert kind="warn">There are no backups on this machine.</Alert>}

      {files.length > 0 && (
        <div className="card card-scroll">
          <table>
            <thead>
              <tr><th>Backup</th><th className="r">Size</th><th /></tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.name}>
                  <td className="num">
                    {f.date}{f.time ? ` ${f.time}` : ''}
                    {f.kind === 'safety' && (
                      <span className="badge" style={{ marginLeft: 7 }}>before a restore</span>
                    )}
                    {f.format === 'db' && f.kind === 'daily' && (
                      <span className="badge" style={{ marginLeft: 7 }}>older format</span>
                    )}
                  </td>
                  <td className="r num">{size(f.size)}</td>
                  <td className="r">
                    <button className="btn ghost sm" onClick={() => void open(f)}>Restore…</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {chosen && (
        <Modal
          title={`Restore ${chosen.date}${chosen.time ? ` ${chosen.time}` : ''}`}
          onClose={close}
          footer={
            <>
              <button className="btn" onClick={close} disabled={busy}>Cancel</button>
              <button className="btn primary" disabled={!armed || busy} onClick={() => void go()}>
                {busy ? 'Restarting…' : 'Restore and restart'}
              </button>
            </>
          }
        >
          {check === null && <div style={{ fontSize: 13 }}>Checking that backup…</div>}

          {check !== null && 'failed' in check && <Alert>{check.failed}</Alert>}

          {check !== null && !('failed' in check) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {check.problem && <Alert>{check.problem}</Alert>}
              {check.warning && <Alert kind="warn">{check.warning}</Alert>}

              {check.ok && (
                <>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                    {size(check.bytes)}, schema {check.schema}
                    {check.schema < check.supported && ' — it will be upgraded as it opens'}
                    {check.taken_at && ` · taken ${new Date(check.taken_at).toLocaleString()}`}
                  </div>
                  <Alert kind="warn">
                    Everything recorded since {chosen.date} will be lost. The shop's current data
                    is saved as a “before a restore” copy in this same list.
                  </Alert>
                  <div>
                    <label htmlFor="restore-confirm" style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                      Type RESTORE to confirm
                    </label>
                    <input
                      id="restore-confirm"
                      className="input"
                      autoFocus
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      style={{ marginTop: 5 }}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {error && <div style={{ marginTop: 11 }}><Alert>{error}</Alert></div>}
        </Modal>
      )}

      {standalone && (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 12 }}>
          The app will restart to finish. If it still cannot start afterwards, the copy taken
          just now is in the same list and puts things back as they were.
        </div>
      )}
    </>
  )
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}
