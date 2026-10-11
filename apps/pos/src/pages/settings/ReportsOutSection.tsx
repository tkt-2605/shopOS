import { useEffect, useState } from 'react'
import { businessDate } from '@shopos/core'
import { deviceSetting, setDeviceSetting } from '../../core/device'
import { useCore } from '../../core/CoreProvider'
import {
  AUTO, AUTO_AT, DEFAULT_AT, MAIL_HOST, MAIL_PASSWORD, MAIL_PORT, MAIL_TO, MAIL_USER, TG_CHAT, TG_TOKEN,
  deliverPack, findTelegramChats, flushOutbox, telegramBuiltIn, lastPackRun, say, type ChatSeen, type PackRun,
} from '../../core/reportOut'
import { Alert, Card, Field, rangePreset } from '../../ui/components'
import { Intro, whenWas } from './parts'

/*
 * Where this shop's reports go, with no server of ours in between.
 *
 * Everything on this screen is a setting of this computer, not of the shop: the
 * mail password in particular must never be written to the shop's database,
 * which is copied to every other till and into every backup.
 */

export function ReportsOutSection() {
  const { db } = useCore()
  const [to, setTo] = useState(() => deviceSetting(MAIL_TO) ?? '')
  const [user, setUser] = useState(() => deviceSetting(MAIL_USER) ?? '')
  const [password, setPassword] = useState(() => deviceSetting(MAIL_PASSWORD) ?? '')
  const [host, setHost] = useState(() => deviceSetting(MAIL_HOST) ?? '')
  const [port, setPort] = useState(() => deviceSetting(MAIL_PORT) ?? '')
  const [tgToken, setTgToken] = useState(() => deviceSetting(TG_TOKEN) ?? '')
  const [tgChat, setTgChat] = useState(() => deviceSetting(TG_CHAT) ?? '')
  const [chats, setChats] = useState<ChatSeen[] | null>(null)
  const [builtIn, setBuiltIn] = useState(false)
  const [auto, setAuto] = useState(() => deviceSetting(AUTO) === '1')
  // A build with the bot in it sends daily unless somebody switched it off here.
  useEffect(() => { if (builtIn && deviceSetting(AUTO) === null) setAuto(true) }, [builtIn])
  const [at, setAt] = useState(() => deviceSetting(AUTO_AT) ?? DEFAULT_AT)
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<PackRun | null>(lastPackRun)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [waiting, setWaiting] = useState<number | null>(null)

  useEffect(() => { void telegramBuiltIn().then(setBuiltIn) }, [])
  useEffect(() => { void flushOutbox().then((s) => setWaiting(s.waiting), () => undefined) }, [])

  const save = (key: string, value: string) => void setDeviceSetting(key, value.trim() === '' ? null : value.trim())

  async function sendNow(which: 'today' | 'month') {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const range = which === 'today' ? { from: businessDate(), to: businessDate() } : rangePreset('month')
      const delivery = await deliverPack(db, range)
      setRun(lastPackRun())
      const text = say(delivery)
      if (delivery.mailError || delivery.folderError) setError(text)
      else setNote(text)
      void flushOutbox().then((s) => setWaiting(s.waiting), () => undefined)
    } catch (err) {
      setError(`The reports could not be sent: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function findChats() {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      // The token is read by the other side from this machine's settings, so
      // it has to be saved before the question is asked.
      await setDeviceSetting(TG_TOKEN, tgToken.trim() === '' ? null : tgToken.trim())
      setChats(await findTelegramChats())
    } catch (err) {
      setChats(null)
      setError(typeof err === 'string' ? err : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function chooseChat(id: string) {
    setTgChat(id)
    save(TG_CHAT, id)
    setChats(null)
  }

  async function retry() {
    setBusy(true)
    setError(null)
    try {
      const state = await flushOutbox()
      setWaiting(state.waiting)
      if (state.error) setError(state.error)
      else setNote(state.sent > 0 ? `${state.sent} sent.` : 'Nothing was waiting.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Intro>
        Every report — sales by day, products, profit, GST, payments, staff, drawer, books and the
        ledger — as one zip of CSV files, sent to the address you give, to a Telegram chat, and copied into
        the backup folder. The shop’s name and id are in every file name, so reports from several shops can
        share one inbox or one Drive folder.
      </Intro>

      <Card title="Email">
        <Field label="Send reports to" hint="One or more addresses, separated by commas.">
          <input
            className="input" id="mail-to" type="text" value={to}
            onChange={(e) => setTo(e.target.value)} onBlur={() => save(MAIL_TO, to)}
          />
        </Field>
        <Field label="Send from (Gmail address)" hint="The account that sends. It can be the same address.">
          <input
            className="input" id="mail-user" type="text" value={user}
            onChange={(e) => setUser(e.target.value)} onBlur={() => save(MAIL_USER, user)}
          />
        </Field>
        <Field
          label="App password"
          hint="Not the Gmail password. In the Google account: Security, 2-Step Verification, App passwords. Kept on this computer only."
        >
          <input
            className="input" id="mail-password" type="password" value={password} autoComplete="off"
            onChange={(e) => setPassword(e.target.value)} onBlur={() => save(MAIL_PASSWORD, password)}
          />
        </Field>
        <Field label="Mail server" hint="Leave both empty for Gmail (smtp.gmail.com, port 587).">
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input" id="mail-host" type="text" value={host} placeholder="smtp.gmail.com"
              onChange={(e) => setHost(e.target.value)} onBlur={() => save(MAIL_HOST, host)}
            />
            <input
              className="input" id="mail-port" type="text" value={port} placeholder="587" style={{ maxWidth: 90 }}
              onChange={(e) => setPort(e.target.value)} onBlur={() => save(MAIL_PORT, port)}
            />
          </div>
        </Field>
        <div className="settings-group-why">
          Reports are queued and sent when the connection allows, so a slow or dropped line delays them
          and never loses them. The folder copy uses the folder chosen under Backups &amp; restore.
        </div>
      </Card>

      <Card title="Telegram">
        {builtIn && (
          <div className="settings-group-why" style={{ marginBottom: 11 }}>
            This copy of ShopOS already sends to its supplier’s Telegram chat. Nothing needs to be
            entered here; a token and chat typed below are used instead.
          </div>
        )}
        <Field
          label="Bot token"
          hint="From BotFather, when you make the bot. Kept on this computer only. Use a bot made for the shops, not one that does anything else."
        >
          <input
            className="input" id="tg-token" type="password" value={tgToken} autoComplete="off"
            onChange={(e) => setTgToken(e.target.value)} onBlur={() => save(TG_TOKEN, tgToken)}
          />
        </Field>
        <Field
          label="Chat id"
          hint="The chat the reports go to: your own id, or a group's (starts with -100). Send the bot a message first, or add it to the group."
        >
          <input
            className="input" id="tg-chat" type="text" value={tgChat}
            onChange={(e) => setTgChat(e.target.value)} onBlur={() => save(TG_CHAT, tgChat)}
          />
        </Field>
        <div style={{ display: 'flex', gap: 8, marginBottom: 11 }}>
          <button className="btn sm" disabled={busy || (tgToken.trim() === '' && !builtIn)} onClick={() => void findChats()}>
            Find my chat id
          </button>
        </div>
        {chats !== null && chats.length === 0 && (
          <div style={{ marginBottom: 11 }}>
            <Alert>
              No chat has messaged this bot yet. Open the bot in Telegram, press Start, send it any word,
              and try again.
            </Alert>
          </div>
        )}
        {chats !== null && chats.length > 0 && (
          <div style={{ marginBottom: 11 }}>
            <div className="settings-group-why">Choose where the reports should go:</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {chats.map((c) => (
                <button key={c.id} className="btn sm" onClick={() => chooseChat(c.id)}>
                  {c.name || c.id} ({c.kind}) {c.id}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="Send">
        <Field label="Every day">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox" checked={auto}
              onChange={(e) => { setAuto(e.target.checked); save(AUTO, e.target.checked ? '1' : '0') }}
            />
            Send this month’s reports once a day, at
            <input
              className="input" id="report-at" type="time" value={at} style={{ maxWidth: 120 }}
              onChange={(e) => { setAt(e.target.value); save(AUTO_AT, e.target.value) }}
            />
          </label>
        </Field>
        <div style={{ display: 'flex', gap: 8, marginBottom: 11 }}>
          <button className="btn primary sm" disabled={busy} onClick={() => void sendNow('today')}>Send today’s now</button>
          <button className="btn sm" disabled={busy} onClick={() => void sendNow('month')}>Send this month’s now</button>
          <button className="btn sm" disabled={busy} onClick={() => void retry()}>
            Try waiting emails{waiting ? ` (${waiting})` : ''}
          </button>
        </div>
        {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}
        {note && <div style={{ marginBottom: 11 }}><Alert kind="ok">{note}</Alert></div>}
        {run && (
          <div className="settings-group-why">
            Last send {whenWas(run.at)}: {run.text}
          </div>
        )}
      </Card>
    </>
  )
}
