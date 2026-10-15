# The licence will not verify

**Symptom.** "It won't take the licence code." Or: "It says the code belongs to a different shop."

First, tell the shop that billing is not affected. One counter always bills, whatever the licence says.

**Confirm.** The Licence card's headline, and `problem` under the licence in `app.json`:

| Headline | Code | Fix |
|---|---|---|
| That does not look like a licence code | `MALFORMED` | The code lost a character or gained a line break on the way. Send it again as a file, or have them copy it with Copy rather than by selecting text. |
| This code did not check out | `BAD_SIGNATURE` | The same, usually. Send a fresh code. |
| This till is too old to check that code | `UNKNOWN_KEY` | The code is fine. Update ShopOS on that till, then paste again. |
| This copy of ShopOS cannot check licence codes | `NOT_CONFIGURED` | Our build was made without its public key. It is our fault, and the shop cannot fix it. Ship a build with the key. |
| That code belongs to a different shop | `WRONG_SHOP` | Compare the shop id the message names with the shop's support code. Either the code was made for the wrong shop (issue again), or this PC was restored from another shop's backup (stop, and find out which). |

**Expiring.** The headline says when paid time ends. The portal sends the renewal; nothing at the till changes until then.

**Escalate.** `NOT_CONFIGURED` on any shipped build. That is a release that should not have gone out.
