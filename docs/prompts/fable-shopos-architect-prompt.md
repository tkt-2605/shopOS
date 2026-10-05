# Prompt for Fable — ShopOS System Architect Pass

You are acting as system architect on ShopOS, a POS product for Indian retail shops (Tauri + Rust + TypeScript, SQLite/libSQL, LAN sync between tills). You have Claude Code access to the real repository — use it. Do not ask me to paste files; open what you need directly.

## Your job, precisely

I already have a phase plan (pasted below, in full, as ground truth for scope and sequencing — do not rewrite or re-justify what it already justifies). Your job is NOT to restate it. Your job is the layer above it: **resolve every open judgment call, challenge the two tech choices flagged as open, and produce one execution-ready spec per phase that a mix of Opus and lighter models can build from without coming back to you.**

You are the expensive pass. Spend your output on decisions, not boilerplate. Where a task is mechanical (a CRUD screen, a wired-up column, an obvious migration), say what it is and hand it off in a sentence or two — don't write the implementation. Where a task is genuinely ambiguous, underspecified, or risky, go deep: that's what you're for.

## Non-negotiable constraints (carry into every phase spec)

- Billing never stops, for any reason (lapsed licence, failed sync, unreachable cloud, expired cert).
- Nothing is "on" unless a person can see it work. No silent switches.
- Every claim about correctness gets verified against the owner's real shop database, not just the fixture — the fixture has already been shown to lie.
- A submitted document is never rewritten.
- Sync/merge logic must be tested from both ends. The host-till bug (1d) survived 1047 tests because every test let the joiner initiate — symmetry must be asserted, never assumed.

## Specific open questions you must resolve and justify (don't ask me — decide, document the reasoning, flag confidence)

1. **libSQL spike outcome.** The plan says spike VACUUM INTO / integrity_check / AUTOINCREMENT+trigger support before committing. Actually check this against real libSQL docs/source or run it if you can in the sandbox. If it fails, the local driver stays rusqlite — say so and adjust Phase 2b/6 accordingly.
2. **Drizzle rollout order** — is service-by-service migration (45 files) actually the right unit, or should it be grouped by risk (money-path queries first, since that's where the 5 hand-written-column bugs this week actually were)? Challenge the plan's ordering if you disagree.
3. **Licensing grace period** — plan says "long grace period," no number. Pick one, justify against the billing-never-stops rule and against piracy/non-payment risk, and specify the offline validation mechanism concretely (what's cached locally, what triggers a re-check, what happens at expiry vs. what happens forever if never re-validated).
4. **Turso-per-shop vs. existing rclone backup** — Phase 0 fixes the *existing* local/rclone offsite backup; Phase 6 adds Turso-per-shop for cloud-tier shops. Are these two independent backup systems that both need to keep working, or does Turso subsume rclone for cloud-tier shops? Specify which shops get which, and whether a downgrade from cloud tier back to single-device silently drops offsite backup (that would violate "nothing is deleted/degraded silently").
5. **CI feasibility for the Docker test bench (Layer 2)** — UDP broadcast across container network namespaces may behave differently or be restricted on hosted GitHub Actions runners vs. local Docker. Verify this rather than assume it, and specify a fallback if hosted CI can't run it (e.g., Layer 2 runs locally/self-hosted only, CI runs Layer 1 headless-till tests).
6. **Code signing acquisition** — EV cert needs a legal entity and a hardware token. Specify who/what entity it's issued to, and note this as a real-world blocking dependency outside the code, not a coding task.
7. **Phone view auth** (Phase 6.3) — is this a new account system, or does it reuse the licensing/entitlement identity from Phase 4? Specify, since building a second auth system is a real scope item the plan currently hides inside one bullet.
8. **Tamil font licensing** (Phase 5) — flag whether the embedding font choice needs a licence check before it's baked into the installer.
9. **WhatsApp-the-bill** (Phase 5) — flag that this needs a WhatsApp Business API account and has a real cost/approval lead time; don't let it get scheduled as if it's just code.

If you find other places where the plan states something as settled but it's actually a guess (the way the audit found `sync_queue` was "a guess made on day one"), call it out the same way.

## Output format

One markdown file per phase: `phase-0-spec.md` through `phase-7-spec.md`, plus `test-bench-spec.md`. Each file:

- **Scope** (one paragraph, reference the source plan section, don't repeat it)
- **Open decisions resolved here** (from the list above, if applicable to this phase)
- **File-level task list** — for each non-mechanical task: what changes, why, and the interface/schema/migration shape if it's non-obvious. For mechanical tasks: one line, marked `[delegate: Opus]` or `[delegate: Sonnet/Haiku]` based on how much judgment it needs.
- **Dependencies** — what this phase needs from an earlier phase to be safely started (the plan implies some parallelism is possible before Phase 2 is fully done; say what's actually blocking vs. not)
- **Verification** — carry forward and sharpen the plan's own verification section for this phase; make it a checklist a builder can run, not prose.

Also produce one `execution-order.md`: given solo-developer-plus-Claude-Code as the team and no hard deadline, sequence the phases (noting where sub-phase items can run in parallel), and state explicitly which items block which.

## Budget discipline

Don't restate content already fixed in the source plan. Reference section numbers instead of re-explaining. If a phase has nothing ambiguous left to resolve, say so briefly and move to the task list — don't manufacture analysis to fill space.

---

## Source plan (ground truth for scope/sequencing)

[PASTE THE FULL SHOPOS PLAN DOCUMENT HERE]
