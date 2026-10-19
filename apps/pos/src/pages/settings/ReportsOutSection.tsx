import { useEffect, useState, type ReactNode } from 'react'
import { billEmailCustomers, businessDate, sendsBillEmails } from '@shopos/core'
import { deviceSetting, setDeviceSetting } from '../../core/device'
import { useCore } from '../../core/CoreProvider'
import { goTo } from '../../core/nav'
import {
  AUTO, AUTO_AT, DEFAULT_AT,
  deliverPack, destinations, flushOutbox, lastPackRun, outboxList, say,
  type Destinations, type PackRun, type Waiting,
} from '../../core/reportOut'
import { Alert, Card, rangePreset } from '../../ui/components'
import { sendHealth } from '../../core/health'
import { Intro, whenWas } from './parts'
import { MailStatus } from './ShopMailCard'

/*
 * What this till sends, where it goes, and what is still waiting.
 *
 * Nothing to type here. The shop's mail login is under Shop details; the
 * vendor's address and the mail server come with the build
 * (`report_out.rs`), so they change in an update. What is left is a row per
 * kind of message -- when it goes, where, and a button to send it now -- and
 * the outbox, with each message that has not gone and why.
 */

export function ReportsOutSection({ onOpenShop }: { onOpenShop: () => void }) {
  const { db } = useCore()
  const [where, setWhere] = useState<Destinations | null>(null)
  // Off until somebody here switches it on: the reports name customers.
  const [auto, setAuto] = useState(() => deviceSetting(AUTO) === '1')
  const [at, setAt] = useState(() => deviceSetting(AUTO_AT) ?? DEFAULT_AT)
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<PackRun | null>(lastPackRun)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [waiting, setWaiting] = useState<Waiting[]>([])
  const [stuck, setStuck] = useState<Record<string, string>>({})
  const [bills, setBills] = useState<{ sender: boolean; customers: number } | null>(null)

  async function refresh() {
    const [d, list] = await Promise.all([destinations(), outboxList()])
    setWhere(d)
    setWaiting(list)
  }

  useEffect(() => {
    let live = true
    void refresh().catch(() => undefined)
    void Promise.all([sendsBillEmails(db), billEmailCustomers(db)])
      .then(([sender, customers]) => { if (live) setBills({ sender, customers }) })
    return () => { live = false }
  }, [db])

  async function doing(work: () => Promise<{ ok: boolean; text: string }>) {
    setBusy(true)
    setMessage(null)
    try {
      setMessage(await work())
    } catch (err) {
      setMessage({ ok: false, text: typeof err === 'string' ? err : err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      void refresh().catch(() => undefined)
    }
  }

  const sendPack = (which: 'today' | 'month') => doing(async () => {
    const range = which === 'today' ? { from: businessDate(), to: businessDate() } : rangePreset('month')
    const delivery = await deliverPack(db, range)
    setRun(lastPackRun())
    return { ok: !delivery.mailError && !delivery.folderError, text: say(delivery) }
  })

  const sendHealthNow = () => doing(async () => {
    const sent = await sendHealth(db)
    const problem = sent.mailError ?? sent.portalError
    if (problem) return { ok: false, text: `Health report: ${problem}` }
    const went = [
      sent.mail === 'sent' && 'by email',
      sent.portal === 'sent' && 'to support',
    ].filter(Boolean).join(', ')
    return { ok: true, text: went ? `Health report sent ${went}.` : 'Health report made and waiting to go.' }
  })

  const tryAgain = () => doing(async () => {
    const state = await flushOutbox()
    setStuck(state.errors)
    if (state.error) return { ok: false, text: state.error }
    return { ok: true, text: state.sent > 0 ? `${state.sent} sent.` : 'Nothing was waiting.' }
  })

  function switchAuto(on: boolean) {
    setAuto(on)
    void setDeviceSetting(AUTO, on ? '1' : '0')
  }

  function changeAt(value: string) {
    setAt(value)
    if (value !== '') void setDeviceSetting(AUTO_AT, value)
  }

  const mailTo = where?.reportsTo.length ? where.reportsTo.join(', ') : null

  return (
    <>
      <Intro>
        What this till sends and where. The shop’s email is set up under Shop details; everything
        else comes with ShopOS.
      </Intro>

      <Card title="Where it goes">
        <Line label="Email">
          {mailTo ? <>To {mailTo}</> : <MailStatus where={where} />}
          <button type="button" className="link-btn" onClick={onOpenShop}>
            {where?.sender ? 'Change under Shop details' : 'Set up under Shop details'} →
          </button>
        </Line>
        <Line label="Folder">
          {deviceSetting('backup_folder')
            ? <>A copy in the backup folder, under reports</>
            : <span className="badge mute">No folder — choose one under Backups &amp; restore</span>}
        </Line>
      </Card>

      <Card title="What is sent">
        {message && <div style={{ marginBottom: 11 }}><Alert kind={message.ok ? 'ok' : 'bad'}>{message.text}</Alert></div>}

        <Row
          title="Daily reports"
          what="Sales, products, profit, GST, payments, staff, drawer and the books for the month so far, as one zip of CSV files."
          when={
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="checkbox" checked={auto} onChange={(e) => switchAuto(e.target.checked)} />
              Every day at
              <input
                className="input" id="report-at" type="time" value={at} style={{ maxWidth: 120 }}
                disabled={!auto} onChange={(e) => changeAt(e.target.value)}
              />
            </label>
          }
          last={run ? `Last sent ${whenWas(run.at)}: ${run.text}` : 'Not sent from this till yet.'}
          actions={<>
            <button className="btn sm" disabled={busy} onClick={() => void sendPack('today')}>Send today’s</button>
            <button className="btn sm" disabled={busy} onClick={() => void sendPack('month')}>Send this month’s</button>
          </>}
        />

        <Row
          title="Customers’ bills"
          what="Each bill for a customer ticked for it, as the A4 invoice in a PDF, to the customer’s own email."
          when={bills === null ? null : bills.sender
            ? <>Within two minutes of the bill, from this till</>
            : <>Sent by the main till, not this one</>}
          last={bills === null ? null : bills.customers === 0
            ? 'No customer is ticked yet.'
            : `${bills.customers} customer${bills.customers === 1 ? '' : 's'} ticked.`}
          actions={
            <button className="btn sm" onClick={() => goTo('customers')}>Choose customers</button>
          }
        />

        <Row
          title="Health report"
          what="How sync, the licence, backups and the books are doing, with the app’s logs, for support. No customer, amount or password."
          when={<>Every day, with the daily reports</>}
          actions={<button className="btn sm" disabled={busy} onClick={() => void sendHealthNow()}>Send now</button>}
        />
      </Card>

      <Card
        title="Waiting to send"
        actions={
          <button className="btn sm" disabled={busy} onClick={() => void tryAgain()}>
            {busy ? 'Sending…' : 'Try again now'}
          </button>
        }
      >
        {waiting.length === 0
          ? <div className="settings-group-why">Nothing is waiting. Anything that cannot go — the line is down, the
              password was changed — waits here and goes by itself when it can.</div>
          : (
            <table>
              <thead><tr><th>What</th><th>To</th><th>Since</th><th>Why it waits</th></tr></thead>
              <tbody>
                {waiting.map((w) => (
                  <tr key={`${w.at}-${w.channel}`}>
                    <td>{w.subject}</td>
                    <td>{w.to.join(', ')}</td>
                    <td>{whenWas(new Date(w.at).toISOString())}</td>
                    <td style={{ color: 'var(--warn)' }}>{stuck[w.channel] ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </>
  )
}

/** One destination, label then where. */
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '6px 0', flexWrap: 'wrap' }}>
      <div style={{ width: 80, color: 'var(--ink-3)', fontSize: 12.5 }}>{label}</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>{children}</div>
    </div>
  )
}

/** One kind of message: what it is, when it goes, how it last went, and Send now. */
function Row({
  title, what, when, last, actions,
}: {
  title: string
  what: string
  when?: ReactNode
  last?: string | null
  actions?: ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: 16, padding: '12px 0', borderTop: '1px solid var(--rule-soft)', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        <div className="settings-option-title">{title}</div>
        <div className="settings-option-note">{what}</div>
        {when && <div style={{ marginTop: 6 }}>{when}</div>}
        {last && <div className="settings-group-why" style={{ marginTop: 6, marginBottom: 0 }}>{last}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>{actions}</div>}
    </div>
  )
}
