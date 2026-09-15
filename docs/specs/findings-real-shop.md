# What the real shop's database says

Findings from `tools/fixtures/real-shop.db`, pulled from this machine's ShopOS
on 2026-09-16. TRT Stationery, schema 26, 29 submitted bills, 51 bill lines,
20 products, 6 customers, 2 returns.

Kept because the architect pass asked for exactly this: places the plan treats
as settled that the data says otherwise about. Each finding names the phase it
belongs to.

---

## 1. CGST and SGST differ by a paisa on 29 of 51 lines — **new, not in any spec**

`bill_items` where `cgst_amount <> sgst_amount`: **29 of 51**, always by exactly
one paisa, always with SGST the larger.

```
taxable 30357 @ 1200bp  →  cgst 1821, sgst 1822
taxable  5085 @ 1800bp  →  cgst  457, sgst  458
taxable  1339 @ 1200bp  →  cgst   80, sgst   81
```

**This is not permissible.** CGST and SGST are levied on the same taxable value
at the same half-rate. They cannot differ. An invoice showing 1821/1822 is
facially wrong, and GSTR-1's rate-wise summary will not reconcile against a
recomputed half.

The mechanism is `domain/tax.ts`, in both `splitTax` and `addTax`:

```ts
// Half each, with the odd paise on CGST so the pair always sums to taxTotal.
const cgst = paise(Math.trunc(taxTotal / 2))
const sgst = sub(taxTotal, cgst)
```

Two things wrong. The comment says the odd paisa goes on CGST; the code puts it
on SGST. And the whole approach is backwards — it computes the *total* tax and
then splits it, when the law computes each half from the taxable value.

### The fix, and why it is not obvious

The module is built on an invariant it states up front: `taxable + cgst + sgst`
reconciles to the line total exactly, because retail prices are tax-inclusive
and the customer pays the shelf price. Computing the halves independently
breaks that invariant — 30357 + 1821 + 1821 = 33999, and the shelf price was
34000. A paisa vanishes from every such sale.

The resolution is to notice which quantity is actually derived. For an
inclusive price the **line total is fixed** and the taxable value is the thing
being back-derived, so the paisa belongs there, not in the tax:

```
half   = round(taxable_raw × (rateBp / 2) / 10000)
cgst   = sgst = half
taxable = lineTotal − 2 × half
```

For 34000 @ 1200bp: `half = round(30357 × 600/10000) = 1821`, so CGST = SGST =
1821, taxable = 34000 − 3642 = 30358. Both invariants now hold: the pair is
equal, and the three sum to the shelf price.

Note that the agreed half is **not** simply the lower of the two stored
figures. It is `round()` on the half-rate, so 6000 @ 18% gives 457.65 and
settles at 458 on *both* sides where the old code had 457/458. Of the eight
sampled lines, four round up and four round down, and the taxable value moves
by a paisa in whichever direction that forces.

`addTax` (exclusive pricing) is the easier case — taxable is fixed, so
`taxTotal = 2 × half` and nothing needs absorbing.

### What this does not do

The 29 existing lines stay as they are. Submitted documents are never
rewritten — that rule outranks this fix, and a migration that "corrected" 29
filed invoices would be worse than the paisa. The owner should know that bills
before this change carry the asymmetry, in case a GSTR-1 reconciliation ever
queries it. The amounts involved are 29 paise in total.

**Applied** on the owner's instruction, ahead of Phase 1a. `domain/tax.ts`,
with `packages/core/test/taxHalves.test.ts` pinning it — including the eight
real lines above, and a fixture-gated replay of all 51.

---

## 2. The shop charges GST without a GSTIN — **Phase 1, confirms the scheme work**

`settings` has no `shop_gstin` key at all. It has `shop_state_code = '33'` and
`shop_name = 'TRT Stationery'`. Yet every bill carries CGST and SGST —
₹1,568.74 and ₹1,569.03 collected across 29 bills.

Phase 1's rule — *"Default on upgrade: `regular` if a GSTIN is set, otherwise
`unregistered`"* — puts this shop on `unregistered`, which charges no tax and
titles the document *Invoice*. That is the right default and it will visibly
change what this till does on the day the migration lands.

**Flagging it because it is not a silent change.** The Settings prompt the
spec asks for on first open after migration is doing real work here, not
covering an edge case. If TRT is in fact registered, the GSTIN needs entering
before the upgrade or the till stops charging tax it is entitled to collect.

---

## 3. This database cannot exercise the inter-state path — **Phase 1 verification gap**

`SUM(igst_amount) = 0` across all 51 lines. Every bill is intra-state.

And the reason is a coincidence that hides the bug: all 6 customers have the
fabricated `state_code = '33'`, and the shop's *own* state code is also `'33'`
— Tamil Nadu, which for TRT is correct. So the fabricated default happens to
match reality, `supplyTypeFor` returns `intra_state` for everyone, and the
result is right by accident.

This is worth stating plainly: **the real database confirms the fabricated
`'33'` (all 6 rows, as the plan said), but it will not reveal the inter-state
bug, because here the fabrication and the truth coincide.** Phase 1's
verification step — *"a bill to a customer in 27 stores IGST"* — has to be set
up by hand on a copy. The data will not volunteer it.

Migration 028's `UPDATE customers SET state_code = NULL` is confirmed correct:
none of the 6 was ever typed by a person.

---

## 4. Rule 46(f) is untested by this data — **Phase 1 verification gap**

Bill totals run from ₹10 to ₹17,680. No bill reaches ₹50,000, so the
`NEEDS_RECIPIENT` guard has no real example to check against. 12 of 29 bills
have a customer; 17 do not.

Set up by hand on a copy, like finding 3.

---

## 5. Things the data confirms are fine

- **HSN is present on all 51 lines.** The Phase 1 exceptions sheet for B2B
  lines missing HSN will be empty here, which is a pass, not a gap.
- **Two returns exist**, so the credit-note renderer and the returns-in-GST
  work have real rows to run against.
- **Only two rates in use**, 1200bp and 1800bp. Rate-summary rendering will
  not be stressed by this shop; use the synthetic fixture for that.
- `integrity_check` = ok.

---

## 6. Schema 26, code at 27

The live database is one migration behind the code, so it has not been opened
by a current build. Useful rather than a problem: it is a genuine "needs
migrating" database, which is what migration 028 and Phase 2c's replay test
want to run against.
