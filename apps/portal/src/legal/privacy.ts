import { KEEP_DAYS, ABANDONED_DAYS } from '../data/store.js'
import { KEEP_PER_TILL } from '../health/store.js'

/*
 * What ShopOS does with a shop's information, for the owner to read before
 * they rely on it. Served at `/privacy`; `docs/legal/privacy-notice.md` is the
 * same text for the repository, and `privacy.test.ts` holds the two, and the
 * periods below, to what the code actually does.
 *
 * DRAFT. To be read by a lawyer before any shop is shown it. The bracketed
 * parts are the vendor's to fill in.
 */

export const VENDOR = '[Vendor legal name]'
export const GRIEVANCE = '[Grievance officer name, email and phone]'

export interface Section {
  heading: string
  paragraphs: string[]
}

export const PRIVACY: Section[] = [
  {
    heading: 'Who this is from',
    paragraphs: [
      `ShopOS is made by ${VENDOR}. This notice says what we hold about your shop, why, for how long, and who can see it.`,
      'Your shop is responsible to your own customers for their details. We handle your customers\' details only on your instructions, as set out in the data processing agreement.',
    ],
  },
  {
    heading: 'Your records stay on your tills',
    paragraphs: [
      'Bills, customers, stock and accounts are kept on the computers in your shop. ShopOS does not send them anywhere unless you choose to, as described below.',
    ],
  },
  {
    heading: 'Your account',
    paragraphs: [
      'Your phone number and name, to sign you in and to issue your licence; which of your tills have asked for it, and their versions. Kept while your shop uses ShopOS.',
    ],
  },
  {
    heading: 'The daily health report',
    paragraphs: [
      'Each till sends us a short report once a day: counts of records, errors by kind, how syncing between your tills is going, and your licence state. It never holds a customer, an amount of money or a password.',
      `We use it to find faults before you have to call. We keep the last ${KEEP_PER_TILL} reports from each till, about two months, and delete older ones.`,
    ],
  },
  {
    heading: 'Records you send to support',
    paragraphs: [
      'When the owner chooses to send the shop\'s records to support, they are locked on your till before they leave it, so that only ShopOS support can open them. Passwords are taken out first, and customer details too unless you choose to include them.',
      `They are deleted from our server ${KEEP_DAYS} days after they arrive, or ${ABANDONED_DAYS} days after an upload that never finished. Every time support opens them is recorded, and we will tell you on request.`,
    ],
  },
  {
    heading: 'Remote help',
    paragraphs: [
      'Support sees your screen only when someone at your shop starts remote help and gives us its number. We do not record the session.',
    ],
  },
  {
    heading: 'Fixes from support',
    paragraphs: [
      'A fix support sends changes your records only when the owner applies it, after seeing what it will change. A backup is taken first, and the change is written to your audit log.',
    ],
  },
  {
    heading: 'The Cloud plan',
    paragraphs: [
      'On the Cloud plan, a copy of your records is kept on our server so your tills can sync from anywhere and the owner can see the shop on a phone. We read it only to do those things. Support looks at it only when you ask, and each look is recorded.',
      'When the Cloud plan ends, the copy can be read for 90 days and is then deleted.',
    ],
  },
  {
    heading: 'What we never do',
    paragraphs: [
      'We do not sell your information or your customers\'. We do not use your customers\' details to contact them or for advertising, and we do not share them with anyone except as the law requires.',
    ],
  },
  {
    heading: 'Where it is kept',
    paragraphs: [
      'On servers in India, with copies kept for recovery. Only the people at ShopOS who do support can see it, each with their own sign-in.',
    ],
  },
  {
    heading: 'Questions and complaints',
    paragraphs: [
      `Write to our grievance officer: ${GRIEVANCE}. We reply within 30 days. You can ask what we hold about your shop, ask us to correct it, or ask us to delete what we are not required to keep.`,
    ],
  },
]

export function privacyPage(): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = PRIVACY.map((s) => `<h2>${esc(s.heading)}</h2>${s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}`).join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ShopOS privacy</title>
<style>
  :root { --ink: #1d232b; --ink-2: #5a6472; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e6e9ee; --ink-2: #9aa4b2; --bg: #15191e; } }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 15px/1.6 system-ui, sans-serif; }
  main { max-width: 680px; margin: 0 auto; } h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 26px; } p { color: var(--ink); }
  .muted { color: var(--ink-2); font-size: 13px; }
</style></head><body><main>
<h1>Your shop's information and ShopOS</h1>
<p class="muted">Draft notice.</p>
${body}
</main></body></html>`
}
