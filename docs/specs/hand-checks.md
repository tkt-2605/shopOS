# The checks a person has to run

Everything that cannot be asserted from a terminal, ordered by what equipment it
needs rather than by which phase asked for it — because the thing that actually
decides when a check happens is whether you have two machines in front of you.

`progress.md` carries the same list scattered through its rows, with the
argument for each. This is the version you work from.

**Tick them here.** A check that was run and not recorded is a check you will
run again in three months because nobody can remember.

---

## Before any of it: one thing that cannot be done later

- [ ] **Generate the updater keypair.** `tauri signer generate`, once, never
      again.

The public half goes in `tauri.conf.json` and ships inside every build. A till
installed from a build without it can never be updated — not by a patch, not by
a fix, ever, because there is no key for it to trust. That is true of a trial
install at a friendly shop exactly as much as of a paying one.

The private half never enters the repository, and goes to two places you
control, with the passphrase stored separately. `owner-readiness.md` row 2 has
the detail.

An hour's work now. Impossible afterwards.

---

## Session 1 — one machine, at your desk

Half an hour. Nothing here needs a second computer.

### Backups and the things that break around them

- [ ] **A backup that fails says so.** Set `backup_hook` to `exit 1`. The Backup
      card on Settings shows the failure *and* the exit code.
      → If it shows a green tick, a shop has no backups and does not know.

- [ ] **A backup folder that has moved says which one.** Rename the backup
      folder while the app is running. Settings names the folder it cannot
      find.
      → A message that says only "backup failed" costs a phone call.

- [ ] **The day rolls over at the right time.** Set the clock to 01:59. A backup
      is written two minutes later, against the correct business day.
      → This is `businessDate()` in the one place UTC would file it against
      yesterday.

### The app surviving itself

- [ ] **One broken screen is one broken screen.** Put a temporary `throw` in
      `Dashboard.tsx`. The sidebar survives, and "back to Billing" works.
      → A shop whose Dashboard throws must still be able to ring up a sale.

---

## Session 2 — two machines on the same Wi-Fi

An hour. Two PCs or a PC and a VM with a real network adapter. This is the
smallest setup that can test sync at all.

- [ ] **The app pairs over Wi-Fi.** Not loopback, not the three-till bench —
      two machines, one wire.
      → Everything proven in the bench assumes the sockets work. This is the
      check that says they do.

- [ ] **An idle joiner is never reported as agreed.** With the joiner switched
      on and doing nothing, the host must not say "Both tills agree" before it
      has actually contacted it.
      → The logic is a tested pure function now. The LAN half is still a LAN.

- [ ] **Two tills opened at the same time produce no conflict.** Switch both on
      within a few seconds of each other and sign in on both. Settings → the
      sync card → conflicts should stay empty.
      → This is migration 049. Before it, every morning filed a row saying an
      edit was being dropped, and the edit was a login timestamp. If a conflict
      appears here, something still writes a shared row on a routine action.

- [ ] **Wrong passwords add up across counters.** Get the password wrong three
      times on one till and twice on the other, let them sync, then look at
      Staff on either. It should say five.
      → It said three before 049. This is the badge under-reporting the one
      thing it exists to show.

- [ ] **Clocks five minutes apart are described as clocks.** Push one machine's
      clock five minutes ahead. The Two tills card says so in words about
      clocks, not the word `STALE`.
      → A shopkeeper can fix a clock. Nobody can fix `STALE`.

- [ ] **A restored backup can take its own counter back.** Restore a backup onto
      a *different* machine. Settings should offer to free the claim the backup
      carried; without it the machine cannot bill at all.
      → The backup carries `claimed_by` and `device.json` deliberately does not,
      so a restored machine holds a counter claimed by a device id that exists
      nowhere. This is migration 045 and it is the most likely of all of these
      to happen to a real shop.

- [ ] **A till that is gone can be forgotten, and the feed shrinks.** Press "This
      till is gone" on a peer, then check the change feed on the remaining
      machine actually gets smaller.
      → `pruneAcknowledged` holds the feed at the lowest cursor of every peer,
      so one machine that was sold pins the feed of every other for the life of
      the shop.

---

## Session 2b — two tills kept apart

From the pre-release review of 26 September. Each of these was a fault a test
now covers; what a person adds is the real LAN, the real restart and the real
screens. Two machines, paired, and a way to pull one off the network.

- [ ] **Both apart, same customer.** Unplug one. Edit the same customer on both
      and ring a bill for them on both. Plug back in: both bills on both tills,
      one version of the customer, and the Sync card lists the dropped edit.

- [ ] **One apart for days.** Keep the back till off while the front does more
      than 200 things, including adding a product to a new category and then
      renaming the category. It catches up to the end; nothing sits in "could
      not be saved" afterwards.

- [ ] **A name used twice.** Make a login `ravi` on both while apart. After
      sync, one is listed as not saved. Rename one, sync again, and the list
      empties by itself.

- [ ] **Restore on the same machine.** Take a backup of the back till, ring
      three bills on it, sync, then restore that backup there. It starts with
      "Billing is held" on every screen and refuses a bill. Pair it with the
      front till again: the front till lists one back till, not two. After the
      sync the hold is gone, the three bills are back here, and the next bill's
      number follows the third.

- [ ] **Cancel across the gap.** Ring a bill on the front, sync, take the front
      off, cancel that bill on the back. Front back on: cancelled on both, with
      the lines it was printed with.

- [ ] **Two machines with no counter.** A laptop and a till that never chose a
      counter each post a stock entry while apart. Both numbers start `S` and a
      lowercase `d`, and they differ.

---

## Session 3 — three machines

An hour, and it needs a third PC. Everything here is about a shop that is not a
pair, which is the shape that two machines cannot show you.

- [ ] **One till switched off mid-merge; the other two keep billing.** Pull the
      power on one machine in the middle of a sync. The other two carry on
      taking sales without pausing, refusing or showing an error about it.

- [ ] **It catches up when it comes back, without anybody pressing anything.**
      Switch it on and leave it. No button, no menu.
      → The 45-second loop is the floor that is supposed to make this automatic.

- [ ] **A counter claimed by a till that has been off three days can be taken.**
      Leave a counter claimed, switch that till off for three days (or move the
      clock). Counters offers to take it over, names the till and the date, and
      refuses if that till has started up since the screen was drawn.
      → The refusal is the part worth watching: the screen must not act on what
      was true when it was drawn.

- [ ] **`node tools/behind.cjs` agrees with the screens.** While all three are
      up, compare what the tool reads out of the databases with what the sync
      card shows.
      → Migration 048 exists because three caught-up tills displayed "?" and
      nothing on screen could have told you it was wrong.

- [ ] **Two tills apart for a day, then together.** Unplug the switch. On both,
      edit the same customer and ring up bills for that customer. On the front
      till add a category, put a product in it, then rename the category. Plug
      the switch back in. Both tills end with every bill, the renamed
      category and its product, and the Sync card lists the customer edit as a
      conflict. Nothing stays under "could not be saved here".
      → The rename-after-add is the batch-boundary case that used to wedge a
        pair of tills for good.

- [ ] **One till off for three days.** Leave the back till off while the front
      rings up a few hundred bills and edits items. Switch it on. It catches up
      without anyone touching it, and every total matches.

- [ ] **A bill cancelled on the other till.** Ring up a bill on the front till,
      let it cross, switch the front till off, cancel the bill on the back
      till, switch the front on. The front shows it cancelled, lines unchanged.

- [ ] **Two machines with no counter.** On a back-office machine and a second
      one that has not claimed a counter, post a stock entry on each while
      apart. Their numbers start `Sd…` and differ; both arrive on both.

- [ ] **Restore a till from its own backup, then bill.** Take a backup of the
      back till, ring up three bills on it, let them cross, then restore that
      backup on the same machine. After the restart: the counter is still its
      own, a banner says billing is held, and Billing refuses with the reason.
      Pair it with the front till again. Once the sync finishes the banner goes,
      the three bills are back on it, and the next bill takes the number after
      them -- not one of theirs. The front till shows one back till, not two.

---

## Session 4 — a machine you are willing to break

This is `layer3-procedure.md`, run in full. Half an hour when nothing is wrong.
It needs Windows Sandbox enabled and a VM you can hard-power-off — not the
Sandbox, which has no persistent disk and so cannot show you what survived.

**Run this once per release, and before any build goes to a shop.**

- [ ] **A corrupt database opens on a screen, not a crash.** Overwrite `shop.db`
      with random bytes. The window opens on `CouldNotStart` with the reason,
      and `logs/shopos.log` carries the same line.

- [ ] **A locked database names the file.** Lock `shop.db` from another process.
      `kind: 'locked'`, and the message says which file.

- [ ] **A broken backup token shows red with the output.** Break the rclone
      token. The Backup card goes red and shows what rclone actually said.

- [ ] **A power cut loses nothing that was acknowledged.** Hard-power-off the VM
      during a burst of fifty bills. Every bill whose submit *returned* is
      present afterwards.
      → This is the only check that tests the promise the whole ledger design
      is built on.

---

## Session 5 — paper

- [ ] **An A4 bill read against Rule 46's list, on paper.** Not a PDF on screen.
      → Print is the one output nobody can patch remotely.

---

## Still code, not a check

Carried here so it is not lost between the two lists:

- [x] A test that the GST tab is hidden under composition. Done in
      `apps/pos/test/reportsGstTab.test.tsx` (c133870): composition and
      unregistered, and a shop moved off the tab when it stops collecting GST.

---

## What this list does not cover

Three things stand between a green run of everything above and a stranger's
shop, and none of them is a check:

- a code-signing certificate, or every install shows "unknown publisher";
- CI, so a release is a reproducible artifact rather than whatever was on your
  machine that afternoon;
- the updater itself, so a bug found in a shop is a download and not a visit.

All three are Phase 4. A shop you can walk into is reachable without them; a
shop you cannot is not. `owner-readiness.md` has the lead times.
