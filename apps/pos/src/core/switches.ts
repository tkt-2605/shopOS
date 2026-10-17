import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  getSetting, newer, switchedOff, verifyBoard, REPAIR_KEYS,
  type SigningKey, type SqlDriver, type Switch, type SwitchBoard,
} from '@shopos/core'
import { deviceSetting, setDeviceSetting } from './device'
import { logEvent } from './log'

/*
 * The vendor's switch board on this till (`core/domain/switches.ts`).
 *
 * Fetched from the portal by Rust at start and every half hour, checked here
 * against the repair key this build carries, and kept on this machine, so a
 * feature switched off stays off with the line down and through a restart.
 * Only a newer board replaces the one held. Until a board has been read,
 * everything is on: a till that cannot reach the portal is a till working.
 */

const KEY = 'switch_board'
const EVERY_MS = 30 * 60_000

let board: SwitchBoard | null = null
let shop: string | null = null
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version += 1
  for (const l of listeners) l()
}

/** Whether the vendor has switched this feature off at this shop, now. */
export function isOff(feature: Switch, now = new Date()): boolean {
  return switchedOff(board, feature, shop, now).off
}

/** The same, for a screen: it redraws when a new board arrives. */
export function useSwitchedOff(feature: Switch): boolean {
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => version)
  return isOff(feature)
}

/** Takes a board if it is the vendor's and newer than the one held. Says what happened. */
export async function takeBoard(token: string, keys: readonly SigningKey[] = REPAIR_KEYS): Promise<'taken' | 'older' | string> {
  const read = await verifyBoard(token, keys)
  if (!read.ok) return read.code
  if (!newer(read.board, board)) return 'older'
  board = read.board
  await setDeviceSetting(KEY, token)
  const off = read.board.off.map((o) => `${o.feature} (${o.why})`).join(', ')
  logEvent('info', 'switches', `board of ${read.board.issuedAt}: ${off || 'everything on'}`)
  changed()
  return 'taken'
}

/** The board this machine already holds, then the portal's. */
export async function loadSwitches(db: SqlDriver, keys: readonly SigningKey[] = REPAIR_KEYS): Promise<void> {
  shop = await getSetting(db, 'shop_id').catch(() => null)
  const held = deviceSetting(KEY)
  if (held) await takeBoard(held, keys)
  await refreshSwitches(keys)
}

export async function refreshSwitches(keys: readonly SigningKey[] = REPAIR_KEYS): Promise<void> {
  const token = await invoke<string | null>('switches_fetch').catch(() => null)
  if (!token) return
  const outcome = await takeBoard(token, keys)
  if (outcome !== 'taken' && outcome !== 'older') logEvent('warn', 'switches', `the portal's board was refused: ${outcome}`)
}

export function startSwitches(db: SqlDriver): () => void {
  void loadSwitches(db)
  const timer = setInterval(() => { void refreshSwitches() }, EVERY_MS)
  return () => clearInterval(timer)
}

/** For tests: forget the board held in memory. */
export function forgetSwitches(): void {
  board = null
  shop = null
  changed()
}
