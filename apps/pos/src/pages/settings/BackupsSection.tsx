import { Fragment, useCallback, useEffect, useState } from 'react'
import { Backup, CARRY_WINDOW_DAYS } from '@shopos/core'
import { deviceSetting, setDeviceSetting } from '../../core/device'
import { useCore } from '../../core/CoreProvider'
import {
  describeBackups, takeBackupNow, deleteBackup, copyBackup, chooseFolder,
  recordHookRun, lastHookRun, onHookResult,
  backupFolderProblem, upgradeCopyFailure, HOOK_SETTING, type BackupEntry, type HookRun,
  backupSchedule, nextBackupAt, EVERY_SETTING, AT_SETTING,
} from '../../core/backup'
import {
  FOLDER_SETTING, recordCopyRun, lastCopyRun, onCopyResult, forgetCopyRun, cloudFolders, makeCloudFolder,
  type CopyRun, type CloudFolder,
} from '../../core/backupFolder'
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
  const [copyTo, setCopyTo] = useState(() => deviceSetting(FOLDER_SETTING) ?? '')
  const [copyRun, setCopyRun] = useState<CopyRun | null>(lastCopyRun)
  const [clouds, setClouds] = useState<CloudFolder[]>([])
  const [schedule, setSchedule] = useState(backupSchedule)
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
  useEffect(() => onCopyResult(setCopyRun), [])
  useEffect(() => { void cloudFolders().then(setClouds) }, [])
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
    const { attachments } = await takeBackupNow(db)
    await refresh()
    say(attachments === 0
      ? 'Saved a backup.'
      : `Saved a backup, with ${attachments} ${attachments === 1 ? 'photo' : 'photos'}.`)
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

  /**
   * Saves the folder and, when there is one, copies the newest backup into it
   * straight away -- so the shopkeeper sees the copy land, or sees why it did
   * not, while they are still on this screen rather than at 02:00.
   */
  async function useFolder(folder: string | null) {
    setCopyTo(folder ?? '')
    if (!(await setDeviceSetting(FOLDER_SETTING, folder))) {
      setCopyTo(deviceSetting(FOLDER_SETTING) ?? '')
      return
    }
    await forgetCopyRun()
    const newest = backups.find((b) => b.kind === 'daily')
    if (folder && newest) await recordCopyRun(newest.name)
  }

  async function pickFolder(clear = false) {
    if (clear) { await useFolder(null); return }
    const folder = await chooseFolder()
    if (folder) await useFolder(folder)
  }

  const useCloud = (root: string) => working('That folder could not be made', async () => {
    await useFolder(await makeCloudFolder(root))
  })

  async function changeSchedule(every: string, at: string) {
    await setDeviceSetting(EVERY_SETTING, every)
    await setDeviceSetting(AT_SETTING, at)
    // The timer reads these on its next look; nothing to restart.
    setSchedule(backupSchedule())
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
        Backups are taken automatically — when the shop opens, and on the schedule below
        for as long as this machine stays on. The last {Backup.KEEP_DAILY} days are kept:
        every backup from today, and the last one of each earlier day. Each holds the whole
        shop: bills, stock, payments and customers. Photographs attached to documents are
        carried for the last {CARRY_WINDOW_DAYS} days.
      </Intro>

      <Card title="When to back up">
        <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap' }}>
          <Field label="How often">
            <select
              className="select" id="backup-every" value={schedule.every}
              onChange={(e) => void changeSchedule(e.target.value, Backup.formatClock(schedule.at))}
            >
              {Backup.BACKUP_EVERY.map((h) => <option key={h} value={h}>{everyWords(h)}</option>)}
            </select>
          </Field>
          <Field label={schedule.every === 24 ? 'At' : 'Starting at'}>
            <input
              className="input" id="backup-at" type="time" value={Backup.formatClock(schedule.at)}
              onChange={(e) => { if (e.target.value) void changeSchedule(String(schedule.every), e.target.value) }}
            />
          </Field>
        </div>
        <div className="settings-group-why">
          {schedule.every === 24
            ? `Next backup ${whenNext(nextBackupAt())}, if this machine is on; otherwise as soon as it is switched on.`
            : `At ${Backup.slotsOfDay(schedule).map(Backup.formatClock).join(', ')}. Next ${whenNext(nextBackupAt())}.`}
          {schedule.every < 24 && ' Each backup pauses this till for a moment while it is written, so a large shop may prefer a time between rushes.'}
        </div>
      </Card>

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
          label="Copy every backup to"
          hint="Each backup is copied here the moment it is written. Choose a folder your Google Drive or OneDrive app syncs and it goes off this machine without ShopOS ever going online — or a USB stick that stays plugged in."
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" id="backup-folder" readOnly value={copyTo} placeholder="Not chosen"
              style={{ flex: 1, minWidth: 0 }} />
            <button className="btn" type="button" onClick={() => void pickFolder()}>Choose…</button>
            {copyTo && <button className="btn ghost" type="button" onClick={() => void pickFolder(true)}>Clear</button>}
          </div>
        </Field>

        {/* The setup a shopkeeper can actually do: install Drive, sign in, press this. */}
        {clouds.filter((c) => c.target !== copyTo).length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 11 }}>
            {clouds.filter((c) => c.target !== copyTo).map((c) => (
              <button key={c.root} className="btn sm" type="button" disabled={busy} title={c.target}
                onClick={() => void useCloud(c.root)}>
                Use {c.label} ({c.root})
              </button>
            ))}
          </div>
        )}
        {clouds.length === 0 && !copyTo && (
          <div className="settings-group-why" style={{ marginBottom: 11 }}>
            No Google Drive or OneDrive folder was found on this machine. Install Google Drive for
            desktop and sign in, then come back here — a button to use it will appear.
          </div>
        )}

        {/* The last copy, which happened after a backup nobody watched. A stick
            left at home or a Drive app that stopped must not look like silence. */}
        {copyTo && copyRun && (
          <div style={{ marginBottom: 11 }}>
            <Alert kind={copyRun.ok ? 'ok' : 'bad'}>
              {copyRun.ok
                ? `Last copied ${whenWas(copyRun.at)} to ${copyRun.output}`
                : `Could not copy ${whenWas(copyRun.at)}: ${copyRun.output}`}
            </Alert>
          </div>
        )}

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

function everyWords(hours: number): string {
  if (hours === 24) return 'Once a day'
  if (hours === 1) return 'Every hour'
  return `Every ${hours} hours`
}

/** "at 14:00 today", "at 02:00 tomorrow". */
function whenNext(at: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === new Date().toDateString() ? `at ${time} today` : `at ${time} tomorrow`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}
