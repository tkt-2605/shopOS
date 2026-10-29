/*
 * What the phone keeps: the last catalogue, the cart, the session, and the
 * last copy of "my orders" -- in IndexedDB, which holds far more than
 * localStorage's 5 MB and is kept for an installed app once
 * `navigator.storage.persist()` has been granted.
 *
 * Every read is allowed to fail. A private window, a full phone or a browser
 * that clears storage gives back nothing, and the storefront then fetches
 * again; nothing here is the only copy of anything.
 */

const DB = 'shop'
const STORE = 'kv'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function read<T>(key: string): Promise<T | null> {
  try {
    const db = await open()
    return await new Promise<T | null>((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function write(key: string, value: unknown): Promise<void> {
  try {
    const db = await open()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Not kept; fetched again next time.
  }
}

export async function forget(...keys: string[]): Promise<void> {
  try {
    const db = await open()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      for (const k of keys) tx.objectStore(STORE).delete(k)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Nothing to forget.
  }
}

/** Asks the phone not to clear what is kept here when space runs low. */
export function askToKeep(): void {
  void navigator.storage?.persist?.().catch(() => false)
}

/**
 * Drops the saved catalogue and the kept photos and page, then reloads, so
 * everything comes fresh from the shop. The cart, the session and the order
 * copy stay.
 */
export async function startAfresh(): Promise<void> {
  await forget('catalog', 'status')
  try {
    for (const k of await caches.keys()) await caches.delete(k)
  } catch {
    // No caches here (the app, or a private window).
  }
  location.reload()
}
