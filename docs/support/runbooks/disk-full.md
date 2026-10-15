# The disk is full

**Symptom.** "Bills won't save." Or: "There's an error when I press Pay." Or: "The till is very slow."

**Confirm.**
- The error at Pay mentions a full disk, or `database or disk is full`, or an I/O error.
- On the PC, check This PC → the drive ShopOS is on (usually C:).
- In the health report, `database.page_count × page_size` gives the database size. It is rarely the cause by itself.

**Fix.** This is a P1, because the counter cannot take money.
1. Nothing was half-saved. A bill that failed rolled back whole, so the cashier can bill again once there is room.
2. Free space at once: empty the Recycle Bin, then Windows' Disk Clean-up (including Windows Update files), then the Downloads folder.
3. Look for what filled it. On a shop PC it is usually videos and WhatsApp media, or old backups if the backup folder is on C: and never pruned.
4. Older ShopOS backups in the backup folder can go, but keep the newest few.
5. Let another counter bill meanwhile.

**Prevent.** Point backups at another drive or a cloud folder (Settings → Backups). Keep 5 GB free. Later, the health report will warn when the free space falls under that.

**Escalate.** If ShopOS itself is what grew (logs are capped at 5 MB), send the diagnostics report.
