import type { PortalRequest, PortalResponse } from './http.js'

/* The small stuff every route uses: reading a request, shaping a reply. */

export function bearer(request: PortalRequest): string | null {
  const header = request.headers['authorization']
  if (header === undefined) return null
  const match = /^Bearer (.+)$/.exec(header)
  return match?.[1] ?? null
}

/** A path segment, or null when its percent-escapes are not escapes. `decodeURIComponent` throws. */
export function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function ok(body: unknown): PortalResponse {
  return { status: 200, body }
}

export function bad(detail: string): PortalResponse {
  return { status: 400, body: { error: 'BAD_REQUEST', detail } }
}

export function unauthorised(): PortalResponse {
  return { status: 401, body: { error: 'UNAUTHORISED' } }
}

export function forbidden(): PortalResponse {
  return { status: 403, body: { error: 'FORBIDDEN' } }
}

/** A page rather than JSON. `server.ts` sends a string body as it is. */
export function html(page: string): PortalResponse {
  return {
    status: 200,
    body: page,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The console fetches only its own origin and runs only its own script.
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  }
}
