import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  handleSyncRequest, offerPairing, withdrawPairing,
  pendingJoin, allowJoin, refuseJoin, onJoinRequest, expectingAJoin,
  type JoinRequest,
} from '../src/services/syncServer.js'
import { askToJoin, pollJoin, pairedPeers, httpTransport, SyncHttpError } from '../src/services/syncClient.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { forgetNonces } from '../src/services/syncAuth.js'
import { freshDb, emptyDb, type Fixture } from './helpers.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * Joining a shop without anybody typing a code.
 *
 * The till that wants in asks; the till that already has the books shows two
 * digits and a person presses Allow. Over real sockets, for the same reason as
 * `syncOverHttp.test.ts`: what is worth testing here only exists once there are
 * two machines and a wire between them.
 *
 * What the digits are and are not is settled in `PendingJoin`'s comment. They
 * are never checked against anything, so there is deliberately no test here
 * that a wrong one is refused — there is no such thing.
 */

const HOST = '1111aaaa-1111-4111-8111-111111111111'
const JOINER = '2222bbbb-2222-4222-8222-222222222222'

let host: { db: SqlDriver; fx: Fixture; server: Server; url: string }
let joinerDb: SqlDriver

async function serve(id: string, db: SqlDriver): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      void (async () => {
        const before = deviceId()
        setDeviceId(id)
        try {
          const answer = await handleSyncRequest(db, {
            path: req.url ?? '/',
            body,
            auth: (req.headers['x-shopos-auth'] as string | undefined) ?? null,
            remoteAddress: '127.0.0.1',
            listenPort: Number(req.headers['x-shopos-port']) || null,
          }, undefined, { keys: TEST_KEYS })
          res.writeHead(answer.status, { 'content-type': 'application/json' })
          res.end(answer.body)
        } finally {
          setDeviceId(before)
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}` }
}

beforeEach(async () => {
  forgetNonces()
  withdrawPairing()
  const fx = await freshDb()
  /* The shop that already exists is on the multi-counter plan. Without it
     `letThemIn` refuses every join, which is the gate working and is not what
     this file is about. */
  await licenseTill(fx.db)
  host = { db: fx.db, fx, ...(await serve(HOST, fx.db)) }
  joinerDb = await emptyDb()
  // Every `askToJoin` below is this machine asking.
  setDeviceId(JOINER)
})

afterEach(async () => {
  setDeviceId(null)
  withdrawPairing()
  onJoinRequest(null)
  await new Promise<void>((r) => host.server.close(() => r()))
  await host.db.close()
  await joinerDb.close()
})

/** What "Add a till" does on the shop's own screen. */
function addingATill() { offerPairing() }

/* A joining till that is itself listening, which is the ordinary case: it says
   so in a header, and that is how the shop learns where to reach it back.
   Without it the shop records a peer with a secret and no address — a till it
   can answer and never call, which `pairedPeers` filters out. */
const MINE = { listenPort: 7801 }
const knock = (label: string | null = null) => askToJoin(host.url, label, fetch, MINE)
const poll = (requestId: string) => pollJoin(joinerDb, host.url, requestId, fetch, MINE)

describe('a till asking to be let in', () => {
  it('is not heard at all unless the shop is expecting somebody', async () => {
    /* A prompt a shopkeeper did not go looking for is one they press to make go
       away, and that press is the whole of the security here. */
    expect(expectingAJoin()).toBe(false)
    await expect(knock()).rejects.toThrow(SyncHttpError)
    expect(pendingJoin()).toBeNull()
  })

  it('waits, and says which six digits to look for', async () => {
    addingATill()
    const asked = await knock('Back Counter')

    expect(asked.state).toBe('PENDING')
    if (asked.state !== 'PENDING') return
    expect(asked.digits).toMatch(/^\d{6}$/)

    // And the shop's own screen has the same request, to show beside them.
    const door = pendingJoin()
    expect(door?.digits).toBe(asked.digits)
    expect(door?.label).toBe('Back Counter')
    expect(door?.deviceId).toBe(JOINER)
  })

  it('tells the screen the moment somebody knocks', async () => {
    // The screen is on the same side of the wall as the handler -- Rust holds
    // the socket and hands the bytes to the webview -- so no event plumbing.
    const seen: (JoinRequest | null)[] = []
    onJoinRequest((j) => seen.push(j))

    addingATill()
    await knock('Back Counter')
    expect(seen.at(-1)?.label).toBe('Back Counter')
  })

  it('is still waiting until somebody presses something', async () => {
    addingATill()
    const asked = await knock()
    if (asked.state !== 'PENDING') throw new Error('should be pending')

    const again = await poll(asked.requestId)
    expect(again.state).toBe('PENDING')
    expect(await pairedPeers(joinerDb)).toHaveLength(0)
  })

  it('is let in when the shop allows it, and gets the shop', async () => {
    addingATill()
    const asked = await knock('Back Counter')
    if (asked.state !== 'PENDING') throw new Error('should be pending')

    allowJoin(asked.requestId)
    const answer = await poll(asked.requestId)

    expect(answer.state).toBe('ALLOWED')
    if (answer.state !== 'ALLOWED') return
    expect(answer.outcome.deviceId).toBe(HOST)
    expect(answer.outcome.shopId).not.toBeNull()

    // Both sides now hold each other, with a secret and somewhere to reach.
    const theirs = await pairedPeers(joinerDb)
    expect(theirs).toHaveLength(1)
    expect(theirs[0]?.deviceId).toBe(HOST)
    expect(await pairedPeers(host.db)).toHaveLength(1)
  })

  it('does not hand out a secret to a caller that never asked', async () => {
    // A poll quoting a request id that was never minted is not a conversation
    // this shop is having, and saying so beats saying "pending".
    addingATill()
    const answer = await poll('a-request-nobody-made')
    expect(answer.state).toBe('LAPSED')
    expect(await pairedPeers(joinerDb)).toHaveLength(0)
  })

  it('says so when the shop refuses', async () => {
    addingATill()
    const asked = await knock()
    if (asked.state !== 'PENDING') throw new Error('should be pending')

    refuseJoin(asked.requestId)
    expect((await poll(asked.requestId)).state).toBe('REFUSED')

    // And nothing is left behind on either side.
    expect(await pairedPeers(joinerDb)).toHaveLength(0)
    expect(await pairedPeers(host.db)).toHaveLength(0)
  })

  it('answers a repeated ask with the same request rather than new digits', async () => {
    /* A reply that went missing, or a till restarted mid-walk. Minting a second
       set would change the number under a shopkeeper already looking at it. */
    addingATill()
    const first = await knock()
    const second = await knock()
    if (first.state !== 'PENDING' || second.state !== 'PENDING') throw new Error('pending')

    expect(second.requestId).toBe(first.requestId)
    expect(second.digits).toBe(first.digits)
  })

  it('hands the same secret back when the answer goes missing', async () => {
    // The joining till polls, the reply is lost, it polls again. Two secrets
    // would leave the shop holding one and the till holding the other.
    addingATill()
    const asked = await knock()
    if (asked.state !== 'PENDING') throw new Error('should be pending')
    allowJoin(asked.requestId)

    const once = await poll(asked.requestId)
    const twice = await poll(asked.requestId)
    expect(once.state).toBe('ALLOWED')
    expect(twice.state).toBe('ALLOWED')

    // One peer row on each side, not two, and the shop still talks to it.
    expect(await pairedPeers(joinerDb)).toHaveLength(1)
    expect(await pairedPeers(host.db)).toHaveLength(1)
  })

  it('refuses a second till while one is already at the door', async () => {
    /* Two prompts swapping under a shopkeeper's hand is how the wrong machine
       gets let in. A shop buys a counter about as often as it buys a building. */
    addingATill()
    await knock('Back Counter')

    setDeviceId('3333cccc-3333-4333-8333-333333333333')
    await expect(askToJoin(host.url, 'Somebody else')).rejects.toThrow(SyncHttpError)

    // The one that was already there is untouched.
    expect(pendingJoin()?.label).toBe('Back Counter')
  })

  it('forgets the whole conversation when the shop stops adding a till', async () => {
    addingATill()
    const asked = await knock()
    if (asked.state !== 'PENDING') throw new Error('should be pending')

    withdrawPairing()
    expect(pendingJoin()).toBeNull()
    expect((await poll(asked.requestId)).state).toBe('LAPSED')
  })

  it('leaves the typed code working for a network where nothing is found', async () => {
    // The bottom rung, and `syncOverHttp.test.ts` is where it is tested in
    // full. Here only that adding one way did not remove the other.
    const code = offerPairing()
    expect(code).toMatch(/^[A-Z0-9]{8}$/)
    expect(expectingAJoin()).toBe(true)
  })
})

describe('the secret two tills agree', () => {
  /** A fetch that keeps a copy of every answer the shop gave. */
  function recording(seen: string[]): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(input, init)
      const text = await response.text()
      seen.push(text)
      return new Response(text, { status: response.status, headers: response.headers })
    }) as typeof fetch
  }

  async function paired(fetchImpl: typeof fetch = fetch) {
    addingATill()
    const asked = await askToJoin(host.url, null, fetchImpl, MINE)
    if (asked.state !== 'PENDING') throw new Error('should be pending')
    allowJoin(asked.requestId)
    const done = await pollJoin(joinerDb, host.url, asked.requestId, fetchImpl, MINE)
    if (done.state !== 'ALLOWED') throw new Error('should be allowed')
  }

  it('is the same on both tills and never crosses the wire', async () => {
    /* The Rust review's finding: the secret was sent in the /pair answer, so
       anybody listening while a till was added could sign requests as it. */
    const seen: string[] = []
    await paired(recording(seen))

    const mine = await joinerDb.get<{ secret: string }>('SELECT secret FROM sync_peers')
    const theirs = await host.db.get<{ secret: string }>('SELECT secret FROM sync_peers')
    expect(mine?.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(theirs?.secret).toBe(mine?.secret)
    for (const body of seen) expect(body).not.toContain(mine!.secret)
  })

  it('shows different digits on the two screens when a machine sits in the middle', async () => {
    /* It has to swap both keys to learn a secret, and the digits come from the
       keys -- the joining till works its own out -- so the person comparing
       them sees the swap. This one also swaps the commitment for one to its
       own key; one that did not would be turned away at the reveal. */
    const { pairingKey, keyCommitment } = await import('../src/services/syncAuth.js')
    const towardShop = await pairingKey()
    const towardTill = await pairingKey()
    const inTheMiddle = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      const forged = 'commitment' in sent
        ? { ...sent, commitment: await keyCommitment(towardShop.publicKey) }
        : { ...sent, publicKey: towardShop.publicKey }
      const response = await fetch(input, { ...init, body: JSON.stringify(forged) })
      const answer = JSON.parse(await response.text()) as Record<string, unknown>
      if (typeof answer['publicKey'] === 'string') answer['publicKey'] = towardTill.publicKey
      return new Response(JSON.stringify(answer), { status: response.status })
    }) as typeof fetch

    addingATill()
    const asked = await askToJoin(host.url, null, inTheMiddle, MINE)
    if (asked.state !== 'PENDING') throw new Error('should be pending')
    expect(pendingJoin()?.digits).toMatch(/^\d{6}$/)
    expect(pendingJoin()?.digits).not.toBe(asked.digits)
  })

  it('turns away a key that is not the one the request committed to', async () => {
    /* The whole of the commitment: a key chosen after the shop's was seen is
       a key that could have been ground to fit the digits. */
    const { pairingKey, keyCommitment } = await import('../src/services/syncAuth.js')
    const committed = await pairingKey()
    const other = await pairingKey()
    const pair = (body: Record<string, unknown>) => fetch(`${host.url}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, unknown>>)

    addingATill()
    const asked = await pair({ deviceId: JOINER, commitment: await keyCommitment(committed.publicKey) })
    expect(asked['state']).toBe('PENDING')
    expect(pendingJoin(), 'no prompt, and no digits, before the key is shown').toBeNull()

    const shown = await pair({ deviceId: JOINER, requestId: asked['requestId'], publicKey: other.publicKey })
    expect(shown['state']).toBe('LAPSED')
    expect(pendingJoin()).toBeNull()
  })

  it('will not ask with the key itself on the first turn', async () => {
    const { pairingKey } = await import('../src/services/syncAuth.js')
    addingATill()
    const response = await fetch(`${host.url}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: JOINER, publicKey: (await pairingKey()).publicKey }),
    })
    expect(response.status).toBe(400)
  })

  it('refuses an answer that was altered on the way back', async () => {
    await paired()
    const [peer] = await pairedPeers(joinerDb)
    const altering = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(input, init)
      const sealed = JSON.parse(await response.text()) as { reply: string; mac: string }
      const reply = JSON.parse(sealed.reply) as Record<string, unknown>
      reply['shopId'] = 'somebody-else'
      return new Response(JSON.stringify({ ...sealed, reply: JSON.stringify(reply) }), { status: response.status })
    }) as typeof fetch

    await expect(httpTransport(peer!, altering).hello()).rejects.toMatchObject({ code: 'BAD_REPLY_SIGNATURE' })
    // Unaltered, the same request is believed.
    await expect(httpTransport(peer!, fetch).hello()).resolves.toMatchObject({ deviceId: HOST })
  })

  it('refuses a successful answer that is not signed at all', async () => {
    await paired()
    const [peer] = await pairedPeers(joinerDb)
    const forged = (async () => new Response(JSON.stringify({ deviceId: HOST, schemaVersion: 1 }), { status: 200 })) as typeof fetch
    await expect(httpTransport(peer!, forged).hello()).rejects.toMatchObject({ code: 'UNSIGNED_REPLY' })
  })
})
