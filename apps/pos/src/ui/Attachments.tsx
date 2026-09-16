import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listAttachments, recordAttachment, removeAttachment, ACCEPTED_MIME,
  type Attachment, type AttachmentEntity,
} from '@shopos/core'
import { useDb, useCore } from '../core/CoreProvider'
import { storeFile, readFile, deleteFile, filesFromTransfer, nameFor } from '../core/attachments'
import { Modal } from './components'

/**
 * The photographs kept against a document.
 *
 * A shop's evidence is on paper today: the handwritten list a customer brought,
 * the delivery challan the driver signed, the UPI screenshot that says the money
 * arrived. Paper is what gets lost, and the argument about it happens three
 * months later.
 *
 * Paste is the important one. A UPI screenshot is on the clipboard already —
 * Ctrl+V and it is against the bill — and a cashier who has to find a file
 * picker at a counter with a queue behind them will not do it twice.
 */

export function Attachments({
  entity,
  entityId,
  canEdit,
  label = 'Photos and documents',
  onChange,
}: {
  entity: AttachmentEntity
  entityId: string
  canEdit: boolean
  label?: string
  /** Told when the set changes, so a list showing a count can refresh it. */
  onChange?: () => void
}) {
  const db = useDb()
  const { user } = useCore()
  const [items, setItems] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [viewing, setViewing] = useState<Attachment | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setItems(await listAttachments(db, entity, entityId))
  }, [db, entity, entityId])

  const changed = useCallback(async () => {
    await refresh()
    onChange?.()
  }, [refresh, onChange])

  useEffect(() => { void refresh() }, [refresh])

  const take = useCallback(async (files: File[]) => {
    if (!user || files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      for (const file of files) {
        const saved = await storeFile(file, nameFor(file))
        await recordAttachment(db, { actorId: user.id }, {
          entity,
          entityId,
          file: {
            fileName: saved.fileName,
            mime: saved.mime,
            sizeBytes: saved.sizeBytes,
            sha256: saved.sha256,
            storedPath: saved.storedPath,
          },
        })
      }
      await changed()
    } catch (err) {
      setError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'That file could not be kept.')
    } finally {
      setBusy(false)
    }
  }, [db, entity, entityId, changed, user])

  // Paste anywhere on the screen while this strip is showing, except inside a
  // box someone is typing into.
  useEffect(() => {
    if (!canEdit) return
    function onPaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
      const files = filesFromTransfer(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      void take(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [canEdit, take])

  async function remove(item: Attachment) {
    if (!user) return
    setBusy(true)
    try {
      // The row goes first and the bytes only if nothing else cites them; the
      // core decides that inside the same transaction as the delete.
      const { orphaned } = await removeAttachment(db, { actorId: user.id }, item.id)
      if (orphaned) await deleteFile(orphaned).catch(() => undefined)
      setViewing(null)
      await changed()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`att${dragging ? ' att-drop' : ''}`}
      onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canEdit) return
        e.preventDefault()
        setDragging(false)
        void take(filesFromTransfer(e.dataTransfer))
      }}
    >
      <div className="att-head">
        <span>{label}{items.length > 0 && <span className="att-count">{items.length}</span>}</span>
        {canEdit && (
          <button className="btn" type="button" disabled={busy} onClick={() => picker.current?.click()}>
            {busy ? 'Saving…' : 'Add'}
          </button>
        )}
      </div>

      <input
        ref={picker}
        type="file"
        multiple
        /* The list the service accepts, rather than a copy of it typed here:
           two lists mean a shop offered a file type that is refused the moment
           it is chosen, or refused one that would have been fine. */
        accept={ACCEPTED_MIME.join(',')}
        style={{ display: 'none' }}
        onChange={(e) => {
          void take(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />

      {error && <div className="att-error">{error}</div>}

      {items.length === 0 ? (
        <div className="att-empty">
          {canEdit
            ? 'Drop a photo here, or paste one with Ctrl+V — a screenshot, the customer’s list, a signed delivery.'
            : 'Nothing attached.'}
        </div>
      ) : (
        <div className="att-strip">
          {items.map((item) => (
            <Tile key={item.id} item={item} onOpen={() => setViewing(item)} />
          ))}
        </div>
      )}

      {viewing && (
        <Viewer
          item={viewing}
          canEdit={canEdit}
          busy={busy}
          onClose={() => setViewing(null)}
          onRemove={() => void remove(viewing)}
        />
      )}
    </div>
  )
}

/** One thumbnail. The bytes are fetched per tile, so a bill with no photographs
 *  costs nothing and a bill with eight does not block on the first. */
function Tile({ item, onOpen }: { item: Attachment; onOpen: () => void }) {
  const [src, setSrc] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const isPdf = item.mime === 'application/pdf'

  useEffect(() => {
    if (isPdf) return
    let live = true
    readFile(item.storedPath).then(
      (url) => { if (live) setSrc(url) },
      () => { if (live) setGone(true) },
    )
    return () => { live = false }
  }, [item.storedPath, isPdf])

  return (
    <button className="att-tile" type="button" onClick={onOpen} title={item.fileName}>
      {isPdf ? (
        <span className="att-doc">PDF</span>
      ) : gone ? (
        <span className="att-doc att-missing">missing</span>
      ) : src ? (
        <img src={src} alt={item.fileName} />
      ) : (
        <span className="att-doc">…</span>
      )}
      <span className="att-name">{item.fileName}</span>
    </button>
  )
}

function Viewer({
  item, canEdit, busy, onClose, onRemove,
}: {
  item: Attachment; canEdit: boolean; busy: boolean; onClose: () => void; onRemove: () => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let live = true
    readFile(item.storedPath).then(
      (url) => { if (live) setSrc(url) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [item.storedPath])

  return (
    <Modal
      title={item.fileName}
      onClose={onClose}
      footer={
        canEdit ? (
          confirming ? (
            <>
              <span className="att-confirm">Remove this from the document?</span>
              <button className="btn" type="button" onClick={() => setConfirming(false)}>Keep</button>
              <button className="btn danger" type="button" disabled={busy} onClick={onRemove}>Remove</button>
            </>
          ) : (
            <button className="btn" type="button" onClick={() => setConfirming(true)}>Remove</button>
          )
        ) : undefined
      }
    >
      <div className="att-view">
        {failed ? (
          <div className="att-empty">
            The file is not on this machine any more. The record of it stays on the document.
          </div>
        ) : item.mime === 'application/pdf' ? (
          <div className="att-empty">
            A PDF of {(item.sizeBytes / 1024).toFixed(0)} KB, kept with the document.
          </div>
        ) : src ? (
          <img src={src} alt={item.fileName} />
        ) : (
          <div className="att-empty">Opening…</div>
        )}
      </div>
      <div className="att-meta">
        {(item.sizeBytes / 1024).toFixed(0)} KB · added {new Date(item.createdAt).toLocaleString()}
      </div>
    </Modal>
  )
}
