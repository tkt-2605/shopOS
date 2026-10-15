/*
 * What a till's health report says, in the few figures the alert rules and
 * the console read.
 *
 * The report is the till's own JSON (`src-tauri/src/health.rs` and
 * `core/health.ts` on the till): `health` is the machine, `checks` the
 * database, `app` what the app knows, `faults` how its runs ended. It arrives
 * from a till that may be any version, so nothing here assumes a field is
 * there or has the right type: a missing figure reads as unknown, never as
 * zero, because "no integrity result" and "integrity fine" are different
 * things to put in front of somebody.
 *
 * Pure and DB-free.
 */

export const REPORT_FORMAT = 1

export interface PeerSeen {
  deviceId: string
  label: string | null
  lastAgreedAt: string | null
  lastError: string | null
  clockSkewMs: number | null
}

export interface Runs {
  started: number
  clean: number
  panicked: number
  unclean: number
}

export interface TillSummary {
  version: string | null
  schemaVersion: number | null
  generatedAt: string | null
  /** Null when the till could not run the check, or did not say. */
  integrityOk: boolean | null
  foreignKeyProblems: number | null
  booksMissing: number | null
  peers: PeerSeen[]
  setAsideWaiting: number
  oldestSetAsideAt: string | null
  discrepancyKinds: string[]
  licence: { state: string | null; problem: string | null; paidThrough: string | null } | null
  clockUnreliable: boolean
  /** This version's runs, from `faults.json`. */
  runs: Runs | null
  errorKinds: number
  problems: string[]
}

export interface Report {
  shopId: string
  deviceId: string
  shopName: string | null
  generatedAt: string | null
  version: string | null
  summary: TillSummary
}

type Obj = Record<string, unknown>

/** The report, or why it is not one. */
export function readReport(body: unknown): { ok: true; report: Report } | { ok: false; detail: string } {
  if (!isObj(body)) return { ok: false, detail: 'the report is not a JSON object' }
  const shopId = str(body['shopId'])
  const deviceId = str(body['deviceId'])
  if (shopId === null) return { ok: false, detail: 'shopId is required' }
  if (deviceId === null) return { ok: false, detail: 'deviceId is required' }
  /* `format` above REPORT_FORMAT is a till newer than this portal. Read all
     the same: whatever it can find is still true. */

  const health = obj(body['health'])
  const checks = obj(body['checks'])
  const app = obj(body['app'])
  const faults = obj(body['faults'])
  const version = str(body['appVersion']) ?? str(health['app_version'])

  return {
    ok: true,
    report: {
      shopId,
      deviceId,
      shopName: str(body['shopName']),
      generatedAt: str(body['generatedAt']) ?? str(health['generated_at']),
      version,
      summary: {
        version,
        schemaVersion: num(checks['schema_version']),
        generatedAt: str(body['generatedAt']) ?? str(health['generated_at']),
        integrityOk: integrity(checks['integrity']),
        foreignKeyProblems: num(checks['foreign_key_problems']),
        booksMissing: firstNumber(obj(checks['documents'])['submitted_bills_without_books'], 'n'),
        peers: arr(obj(checks['sync'])['peers']).map(peer).filter((p): p is PeerSeen => p !== null),
        ...setAside(arr(obj(checks['sync'])['set_aside'])),
        discrepancyKinds: [...new Set(arr(app['discrepancies']).map((d) => str(obj(d)['kind'])).filter((k): k is string => k !== null))].sort(),
        licence: licence(app['licence']),
        clockUnreliable: obj(app['licence'])['clockUnreliable'] === true,
        runs: version === null ? null : runs(obj(obj(faults['sessions'])[version])),
        errorKinds: arr(faults['errors']).filter((e) => version === null || str(obj(e)['version']) === version).length,
        problems: arr(health['problems']).map(str).filter((p): p is string => p !== null).slice(0, 20),
      },
    },
  }
}

function integrity(rows: unknown): boolean | null {
  const list = arr(rows)
  if (list.length === 0) return null
  // `PRAGMA quick_check` says one row, `ok`, when there is nothing wrong.
  return list.length === 1 && str(obj(list[0])['quick_check']) === 'ok'
}

function peer(row: unknown): PeerSeen | null {
  const p = obj(row)
  const deviceId = str(p['device_id'])
  if (deviceId === null) return null
  return {
    deviceId,
    label: str(p['label']),
    lastAgreedAt: str(p['last_agreed_at']),
    lastError: str(p['last_error']),
    clockSkewMs: num(p['clock_skew_ms']),
  }
}

function setAside(rows: unknown[]): { setAsideWaiting: number; oldestSetAsideAt: string | null } {
  const waiting = rows.map(obj).filter((r) => !truthy(r['acknowledged']))
  const times = waiting.map((r) => str(r['at'])).filter((t): t is string => t !== null).sort()
  return { setAsideWaiting: waiting.length, oldestSetAsideAt: times[0] ?? null }
}

function licence(value: unknown): TillSummary['licence'] {
  const l = obj(value)
  if (Object.keys(l).length === 0 || 'failed' in l) return null
  return { state: str(l['state']), problem: str(l['problem']), paidThrough: str(l['paidThrough']) }
}

function runs(s: Obj): Runs | null {
  const started = num(s['started'])
  if (started === null) return null
  return { started, clean: num(s['clean']) ?? 0, panicked: num(s['panicked']) ?? 0, unclean: num(s['unclean']) ?? 0 }
}

function firstNumber(rows: unknown, column: string): number | null {
  const first = arr(rows)[0]
  return first === undefined ? null : num(obj(first)[column])
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function obj(value: unknown): Obj {
  return isObj(value) ? value : {}
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
