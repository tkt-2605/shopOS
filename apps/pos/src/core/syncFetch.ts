import { invoke } from '@tauri-apps/api/core'
import { LISTEN_PORT_HEADER } from '@shopos/core'

/**
 * The asking half of a sync, routed through Rust.
 *
 * `syncClient.ts` is written against `fetch` and takes it as an argument. In
 * the bench that argument is the real thing, over real sockets. In the app it
 * cannot be: the CSP takes `connect-src` from `default-src 'self'`, so a fetch
 * at another till is refused in the webview before a packet leaves, and the
 * only thing the screen can say about it is "Failed to fetch" -- which reads
 * exactly like a till that is switched off, and sent one shopkeeper looking at
 * their router.
 *
 * So this is a fetch in shape only. It takes the request core built, hands the
 * parts to `sync_request`, and dresses the answer back up as a `Response` so
 * that the status handling on the other side is the one already tested.
 */
export const syncFetch: typeof fetch = async (input, init) => {
  const href = typeof input === 'string' ? input
    : input instanceof URL ? input.href
    : input.url
  const url = new URL(href)
  const headers = new Headers(init?.headers)

  const port = headers.get(LISTEN_PORT_HEADER)
  const answered = await invoke<{ status: number; body: string }>('sync_request', {
    // `host` rather than `hostname`: Rust opens a socket, and wants the port on it.
    address: url.host,
    path: url.pathname,
    body: typeof init?.body === 'string' ? init.body : '',
    auth: headers.get('x-shopos-auth'),
    listenPort: port === null ? null : Number(port),
  })

  return new Response(answered.body, {
    status: answered.status,
    headers: { 'content-type': 'application/json' },
  })
}
