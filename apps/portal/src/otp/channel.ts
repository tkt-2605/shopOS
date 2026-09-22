/**
 * How a one-time code reaches a phone.
 *
 * The seam exists because the answer changes for reasons that have nothing to
 * do with this product: Telegram's Gateway is free below a volume and then is
 * not, an Indian SMS provider needs DLT template registration that takes
 * weeks, and WhatsApp needs Meta's verification. None of those should reach
 * into how a person signs in.
 *
 * So a channel does one thing -- put six digits in front of somebody -- and
 * the portal keeps the code, the expiry, the attempt count and the decision.
 * That split matters more than it looks: several of these providers offer to
 * generate *and check* the code for you, and taking that offer would move the
 * security decisions into a vendor and make swapping them a rewrite of the
 * login flow rather than a line in a config.
 *
 * ## What a channel must not do
 *
 * - It must not see a code it did not receive as an argument.
 * - It must not decide whether a code is right.
 * - It must not throw for a bad phone number. That is a `refused` result, and
 *   the caller turns it into a sentence a person can act on.
 *
 * ## What is here today
 *
 * | Channel | State |
 * |---|---|
 * | `console` | real, for development. Prints the code |
 * | `memory` | real, for tests. Keeps the code |
 * | `telegram` | written to Telegram's Gateway API, needs a token dropped in |
 * | `sms` | placeholder. An Indian DLT-registered provider goes here |
 * | `whatsapp` | placeholder. Needs Meta verification, Phase 6 |
 */

export interface OtpDelivery {
  /** E.164, with the leading `+`. */
  phone: string
  /** The digits. The channel delivers these and forgets them. */
  code: string
  /** How long the portal will accept it, for the message's wording. */
  ttlSeconds: number
  /**
   * What the code is for, so the message can say. A person who did not ask
   * for one needs to know what they are being asked to approve.
   */
  purpose: OtpPurpose
}

export type OtpPurpose = 'sign-in' | 'add-phone'

export type SendResult =
  /** Handed off. `ref` is the provider's id, kept for support and billing. */
  | { ok: true; ref: string | null }
  /**
   * Not delivered, and not worth retrying with the same input: the number is
   * not on this channel, or is malformed. The caller says so to the person.
   */
  | { ok: false; reason: 'unreachable'; detail: string }
  /**
   * Not delivered, and another channel or another moment might work: the
   * provider is down, out of quota, or refused the request. The caller falls
   * back or asks the person to try again.
   */
  | { ok: false; reason: 'unavailable'; detail: string }

export interface OtpChannel {
  /** For logs, the account's record of how it was sent, and config. */
  readonly name: string
  send(delivery: OtpDelivery): Promise<SendResult>
}

/**
 * Tries each channel in order until one accepts.
 *
 * `unreachable` stops the chain -- a number that is not a number will not
 * become one at the next provider -- while `unavailable` moves on, which is
 * the fallback that matters: Telegram free tier exhausted at eight in the
 * evening, SMS picks it up, and nobody signing in notices.
 */
export function firstThatWorks(channels: readonly OtpChannel[]): OtpChannel {
  if (channels.length === 0) throw new Error('no OTP channel configured')
  if (channels.length === 1) return channels[0] as OtpChannel

  return {
    name: channels.map((c) => c.name).join('→'),
    async send(delivery) {
      let last: SendResult = { ok: false, reason: 'unavailable', detail: 'no channel tried' }
      for (const channel of channels) {
        const result = await channel.send(delivery)
        if (result.ok) return result
        if (result.reason === 'unreachable') return result
        last = { ok: false, reason: 'unavailable', detail: `${channel.name}: ${result.detail}` }
      }
      return last
    },
  }
}
