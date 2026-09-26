/*
 * Where a till may be spoken to in the clear.
 *
 * Bills, customers and every staff member's password hash cross in a sync. On
 * the shop's own wifi that was argued and accepted in `sync-compliance.md` --
 * the threat is somebody already inside the shop, and Settings says out loud
 * that bills cross in clear. Over the internet it is not the same argument at
 * all: a cloud peer reached over plain HTTP is a shop's books handed to every
 * network in between. So plain HTTP is for addresses that cannot be anywhere
 * but here -- private, loopback and link-local -- and anything else must be
 * HTTPS. Written now, before there is a cloud peer, so that the first one
 * cannot be added the easy way.
 */

export class NeedsTls extends Error {
  constructor(readonly baseUrl: string) {
    super(`${baseUrl} is not on this shop's network, so it is only ever spoken to over HTTPS`)
    this.name = 'NeedsTls'
  }
}

/** Throws `NeedsTls` for a plain-HTTP address that is not on the LAN. */
export function assertSafeToSpeak(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new NeedsTls(baseUrl)
  }
  if (url.protocol === 'https:') return
  if (url.protocol !== 'http:' || !onThisNetwork(url.hostname)) throw new NeedsTls(baseUrl)
}

/** Private, loopback or link-local, or a name only this network can answer. */
export function onThisNetwork(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true
  // A bare name with no dot is resolved on the LAN, by NetBIOS or mDNS.
  if (!h.includes('.') && !h.includes(':')) return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
  }
  if (h.includes(':')) {
    return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
  }
  return false
}
