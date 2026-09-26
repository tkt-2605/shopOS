# Two companies on one machine

A shopkeeper who runs two businesses from one counter — a kirana and a
hardware shop, a firm and a proprietorship — needs two sets of books on one PC.

**Two databases. Never a `company_id` column.** This file is why, and what it
cost.

---

## The decision

```
%APPDATA%\com.shopos.pos\
  shop.db              ← the original shop. No name, no flag, unchanged for ever
  device.json
  backups\
  shops\
    acme\shop.db       ← shopos.exe --shop acme
    raja\shop.db       ← shopos.exe --shop raja
```

Selected at launch with `--shop <name>` or `SHOPOS_SHOP`. One desktop shortcut
per company, and two can run at once.

---

## Why not a column

Four reasons, in order of how much they would cost to get wrong.

**GST makes them genuinely separate.** A second registration is a separate
registrant: its own GSTIN, its own invoice series, its own returns, its own
stock. There is no report that legitimately spans both, so there is nothing to
gain from putting them in one file.

**Every global unique constraint would turn into a cross-company collision.**
`bills.doc_no`, `registers.prefix`, `users.username`, `customers.code`,
`product_barcodes.barcode` are each correct today *because* the database holds
one shop. Under a shared schema every one of them becomes a bug, and the
failure is not a crash — it is one company being refused a barcode because the
other already used it.

**A forgotten `WHERE` is invisible; a wrong connection string is not.**
`docs/multi-device.md:47` puts it as the one failure that ends this product:
shop A seeing shop B's sales. Row-level isolation is one missing predicate away
in any of several hundred queries. File isolation is not reachable by a query
at all.

**`packages/core` already promised not to.** `docs/multi-device.md:56`: *"If a
`tenant_id` ever appears in a diff, this decision has been reversed by
accident."* The cloud tier made this decision for the same reasons; the desktop
case is the same shape with fewer moving parts.

---

## The rule that protects every existing till

**No `--shop` resolves to exactly the folder the app has always used.** Not
`shops/default`, not a migration, not a move — the same path, byte for byte.

This is the whole safety of the feature. Every till in the field has its
database in the app folder. A build that started looking one directory deeper
would find nothing there, conclude it was a fresh machine, and bootstrap an
empty shop on top of a working one. `host-contract.md:115` names that as *"the
single most expensive mistake available to a new host, and it looks like it
worked"* — no error, no crash, just a shop whose year of books has apparently
vanished.

So a sub-folder is used **only** when somebody asks for one by name. A machine
that never passes `--shop` cannot be affected by any of this.

---

## Where it is enforced

`apps/pos/src-tauri/src/paths.rs` — `shop_slug()`, `slug()`, `data_dir()`,
`named_shops()`.

`lib.rs` used to call `app.path().app_data_dir()` directly when building the
database path, bypassing `paths::data_dir`. That is now fixed and it mattered:
a second company would have put its device identity, its backups and its
attachments in its own folder **while still opening the first company's
database**. Two sets of books, one file, and nothing to see until the invoice
numbers collided.

### The name is a directory name and is treated like one

`slug()` accepts `a-z 0-9 - _`, lower-cased and trimmed, up to 40 characters.
Everything else is **refused rather than cleaned**. Silently turning
`../../etc` into `etc` hands somebody a shop they did not ask for under a name
they will not recognise, and possibly a different one next time.

Lower-casing matters for a reason that only shows up later: two shortcuts
differing by a capital letter would be one shop on Windows and two on Linux,
and the books would disagree with no visible cause.

Three tests in `paths.rs` cover this: what is accepted, what is refused
(`..`, path separators, drive letters, spaces, dots, NUL, non-ASCII), and the
length bound.

---

## What each company gets, and what it shares

| Per company | Shared by the machine |
|---|---|
| database, stock, customers, bills | the device id in `device.json` |
| backups and attachments | the installed binary and its updates |
| users, roles, counters | the printer |
| its own licence | |

**The device id is shared on purpose.** It is a fact about the machine, and the
two databases never speak to each other — so the same id appearing in both is
accurate rather than a collision. `device.json` lives in each shop's own folder,
so in practice each gets its own; if that ever changes, this paragraph is the
thing to re-read.

**Each company needs its own licence.** `shop_id` differs, so a licence issued
to one is refused by the other with `WRONG_SHOP` — which is correct
commercially as well as technically. The licence card already says exactly that,
and mentions restoring a backup from another shop as the other way to see it.

---

## What is not built

**A picker.** Creating and switching companies is `--shop` and a desktop
shortcut, which is how a small business would do it anyway. A picker window
would mean a remembered "current shop", which is shared mutable state that two
running instances would fight over — and the loser opens the wrong company's
books. If a picker is ever built it should *launch a new instance*, not switch
the current one.

**Anything consolidated across companies.** No combined report, no shared
customer list, no cross-company stock. Each of those is a query spanning two
databases, and the first one written is the moment this decision starts being
reversed.

---

## Trying it

```
shopos.exe --shop acme
```

First run bootstraps a new shop in `shops\acme`. The sidebar shows the company
name as always, with `Books: acme` beside the counter name; the version line in
Settings carries it too, for whoever is reading it down a phone line.

Without the flag, nothing changes at all.
