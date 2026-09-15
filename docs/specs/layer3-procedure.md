# Layer 3 — the things only a real Windows machine can tell you

A procedure, not code. Four checks that need a real installer, a real disk and a
real power cut, run by hand before a build goes to a shop. Each step names the
file it produces, so a run either leaves evidence or did not happen.

Run the whole thing once per release. Half an hour when nothing is wrong.

**Where the evidence goes:** `docs/specs/evidence/layer3-<version>/`. It is
gitignored where it holds a shop's data and committed where it does not — a
screenshot of a version line is fine, a database is not.

---

## Before you start

- A Windows 11 machine with **Windows Sandbox** enabled
  (Settings → Optional features → More Windows features → Windows Sandbox).
- A VM you are willing to hard-power-off. Hyper-V, VirtualBox, anything with a
  "power off" that is not a shutdown. **Not** the Sandbox: it has no persistent
  disk, so it cannot show you what survived a power cut, which is the one thing
  check 4 is about.
- The installer under test, and the one before it.
- `tools/fixtures/real-shop.db` from `npm run pull-shop-db`.

---

## 1. Install, on a machine that has never seen ShopOS

The Sandbox is the only honest way to do this. A development machine has the
data folder, the registry entries and the Visual C++ runtime already, and every
one of those hides a failure a shopkeeper would hit.

1. Start Windows Sandbox. Copy the installer in.
2. Run it. **Record what SmartScreen says**, exactly — "unknown publisher" and
   the reputation warning are different outcomes and the difference is the
   certificate. → `01-smartscreen.png`
3. Let it install. Open the app.
4. It must reach the setup screen, not an error. → `02-first-run.png`
5. Complete setup with a shop name and a password. Raise one bill. Print it to
   the Microsoft PDF printer.  → `03-first-bill.pdf`
6. Settings → bottom of the page: note the version and schema line.
   → `04-version.png`

**Fails if:** the installer needs administrator rights it was not given, the app
opens to `CouldNotStart`, or the version line disagrees with the tag you built.

---

## 2. Update, from the release before

The check is that a shop's data survives, and that nothing interrupts a sale.

1. In the Sandbox, install the **previous** release first. Complete setup and
   raise two bills, so there is data with a known shape.
2. Note the bill numbers. → `05-before-update.png`
3. Put the new release where the updater will find it, or trigger the check.
4. "Update ready" must appear **in the sidebar** and nowhere else. It must not
   be a dialog and must not steal focus.
5. **Open a cash session.** Ask it to install. It must refuse, and say why.
   → `06-refused-mid-session.png`
6. Close the session. Install. The app reopens.
7. The two bills are there, with the same numbers. The version line has moved.
   → `07-after-update.png`

**Fails if:** anything installs while a session is open, the app reopens on an
empty database, or the update applies without the person choosing it.

---

## 3. Restore, into a machine that is not the one that backed up

1. In the Sandbox with the app installed and set up, copy in a backup `.zip`
   taken from a real shop.
2. Settings → Restore a backup. Pick it. Type `RESTORE`.
3. The app restarts. Sign in.
4. The bill count matches the shop it came from. Check one bill against the
   original by number and total. → `08-restored.png`
5. **Raise a new bill on the restored data** and print it. This is the step
   people skip, and it is the one that catches a restore that left the document
   numbering pointing at a series that already has rows. → `09-bill-after-restore.pdf`
6. Settings → Backups: the safety copy taken before the restore is listed.

**Fails if:** the new bill collides with an existing number, the restore leaves
the till unable to sign in, or no safety copy was taken.

---

## 4. Power cut, mid-trade

The VM, not the Sandbox. This is the only check here that is about the disk.

1. Install and set up. Note the time.
2. Raise bills steadily — fifty of them, as fast as you can work the screen.
   Keep a count as you go, out loud or on paper. The number you are after is
   **the last bill whose save visibly completed**.
3. While a bill is saving, **hard power off the VM.** Not shutdown. The host's
   "power off" button.
4. Start it again. Open ShopOS.
5. It must open. Not to `CouldNotStart`, not to a repair prompt.
6. Every bill whose submit had returned is present. The one that was mid-save
   may be absent — that is correct, it was never committed — but it must be
   absent *cleanly*, not as a half-written row.
   → `10-after-power-cut.png`
7. Settings → Backups → "Check this backup" on the most recent one: it must
   pass. → `11-integrity.png`

**Fails if:** a bill that printed is missing, the database will not open, or
`integrity_check` reports anything but `ok`.

> This is the check that `PRAGMA synchronous = FULL` exists for. Before Phase 0
> the till ran on `NORMAL`, which lets a commit return before the write-ahead
> log has reached the platter — so the bills lost here would be ones that had
> already printed and already been paid for. If this step ever fails, look at
> the pragma first.

---

## What to write down at the end

One line per check in `docs/specs/evidence/layer3-<version>/result.md`:

```
version   0.1.1 · schema 28
machine   Windows 11 Home 26200, Sandbox + Hyper-V VM
1 install ok — SmartScreen: reputation warning, publisher named
2 update  ok — refused during an open session as designed
3 restore ok — 29 bills, new bill BFR/2627/00030, no collision
4 power   ok — 47 of 48 present, the mid-save one absent cleanly, integrity ok
```

A check that was not run says `not run` and why. It never says `ok`.
