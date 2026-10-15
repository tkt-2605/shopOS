# Runbooks

One page per known problem, for whoever answers the phone. Each page has the
same five parts:

- **Symptom:** what the shop says, in their words.
- **Confirm:** where to look before believing it: the health report (`health.json` / `app.json` in the zip), the diagnostics bundle, or a screen.
- **Fix:** what the shop does, then what support does if that is not enough.
- **Prevent:** what stops it happening again, and which version has it.
- **Escalate:** when it stops being support and becomes a bug.

First, always:

1. Get the support code from the shop. The shopkeeper reads it off sidebar → Get help, e.g. `0192 f4a1 · FC · 0.3.0`. The first part is the short shop id used in reports and in `tools/release.ts target --only`.
2. Find that shop's latest health report (Telegram, the shop's mail, or later the portal console).
3. Ask whether billing works on at least one counter. If it does, this is not a P1, however it sounds.

| # | Runbook | Usual severity |
|---|---|---|
| 1 | [Till restored from a backup](restored-from-backup.md) | P2 |
| 2 | [Counter claimed by a till that no longer exists](counter-claimed-by-dead-till.md) | P2 |
| 3 | [Two bills with the same number](duplicate-document-numbers.md) | P2 |
| 4 | [A bill paid, or an account paid, twice](paid-twice.md) | P3 |
| 5 | [Goods taken back twice](refunded-twice.md) | P3 |
| 6 | [The machine's clock is wrong](clock-wrong.md) | P3 |
| 7 | [The licence will not verify](licence-will-not-verify.md) | P2 |
| 8 | [Other tills cannot reach this one (Windows network prompt)](windows-network-prompt.md) | P2 |
| 9 | [The disk is full](disk-full.md) | P1 |
| 10 | [Forgotten password](forgotten-password.md) | P1 if it is the only owner, else P3 |

A runbook whose fix says "by hand" marks a repair that the repair packs
(`docs/specs/support-kit.md`, part 6) should take over. Each new case that
needed hand work gets a page here the same week.
