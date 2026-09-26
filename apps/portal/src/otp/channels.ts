import type { OtpChannel, OtpDelivery, SendResult } from './channel.js'

/**
 * The channels that are not Telegram: two real, two placeholders.
 *
 * The placeholders are written out rather than left as a comment because the
 * shape of the thing you have to build is the useful half of a to-do. Each
 * one says what paperwork it needs, which is the part that takes weeks and
 * the part a code comment usually leaves out.
 */

/** Prints the code. Development only, and it says so in the output. */
export function consoleChannel(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): OtpChannel {
  return {
    name: 'console',
    async send(delivery: OtpDelivery): Promise<SendResult> {
      write(
        `[otp] ${delivery.purpose} code for ${delivery.phone}: ${delivery.code} ` +
        `(${delivery.ttlSeconds}s) — development channel, not delivered anywhere`,
      )
      return { ok: true, ref: null }
    },
  }
}

export interface Captured extends OtpDelivery {
  at: number
}

/** Keeps every code it is given, for tests. Never sends anything anywhere. */
export function memoryChannel(): OtpChannel & {
  sent: Captured[]
  last(): Captured | undefined
  /** Makes the next `send` fail, to exercise the fallback chain. */
  failNext(result: Exclude<SendResult, { ok: true }>): void
} {
  const sent: Captured[] = []
  let queued: Exclude<SendResult, { ok: true }> | null = null

  return {
    name: 'memory',
    sent,
    last: () => sent[sent.length - 1],
    failNext(result) { queued = result },
    async send(delivery) {
      if (queued !== null) {
        const result = queued
        queued = null
        return result
      }
      sent.push({ ...delivery, at: Date.now() })
      return { ok: true, ref: `memory-${sent.length}` }
    },
  }
}

/**
 * SMS — the one that has to exist before Telegram can be the only other way in.
 *
 * **Drop in here.** An Indian transactional SMS provider: MSG91, Kaleyra,
 * Gupshup, Twilio. The work is not the HTTP call, it is DLT: since 2021 every
 * commercial sender must register an entity and each message template with a
 * telecom operator's DLT portal, and unregistered traffic is dropped rather
 * than bounced. Budget weeks, and register the template before writing the
 * code, because the template's exact text is what this function must send.
 *
 * Reports itself unavailable rather than throwing, so a portal configured
 * with `[telegram, sms]` degrades to Telegram alone instead of failing.
 */
export function smsChannel(): OtpChannel {
  return {
    name: 'sms',
    async send(): Promise<SendResult> {
      return {
        ok: false,
        reason: 'unavailable',
        detail: 'no SMS provider configured — see smsChannel() in otp/channels.ts',
      }
    },
  }
}

/**
 * WhatsApp — Phase 6, and behind Meta's verification.
 *
 * **Drop in here.** The Cloud API through a BSP, as an authentication-category
 * template. Needs the same business verification the bill-PDF delivery in
 * Phase 6 needs, so the two arrive together or neither does.
 */
export function whatsappChannel(): OtpChannel {
  return {
    name: 'whatsapp',
    async send(): Promise<SendResult> {
      return {
        ok: false,
        reason: 'unavailable',
        detail: 'no WhatsApp sender configured — see whatsappChannel() in otp/channels.ts',
      }
    },
  }
}
