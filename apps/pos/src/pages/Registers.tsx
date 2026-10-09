import { useCallback, useEffect, useState } from 'react'
import {
  listRegisters, renameRegister, setRegisterActive,
  resolveDeviceRegister, countersOtherTillsUse, takeRegister,
  type Register, type CounterTaken,
} from '@shopos/core'
import { chosenRegister } from '../core/device'
import { takeCounter } from '../core/counters'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Empty, Alert } from '../ui/components'
import { useConfirm } from '../ui/useConfirm'
import { useShopChanged } from '../core/useShopChanged'
import { ago } from '../core/syncStatus'

export default function Registers() {
  const { db, reloadRegister } = useCore()
  const user = useUser()
  const [confirmUi, ask] = useConfirm()
  const [rows, setRows] = useState<Register[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /* What this machine picked, as against what it ended up on. They are two
     different facts and the screen showed only the second, which is how the
     fallback became invisible — see `settled` below. */
  const [chosen, setChosen] = useState<string | null>(null)

  /* Which counters the shop's other tills sit at, so this screen can refuse to
     put this machine on one of them. Empty on a single-till shop, and empty for
     a peer that has never answered — `countersOtherTillsUse` says why an
     unheard-from till is left out rather than guessed at. */
  const [taken, setTaken] = useState<CounterTaken[]>([])

  const refresh = useCallback(async () => {
    setRows(await listRegisters(db, true))
    setChosen(chosenRegister())
    setDeviceId(await resolveDeviceRegister(db, chosenRegister()))
    setTaken(await countersOtherTillsUse(db))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])
  // And again whenever the other till sends something this list shows.
  useShopChanged(refresh)

  async function useHere(id: string) {
    setError(null)

    /* Asked again here rather than trusted from the row that was pressed. The
       list on screen may be a minute old, and a peer's counter can arrive in
       any sync between the two — a disabled button is a statement about what
       was true when it rendered, and this is the thing that must not happen. */
    const nowTaken = (await countersOtherTillsUse(db)).find((t) => t.registerId === id)
    if (nowTaken !== undefined) {
      setError(
        `${nowTaken.label ?? 'Another till'} is already billing on that counter. `
        + 'Two tills on one counter give two customers the same bill number, so '
        + 'this machine needs one of its own — add a counter if there is none free.',
      )
      await refresh()
      return
    }

    /* Which counter this machine bills on goes to the machine; which till sits
       here goes to the shop. `takeCounter` says why neither can be done alone. */
    if (!(await takeCounter(db, id))) {
      /* The choice did not happen at all: nothing was written and this machine
         is still on the counter it was on. Saying "it will go back at the next
         start" would describe a move that never took place, and the green
         notice below used to appear alongside this, so the screen said the
         choice had been made and had failed, at once. */
      const staying = rows.find((r) => r.id === chosenRegister())
      setError(
        'This machine could not record which counter it is, so the choice was not made. '
        + `It is still on ${staying ? staying.name : 'the counter it resolved to'}, and `
        + 'billing is unaffected. The banner above says why.',
      )
      await refresh()
      return
    }
    await reloadRegister()
    await refresh()
    setNotice('This machine now bills on that counter.')
    setTimeout(() => setNotice(null), 3000)
  }

  /**
   * Takes a counter whose holder has stopped starting up.
   *
   * Confirmed rather than done, because the cost of being wrong is two tills
   * minting one series of invoice numbers — and the shopkeeper is the only one
   * who knows whether that machine is in a cupboard or on the counter.
   */
  async function takeOver(r: Register) {
    setError(null)
    const holder = taken.find((t) => t.registerId === r.id)
    const who = holder?.label ?? 'another till'
    const agreed = await ask(
      `${r.name} is claimed by ${who}`
      + `${holder?.at === null || holder?.at === undefined ? ', which has never said so since' : `, last seen ${ago(holder.at)}`}.\n\n`
      + 'Take it over only if that machine is not billing any more. Two tills on '
      + 'one counter give two customers the same bill number.',
    )
    if (!agreed) return

    const result = await takeRegister(db, r.id)
    if (!result.ok) {
      setError(
        `${result.label ?? 'That till'} has started up since this screen was drawn, so the `
        + 'counter is still theirs. Nothing was changed.',
      )
      await refresh()
      return
    }
    await useHere(r.id)
  }

  async function toggle(r: Register) {
    setError(null)
    const result = await setRegisterActive(db, { registerId: r.id, isActive: !r.isActive, actorId: user.id })
    if (!result.ok) {
      setError('That counter still has its drawer open. Close the drawer before switching it off.')
      return
    }
    await refresh()
    await reloadRegister()
  }

  async function rename(r: Register) {
    const name = window.prompt('Rename this counter', r.name)
    if (name === null || name.trim() === '') return
    const result = await renameRegister(db, { registerId: r.id, name, actorId: user.id })
    if (!result.ok) { setError('A counter with that name already exists.'); return }
    await refresh()
    await reloadRegister()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
      {confirmUi}
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      {/* Two cases that used to be one. A shop with a single till still falls
          back to its first counter, which is right — a till that refused to
          sell because nobody pressed a button here would be worse. A shop with
          a second till gets no fallback at all, because the first counter is
          the other till's, and taking it means two machines minting one number
          series and sharing one drawer. */}
      {deviceId === null && (
        <Alert>
          This machine has not been told which counter it sits at, and this shop
          has more than one till — so it is not billing at all. Press
          <strong> Use here</strong> on the counter it actually sits at. The ones
          another till is already on cannot be picked.
        </Alert>
      )}
      {deviceId !== null && chosen !== deviceId && (
        <Alert>
          This machine has not been told which counter it is, so it is billing on{' '}
          <strong>{rows.find((r) => r.id === deviceId)?.name ?? 'the first counter'}</strong>{' '}
          because that is the first one switched on. Its bills carry that counter's
          number series and its cash goes into that counter's drawer. Press
          <strong> Use here</strong> on the counter this machine actually sits at —
          if it is that one, press it there too, and it will stop moving when the
          list changes.
        </Alert>
      )}

      <Card title="Counters">
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          Each till makes its own counter the first time it starts, with a bill prefix
          worked out from the machine itself. It is never typed and never changes, so
          two tills cannot end up with the same one.
        </div>

        <div className="card card-scroll">
          <table>
            <thead>
              <tr><th>Counter</th><th>Prefix</th><th>Drawer</th><th>This machine</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {!r.isActive && <span className="badge mute" style={{ marginLeft: 7 }}>off</span>}
                  </td>
                  <td className="num">{r.prefix}</td>
                  <td>
                    {r.hasOpenSession
                      ? <span className="badge ok">open</span>
                      : <span style={{ color: 'var(--ink-3)' }}>closed</span>}
                  </td>
                  <td>
                    {deviceId === r.id && chosen === r.id
                      ? <span className="badge ok">billing here</span>
                      : deviceId === r.id
                        /* Billing here without having chosen it. Shown apart from a
                           real choice, and still offering the button, because the
                           two used to look identical — so a second till that fell
                           back onto the first one's counter said "billing here" in
                           green and nobody ever pressed anything. */
                        ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            <span className="badge">falling back here</span>
                            {r.isActive && (
                              <button className="btn sm" onClick={() => void useHere(r.id)}>Use here</button>
                            )}
                          </div>
                        )
                      /* A counter another till bills on is shown and refused
                         rather than hidden: "the front counter is on this one"
                         is an answer, and a row that quietly disappears is not.
                         This is the half `resolveDeviceRegister` cannot do —
                         it stopped this machine being *given* that counter, and
                         nothing stopped it being chosen. */
                      : taken.find((t) => t.registerId === r.id) !== undefined
                        ? (() => {
                          const holder = taken.find((t) => t.registerId === r.id)!
                          const who = holder.label ?? 'Another till'
                          /* A claim nobody has renewed, or one that arrived on a
                             restored backup and belongs to a machine that no
                             longer exists. Offered rather than refused, and
                             offered with a name and a date on it, because
                             "claimed" is not a thing a shopkeeper can act on
                             and "last used by the back counter on the 3rd" is.
                             `takeRegister` checks again before it writes. */
                          if (!holder.stale) {
                            return (
                              <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                                {who} bills here
                              </span>
                            )
                          }
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                                {holder.at === null
                                  ? `${who} claimed this and has not been seen since`
                                  : `${who}, last seen ${ago(holder.at)}`}
                              </span>
                              {r.isActive && (
                                <button className="btn sm" onClick={() => void takeOver(r)}>
                                  Take it over
                                </button>
                              )}
                            </div>
                          )
                        })()
                      : r.isActive
                        ? <button className="btn sm" onClick={() => void useHere(r.id)}>Use here</button>
                        : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                  </td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" onClick={() => void rename(r)}>Rename</button>
                    <button className="btn ghost sm" onClick={() => void toggle(r)}>
                      {r.isActive ? 'Switch off' : 'Switch on'}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5}><Empty>No counters</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
