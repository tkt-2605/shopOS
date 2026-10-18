import { invoke } from '@tauri-apps/api/core'
import {
  Money, billsToEmail, loadShopProfile, noteBillEmail, sendsBillEmails,
  type BillToEmail, type SqlDriver,
} from '@shopos/core'
import { billSheetHtml } from './printHtml'
import { deviceSetting, setDeviceSetting } from './device'
import { logEvent } from './log'

/*
 * Bills emailed to the customers the shop has ticked (`services/billEmails.ts`).
 *
 * The main till looks every two minutes for bills rung for those customers,
 * builds each one's A4 invoice -- the page the shop prints -- and hands it to
 * Rust, which makes the PDF and keeps it in the outbox until the mail server
 * takes it. Nothing here waits for the line: a bill rung in an outage is queued
 * like any other and goes when the line is back.
 *
 * Only the main sends (`sendsBillEmails`). The counters' bills reach it within
 * a minute, so the shop's mail is set up once, and no bill can go twice.
 */

const EVERY_MS = 2 * 60_000
const FIRST_MS = 45_000
/** A browser is started for each; a backlog drains over a few passes, not at once. */
const PER_PASS = 5

interface BillMailed { mail: 'sent' | 'queued'; error: string | null }

/** Why this till cannot email bills, or null when it can. */
export function billMailReady(): Promise<string | null> {
  return invoke<string | null>('bill_mail_ready').catch(() => 'Bills are emailed from a Windows till.')
}

/** The words of the email, which carry the shop's name and how to reach it. */
export function letterFor(bill: BillToEmail, shop: { name: string; phone: string | null }): { subject: string; body: string } {
  const total = Money.formatWithSymbol(bill.grandTotal)
  return {
    subject: `Invoice ${bill.docNo} from ${shop.name}`,
    body: [
      `Dear ${bill.customerName},`,
      '',
      `Thank you for shopping at ${shop.name}. Your invoice ${bill.docNo} for ${total} is attached.`,
      '',
      shop.phone ? `For any question about it, call us on ${shop.phone}.` : 'Reply to this email with any question about it.',
      '',
      shop.name,
    ].join('\n'),
  }
}

/**
 * Device setting: when this till took on sending. Set on the first pass that
 * finds it the sender and cleared on any pass that does not, so a till handed
 * the main's job starts from then and does not mail the old main's bills again.
 */
const SENDING_SINCE = 'bill_mail_since'

/** One pass. Returns how many bills were handed over. */
export async function sendDueBills(db: SqlDriver, now = new Date()): Promise<number> {
  if (!(await sendsBillEmails(db))) {
    if (deviceSetting(SENDING_SINCE) !== null) await setDeviceSetting(SENDING_SINCE, null)
    return 0
  }
  let since = deviceSetting(SENDING_SINCE)
  if (since === null) {
    since = now.toISOString()
    await setDeviceSetting(SENDING_SINCE, since)
  }
  const due = await billsToEmail(db, PER_PASS, since)
  if (due.length === 0) return 0
  // Asked once a pass, not per bill: with no mail login every bill would wait anyway.
  const notReady = await billMailReady()
  if (notReady !== null) {
    logEvent('warn', 'bill-mail', `${due.length} bill(s) waiting to be emailed: ${notReady}`)
    return 0
  }

  const profile = await loadShopProfile(db)
  let handed = 0
  for (const bill of due) {
    const sheet = await billSheetHtml(db, bill.billId)
    if (!sheet.ok) {
      await noteBillEmail(db, { billId: bill.billId, to: bill.to, error: sheet.message })
      continue
    }
    const letter = letterFor(bill, { name: profile.name, phone: profile.phone })
    try {
      const result = await invoke<BillMailed>('bill_mail', {
        docNo: bill.docNo, to: bill.to, subject: letter.subject, body: letter.body, html: sheet.html,
      })
      // In the outbox now, sent or waiting: either way it is not queued again.
      await noteBillEmail(db, { billId: bill.billId, to: bill.to })
      handed += 1
      if (result.mail === 'queued' && result.error) {
        logEvent('warn', 'bill-mail', `${bill.docNo} is waiting to be emailed: ${result.error}`)
      }
    } catch (err) {
      /* Not in the outbox: the PDF could not be made, or the address was refused.
         Noted with the reason, and the bill screen offers to try it again. */
      const why = err instanceof Error ? err.message : String(err)
      await noteBillEmail(db, { billId: bill.billId, to: bill.to, error: why })
      logEvent('warn', 'bill-mail', `${bill.docNo} could not be emailed: ${why}`)
    }
  }
  return handed
}

export function startBillMail(db: SqlDriver): () => void {
  let busy = false
  async function tick() {
    if (busy) return
    busy = true
    try {
      await sendDueBills(db)
    } catch (err) {
      logEvent('warn', 'bill-mail', `Emailing bills stopped: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busy = false
    }
  }
  const first = setTimeout(() => void tick(), FIRST_MS)
  const every = setInterval(() => void tick(), EVERY_MS)
  return () => { clearTimeout(first); clearInterval(every) }
}
