import { Fragment, useCallback, useEffect, useState } from 'react'
import { Backup, CARRY_WINDOW_DAYS } from '@shopos/core'
import { deviceSetting, setDeviceSetting } from '../../core/device'
import { useCore } from '../../core/CoreProvider'
import {
  describeBackups, takeBackupNow, deleteBackup, copyBackup, chooseFolder,
  todaysBackupName, recordHookRun, lastHookRun, onHookResult,
  backupFolderProblem, upgradeCopyFailure, HOOK_SETTING, type BackupEntry, type HookRun,
} from '../../core/backup'
import { lastRestore, inspectBackup, type RestoreReport, type RestoreCheck } from '../../core/restore'
import { Card, Field, Alert } from '../../ui/components'
import { FreeGhostClaims } from '../../ui/FreeGhostClaims'
import { RestorePanel } from '../../ui/RestorePanel'
import { Intro, whenWas } from './parts'

/** What `inspectBackup` can come back with: a reading, or a reason it could not take one. */
type CheckResult = RestoreCheck | { failed: string }

export function BackupsSection() {
  const { db, backup: dailyBackup } = useCore()
  const [backups, setBackups] = useState<BackupEntry[]>([])
  const [checking, setChecking] = useState<string | null>(null)
  const [checked, setChecked] = useState<Record<string, CheckResult>>({})
  const [restore, setRestore] = useState<RestoreReport>({ restored: null, error: null })
  const [copyTo, setCopyTo] = useState(() => deviceSetting('backup_folder') ?? '')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Why the list below is empty, when it is empty for a reason. */
  const [folderProblem, setFolderProblem] = useState<string | null>(null)
  const [hookCommand, setHookCommand] = useState(() => deviceSetting(HOOK_SETTING) ?? '')
  const [hookOutput, setHookOutput] = useState<{ ok: boolean; text: string } | null>(null)
  const [hookBusy, setHookBusy] = useState(false)
  const [hookRun, setHookRun] = useState<HookRun | null>(lastHookRun)

  // The automatic run finishes long after this screen was opened -- or long
  // before it. Both: read what is stored on mount, and listen for the next one.
  useEffect(() => onHookResult(setHookRun), [])
  useEffect(() => { void lastRestore().then(setRestore) }, [])

  const refresh = useCallback(async () => {
    try {
      setBackups(await describeBackups())
      setFolderProblem(null)
    } catch (err) {
      setBackups([])
      setFolderProblem(backupFolderProblem(err))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  function say(message: string) {
    setNote(message)
    setError(null)
    setTimeout(() => setNote(null), 6000)
  }

  /** Any of the file operations, with the buttons given back however it ends. */
  async function working(what: string, work: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(typeof err === 'string' ? err : `${what}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const backupNow = () => working('The backup could not be written', async () => {
    const { attachments } = await takeBackupNow(db, todaysBackupName())
    await refresh()
    say(attachments === 0
      ? 'Saved today’s backup.'
      : `Saved today’s backup, with ${attachments} ${attachments === 1 ? 'photo' : 'photos'}.`)
  })

  const copyOut = (name: string) => working('That backup could not be copied', async () => {
    const result = await copyBackup(name, copyTo)
    if (!result.ok) { setError(result.message); return }
    say(`Copied to ${result.path}`)
  })

  const remove = (name: string) => working('That backup could not be removed', async () => {
    await deleteBackup(name)
    await refresh()
  })

  /**
   * Opens a backup and says what is in it. What a shopkeeper is asking is "is
   * this the one I want", and the bill count and the date of the last bill are
   * what answer that.
   */
  async function checkOne(name: string) {
    setChecking(name)
    try {
      const result = await inspectBackup(name)
      setChecked((was) => ({ ...was, [name]: result }))
    } finally {
      setChecking(null)
    }
  }

  async function pickFolder(clear = false) {
    if (clear) {
      setCopyTo('')
      await setDeviceSetting('backup_folder', null)
      return
    }
    const folder = await chooseFolder()
    if (!folder) return
    setCopyTo(folder)
    await setDeviceSetting('backup_folder', folder)
  }

  async function testHook() {
    const name = backups[0]?.name
    if (!name) { setHookOutput({ ok: false, text: 'Take a backup first, so there is a file to send.' }); return }
    setHookBusy(true)
    setHookOutput(null)
    try {
      // Through `recordHookRun`, so pressing Test leaves the same record an
      // automatic run does.
      const result = await recordHookRun(hookCommand, name)
      setHookOutput({
        ok: result.ok,
        text: result.output || (result.ok ? 'Finished with nothing to say.' : `Exit code ${result.code ?? '—'}.`),
      })
    } catch (err) {
      setHookOutput({ ok: false, text: typeof err === 'string' ? err : 'That command could not be run.' })
    } finally {
      setHookBusy(false)
    }
  }

  return (
    <>
      <Intro>
        One backup is taken automatically each day — when the shop opens, and again at
        2 a.m. for a machine that is never switched off — and the last {Backup.KEEP_DAILY} are
        kept. Each holds the whole shop: bills, stock, payments and customers. Photographs
        attached to documents are carried for the last {CARRY_WINDOW_DAYS} days.
      </Intro>

      <Card
        title="Backups on this machine"
        actions={
          <button className="btn primary sm" disabled={busy} onClick={() => void backupNow()}>
            {busy ? 'Working…' : 'Back up now'}
          </button>
        }
      >
        {/* The automatic run, which happens with this screen closed. */}
        {upgradeCopyFailure() && (
          <div style={{ marginBottom: 11 }}><Alert>{upgradeCopyFailure()}</Alert></div>
        )}
        {dailyBackup?.error && (
          <div style={{ marginBottom: 11 }}><Alert>Today’s automatic backup did not run: {dailyBackup.error}</Alert></div>
        )}
        {folderProblem && <div style={{ marginBottom: 11 }}><Alert>{folderProblem}</Alert></div>}
        {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}
        {note && <div style={{ marginBottom: 11 }}><Alert kind="ok">{note}</Alert></div>}
        {restore.restored && (
          <div style={{ marginBottom: 11 }}>
            <Alert kind="ok">
              Restored from {restore.restored.source}. Your data from before that is saved
              as {restore.restored.safety}.
            </Alert>
          </div>
        )}
        <FreeGhostClaims />
        {restore.error && <div style={{ marginBottom: 11 }}><Alert>{restore.error}</Alert></div>}

        <div className="card card-scroll">
          <table>
            <thead><tr><th>Backup</th><th className="r">Size</th><th /></tr></thead>
            <tbody>
              {backups.map((f, i) => (
                <Fragment key={f.name}>
                  <tr>
                    <td className="num">
                      {f.date}{f.time ? ` ${f.time}` : ''}
                      {i === 0 && <span className="badge ok" style={{ marginLeft: 7 }}>latest</span>}
                      {f.kind === 'safety' && (
                        <span className="badge" style={{ marginLeft: 7 }}>
                          {f.before === 'schema' ? 'before an upgrade'
                            : f.before === 'update' ? 'before an update' : 'before a restore'}
                        </span>
                      )}
                    </td>
                    <td className="r num">{formatSize(f.size)}</td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {/* Opening it is the only way to know it is a backup. */}
                      <button className="btn ghost sm" disabled={checking === f.name} onClick={() => void checkOne(f.name)}>
                        {checking === f.name ? 'Checking…' : 'Check'}
                      </button>
                      <button className="btn ghost sm" disabled={!copyTo || busy}
                        title={copyTo ? undefined : 'Choose a folder below first'}
                        onClick={() => void copyOut(f.name)}>Copy out</button>
                      {i > 0 && (
                        <button className="btn ghost sm" disabled={busy} onClick={() => void remove(f.name)}>Delete</button>
                      )}
                    </td>
                  </tr>
                  {checked[f.name] && (
                    <tr><td colSpan={3} style={{ paddingTop: 0 }}><BackupVerdict result={checked[f.name]!} /></td></tr>
                  )}
                </Fragment>
              ))}
              {backups.length === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--ink-3)' }}>
                  {folderProblem ? 'The folder could not be read — see above.' : 'No backups yet.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Keep a copy somewhere else">
        <Field
          label="Copy backups to"
          hint="A USB stick, or a folder your Drive or OneDrive app syncs — that is an offsite copy without ShopOS ever going online."
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" id="backup-folder" readOnly value={copyTo} placeholder="Not chosen"
              style={{ flex: 1, minWidth: 0 }} />
            <button className="btn" type="button" onClick={() => void pickFolder()}>Choose…</button>
            {copyTo && <button className="btn ghost" type="button" onClick={() => void pickFolder(true)}>Clear</button>}
          </div>
        </Field>

        <Field
          label="Run after each backup"
          hint="A command this machine runs once the backup is written, with the file's path in place of {file}. Point it at rclone to upload to a cloud account you already have. ShopOS runs exactly what you type here and never goes online by itself."
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input mono" id="backup-hook" value={hookCommand}
              placeholder={'rclone copy {file} gdrive:shopos'}
              style={{ flex: 1, minWidth: 0 }}
              onChange={(e) => setHookCommand(e.target.value)}
              onBlur={(e) => void setDeviceSetting(HOOK_SETTING, e.target.value.trim()).then((saved) => {
                // Cancelled at the dialog, or not written: show the command that will actually run.
                if (!saved) setHookCommand(deviceSetting(HOOK_SETTING) ?? '')
              })}
            />
            <button className="btn" type="button" disabled={hookBusy || hookCommand.trim() === ''} onClick={() => void testHook()}>
              {hookBusy ? 'Running…' : 'Test'}
            </button>
          </div>
        </Field>

        {hookOutput && (
          <Alert kind={hookOutput.ok ? 'ok' : 'bad'}>
            <span className="mono" style={{ whiteSpace: 'pre-wrap' }}>{hookOutput.text}</span>
          </Alert>
        )}

        {/* The last time the command actually ran, which is after a backup
            nobody watched. The upload is the only copy that survives the machine
            being stolen, so a month of failures must not look like silence. */}
        {hookRun && !hookOutput && (
          <Alert kind={hookRun.ok ? 'ok' : 'bad'}>
            <div>
              {hookRun.ok
                ? `Last carried off ${whenWas(hookRun.at)}.`
                : `Did not carry off ${whenWas(hookRun.at)}` + (hookRun.code !== null ? ` — exit code ${hookRun.code}.` : '.')}
            </div>
            {hookRun.output.trim() !== '' && (
              <div className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: 5 }}>{hookRun.output.trim()}</div>
            )}
          </Alert>
        )}
      </Card>

      <Card title="Restore a backup">
        <RestorePanel />
      </Card>
    </>
  )
}

/**
 * What one backup turned out to contain, ordered by what a shopkeeper is
 * asking: the bill count and the last bill's date first, "is it broken" second.
 */
function BackupVerdict({ result }: { result: CheckResult }) {
  if ('failed' in result) return <Alert>{result.failed}</Alert>
  if (result.problem) return <Alert>{result.problem}</Alert>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
        <strong>{result.bills.toLocaleString('en-IN')}</strong>
        {result.bills === 1 ? ' bill' : ' bills'}
        {result.last_bill && <> — the last one dated {result.last_bill}</>}
        {'. '}Opened and checked, nothing damaged.
      </div>
      {result.warning && <Alert kind="warn">{result.warning}</Alert>}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}
