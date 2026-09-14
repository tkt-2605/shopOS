import { useCallback, useEffect, useState } from 'react'
import {
  listRegisters, createRegister, renameRegister, setRegisterActive,
  resolveDeviceRegister, type Register,
} from '@shopos/core'
import { chooseRegister, chosenRegister } from '../core/device'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Modal, Field, Empty, Alert } from '../ui/components'

export default function Registers() {
  const { db, reloadRegister } = useCore()
  const user = useUser()
  const [rows, setRows] = useState<Register[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ name: string; prefix: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /* What this machine picked, as against what it ended up on. They are two
     different facts and the screen showed only the second, which is how the
     fallback became invisible — see `settled` below. */
  const [chosen, setChosen] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRows(await listRegisters(db, true))
    setChosen(chosenRegister())
    setDeviceId(await resolveDeviceRegister(db, chosenRegister()))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  async function add() {
    if (!adding) return
    setError(null)
    const result = await createRegister(db, { name: adding.name, prefix: adding.prefix, actorId: user.id })
    if (!result.ok) {
      setError(
        result.code === 'PREFIX_TAKEN' ? `${result.prefix} is already used by another counter. Every counter needs its own, or two tills will print the same bill number.`
        : result.code === 'NAME_TAKEN' ? 'A counter with that name already exists.'
        : 'A prefix is 2 to 6 letters or digits, like FC or TILL2.',
      )
      return
    }
    setAdding(null)
    await refresh()
  }

  async function useHere(id: string) {
    setError(null)
    /* Written to this machine, not to the shop's database — two tills sharing
       one database must be able to sit on different counters. */
    if (!(await chooseRegister(id))) {
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
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      {/* A machine that has never been told which counter it is falls back to the
          first one that is switched on. That is the right thing to do — a till
          that refuses to sell because nobody pressed a button here would be
          worse — but it was indistinguishable from a deliberate choice, and two
          tills quietly sharing one counter share its drawer: both days are
          reconciled as one and neither can be closed. */}
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

      <Card
        title="Counters"
        actions={<button className="btn primary sm" onClick={() => setAdding({ name: '', prefix: '' })}>Add counter</button>}
      >
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          Each counter has its own bill number series and its own cash drawer. The prefix
          is fixed once bills carry it.
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

      {adding && (
        <Modal
          title="Add a counter"
          onClose={() => setAdding(null)}
          footer={<>
            <button className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <button className="btn primary" disabled={adding.name.trim() === '' || adding.prefix.trim() === ''}
              onClick={() => void add()}>Add</button>
          </>}
        >
          <Field label="Name">
            <input className="input" id="reg-name" autoFocus value={adding.name}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Front Counter" />
          </Field>
          <Field label="Bill prefix" hint="2–6 letters or digits. Appears in every bill number from this counter and cannot change later.">
            <input className="input num" id="reg-prefix" value={adding.prefix}
              onChange={(e) => setAdding({ ...adding, prefix: e.target.value.toUpperCase() })} placeholder="FC" />
          </Field>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            Bills will read <span className="num">INV/{adding.prefix || 'FC'}/26-27/00001</span>.
          </div>
        </Modal>
      )}
    </div>
  )
}
