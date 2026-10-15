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

**Fix.**
1. Have the shop send their data (Settings → Help → Send my data to support) from both tills, or the diagnostics report.
2. Find both bills with `support.ts timeline <file> --doc <number>` on each. Both are real sales; neither is dropped.
3. Make a fix that moves the counter's next number past the highest one used. Send it to the till that did not make the original; the owner applies it from Settings → Help → Apply a fix from support.

   `pack.ts --shop <id> --ticket "<case>" --repair renumber_from:docType=bill,prefix=<FC>,fiscalYear=2627,next=<highest+1>`
4. The bill that was set aside still holds its number. Note it and the customer, and escalate: renumbering a bill that has been set aside has no repair yet.

**Prevent.** From 0.3.0 a till cannot change counter while it holds changes the main has not got (`HAND_OVER_FIRST`), and the latest claim wins (`claim_seq`).

**Escalate.** For step 4, always. Write the case down: it is the test for a repair that renumbers a set-aside bill.
