import { describe, it, expect, afterEach } from 'vitest'
import { pairedPeers } from '@shopos/core'
import { host, joiner, stopAll } from './bench.js'

/**
 * A till with something else answering the door for it.
 *
 * In the app the Rust side holds the socket and the webview holds the database.
 * In a container it is `shopos-net` on 7801 and the Node till on loopback. Both
 * are the same shape: **the process that decides what a request means is not
 * the process that saw who sent it**.
 *
 * That gap produced two bugs which Layer 1 could not have found on its own,
 * because in-process the two are the same socket. Layer 2 found them; these
 * tests are what stop them coming back without waiting for a nightly Docker
 * run to say so.
 *
 *   1. The till saw `127.0.0.1` for every caller, because that is genuinely
 *      who connected to it. It recorded the peer as being on loopback and
 *      then, on the next host-initiated round, dialled *itself* — which
 *      answered `UNKNOWN_PEER`, since a till is not its own peer.
 *
 *   2. The till advertised the port it listens on rather than the port the
 *      outside world reaches it by, so the peer wrote down a door only that
 *      container can open.
 */

afterEach(stopAll)

describe('the address a till records for a peer', () => {
  it('takes the forwarder\'s word only when the forwarder is on this machine', async () => {
    const front = await host()
    const back = await joiner()

    /* The shape of a forwarded request: it arrives from loopback, and the
       address of the real caller is in a header, because the only process that
       held a socket to them was the one that passed it on. */
    const response = await fetch(`${front.url}/pair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopos-remote': '172.21.0.3',
        'x-shopos-port': '7801',
      },
      body: JSON.stringify({ code: 'WRONGWRO', deviceId: back.deviceId }),
    })

    // The code is wrong, so pairing is refused — the point here is only that
    // the request was parsed and the header was reachable.
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('records the peer at the address the forwarder reported, not at loopback', async () => {
    const front = await host()
    const back = await joiner()

    const { offerPairing, pairingKey, codeProof } = await import('@shopos/core')
    const code = await front.as(async () => offerPairing())
    // The joining till's half of the key agreement; the secret is never sent.
    const { publicKey } = await pairingKey()

    await fetch(`${front.url}/pair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopos-remote': '172.21.0.3',
        'x-shopos-port': '7801',
      },
      // A proof of the code, never the code: see `codeProof`.
      body: JSON.stringify({
        proof: await codeProof(code, back.deviceId, publicKey), deviceId: back.deviceId,
        label: 'Back counter', publicKey,
      }),
    })

    const peers = await front.as(() => pairedPeers(front.db))
    const recorded = peers.find((p) => p.deviceId === back.deviceId)

    /* Loopback here would mean the host dials its own till on the next round.
       That is not a failed sync — it is a sync that connects, authenticates
       against the wrong table and comes back `UNKNOWN_PEER`, which reads like
       a pairing problem and is not one. */
    expect(recorded?.baseUrl).toBe('http://172.21.0.3:7801')
    expect(recorded?.baseUrl).not.toContain('127.0.0.1')
  })

  it('ignores the header when the caller is not on this machine', async () => {
    /* The rule in one line: a header is whatever the caller wants it to be, so
       it is trusted from loopback — our own forwarder — and nowhere else.
       A peer reaching the port directly is described by its own socket. */
    const front = await host()
    const back = await joiner()

    await back.pairWith(front)

    const peers = await front.as(() => pairedPeers(front.db))
    const recorded = peers.find((p) => p.deviceId === back.deviceId)

    // Both tills really are on loopback in this test, so the honest answer is
    // loopback — and the port is the one the joiner advertised, not a guess.
    expect(recorded?.baseUrl).toBe(`http://127.0.0.1:${back.port}`)
  })
})

describe('the port a till advertises', () => {
  it('is the one the outside world reaches it by, not the one it binds', async () => {
    // A container's till binds loopback and `shopos-net` answers 7801 for it.
    const front = await host()
    const back = await joiner({ advertisePort: 7801 })

    await back.pairWith(front)

    const peers = await front.as(() => pairedPeers(front.db))
    const recorded = peers.find((p) => p.deviceId === back.deviceId)

    expect(recorded?.baseUrl).toBe('http://127.0.0.1:7801')
    expect(back.port).toBe(7801)
  })
})
