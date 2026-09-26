# Which branch, and why there are three

Written for: whoever picks this up next, including me in three months.

Three long-lived branches, and the rule that keeps a solo developer out of merge
trouble is that **only one of them accumulates work**.

| Branch | What it is | Receives |
|---|---|---|
| `phase-2-foundations` | **trunk.** Everything lands here first. | every commit |
| `sellable` | what a shop actually runs | merges *from* trunk at a release point; cherry-picked fixes only |
| `cloud-and-billing` | the cloud tier and the subscription work | merges *from* trunk; merges *back* when a piece is done |

`main` is 46 commits behind trunk and has been since Phase 0. Merging trunk into
it is a decision worth taking deliberately, not a side effect of this file.

---

## The rule

**Features go to trunk. Never to `sellable` directly.**

`sellable` is not a place work happens; it is a record of what has been
verified. Its history should read as a short list of merges and the occasional
fix, and if it ever grows a feature of its own the other two branches have
silently forked.

```
trunk  ──●──●──●──●──●──●──●──●──▶   every feature, every fix
          \           \
sellable   ●───────────●              a merge at each release point
            (v0.1)      (v0.2)

cloud-and-billing
           \
            ●──●──●──●──▶             merges from trunk weekly; back when done
```

---

## `sellable` — what a shop runs

A commit reaches this branch when it has been **verified by a person**, not
merely when it is green. `hand-checks.md` is the gate.

What goes on it before the first sale:

- the Settings licence card (a licence has no way into a till without it)
- CI, so there is an installer to carry on a USB stick
- `hand-checks.md` sessions 1, 4 and 5 ticked

What must **not** go on it yet: anything needing two real machines, because LAN
sync has never met two of them. Until sessions 2 and 3 are done, this branch
sells to single-till shops and says so.

Tags and builds come from here, never from trunk. A shop should be able to ask
"what am I running" and get an answer that is a tag.

---

## `cloud-and-billing` — the parallel track

Two things that look separate and are not: the cloud tier is the thing worth
paying a subscription for, and a subscription is the thing that pays for the
cloud tier. They share the portal, the accounts and `portal.db`.

Work here in this order:

1. **Billing, manual first** — `billing.md`. Needs no VPS, no payment gateway,
   no integration. It is the part that can earn money on the `sellable` branch
   while the cloud is still being built.
2. **C1–C4, the cloud peer** — `pairWithCloud`, the per-shop peer, the
   supervisor and router, provisioning. All on loopback, all in `npm test`.

Billing first is deliberate. It is cheaper, it applies to shops you can already
sell to, and the cloud tier cannot be charged for until there is something to
charge with.

**Merge from trunk weekly**, even when nothing seems to conflict. This branch
touches `packages/core/src/services/syncClient.ts` and `apps/portal/`, and both
are places trunk will also move.

---

## When trunk and `sellable` disagree

A bug found at a shop is fixed **on trunk**, tested there, and cherry-picked to
`sellable`:

```
git checkout phase-2-foundations
# fix, test, commit
git checkout sellable
git cherry-pick <sha>
```

Not the other way round. A fix that exists only on `sellable` is a fix that
comes back as a regression the next time trunk is merged in — and it will not
look like a regression, it will look like the bug returning on its own.
