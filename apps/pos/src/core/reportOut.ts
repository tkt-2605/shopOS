import { invoke } from '@tauri-apps/api/core'
import { Money, Reports as R, businessDate, getSetting, loadShopProfile, type DateRange, type SqlDriver } from '@shopos/core'
import { deviceSetting, setDeviceSetting } from './device'
import { logEvent } from './log'
import { EVERYTHING } from '../pages/reports/LedgerTable'
import { gstDetailCsv, loadReportData } from '../pages/reports/loadData'
import { TABS_IN_PACK, describe, tableFor } from '../pages/reports/tableFor'

/*
 * A shop's reports, sent out of the building without a server of ours.
 *
 * Three destinations, each reported on its own: a zip kept on this machine, a
 * copy in the folder backups already go to (a Google Drive or OneDrive folder),
 * and an email. The shop's line is poor, so the email is queued by Rust and
 * retried until it is accepted; nothing here waits for the network.
 *
 * Where a pack goes is this machine's setting, read by Rust. Nothing in this
 * file chooses a recipient.
 */

/** Device settings. Must match `report_out.rs`. */
export const MAIL_TO = 'mail_to'
export const MAIL_USER = 'mail_user'
export const MAIL_PASSWORD = 'mail_password'
export const MAIL_HOST = 'mail_host'
export const MAIL_PORT = 'mail_port'
export const TG_TOKEN = 'tg_token'
export const TG_CHAT = 'tg_chat'
/** `1` when the pack goes out by itself once a day, `0` when switched off. Unset follows the build. */
export const AUTO = 'report_auto'
/** `HH:MM`, local time. */
export const AUTO_AT = 'report_at'
const LAST_DAY = 'report_last_day'
const LAST_RUN = 'report_last_run'

export const DEFAULT_AT = '21:30'

export interface Delivery {
  zip: string
  folder: string | null
  folderError: string | null
  mail: 'off' | 'sent' | 'queued'
  mailError: string | null
  telegram: 'off' | 'sent' | 'queued'
  telegramError: string | null
}

export interface OutboxState { waiting: number; sent: number; error: string | null }

export interface PackRun {
  at: string
  ok: boolean
  /** One line a person can read. */
  text: string
}

export function lastPackRun(): PackRun | null {
  const raw = deviceSetting(LAST_RUN)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<PackRun>
    return typeof p.at === 'string' && typeof p.text === 'string' ? { at: p.at, ok: p.ok === true, text: p.text } : null
  } catch {
    return null
  }
}

/** Letters, digits and spaces only: it ends up in a file name and a subject line. */
export function plain(text: string, limit = 40): string {
  return text.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit).trim()
}

/** Every report for the range as files, skipping the ones that have nothing in them. */
export async function buildPack(db: SqlDriver, range: DateRange): Promise<{ name: string; contents: string }[]> {
  const data = await loadReportData(db, range, EVERYTHING)
  const files: { name: string; contents: string }[] = []

  for (const tab of TABS_IN_PACK) {
    const table = tableFor(tab, data)
    if (!table || (table.rows.length === 0 && tab !== 'days')) continue
    files.push({ name: `${table.name}.csv`, contents: R.toCsv(table.columns.map((c) => c.label), table.rows) })
  }

  const lines = await R.gstLines(db, range)
  if (lines.length > 0) files.push({ name: 'gst-detail.csv', contents: gstDetailCsv(lines) })

  const s = data.summary
  files.push({
    name: 'summary.txt',
    contents: [
      `Period: ${describe(range)}`,
      `Bills: ${s.bills}`,
      `Net sales: ${Money.formatWithSymbol(s.net)}`,
      `Returns: ${Money.formatWithSymbol(s.returns)}`,
      `GST collected: ${Money.formatWithSymbol(s.tax)}`,
      `Taken at the counter: ${Money.formatWithSymbol(s.paid)}`,
      `Sold on credit: ${Money.formatWithSymbol(s.credit)}`,
      '',
    ].join('\n'),
  })
  return files
}

/**
 * Builds the pack and hands it to Rust. The subject and file name carry the
 * shop's name and id, so two shops sending to one inbox or one Drive folder
 * can be told apart at a glance and never overwrite each other.
 */
export async function deliverPack(db: SqlDriver, range: DateRange): Promise<Delivery> {
  const [profile, shopId] = await Promise.all([loadShopProfile(db), getSetting(db, 'shop_id')])
  const shop = plain(profile.name) || 'Shop'
  const id = (shopId ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) || 'noid'
  const files = await buildPack(db, range)
  const when = range.from === range.to ? range.to : `${range.from} to ${range.to}`

  const subject = `ShopOS reports - ${shop} (${id}) - ${when}`
  const delivery = await invoke<Delivery>('report_deliver', {
    packName: `${shop} (${id}) ${when}.zip`,
    files,
    subject,
    body: [
      `Shop: ${profile.name}`,
      `Shop id: ${shopId ?? 'not set'}`,
      `Period: ${describe(range)}`,
      '',
      files.find((f) => f.name === 'summary.txt')?.contents ?? '',
      'All the reports are in the attached zip, as CSV files that open in Excel.',
    ].join('\n'),
  })
  await record(delivery)
  return delivery
}

/** What a person should read after a delivery. */
export function say(d: Delivery): string {
  const parts = [`Saved to ${d.zip}`]
  if (d.folder) parts.push(`copied to ${d.folder}`)
  else if (d.folderError) parts.push(`not copied to the folder: ${d.folderError}`)
  if (d.mail === 'sent') parts.push('emailed')
  else if (d.mail === 'queued') parts.push(`email waiting for the line${d.mailError ? ` (${d.mailError})` : ''}`)
  else if (d.mailError) parts.push(`email not sent: ${d.mailError}`)
  if (d.telegram === 'sent') parts.push('sent to Telegram')
  else if (d.telegram === 'queued') parts.push(`Telegram waiting for the line${d.telegramError ? ` (${d.telegramError})` : ''}`)
  else if (d.telegramError) parts.push(`Telegram not sent: ${d.telegramError}`)
  return parts.join('; ')
}

async function record(d: Delivery): Promise<void> {
  const ok = d.mailError === null && d.folderError === null && d.telegramError === null
  const run: PackRun = { at: new Date().toISOString(), ok, text: say(d) }
  await setDeviceSetting(LAST_RUN, JSON.stringify(run))
  logEvent(ok ? 'info' : 'warn', 'reports', run.text)
}

export interface ChatSeen { id: string; kind: string; name: string }

/** The chats that have messaged this machine's bot, for picking a chat id from. */
export function findTelegramChats(): Promise<ChatSeen[]> {
  return invoke<ChatSeen[]>('report_telegram_chats')
}

/** True when this build was made with the vendor's bot in it. */
export function telegramBuiltIn(): Promise<boolean> {
  return invoke<boolean>('report_telegram_builtin').catch(() => false)
}

export function flushOutbox(): Promise<OutboxState> {
  return invoke<OutboxState>('report_outbox')
}

/**
 * Once a day, after the set time, and again whenever the check finds the line
 * back and something waiting. The day is marked done once the pack is built and
 * queued, not once it is delivered: the outbox owns the retrying.
 */
export function startReportSchedule(db: SqlDriver): () => void {
  let busy = false
  /* The reports go daily only when somebody at the shop switched it on: they
     name customers. A build carrying the vendor's bot sends its health report
     daily regardless -- it names none -- and Rust never lets that bot carry a
     pack (`report_out.rs`, `Queued::vendor`). */
  let builtIn = false
  void telegramBuiltIn().then((yes) => { builtIn = yes })

  async function tick() {
    if (busy) return
    busy = true
    try {
      const auto = deviceSetting(AUTO) === '1'
      if (auto || builtIn) {
        const now = new Date()
        const today = businessDate(now)
        const [h, m] = (deviceSetting(AUTO_AT) ?? DEFAULT_AT).split(':').map(Number)
        const due = now.getHours() * 60 + now.getMinutes() >= (h ?? 21) * 60 + (m ?? 30)
        if (due && deviceSetting(LAST_DAY) !== today) {
          const month: DateRange = { from: businessDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
          if (auto) await deliverPack(db, month)
          await setDeviceSetting(LAST_DAY, today)
          // The shop's health goes with it: why a sync or a licence failed.
          // Loaded here rather than imported, because it reads this module.
          const { sendHealth } = await import('./health')
          await sendHealth(db).catch((err: unknown) =>
            logEvent('warn', 'reports', `The health report did not go out: ${err instanceof Error ? err.message : String(err)}`))
          return
        }
      }
      await flushOutbox()
    } catch (err) {
      logEvent('warn', 'reports', `The daily reports did not go out: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busy = false
    }
  }

  let stopWatching: (() => void) | null = null
  void import('./health').then(({ watchSyncForHealth }) => { stopWatching = watchSyncForHealth() })

  const first = setTimeout(() => void tick(), 60_000)
  const every = setInterval(() => void tick(), 10 * 60_000)
  return () => { clearTimeout(first); clearInterval(every); stopWatching?.() }
}
