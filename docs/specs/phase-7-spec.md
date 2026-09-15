# Phase 7 spec — Branches

Source: plan *Phase 7*. Not started until Phase 6 has shops on it; specified
here only far enough to price the tier and to stop earlier phases from
foreclosing it.

## Scope

Per-branch stock, transfers, consolidated reporting. A different product on
the same core.

## Open decisions resolved here

Nothing is resolved yet, deliberately. Three things earlier phases must not
foreclose:

- **A branch is a set of registers.** A `branches` table and a nullable,
  additive `registers.branch_id`. Bills already carry `register_id`, so every
  past bill can be attributed to a branch when the column arrives. Do not add
  `branch_id` to `bills` before then.
- **Stock is per branch.** `stock_ledger` and `product_stock` gain
  `branch_id`; a transfer is two ledger rows in one transaction sharing a
  `transfer_id`. Phase 3's `recomputeStock(db, productIds)` must be written
  so a branch dimension is one more `WHERE`, not a rewrite.
- **Sync topology**: branches sync through the cloud peer only, never LAN
  across branches. The cloud peer is already the hub in Phase 6, so the
  protocol does not change; only `branch_id` appears on the replicated rows.

## File-level task list

Deferred. When opened: an additive migration, `services/branches.ts`, a
transfer document series, a branch filter on every report, and the branch on
the invoice header. Rule 46 requires the address of the place of business the
supply is made from; a branch with its own GSTIN is a separate registrant,
and that is the case to design for first.

## Dependencies

Phase 6 in production for a season.

## Verification

Written when the phase is opened. The one check that exists now: nothing in
Phases 1–6 adds a column or a rule that assumes one address per shop, except
`settings.shop_address`, which is the thing this phase replaces.
