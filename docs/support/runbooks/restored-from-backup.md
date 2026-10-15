# Till restored from a backup

**Symptom.** "The till says billing is held." Or: "After we restored, the till won't bill."

**Confirm.**
- The banner reads: *Billing is held on this till until it catches up.* The text under it gives the date of the restore.
- In the health report, `sync.peers` shows the other tills with an old `last_agreed_at` for this till.

**Fix.**
1. Make sure the other tills are on and on the same network. With one main till, the main must be on.
2. Leave this till open for a few minutes. It catches up by itself, and the hold lifts when it has.
3. If no other till exists, or nothing was billed on any till since the backup was taken, the shop can press **Bill anyway**. Ask them first. Pressing it when bills were made elsewhere means this till can give out a bill number a customer already has (see [duplicate-document-numbers.md](duplicate-document-numbers.md)).
4. If the counters then show as claimed by a till that is gone, see [counter-claimed-by-dead-till.md](counter-claimed-by-dead-till.md).

**Prevent.** Restore from the newest backup. With two or more tills, a new machine is better joined to the shop (Add a till) than restored. Joining copies the shop from the main, with nothing lost.

**Escalate.** The hold stays after the till has synced with every other till: compare the `feed_by_origin` numbers on both tills' health reports.
