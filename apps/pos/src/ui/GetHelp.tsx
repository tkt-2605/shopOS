import { useEffect, useState } from 'react'
import { getSetting, listRegisters } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { chosenRegister } from '../core/device'
import { appVersion } from '../core/version'
import { copyText } from '../core/clipboard'
import {
  supportCode, supportLine, spokenShop, helpMessage, supportContact, openWhatsApp, startRemoteHelp,
  type SupportCode, type SupportContact, type RemoteHelp,
} from '../core/support'
import { Modal, Alert } from './components'

/**
 * Getting help, from anybody signed in.
 *
 * Beside "Change my password" in the sidebar rather than on Settings, which is
 * behind the owner's gate: the person at the counter when something goes wrong
 * is as often a cashier as the owner, and the first thing support asks for is
 * which shop this is. The report an owner can save stays on Settings → Help.
 */
export function GetHelp({ onClose }: { onClose: () => void }) {
  const { db } = useCore()
  const [code, setCode] = useState<SupportCode | null>(null)
  const [contact, setContact] = useState<SupportContact | null | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [remote, setRemote] = useState<RemoteHelp | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const mine = chosenRegister()
      const [shopId, registers, version, reach] = await Promise.all([
        getSetting(db, 'shop_id').catch(() => null),
        listRegisters(db, true).catch(() => []),
        appVersion(),
        supportContact(),
      ])
      if (!live) return
      setCode(supportCode({
        shopId,
        counterPrefix: registers.find((r) => r.id === mine)?.prefix ?? null,
        version: version?.version ?? null,
      }))
      setContact(reach)
    })()
    return () => { live = false }
  }, [db])

  async function copy() {
    if (!code) return
    setCopied(await copyText(supportLine(code)))
  }

  async function whatsapp() {
    if (!code) return
    setProblem(await openWhatsApp(helpMessage(code)))
  }

  async function remoteHelp() {
    setRemote(await startRemoteHelp())
  }

  return (
    <Modal
      title="Get help"
      onClose={onClose}
      footer={<button className="btn primary" onClick={onClose}>Close</button>}
    >
      <div className="get-help">
        <section>
          <div className="get-help-label">Your support code</div>
          <div className="get-help-code">
            <span className="num">{code ? (code.shop ? spokenShop(code.shop) : 'no shop yet') : '…'}</span>
            {code?.counter && <span className="get-help-part">counter {code.counter}</span>}
            {code?.version && <span className="get-help-part">version {code.version}</span>}
          </div>
          <div className="get-help-row">
            <button className="btn sm" disabled={!code} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="get-help-note">Read this out, or paste it, when you ask for help.</span>
          </div>
        </section>

        <section>
          <div className="get-help-label">Talk to support</div>
          {contact === undefined ? null : contact?.phone ? (
            <>
              <div className="get-help-phone num">{contact.phone}</div>
              {contact.whatsapp && (
                <div className="get-help-row">
                  <button className="btn sm" disabled={!code} onClick={() => void whatsapp()}>
                    Message on WhatsApp
                  </button>
                  <span className="get-help-note">Opens a chat with your support code already in it.</span>
                </div>
              )}
            </>
          ) : (
            <Alert>
              This copy of ShopOS has no support number. Ask whoever installed it, or set
              SHOPOS_SUPPORT_PHONE in apps/pos/src-tauri/.env and build again.
            </Alert>
          )}
          {problem && <Alert>{problem}</Alert>}
        </section>

        <section>
          <div className="get-help-label">Let support see this screen</div>
          <p className="get-help-note" style={{ margin: '0 0 8px' }}>
            Only while you are talking to support and can watch what they do. Close the
            program when they have finished. Billing carries on as normal while it is open.
          </p>
          <button className="btn sm" onClick={() => void remoteHelp()}>Start remote help</button>
          {remote?.outcome === 'started' && (
            <Alert kind="ok">{remote.program} is open. Read support the number it shows.</Alert>
          )}
          {remote?.outcome === 'notInstalled' && (
            <Alert>
              Neither RustDesk nor AnyDesk is on this machine. Support will tell you which one to
              download.
            </Alert>
          )}
          {remote?.outcome === 'failed' && <Alert>{remote.error}</Alert>}
        </section>
      </div>
    </Modal>
  )
}
