import { createServer, type Server, type IncomingMessage } from 'node:http'
import { handle, type PortalDeps, type PortalRequest } from './http.js'

/**
 * `node:http` around `handle`. Nothing decides anything here.
 *
 * Kept separate so that the tests exercise the routes without a port, and so
 * that putting the portal behind something else later -- a serverless
 * handler, a different runtime -- replaces this file and only this file.
 */

const MAX_BODY_BYTES = 64 * 1024

export interface ServeOptions {
  port: number
  host?: string
}

export function createPortalServer(deps: PortalDeps): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const request = await readRequest(req)

        if (request === null) {
          /* Too large. The sender is still writing, and simply answering
             leaves a half-read socket open for as long as it cares to keep
             writing -- which holds the process open at shutdown and is a
             cheap way to tie up a server. So: say so, close the connection,
             and stop reading. */
          res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' })
          res.end(JSON.stringify({ error: 'BODY_TOO_LARGE' }))
          req.destroy()
          return
        }

        const response = await handle(deps, request)

        const body = response.body === null ? '' : JSON.stringify(response.body)
        res.writeHead(response.status, {
          'Content-Type': 'application/json',
          /* The portal answers tills and a phone browser, and neither is a
             page on another origin that should be reading this. No CORS
             header at all is the right default; add one deliberately when
             `apps/phone` needs it and knows its own origin. */
          'Cache-Control': 'no-store',
          ...response.headers,
        })
        res.end(body)
      } catch (cause) {
        /* Never leak a stack. A portal 500 is a thing to find in the log, not
           a thing to hand to whoever caused it. */
        process.stderr.write(`[portal] ${String(cause)}\n`)
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'INTERNAL' }))
      }
    })()
  })

  /* Keep-alive sockets otherwise outlive `close()`, which hangs a shutdown
     and hangs a test suite's teardown. Five seconds is longer than any
     request here and short enough to be forgotten about. */
  server.keepAliveTimeout = 5_000
  return server
}

export function serve(deps: PortalDeps, opts: ServeOptions): Promise<Server> {
  const server = createPortalServer(deps)
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve(server))
  })
}

async function readRequest(req: IncomingMessage): Promise<PortalRequest | null> {
  const url = new URL(req.url ?? '/', 'http://portal.invalid')

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  let body: unknown = null
  if (raw !== '') {
    try {
      body = JSON.parse(raw)
    } catch {
      // Left null. A route that needs a field reports the missing field,
      // which is more use than "your JSON is wrong" with no idea where.
      body = null
    }
  }

  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }

  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    headers,
    body,
    remoteAddress: req.socket.remoteAddress ?? null,
  }
}
