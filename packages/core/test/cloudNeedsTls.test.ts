import { describe, it, expect } from 'vitest'
import { assertSafeToSpeak, onThisNetwork, NeedsTls } from '../src/services/sync/reach.js'
import { httpTransport, pairWith } from '../src/services/syncClient.js'
import { setDeviceId } from '../src/device.js'
import { emptyDb } from './helpers.js'

/**
 * Bills and password hashes cross in the clear on the shop's own wifi, which
 * was argued for. Past the shop's router they may not: a peer that is not on
 * this network is spoken to over HTTPS or not at all.
 */

describe('where a till may be spoken to in the clear', () => {
  it('is the shop\'s own network', () => {
    for (const host of [
      '192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.1', '127.0.0.1', '169.254.3.3',
      'localhost', 'counter-2', 'till.local', '[::1]', 'fd12:3456::1', 'fe80::1',
    ]) expect(onThisNetwork(host), host).toBe(true)
  })

  it('and nowhere else', () => {
    for (const host of ['8.8.8.8', '172.32.0.1', '100.64.0.1', 'shop.turso.io', 'example.com', '2001:db8::1']) {
      expect(onThisNetwork(host), host).toBe(false)
    }
  })

  it('lets HTTPS go anywhere and refuses plain HTTP past the router', () => {
    expect(() => assertSafeToSpeak('https://shop.example.com')).not.toThrow()
    expect(() => assertSafeToSpeak('http://192.168.1.20:47811')).not.toThrow()
    expect(() => assertSafeToSpeak('http://shop.example.com')).toThrow(NeedsTls)
    expect(() => assertSafeToSpeak('ftp://192.168.1.20')).toThrow(NeedsTls)
  })

  it('is asked before anything is sent, by pairing and by every round', async () => {
    setDeviceId('11111111-1111-4111-8111-111111111111')
    let sent = 0
    const counting = (async () => { sent += 1; return new Response('{}') }) as typeof fetch
    const db = await emptyDb()
    try {
      await expect(pairWith(db, 'http://shop.example.com', 'ABCDEFGH', null, counting)).rejects.toThrow(NeedsTls)
      const peer = { deviceId: 'x', secret: 'ab'.repeat(32), baseUrl: 'http://203.0.113.9:47811', reach: 'lan' as const }
      await expect(httpTransport(peer, counting).hello()).rejects.toThrow(NeedsTls)
      expect(sent).toBe(0)
    } finally {
      setDeviceId(null)
      await db.close()
    }
  })
})
