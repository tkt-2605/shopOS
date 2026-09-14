import { useCallback, useEffect, useState } from 'react'
import {
  Money, Backup, getSetting, setSetting, loadLoyaltyProgram, CARRY_WINDOW_DAYS,
  saveShopProfile, stateName, STATES, Permissions,
  type Loyalty, type ShopProfile, type Page,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { goTo } from '../core/nav'
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
  const { db, features, setFeatureFlag, stockPolicy, setStockPolicyTo } = useCore()
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

      <ShopCard />

      <SetupCard />

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

      <Card title="What this shop uses">
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          Not every shop needs everything. Switching one of these off takes it off
          the screens that ask for it — nothing already saved is deleted, and
          turning it back on finds it where it was.
        </div>

        <Switch
          id="feature-multi-barcode"
          on={features.multiBarcode}
          onChange={(on) => void setFeatureFlag('multiBarcode', on)}
          title="Several barcodes for one item"
          note={
            'The manufacturer’s code, your own printed tag, and the one on the old packaging '
            + 'still at the back of the shelf — all finding the same item. Off, the item form '
            + 'asks for one code. Codes already saved go on working at the counter either way: a '
            + 'scan that stopped finding its item would be the worst thing this switch could do.'
          }
        />

        <Switch
          id="feature-tiered-pricing"
          on={features.tieredPricing}
          onChange={(on) => void setFeatureFlag('tieredPricing', on)}
          title="Cheaper by the quantity"
          note={
            'One is ₹15, ten or more are ₹12, twenty or more are ₹11. Off, an item has '
            + 'one price and the forms ask for one number. Any breaks already written stay in the '
            + 'database, but they stop setting prices while this is off — a price that is still '
            + 'being charged by a rule nobody can see is worse than no rule at all.'
          }
        />
        <Switch
          id="feature-unique-phone"
          on={features.uniquePhone}
          onChange={(on) => void setFeatureFlag('uniquePhone', on)}
          title="One customer per phone number"
          note={
            'The number is what a cashier searches on, so the same person entered twice under '
            + 'one number is two khata accounts and two balances. On, a number already in use is '
            + 'refused and the form offers to open whoever has it. Off, the same warning appears '
            + 'and the save goes through — for the household that shares one phone between two '
            + 'accounts on purpose. Nothing already saved is changed either way.'
          }
        />

        <div style={{ paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>When the count says there is nothing left</div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2, marginBottom: 9, lineHeight: 1.5 }}>
            The customer is at the counter holding the item and the records say it does
            not exist. Counts are wrong in every shop that has just started, so this
            decides whether that is the cashier’s problem or the owner’s. Whatever is
            chosen, the item turns up on “Counts that need fixing” on the stock count
            screen, and the goods still leave at a cost so the margin stays right.
          </div>
          <Choice
            value={stockPolicy}
            onChange={(next) => void setStockPolicyTo(next)}
            options={[
              {
                id: 'block',
                title: 'Refuse the sale',
                note: 'Nothing can be sold that the records do not show. Right where the count is the point — a pharmacy, or anything licensed.',
              },
              {
                id: 'warn',
                title: 'Warn, and let it through',
                note: 'The cashier is told what is short and can go ahead. The queue moves and the owner gets a list to fix.',
              },
              {
                id: 'allow',
                title: 'Say nothing',
                note: 'Fastest at the counter. A count that is genuinely wrong is never noticed at the till.',
              },
            ]}
          />
        </div>
      </Card>

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

    </div>
  )
}

/**
 * Who the shop is, on every document it prints.
 *
 * Every field on this form was already being read by the printing code and
 * written by nothing — the receipt builder has asked for the address, the phone
 * and the GSTIN since v1 and got null every time, because the only screen that
 * could have set them showed the signed-in user's name and stopped there.
 */
/**
 * The four screens that used to sit under Setup in the sidebar.
 *
 * Each is set up once and then left alone for months, which is the wrong shape
 * for a sidebar: they pushed the pages a shop opens every day down the list and
 * all four read as "more settings" anyway. They are unchanged pages with their
 * own permissions — this is a way in, not a new home, and a role that was never
 * granted one is not shown it.
 */
function SetupCard() {
  const user = useUser()
  const allowed = Permissions.visiblePages(user.permissions)
  const shown = SETUP_ITEMS.filter((item) => allowed.includes(item.page))
  if (shown.length === 0) return null

  return (
    <Card title="Set up">
      <div style={{ display: 'grid', gap: 8 }}>
        {shown.map((item) => (
          <button
            key={item.page}
            className="btn ghost"
            onClick={() => goTo(item.page)}
            style={{ display: 'block', textAlign: 'left', padding: '9px 11px' }}
          >
            <div style={{ fontWeight: 600 }}>{item.title}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 400 }}>{item.what}</div>
          </button>
        ))}
      </div>
    </Card>
  )
}

const SETUP_ITEMS: { page: Page; title: string; what: string }[] = [
  { page: 'registers', title: 'Counters', what: 'The tills this shop bills from, and the number series each one uses.' },
  { page: 'users', title: 'Staff', what: 'Who can sign in, and which role each of them has.' },
  { page: 'roles', title: 'Roles & Permissions', what: 'What each role is allowed to see and to change.' },
]

function ShopCard() {
  const { db, shop, refreshShop } = useCore()
  const user = useUser()
  const [draft, setDraft] = useState<ShopProfile>(shop)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  // The profile arrives one tick after the provider mounts, so the form has to
  // follow it rather than snapshot whatever was there first.
  useEffect(() => { setDraft(shop) }, [shop])

  function patch(next: Partial<ShopProfile>) {
    setDraft((d) => ({ ...d, ...next }))
    setSaved(false)
  }

  async function save() {
    setBusy(true)
    setError(null)
    const result = await saveShopProfile(db, { actorId: user.id }, draft)
    setBusy(false)

    if (!result.ok) {
      setError(
        result.code === 'NAME_REQUIRED'
          ? 'The shop needs a name — it is the first line of every bill.'
          : result.code === 'BAD_GSTIN'
            ? 'That is not the shape of a GSTIN. It is 15 characters: two digits, then five letters, four digits, a letter, one more character, a Z, and a last character.'
            : result.code === 'UNKNOWN_STATE'
              ? 'That is not a state this software knows.'
              : result.code === 'BAD_LOGO'
                ? 'That file is not an image this can print. Use a PNG, JPEG or SVG.'
                : result.code === 'LOGO_TOO_BIG'
                  ? `That image is ${result.kb} KB and the limit is ${result.limitKb} KB. It rides on every bill and every preview, so a smaller copy is worth making.`
                  : `This GSTIN belongs to ${stateName(result.gstinState) ?? `state ${result.gstinState}`}, but the state chosen is ${stateName(result.chosenState) ?? result.chosenState}. One of the two is wrong.`,
      )
      return
    }

    await refreshShop()
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <Card
      title="Shop"
      actions={
        <button className="btn primary sm" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
        This is what prints at the top of every bill, receipt and statement.
        Changing it never rewrites a document already raised — a bill keeps the
        address it was printed with.
      </div>

      {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}
      {saved && <div style={{ marginBottom: 11 }}><Alert kind="ok">Saved.</Alert></div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px 24px' }}>
        <Field label="Shop name">
          <input className="input" id="shop-name" value={draft.name}
            onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input className="input" id="shop-phone" value={draft.phone ?? ''}
            onChange={(e) => patch({ phone: e.target.value })} />
        </Field>
        <Field label="Email" hint="Printed on documents that have room for it.">
          <input className="input" id="shop-email" value={draft.email ?? ''}
            onChange={(e) => patch({ email: e.target.value })} />
        </Field>
        <Field label="GSTIN" hint="Leave blank if the shop is not registered.">
          <input className="input num" id="shop-gstin" value={draft.gstin ?? ''}
            placeholder="33ABCDE1234F1Z5"
            onChange={(e) => patch({ gstin: e.target.value.toUpperCase() })} />
        </Field>
      </div>

      <Field label="Address">
        <textarea className="input" id="shop-address" rows={2} value={draft.address ?? ''}
          onChange={(e) => patch({ address: e.target.value })} />
      </Field>

      <Field
        label="State the shop is in"
        hint={
          'This decides the tax on every bill. Without it, a sale to a customer in '
          + 'another state is charged CGST and SGST when the law says IGST — and '
          + 'nothing on the bill would show that it was wrong.'
        }
      >
        <select className="select" id="shop-state" value={draft.stateCode ?? ''}
          onChange={(e) => patch({ stateCode: e.target.value === '' ? null : e.target.value })}>
          <option value="">Not chosen — every sale is treated as local</option>
          {STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      </Field>

      <Field label="Small print on the receipt" hint="Shown at the bottom of every receipt and statement.">
        <input className="input" id="receipt-footer" value={draft.receiptFooter ?? ''}
          placeholder="Thank you. Goods once sold are not returnable without this bill."
          onChange={(e) => patch({ receiptFooter: e.target.value })} />
      </Field>

      <LogoField logo={draft.logo} onChange={(logo) => patch({ logo })} onError={setError} />

      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
        Signed in as <strong>{user.username}</strong> ({user.roleName}).
      </div>
    </Card>
  )
}

/**
 * The shop's own mark.
 *
 * Read straight into the form as a `data:` URI rather than filed away and
 * pointed at: the bill prints from the app window, from a browser tab in
 * development, and into a preview that is only ever HTML, and none of the three
 * can be handed a filename. Saving is what commits it, like every other field
 * on this card — choosing a file changes nothing until Save.
 */
function LogoField({ logo, onChange, onError }: {
  logo: string | null
  onChange: (logo: string | null) => void
  onError: (message: string | null) => void
}) {
  const inputId = 'shop-logo'

  function choose(file: File | undefined) {
    if (!file) return
    onError(null)
    const reader = new FileReader()
    reader.onerror = () => onError('That file could not be read.')
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      /* Refused here as well as in the service, because the service's message
         arrives only on Save and the file picker is where the mistake was
         made. The service still checks: this screen is not the only caller. */
      if (!/^data:image\//.test(result)) {
        onError('That file is not an image this can print. Use a PNG, JPEG or SVG.')
        return
      }
      onChange(result)
    }
    reader.readAsDataURL(file)
  }

  return (
    <Field
      label="Logo"
      hint={
        'Printed at the top of the A4 sheet, above the address. The thermal '
        + 'printer cannot carry a picture, so the roll prints the shop name as it '
        + 'always has. Switch the logo block on under Bill Formats to use it.'
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {logo && (
          <img
            src={logo} alt=""
            style={{ height: 44, maxWidth: 160, objectFit: 'contain', border: '1px solid var(--rule-soft)' }}
          />
        )}
        <input
          type="file" id={inputId} accept="image/png,image/jpeg,image/svg+xml,image/webp"
          style={{ fontSize: 12.5 }}
          onChange={(e) => { choose(e.target.files?.[0]); e.target.value = '' }}
        />
        {logo && (
          <button className="btn ghost sm" onClick={() => onChange(null)}>Remove</button>
        )}
      </div>
    </Field>
  )
}

/**
 * A switch with its consequence written beside it.
 *
 * The note is not decoration. Every one of these changes what other screens do,
 * and an owner flicking it deserves to know what happens to the data they have
 * already entered before they find out by looking for it.
 */
function Switch({
  id, on, onChange, title, note,
}: {
  id: string
  on: boolean
  onChange: (on: boolean) => void
  title: string
  note: string
}) {
  return (
    <label
      htmlFor={id}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
        padding: '11px 0', borderTop: '1px solid var(--rule-soft)',
      }}
    >
      <input
        type="checkbox" id={id} checked={on} style={{ marginTop: 3 }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2, lineHeight: 1.5 }}>
          {note}
        </span>
      </span>
    </label>
  )
}

/**
 * One answer out of several, where a switch would be a lie.
 *
 * Laid out as full rows rather than a dropdown because each option needs its
 * consequence written beside it — these change what happens at a counter, and an
 * owner picking one deserves to know what they are picking before they find out
 * on a Saturday.
 */
function Choice<T extends string>({
  value, onChange, options,
}: {
  value: T
  onChange: (next: T) => void
  options: { id: T; title: string; note: string }[]
}) {
  return (
    <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {options.map((o) => (
        <label
          key={o.id}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
            padding: '9px 11px',
            background: value === o.id ? 'var(--accent-soft)' : 'var(--surface)',
            border: value === o.id ? '2px solid var(--accent)' : '1px solid var(--rule-strong)',
          }}
        >
          <input
            type="radio"
            name="stock-policy"
            checked={value === o.id}
            style={{ marginTop: 2 }}
            onChange={() => onChange(o.id)}
          />
          <span>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{o.title}</span>
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2, lineHeight: 1.5 }}>
              {o.note}
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}
