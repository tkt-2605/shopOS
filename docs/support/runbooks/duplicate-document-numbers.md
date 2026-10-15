# Two bills with the same number

**Symptom.** "Needs Attention says records from another till could not be taken in." Or: "A bill is missing on one till."

**Confirm.**
- Needs Attention shows *N record(s) from another till could not be taken in*.
- In the health report, `sync.set_aside` has rows with `table_name` `bills` (or `sales_returns`, `payment_entries`), and the reason names `UNIQUE constraint failed: ....doc_no`.
- The prefix in the number says which counter made it.

**Why it happens.** One counter's numbers were used on two machines at once:
- a till restored from a backup and told to **Bill anyway**;
- a counter freed while its old machine still billed;
- on versions before 0.3.0, a counter moved before the till had handed over.

**Fix.** This one is by hand today:
1. Have the shop send the diagnostics report from both tills.
2. Find both bills with that number. Both are real sales; neither is dropped.
3. Over remote help, on the till that did not make the original, move that counter's next number past the highest number used. There is no screen for it yet, so it is done by hand, with a backup first.
4. The set-aside bill needs a new number before it can land. There is no screen for this. Note the bill and the customer, and escalate.

**Prevent.** From 0.3.0 a till cannot change counter while it holds changes the main has not got (`HAND_OVER_FIRST`), and the latest claim wins (`claim_seq`).

**Escalate.** Always, until the `renumber_from` repair exists. Write the case down: it is the test for that repair.
