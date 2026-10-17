# How support runs

Everything a person needs to answer a shop: where cases come in, how fast
each kind is answered, the tools, and what is written down after.

## Where cases come in

- **WhatsApp** on the support number. The till's Get help screen opens a chat with the shop's support code already in it.
- **Phone**, the same number.
- **The morning digest** in the vendor's Telegram, and the console's "To look at" list. These are the cases nobody has called about yet.

Each case is an issue in the private tracker. Put the support code in the title, e.g. `0192f4a1 · FC · 0.3.0: bills not crossing`, and label it with its severity and area.

## How fast

**For the owner to decide and promise:** the hours, and which plans get the faster targets. Until then, these are what the kit is built for.

| Severity | Meaning | First reply | Put right |
|---|---|---|---|
| P1 | Cannot bill on any counter, or the books are wrong | 1 hour, 9 a.m. to 9 p.m. every day | Same day |
| P2 | Sync stuck, one till unusable, a feature broken | 4 hours, working hours | 2 days |
| P3 | A wrong figure in a report, something awkward | Next working day | Next release |
| P4 | A question or a request | 2 working days | — |

Billing works offline on one counter, so a true P1 is rare. When a shop says "nothing works", the first question is whether any counter can bill.

## The tools

| Need | Tool |
|---|---|
| Which shop | The support code: the short shop id, the counter, the version |
| Is anything wrong | The console (`/console`), the morning digest |
| What happened | The health report on the console; `faults.json` in it |
| The shop's records | The owner sends them (Settings → Help); `tools/support/open.ts` opens them |
| Read them | `tools/support/support.ts check`, `timeline`, `diff` |
| Put them right | `tools/support/pack.ts` makes a fix; the owner applies it |
| Turn a broken feature off | `tools/support/switches.ts`, then `cli.ts switches` on the portal |
| Stop a bad release | `tools/release.ts target <tag> --percent 0` |
| Fix one shop first | `tools/release.ts hotfix <tag> --shops <id>` |
| Known problems | [runbooks/](runbooks/README.md) |

The two private keys (data and repair) stay offline. Support opens data and signs fixes on the vendor's own machine, never on the server.

## When a new shop is set up

On Settings → Help, the "Ready for a bad day" card should show every item ticked before you leave:

- [ ] the recovery code written down, and the paper kept away from the till;
- [ ] backups going to a pen drive or a Drive folder;
- [ ] support hearing about problems (a build with the portal, or Telegram or email set up);
- [ ] the support number saved in the shop's phone.

## After a P1

Within 48 hours, a note in `incidents/`, copied from [the template](incidents/TEMPLATE.md): what happened, what it did to the shop, why, and what stops it happening again. Most fixes in this project began as one of these. If the case needed hand work, add a runbook the same week. If a fix kind or a switch would have done it, add that too.
