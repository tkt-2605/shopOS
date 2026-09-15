# What the owner has to have ready

Everything in the phase specs that is not a coding task. Each row is something
Claude Code cannot do, that has a lead time, a cost, or needs a person with
identity documents. Ordered by when it blocks.

The rule this list exists to serve: none of these may become the reason a shop
cannot bill. Each row says what happens if it is missing, and in every case the
answer is "the counter keeps working".

## Start on day one — these have the longest lead times

| # | Item | Why now | Lead time / cost |
|---|---|---|---|
| 1 | **OV code-signing certificate** | Blocks the *signed* release in Phase 4, nothing before it. Without it, every install shows SmartScreen's "unknown publisher" and each shop needs a visit. | 1–3 weeks, ~₹10–25k/yr |
| 2 | **Updater keypair** (`tauri signer generate`) | Blocks the first release permanently: if the key is lost after tills are installed, those tills can never update again. | 1 hour |
| 3 | **`tools/pull-shop-db`** | Every phase's verification ends "against the owner's real shop database". There is no way to run those checks until there is a way to get a copy of that database. | half a day, code |

### 1 — the certificate, concretely

- **Type**: OV (organisation validation), not EV. EV needs a hardware token
  posted to a legal entity; OV with cloud key storage is signable from CI.
- **Issued to**: the proprietor by name, **unless** the firm holds Udyam or
  GST registration — then the firm, because the shop sees that name in
  Properties → Digital Signatures and a personal name there invites a call.
- **Documents to have scanned before starting**: government photo ID and
  address proof for individual validation; Udyam certificate and GST
  certificate for firm validation; a phone number the CA can verify against a
  public directory.
- **Key storage**: the CA's cloud signing service, so `release.yml` can call
  its CLI. Ask for this explicitly — the default offer is a USB token.
- **Decide before ordering**: which name goes on it. Changing it later means
  buying a new certificate.

### 2 — the updater key, concretely

- Generated once, never regenerated. The public half is committed in
  `tauri.conf.json`; the private half **never** enters the repository.
- Backed up to two places the owner controls — not one, and not a place that
  syncs to a machine that might be reinstalled.
- Also needed: the passphrase, stored separately from the key.

## Before the first outside install

| # | Item | Why |
|---|---|---|
| 4 | **GitHub repository and Actions** | CI runs on every push from Phase 4. A private repo is fine. |
| 5 | **GitHub secrets** | The CA's signing credentials and the updater private key. Only after rows 1 and 2. |
| 6 | **A Windows machine that can run Windows Sandbox** | Layer 3 of the test bench is a written procedure run by hand: install, update, restore, power cut. Windows 11 Home supports Sandbox; it needs enabling in Windows Features. |
| 7 | **A second PC or VM on the same Wi-Fi** | The two-till claims are asserted in the bench on one machine, but "the app still pairs over Wi-Fi" is a hand check that needs two real machines once per phase that touches sync. |
| 8 | **A shop willing to be the first install** | Not before the log file (Phase 3), the updater and the signed build (Phase 4) all exist. An unsigned build with no log file at a stranger's shop is a visit per bug. |

## Phase 5 — features

| # | Item | Why | Cost |
|---|---|---|---|
| 9 | **Noto Sans Tamil** | Embedded in the installer for Tamil PDFs. Licensed under the **OFL**, which permits embedding — the requirement is that the OFL text ships in the installer's licences folder. No purchase, no approval. | free |
| 10 | **A real Tamil bill to check against** | Shaping is the risk, not the font: a font that renders without shaping produces Tamil that is wrong in a way nobody reviewing it in English would notice. Someone who reads Tamil has to look at one printed receipt and one PDF. | a person, an hour |
| 11 | **A 2,000-row supplier CSV** | The import's dry run is verified against a hand count of a 20-row sample. A real file, not a generated one — generated files do not have the encoding and trailing-comma problems that real ones do. | — |

**WhatsApp in Phase 5 needs nothing.** The architect resolved this: Phase 5
ships the share path — it opens WhatsApp Desktop with the summary and the PDF
already saved for the user to attach. No Business API account, no approval, no
per-message cost. The API version is Phase 6 and is listed below.

## Phase 6 — cloud

These are only needed by shops on the cloud tier. A single-device shop never
touches any of them.

| # | Item | Why | Cost / lead time |
|---|---|---|---|
| 12 | **Turso account** | One database per shop. **Do not commit to this before the one-day spike** — the spike's three pass/fail criteria decide whether Turso is used at all, and if any fail the cloud peer becomes a plain SQLite file on a VPS with nothing else changing. | free tier for the spike |
| 13 | **A VPS** | Runs the portal and one cloud-peer process per active shop. Needed either way — it is the fallback if the spike fails. | ~₹500–1500/mo |
| 14 | **A domain and TLS certificate** | The cloud peer listens on HTTPS; tills pair with a URL, not an IP. | ~₹1000/yr |
| 15 | **Object storage** | The nightly dump of each shop database, 30 daily and 12 monthly. This is the backup; the Turso replica is not a backup. | usage-based |
| 16 | **Transactional email** | The downgrade path sends an email when the replica goes read-only and again 90 days later before deletion. Without it the deletion is silent, which the "nothing is degraded silently" rule forbids. | free tier |
| 17 | **WhatsApp Cloud API via a BSP** | Bill PDFs as utility template messages. **Start the paperwork the day Phase 6 starts** — Meta business verification plus template approval is the long pole. Needs: GST or Udyam certificate, a phone number **not** currently on consumer WhatsApp (this trips people up — the number is consumed), and a Meta Business account. | weeks; per-message cost |

## Decisions the owner has to make, not buy

| Decision | Where it bites | Default if undecided |
|---|---|---|
| The name on the certificate | Phase 4, before ordering | Proprietor's name |
| GitHub owner/repo name | Phase 4 — it is baked into the updater endpoint URL in `tauri.conf.json`, and changing it later strands installed tills | — |
| Price per tier | Phase 4's portal issues tokens against tiers; the tiers exist in code regardless | — |
| Which shop is the first install | Phase 4 sign-off | — |

## What is *not* on this list, deliberately

- **Nothing in Phase 0, the test bench, Phase 1, Phase 2 or Phase 3.** All of
  it is code and runs on the machine already in front of you. That is roughly
  the first 27 days of work with no external dependency at all — which is why
  rows 1 and 2 start on day one and then wait in the background.
- **A Google/OneDrive account for backups.** Already handled: the backup hook
  runs whatever command the shop types, against an account the shop already
  has. ShopOS never goes online for it.

## The one thing to do today

Order the certificate (row 1) and generate the updater key (row 2). Both are
pure waiting after the first hour, and both block a phase that is six weeks
out. Everything else on this list can be arranged when its phase arrives.
