import { openDatabase } from '@shopos/core/node'
import type { PortalDeps } from './http.js'
import { migratePortal } from './store.js'
import { loadSigningKey } from './keys.js'
import { firstThatWorks, type OtpChannel } from './otp/channel.js'
import { telegramGateway } from './otp/telegram.js'
import { consoleChannel, smsChannel, whatsappChannel } from './otp/channels.js'

/**
 * Everything the portal reads from its environment, in one place.
 *
 * | Variable | Default | What it is |
 * |---|---|---|
 * | `SHOPOS_PORTAL_DB` | `portal.db` | the portal's SQLite file |
 * | `SHOPOS_LICENCE_KEY` | unset | the Ed25519 private key, base64url PKCS#8 |
 * | `SHOPOS_LICENCE_KID` | `shopos-dev` | which key that is |
 * | `SHOPOS_ADMIN_TOKEN` | unset | the shared secret for `POST /v1/licences` |
 * | `SHOPOS_TELEGRAM_TOKEN` | unset | Telegram Gateway access token |
 * | `SHOPOS_OTP_CHANNELS` | `console` | comma-separated, tried in order |
 * | `SHOPOS_EXPOSE_CODES` | unset | `1` returns OTP codes in the response |
 *
 * **Every secret is unset by default and every unset secret disables its
 * feature rather than weakening it.** No signing key means the issuing route
 * answers 503; no admin token means the route is not there at all; no
 * Telegram token means that channel reports itself unavailable and the chain
 * moves on. A portal started with nothing configured is a portal that can do
 * nothing, which is the only safe thing for it to be.
 *
 * `SHOPOS_EXPOSE_CODES` is the one that can hurt: it puts the OTP in the HTTP
 * response so a developer with no SMS provider can sign in. `fromEnvironment`
 * refuses to honour it when a real channel is configured, so it cannot be
 * left on by accident in something that is actually delivering codes.
 */

export interface PortalConfig extends PortalDeps {
  /** Closed on shutdown. */
  close: () => Promise<void>
}

export async function fromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PortalConfig> {
  const db = openDatabase(env['SHOPOS_PORTAL_DB'] ?? 'portal.db')
  await migratePortal(db)

  const privateKey = env['SHOPOS_LICENCE_KEY'] ?? null
  const signingKey = privateKey === null ? null : await loadSigningKey(privateKey)

  const names = (env['SHOPOS_OTP_CHANNELS'] ?? 'console').split(',').map((n) => n.trim())
  const channels = names.map((name) => channelNamed(name, env))
  const channel = firstThatWorks(channels)

  const onlyDevChannels = names.every((name) => name === 'console')
  const exposeCodes = env['SHOPOS_EXPOSE_CODES'] === '1' && onlyDevChannels

  if (env['SHOPOS_EXPOSE_CODES'] === '1' && !onlyDevChannels) {
    process.stderr.write(
      '[portal] SHOPOS_EXPOSE_CODES ignored: a real OTP channel is configured\n',
    )
  }

  return {
    db,
    channel,
    signingKey,
    kid: env['SHOPOS_LICENCE_KID'] ?? 'shopos-dev',
    adminToken: env['SHOPOS_ADMIN_TOKEN'] ?? null,
    ...(exposeCodes ? { exposeCodes: true } : {}),
    close: () => db.close(),
  }
}

function channelNamed(name: string, env: NodeJS.ProcessEnv): OtpChannel {
  switch (name) {
    case 'console': return consoleChannel()
    case 'telegram': return telegramGateway({ token: env['SHOPOS_TELEGRAM_TOKEN'] ?? null })
    case 'sms': return smsChannel()
    case 'whatsapp': return whatsappChannel()
    default:
      throw new Error(
        `unknown OTP channel "${name}" — one of console, telegram, sms, whatsapp`,
      )
  }
}
