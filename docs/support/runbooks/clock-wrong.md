# The machine's clock is wrong

**Symptom.** "Bills show yesterday's date." Or: "The licence dates look odd." Or: "Two tills disagree about which change came last."

**Confirm.**
- The Licence card shows *This machine's date looks wrong — it is set earlier than a date this till has already seen.*
- In the health report, `clock_skew_ms` in `sync.peers` is more than a few minutes, and `clockUnreliable` is true in `app.json`.

**Why it matters.**
- The business day comes from the machine's clock, so a wrong clock files bills against the wrong day.
- When the same record changes on two tills, the merge uses time as a tie-break.

**Fix.**
1. Have the shop set Windows' date, time and time zone (India Standard Time, UTC+05:30). Turn on Set time automatically.
2. A clock that falls back every time the PC is switched on is a dead CMOS battery. It is a cheap part, and fitting it is a job for the shop's hardware person.
3. Bills already made on the wrong date stand, because a submitted bill cannot change. For one bill of real importance, cancel it and bill again, if the books for that date are open.

**Escalate.** The clock is right, but the skew keeps being reported.
