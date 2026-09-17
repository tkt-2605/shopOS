import { useCallback, useEffect, useState } from 'react'
import { listRegisters, type Register } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { chooseRegister } from '../core/device'
import { lookAround, type FoundTill } from '../core/syncHost'
import { explain } from '../core/syncWords'
import { Field, Alert } from './components'

/**
 * A machine becoming the shop's second till.
 *
 * On the first screen, before anything is signed in, because that is when it is
 * needed: until now the only door on a new machine was "Set up ShopOS", which
 * creates a *shop*. A second till that goes through it has made a second shop —
 * its own Admin role, its own counter, its own price list, same names, different
 * rows — and the sync handshake refuses the pair with `DIFFERENT_SHOP`, which is
 * right and arrives after a day's work is already in the wrong database.
 *
 * Nothing here calls `bootstrap`. The machine stays empty and receives the shop.
 *
 * ## Why it asks for a counter before it lets go
 *
 * A till with no counter of its own falls back to the first one in the list,
 * which is the till it just joined. Two tills on one counter mint invoice
 * numbers from the same series, so the next sync is refused with
 * `SAME_REGISTER` — recoverable in ten seconds and completely opaque if you do
 * not already know what a counter is. Asking here costs one screen and removes
 * the only refusal this flow can cause by itself.
 */

type Stage =
  | { at: 'choosing' }
  | { at: 'joining' }
  | { at: 'counter'; registers: Register[]; taken: string | null }

export function JoinShop({ onCancel }: { onCancel: () => void }) {
  const { db, joinShop } = useCore()
  const [stage, setStage] = useState<Stage>({ at: 'choosing' })
  const [found, setFound] = useState<FoundTill[] | null>(null)
  const [looking, setLooking] = useState(true)
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  /* Asked on arrival rather than behind a button. A shopkeeper setting up a
     second till is holding a machine that knows nothing; the list of tills on
     the network is the one thing the screen can offer without being asked. */
  const look = useCallback(async () => {
    setLooking(true)
    setError(null)
    try {
      const tills = await lookAround()
      setFound(tills)
      if (tills.length === 1) setAddress(tills[0]!.address)
    } catch (err) {
      setError(`Could not look for tills on this network. ${String(err)}`)
    } finally {
      setLooking(false)
    }
  }, [])

  useEffect(() => { void look() }, [look])

  async function join() {
    setError(null)
    setStage({ at: 'joining' })
    try {
      await joinShop({ address, code })
      /* The shop has arrived, so the counters are here to choose from. The one
         the till we joined is billing on is marked rather than hidden: a shop
         may genuinely have two machines at one counter for a day, and a screen
         that removes the option is a screen that cannot explain itself. */
      const registers = await listRegisters(db)
      const till = found?.find((t) => t.address === address)
      setStage({ at: 'counter', registers, taken: till?.label ?? null })
    } catch (err) {
      setError(explain(err))
      setStage({ at: 'choosing' })
    }
  }

  async function useCounter(id: string) {
    setError(null)
    if (!(await chooseRegister(id))) {
      setError('This machine could not record which counter it sits at. '
        + 'It has joined the shop; open Counters after signing in and press "Use here".')
    }
    window.location.reload()
  }

  if (stage.at === 'joining') {
    return (
      <div className="panel-body">
        <p style={{ fontSize: 13 }}>
          Joining, and taking a copy of the shop. On a shop with a year of trade
          behind it this takes a minute.
        </p>
      </div>
    )
  }

  if (stage.at === 'counter') {
    return (
      <div className="panel-body">
        <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Which counter is this machine?</h2>
        <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 0 }}>
          Every bill this machine prints carries its counter’s prefix, and two
          tills on one counter would give two customers the same bill number.
        </p>
        {error && <Alert>{error}</Alert>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {stage.registers.map((r) => (
            <button
              key={r.id}
              className="btn"
              style={{ justifyContent: 'space-between', display: 'flex' }}
              onClick={() => void useCounter(r.id)}
            >
              <span>{r.name} — {r.prefix}</span>
              {r.hasOpenSession && (
                <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>a drawer is open here</span>
              )}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 12 }}>
          Nothing here yet for this machine? Sign in, open Counters and add one —
          this till will keep asking until it has one of its own.
        </p>
      </div>
    )
  }

  return (
    <div className="panel-body">
      {error && <Alert>{error}</Alert>}

      <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 0 }}>
        This machine will receive the shop from a till that already has it —
        staff, counters, prices and every bill. It does not set up a shop of its
        own.
      </p>

      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 12.5 }}>Tills on this network</strong>
          <button className="btn ghost sm" disabled={looking} onClick={() => void look()}>
            {looking ? 'Looking…' : 'Look again'}
          </button>
        </div>

        {found !== null && found.length === 0 && (
          <p style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
            None answered. Both machines have to be on the same network, and the
            other till has to be serving — open Settings there and switch on
            “Let another till join this shop”. You can also type its address
            below.
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {(found ?? []).map((t) => (
            <button
              key={t.device}
              className={address === t.address ? 'btn primary' : 'btn'}
              style={{ display: 'flex', justifyContent: 'space-between' }}
              onClick={() => setAddress(t.address)}
            >
              <span>{t.shop ?? 'A shop'} — {t.label}</span>
              <span style={{ fontSize: 11.5, opacity: 0.8 }}>{t.address}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <Field label="Address" hint="Filled in by the list above. Type it only if nothing answered.">
          <input
            className="input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="192.168.1.11:7801"
          />
        </Field>
        <Field
          label="Code from that till"
          hint="Shown on its Settings screen. It lasts ten minutes and one attempt uses it up."
        >
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD2345"
          />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          className="btn primary"
          disabled={address.trim() === '' || code.trim() === ''}
          onClick={() => void join()}
        >
          Join this shop
        </button>
        <button className="btn ghost" onClick={onCancel}>Back</button>
      </div>
    </div>
  )
}
