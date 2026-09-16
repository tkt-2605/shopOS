import { invoke } from '@tauri-apps/api/core'
import { chooseFolder } from './backup'

/**
 * One file that says what this machine is doing, for somebody who cannot see it.
 *
 * The shape of the problem: the shop is in one town, whoever can fix it is in
 * another, and the thing that went wrong happened four hours ago. Asking a
 * shopkeeper to find a log folder, read a version off a screen and describe
 * what the database is doing is asking them to do a developer's job down a
 * phone line while customers wait.
 *
 * So the button writes a zip they can attach to a message.
 *
 * ## Nothing is sent from here
 *
 * The file is written to a folder the shopkeeper picks and stays there. ShopOS
 * does not upload it, does not know where it went, and opens no connection to
 * do any of this — sending it is the shopkeeper's decision, made in whatever
 * app they already use. Upload with consent is a Phase 6 question.
 *
 * The bundle is built to be forwarded, so the Rust side redacts on an allowlist
 * rather than a denylist: `backup_hook` can hold an rclone token, and any
 * setting nobody has considered is withheld until somebody decides it is safe.
 */

export type BundleResult =
  | { ok: true; path: string }
  /** The shopkeeper closed the folder picker. Not an error, and not a message. */
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string }

export async function writeDiagnosticsBundle(now = new Date()): Promise<BundleResult> {
  const destination = await chooseFolder()
  if (!destination) return { ok: false, cancelled: true }

  try {
    const path = await invoke<string>('diagnostics_bundle', {
      destination,
      now: now.toISOString(),
    })
    return { ok: true, path }
  } catch (err) {
    return {
      ok: false,
      cancelled: false,
      error: typeof err === 'string' ? err : 'The report could not be written.',
    }
  }
}
