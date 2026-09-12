import { useCallback, useEffect, useState } from 'react'
import {
  Money, Backup, getSetting, setSetting, loadLoyaltyProgram, CARRY_WINDOW_DAYS, type Loyalty,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { listPrinters, defaultPrinter } from '../core/print'
import {
  describeBackups, takeBackupNow, deleteBackup, copyBackup, chooseFolder,
  todaysBackupName, runHook, HOOK_SETTING, type BackupEntry,
} from '../core/backup'
import { lastRestore, type RestoreReport } from '../core/restore'
import { Card, Field, Alert } from '../ui/components'
import { RestorePanel } from '../ui/RestorePanel'

type Theme = 'daylight' | 'khata' | 'night'
type Density = 'comfortable' | 'compact' | 'dense'

const THEMES: { id: Theme; name: string; note: string; swatch: [string, string, string] }[] = [
  { id: 'daylight', name: 'Daylight', note: 'Light and soft. Default.', swatch: ['#f7f8fa', '#eef1f6', '#3b6fd4'] },
  { id: 'khata', name: 'Khata', note: 'Warm paper, red ink.', swatch: ['#f7f2e8', '#efe6d6', '#a8452c'] },
  { id: 'night', name: 'Night counter', note: 'Dark, for late hours.', swatch: ['#1c2430', '#2a3442', '#6f9fe8'] },
]

const DENSITIES: { id: Density; name: string }[] = [
  { id: 'comfortable', name: 'Comfortable' },
  { id: 'compact', name: 'Compact' },
  { id: 'dense', name: 'Very compact' },
]

export default function Settings() {
  const { db } = useCore()
  const user = useUser()
  const [theme, setTheme] = useState<Theme>('daylight')
  const [density, setDensity] = useState<Density>('compact')
  const [program, setProgram] = useState<Loyalty.LoyaltyProgram | null>(null)
  const [saved, setSaved] = useState(false)
  const [printers, setPrinters] = useState<string[]>([])
  const [printer, setPrinter] = useState('')
  const [systemDefault, setSystemDefault] = useState<string | null>(null)
  const [backups, setBackups] = useState<BackupEntry[]>([])
  const [restore, setRestore] = useState<RestoreReport>({ restored: null, error: null })
  const [copyTo, setCopyTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [backupNote, setBackupNote] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [hookCommand, setHookCommand] = useState('')
  const [hookOutput, setHookOutput] = useState<{ ok: boolean; text: string } | null>(null)
  const [hookBusy, setHookBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      setTheme(((await getSetting(db, 'ui_theme')) as Theme) ?? 'daylight')
      setDensity(((await getSetting(db, 'ui_density')) as Density) ?? 'compact')
      setProgram(await loadLoyaltyProgram(db))
      setPrinters(await listPrinters())
      setSystemDefault(await defaultPrinter())
      setPrinter((await getSetting(db, 'thermal_printer')) ?? '')
      setCopyTo((await getSetting(db, 'backup_folder')) ?? '')
      setHookCommand((await getSetting(db, HOOK_SETTING)) ?? '')
    })()
  }, [db])

  const refreshBackups = useCallback(async () => {
    setBackups(await describeBackups())
  }, [])

  useEffect(() => { void refreshBackups() }, [refreshBackups])
  useEffect(() => { void lastRestore().then(setRestore) }, [])

  // Applied immediately so the choice is visible while still on this screen.
  function chooseTheme(next: Theme) {
    setTheme(next)
    document.documentElement.dataset['theme'] = next
    void setSetting(db, 'ui_theme', next)
  }

  function chooseDensity(next: Density) {
    setDensity(next)
    document.documentElement.dataset['density'] = next
    void setSetting(db, 'ui_density', next)
  }

  async function saveProgram() {
    if (!program) return
    await setSetting(db, 'loyalty_program', JSON.stringify(program))
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  function sayBackup(message: string) {
    setBackupNote(message)
    setBackupError(null)
    setTimeout(() => setBackupNote(null), 6000)
  }

  async function backupNow() {
    setBusy(true)
    setBackupError(null)
    try {
      const name = todaysBackupName()
      const { attachments } = await takeBackupNow(db, name)
      await refreshBackups()
      sayBackup(
        attachments === 0
          ? `Saved today's backup.`
          : `Saved today's backup, with ${attachments} ${attachments === 1 ? 'photo' : 'photos'}.`,
      )
    } catch (err) {
      setBackupError(typeof err === 'string' ? err : 'The backup could not be written.')
    } finally {
      setBusy(false)
    }
  }

  async function copyOut(name: string) {
    setBusy(true)
    setBackupError(null)
    const result = await copyBackup(name, copyTo)
    setBusy(false)
    if (!result.ok) { setBackupError(result.message); return }
    sayBackup(`Copied to ${result.path}`)
  }

  async function removeBackup(name: string) {
    setBusy(true)
    try {
      await deleteBackup(name)
      await refreshBackups()
    } catch (err) {
      setBackupError(typeof err === 'string' ? err : 'That backup could not be removed.')
    } finally {
      setBusy(false)
    }
  }

  async function pickFolder(clear = false) {
    if (clear) {
      setCopyTo('')
      await setSetting(db, 'backup_folder', '')
      return
    }
    const folder = await chooseFolder()
    if (!folder) return
    setCopyTo(folder)
    await setSetting(db, 'backup_folder', folder)
  }

  async function saveHook(value: string) {
    setHookCommand(value)
    await setSetting(db, HOOK_SETTING, value.trim())
  }

  async function testHook() {
    const name = backups[0]?.name
    if (!name) { setHookOutput({ ok: false, text: 'Take a backup first, so there is a file to send.' }); return }
    setHookBusy(true)
    setHookOutput(null)
    try {
      const result = await runHook(hookCommand, name)
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

  function patch(next: Partial<Loyalty.LoyaltyProgram>) {
    setProgram((p) => (p ? { ...p, ...next } : p))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>
      {saved && <Alert kind="ok">Saved.</Alert>}

      <Card title="Appearance">
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          Changes how the counter looks. The layout stays the same.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 11 }}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => chooseTheme(t.id)}
              style={{
                padding: 0, cursor: 'pointer', textAlign: 'left', overflow: 'hidden',
                background: 'var(--surface)', borderRadius: 'var(--radius-sm)',
                border: theme === t.id ? '2px solid var(--accent)' : '1px solid var(--rule-strong)',
              }}
            >
              <div style={{ display: 'flex', height: 46 }}>
                <div style={{ width: 26, background: t.swatch[1] }} />
                <div style={{ flex: 1, background: t.swatch[0] }} />
                <div style={{ width: 30, background: t.swatch[2] }} />
              </div>
              <div style={{ padding: '8px 11px', borderTop: '1px solid var(--rule)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{t.note}</div>
              </div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 15, paddingTop: 14, borderTop: '1px solid var(--rule-soft)' }}>
          <span style={{ fontSize: 12.5, fontWeight: 500, width: 150 }}>Row density</span>
          <div style={{ display: 'flex', border: '1px solid var(--rule-strong)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
            {DENSITIES.map((d) => (
              <button
                key={d.id}
                onClick={() => chooseDensity(d.id)}
                style={{
                  padding: '6px 15px', border: 0, cursor: 'pointer', fontSize: 12.5,
                  fontWeight: density === d.id ? 600 : 400,
                  background: density === d.id ? 'var(--accent-soft)' : 'var(--surface)',
                  color: density === d.id ? 'var(--accent-ink)' : 'var(--ink-2)',
                }}
              >
                {d.name}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {program && (
        <Card
          title="Loyalty program"
          actions={<button className="btn primary sm" onClick={() => void saveProgram()}>Save</button>}
        >
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
            Points are earned per bill and spent soonest-to-expire first.
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, marginBottom: 14 }}>
            <input
              type="checkbox" id="loyalty-enabled" checked={program.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span style={{ fontWeight: 500 }}>Run a loyalty program</span>
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px 24px' }}>
            <Field label="One point is worth">
              <input
                className="input num" id="point-value"
                defaultValue={Money.format(program.pointValue)}
                onBlur={(e) => patch({ pointValue: Money.parseMoney(e.target.value) ?? program.pointValue })}
              />
            </Field>
            <Field label="Points expire after" hint="Days. Leave blank for never.">
              <input
                className="input num" id="expiry-days"
                defaultValue={program.expiryDays ?? ''}
                onBlur={(e) => patch({ expiryDays: e.target.value.trim() === '' ? null : Number(e.target.value) })}
              />
            </Field>
            <Field label="Minimum bill to earn">
              <input
                className="input num" id="min-bill"
                defaultValue={Money.format(program.minBillForEarn)}
                onBlur={(e) => patch({ minBillForEarn: Money.parseMoney(e.target.value) ?? program.minBillForEarn })}
              />
            </Field>
            <Field label="Points may pay at most" hint="Per cent of the bill.">
              <input
                className="input num" id="max-redeem"
                defaultValue={program.maxRedeemFractionBp / 100}
                onBlur={(e) => patch({ maxRedeemFractionBp: Math.round(Number(e.target.value) * 100) })}
              />
            </Field>
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 15, paddingTop: 14, borderTop: '1px solid var(--rule-soft)' }}>
            <input
              type="checkbox" id="earn-on-credit" style={{ marginTop: 2 }}
              checked={program.earnOnCreditPortion}
              onChange={(e) => patch({ earnOnCreditPortion: e.target.checked })}
            />
            <span>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>Earn points on the credit portion of a bill</span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-3)', marginTop: 1 }}>
                Off means a customer buying on khata earns only on what they actually paid today.
              </span>
            </span>
          </label>

          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>Earning tiers</span>
              <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>The highest tier the bill reaches applies.</span>
              <span style={{ flex: 1 }} />
              <button
                className="btn sm"
                onClick={() => patch({ tiers: [...program.tiers, { minSpend: 0 as never, pointsPerHundred: 1 }] })}
              >
                Add tier
              </button>
            </div>

            <div className="card">
              <table>
                <thead>
                  <tr><th>Bill is at least</th><th>Points per ₹100</th><th style={{ width: 60 }} /></tr>
                </thead>
                <tbody>
                  {program.tiers.map((tier, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          className="qty-input num" style={{ width: 110, textAlign: 'left' }}
                          defaultValue={Money.format(tier.minSpend)}
                          onBlur={(e) => {
                            const tiers = [...program.tiers]
                            tiers[i] = { ...tier, minSpend: Money.parseMoney(e.target.value) ?? tier.minSpend }
                            patch({ tiers })
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="qty-input num" style={{ width: 70, textAlign: 'left' }}
                          defaultValue={tier.pointsPerHundred}
                          onBlur={(e) => {
                            const tiers = [...program.tiers]
                            tiers[i] = { ...tier, pointsPerHundred: Number(e.target.value) || 0 }
                            patch({ tiers })
                          }}
                        />
                      </td>
                      <td className="r">
                        <button
                          className="btn ghost sm"
                          onClick={() => patch({ tiers: program.tiers.filter((_, n) => n !== i) })}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                  {program.tiers.length === 0 && (
                    <tr><td colSpan={3} style={{ color: 'var(--ink-3)' }}>No tiers — nothing is earned.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}

      <Card title="Receipt printer">
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          Receipts are sent as raw ESC/POS, so the driver cannot reinterpret them.
        </div>
        <Field
          label="Thermal printer"
          hint={systemDefault ? `Windows default is ${systemDefault}.` : 'No Windows default printer is set.'}
        >
          <select
            className="select" id="printer"
            value={printer}
            onChange={(e) => { setPrinter(e.target.value); void setSetting(db, 'thermal_printer', e.target.value) }}
          >
            <option value="">Use the Windows default</option>
            {printers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        {printers.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 10 }}>
            No printers found on this machine.
          </div>
        )}
      </Card>

      <Card
        title="Backups"
        actions={
          <button className="btn primary sm" disabled={busy} onClick={() => void backupNow()}>
            {busy ? 'Working…' : 'Back up now'}
          </button>
        }
      >
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          One backup is taken automatically each day the shop opens, and the last{' '}
          {Backup.KEEP_DAILY} are kept. They live on this machine — copy one somewhere else
          for it to survive the machine. Every backup holds the whole shop: bills, stock,
          payments and customers, complete. Photographs attached to documents are carried
          for the last {CARRY_WINDOW_DAYS} days; older ones stay on this machine.
        </div>

        {backupError && <div style={{ marginBottom: 11 }}><Alert>{backupError}</Alert></div>}
        {backupNote && <div style={{ marginBottom: 11 }}><Alert kind="ok">{backupNote}</Alert></div>}
        {restore.restored && (
          <div style={{ marginBottom: 11 }}>
            <Alert kind="ok">
              Restored from {restore.restored.source}. Your data from before that is saved
              as {restore.restored.safety}.
            </Alert>
          </div>
        )}
        {restore.error && <div style={{ marginBottom: 11 }}><Alert>{restore.error}</Alert></div>}

        <div className="card card-scroll" style={{ marginBottom: 14 }}>
          <table>
            <thead><tr><th>Backup</th><th className="r">Size</th><th /></tr></thead>
            <tbody>
              {backups.map((f, i) => (
                <tr key={f.name}>
                  <td className="num">
                    {f.date}{f.time ? ` ${f.time}` : ''}
                    {i === 0 && <span className="badge ok" style={{ marginLeft: 7 }}>latest</span>}
                    {f.kind === 'safety' && (
                      <span className="badge" style={{ marginLeft: 7 }}>before a restore</span>
                    )}
                  </td>
                  <td className="r num">{formatSize(f.size)}</td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" disabled={!copyTo || busy}
                      onClick={() => void copyOut(f.name)}>Copy out</button>
                    {i > 0 && (
                      <button className="btn ghost sm" disabled={busy}
                        onClick={() => void removeBackup(f.name)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
              {backups.length === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--ink-3)' }}>No backups yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <Field
          label="Copy backups to"
          hint="A USB stick, or a folder your Drive or OneDrive app syncs — that is an offsite copy without ShopOS ever going online."
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" id="backup-folder" readOnly value={copyTo}
              placeholder="Not chosen" style={{ flex: 1, minWidth: 0 }} />
            <button className="btn" onClick={() => void pickFolder()}>Choose…</button>
            {copyTo && <button className="btn ghost" onClick={() => void pickFolder(true)}>Clear</button>}
          </div>
        </Field>

        <Field
          label="Run after each backup"
          hint="A command this machine runs once the backup is written, with the file's path in place of {file}. Point it at rclone to upload to a cloud account you already have. ShopOS runs exactly what you type here and never goes online by itself."
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input"
              id="backup-hook"
              value={hookCommand}
              placeholder={'rclone copy {file} gdrive:shopos'}
              style={{ flex: 1, minWidth: 0, fontFamily: 'Consolas, monospace', fontSize: 12.5 }}
              onChange={(e) => setHookCommand(e.target.value)}
              onBlur={(e) => void saveHook(e.target.value)}
            />
            <button className="btn" disabled={hookBusy || hookCommand.trim() === ''} onClick={() => void testHook()}>
              {hookBusy ? 'Running…' : 'Test'}
            </button>
          </div>
        </Field>

        {hookOutput && (
          <div style={{ marginTop: -4, marginBottom: 11 }}>
            <Alert kind={hookOutput.ok ? 'ok' : 'bad'}>
              <span style={{ fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {hookOutput.text}
              </span>
            </Alert>
          </div>
        )}
      </Card>

      <Card title="Restore a backup">
        <RestorePanel />
      </Card>

      <Card title="Shop">
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
          Signed in as <strong>{user.username}</strong> ({user.roleName}).
        </div>
      </Card>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}
