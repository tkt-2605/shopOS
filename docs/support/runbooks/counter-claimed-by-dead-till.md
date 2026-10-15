# Counter claimed by a till that no longer exists

**Symptom.** "The new PC won't let me bill." Or: "All counters say they are in use."

**Confirm.**
- Settings shows *One counter in this shop is claimed by a till that no longer exists* (or *N counters ...*).
- In the health report, `registers` shows `claimed_by` set to a device id that is not in `sync.peers` and is not this till.

**Fix.**
1. On Settings, press **Free them**.
2. Open Counters and press **Use here** on the counter this machine sits at.
3. With one main till, changing counter needs the main to be on. If the till says it must hand over first, let it sync, then try again.

**When the old PC is not dead.** If the old machine might come back (sent for repair, for example), do not free its counter. Bring it back first and let it hand over. Two machines billing on one counter is how duplicate bill numbers happen.

**Prevent.** Retire a till from Counters before it leaves the shop.

**Escalate.** Freeing does not stick after a sync. The claim comes back from another till, so look at `claim_seq` on `registers` on both sides.
