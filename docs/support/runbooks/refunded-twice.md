# Goods taken back twice

**Symptom.** "It says an item was taken back more times than it was sold." Or: "A bill was cancelled and also returned."

**Confirm.**
- Needs Attention shows *[item] was taken back more times than it was sold* (`refunded_twice`), or *Bill X was cancelled and taken back as well* (`refunded_and_cancelled`).
- The health report gives the kind and the document numbers.

**Why it happens.** The customer came to two counters, or one return was keyed on two counters, while they could not reach each other.

**Fix.** The shop can do this themselves.
1. Ask whether the customer really brought the goods back twice. Almost always they did not.
2. Needs Attention lists the returns, each with the counter and time. Press **Cancel this return** on the one that did not happen. Cancelling it takes back the refund, the credit note and the loyalty points with it.
3. For *cancelled and taken back*: cancel the return if the bill's cancellation already gave the money back. Otherwise cancel nothing and press **Clear**.
4. Check the cash drawer against the day's refunds. A refund paid out twice in cash is money to recover from the customer, which no software can do.

**Prevent.** As for [paid-twice.md](paid-twice.md): keep the main on.

**Escalate.** The figure on the item's line stays wrong after the cancel. The reconciler should set it from the standing returns, so send the diagnostics report.
