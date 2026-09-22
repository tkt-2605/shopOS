import type { OtpChannel, OtpDelivery, SendResult } from './channel.js'

/**
 * Telegram's Gateway API — the free one, today.
 *
 * Not the Bot API. A bot can only message somebody who has already started a
 * chat with it, so it cannot deliver a code to a phone number, which is the
 * whole job. The Gateway is a separate product that does exactly this: you
 * give it a number and a code, it delivers the code as a Telegram message if
 * that number is on Telegram, and it tells you it could not if the number is
 * not.
 *
 * ## Why this one first
 *
 * It is free at the volume a new product has, and it needs no DLT template
 * registration, no Meta business verification and no per-message price
 * negotiated with an Indian aggregator. Every one of those is weeks of
 * paperwork that can happen after there are shops to sign in, rather than
 * before.
 *
 * ## What it cannot do
 *
 * **It only reaches numbers that are on Telegram.** In an Indian retail
 * context that is a large minority, not everybody, and a shopkeeper whose
 * number is not on Telegram gets `unreachable` — which is why
 * `firstThatWorks` exists and why the SMS placeholder beside this is the one
 * that has to be real before this is the only way in. Do not ship a portal
 * where Telegram is the sole channel.
 *
 * ## Honesty about this file
 *
 * Written to Telegram's documented Gateway API and **not yet run against the
 * live service** — this machine has no network. The request and response
 * shapes are in one small place below for exactly that reason: when the first
 * real call disagrees, the correction is a few lines here and nothing else in
 * the portal moves.
 */

const ENDPOINT = 'https://gatewayapi.telegram.org/sendVerificationMessage'

export interface TelegramGatewayOptions {
  /**
   * The Gateway access token, from Telegram.
   *
   * Placeholder today: null means the channel reports itself unavailable
   * rather than pretending to send. A portal started without it logs the
   * reason once at boot instead of failing at the first sign-in.
   */
  token: string | null
  /** Overridden in tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
  endpoint?: string
}

/** What the Gateway hands back. Narrowed to the fields this uses. */
interface GatewayResponse {
  ok?: boolean
  error?: string
  result?: { request_id?: string }
}

export function telegramGateway(opts: TelegramGatewayOptions): OtpChannel {
  const send = opts.fetch ?? globalThis.fetch
  const endpoint = opts.endpoint ?? ENDPOINT

  return {
    name: 'telegram',

    async send(delivery: OtpDelivery): Promise<SendResult> {
      if (opts.token === null || opts.token === '') {
        return {
          ok: false,
          reason: 'unavailable',
          detail: 'no Telegram Gateway token — set SHOPOS_TELEGRAM_TOKEN',
        }
      }

      let response: Response
      try {
        response = await send(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            phone_number: delivery.phone,
            /* Our code, not theirs. The Gateway will generate and verify one
               for you; taking that offer would put the expiry, the attempt
               limit and the "is this right" decision inside a vendor, and
               swapping the vendor would then be a rewrite of sign-in. */
            code: delivery.code,
            ttl: delivery.ttlSeconds,
            payload: delivery.purpose,
          }),
        })
      } catch (cause) {
        // A dead line, DNS, TLS. Another channel or another minute may work.
        return { ok: false, reason: 'unavailable', detail: describe(cause) }
      }

      let body: GatewayResponse
      try {
        body = await response.json() as GatewayResponse
      } catch {
        return {
          ok: false,
          reason: 'unavailable',
          detail: `Telegram answered ${response.status} with something that is not JSON`,
        }
      }

      if (body.ok === true) return { ok: true, ref: body.result?.request_id ?? null }

      const error = body.error ?? `HTTP ${response.status}`
      return UNREACHABLE.some((e) => error.includes(e))
        ? { ok: false, reason: 'unreachable', detail: error }
        : { ok: false, reason: 'unavailable', detail: error }
    },
  }
}

/**
 * The errors that mean *this number*, rather than *this moment*.
 *
 * Split out because the difference decides whether `firstThatWorks` tries the
 * next channel or stops, and because getting it wrong in the safe direction
 * -- treating a permanent failure as temporary -- costs a person three
 * pointless retries before the portal admits it cannot reach them.
 */
const UNREACHABLE = [
  'PHONE_NUMBER_INVALID',
  'PHONE_NUMBER_NOT_FOUND',
  'PHONE_NUMBER_BANNED',
]

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
