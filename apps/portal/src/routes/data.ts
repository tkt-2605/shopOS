import type { PortalDeps, PortalRequest, PortalResponse } from '../http.js'
import { bearer, decoded, ok, bad } from '../reply.js'
import { proveTill } from '../health/store.js'
import { startUpload, uploadById, addPart, MAX_BYTES } from '../data/store.js'

/*
 * A shop's data arriving from a till: start, then parts, carrying on where a
 * broken upload stopped (`data/store.ts`). The till proves itself with the
 * key its health reports use. The console's side -- the list and the
 * download -- is in `routes/support.ts`, behind a vendor's sign-in.
 */

export const DATA_START_PATH = /^\/v1\/shops\/([^/]+)\/data$/
export const DATA_PART_PATH = /^\/v1\/data\/([0-9a-f]{32})\/part$/

export async function dataRoutes(
  deps: PortalDeps, request: PortalRequest, now: Date,
): Promise<PortalResponse | null> {
  const { method, path } = request
  const start = DATA_START_PATH.exec(path)
  const part = DATA_PART_PATH.exec(path)
  if (method !== 'POST' || (!start && !part)) return null
  if (!deps.filesDir) return { status: 503, body: { error: 'NO_FILES_FOLDER', detail: 'set SHOPOS_PORTAL_FILES' } }

  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>

  if (start) {
    const shopId = decoded(start[1]!)
    const deviceId = typeof body['deviceId'] === 'string' ? body['deviceId'] : null
    const bytes = typeof body['bytes'] === 'number' ? body['bytes'] : null
    const sha256 = typeof body['sha256'] === 'string' ? body['sha256'].toLowerCase() : null
    if (shopId === null || body['shopId'] !== shopId) return bad('the shop in the address is not the shop in the request')
    if (deviceId === null) return bad('deviceId is required')
    if (bytes === null || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) return bad('bytes is the size of the file')
    if (sha256 === null || !/^[0-9a-f]{64}$/.test(sha256)) return bad('sha256 is the file\'s SHA-256 in hex')

    const proved = await proveTill(deps.db, { shopId, deviceId, key: bearer(request), now })
    if (!proved.ok) return { status: 401, body: { error: proved.code } }
    const upload = await startUpload(deps.db, deps.filesDir, {
      shopId, deviceId, bytes, sha256, anonymised: body['anonymised'] === true,
      note: typeof body['note'] === 'string' ? body['note'].slice(0, 2000) : null, now,
    })
    return ok({ uploadId: upload.id, received: upload.received, ...(proved.key === null ? {} : { key: proved.key }) })
  }

  const upload = await uploadById(deps.db, part![1]!)
  if (upload === null) return { status: 404, body: { error: 'NO_UPLOAD' } }
  const proved = await proveTill(deps.db, { shopId: upload.shopId, deviceId: upload.deviceId, key: bearer(request), now })
  if (!proved.ok) return { status: 401, body: { error: proved.code } }

  const offset = typeof body['offset'] === 'number' ? body['offset'] : null
  const data = typeof body['data'] === 'string' ? Buffer.from(body['data'], 'base64') : null
  if (offset === null || data === null || data.length === 0) return bad('offset and data are required')

  const added = await addPart(deps.db, deps.filesDir, upload, { offset, data, now })
  if (added.ok) return ok({ received: added.upload.received, done: added.upload.completedAt !== null })
  const status = added.code === 'GONE' ? 410 : added.code === 'NOT_WHAT_WAS_SENT' ? 422 : 409
  return { status, body: { error: added.code, received: added.received } }
}
