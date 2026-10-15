# A bill paid, or an account paid, twice

**Symptom.** "It says the bill was paid off more than once." Or: "The customer's payment was spent twice."

**Confirm.**
- Needs Attention shows one of these:
  - *Bill X was paid off more than once*;
  - *[customer]'s payment Y was spent on more than it was worth*;
  - *[customer] spent the same loyalty points twice*.
- The health report lists the kinds (`paid_twice`, `advance_spent_twice`, `points_spent_twice`) and the document numbers.

**Why it happens.** Two counters took the same money while they could not reach each other (the main was off, or the network was down), and both entries arrived when they met again.

**Fix.** The shop can do this themselves.
1. Ask the shop whether the customer really paid twice. If they did, nothing is wrong: the extra stays on the account as an advance. Press **Clear**.
2. If they paid once, Needs Attention lists both payments, each with the counter and the time. Press **Cancel this payment** on the one that did not happen, then **Yes, go ahead**.
3. The same can be done from Credit → the customer's account → **Cancel payment**.

**Prevent.** Keep the main till on during trading hours. Counters show the main as out of reach when it is.

**Escalate.** The cancel is refused because the books are closed for that date: the owner must open them or post a correction.
