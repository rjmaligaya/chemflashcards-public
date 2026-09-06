# LAB_HANDOFF.md — Running the ChemFlashcards study

The single front door for the lab to **run data collection** day to day. The web
app is built and live; this file explains what participants do, how to enrol them,
how the reminder emails work, what still gates launch, and where to look when
something breaks.

- **Study:** GREB File #6046199 · QCER Lab · Queen's University Department of Chemistry.
- **Live site:** [chemflashcards.com](https://chemflashcards.com) · **Live database:** Cloudflare D1 `ssp-study-02`.
- **Owner:** RJ (study coordinator). **Supervisor:** Dr. Bongers (AB). **Chemistry review:** Ebun Coker.
- **Authoritative design record:** `DESIGN_RATIONALE.md`. **Reminder internals:** `REMINDERS_SETUP.md`.
  **Why the design is what it is:** `DESIGN_RATIONALE.md`.

---

## 0. Status at a glance (2026-06-15)

- ✅ Web app (within-subjects v2) built and deployed at chemflashcards.com.
- ✅ Reminder system built and tested (Power Automate + OneDrive Excel + Outlook; per-participant
  send time, default 3 PM; Visit-2 nudge at +8).
- ✅ **Ethics: formally approved by GREB** (2026-06-15) — the metacognitive layer + Session-0
  rating are covered; cleared to recruit.
- 🔧 Before recruiting real participants: one live-copy fix (the forced-choice wording in the
  database) plus a final DEV walkthrough + pre-pilot — see §5.

---

## 1. What a participant does

**Recruitment + Visit 1 (in the lab)**
- Recruited, comes in, gives informed consent.
- Completes a **paper** demographic questionnaire (includes the baseline familiarity
  self-rating and one "name this molecule" item — this replaced the old in-app pre-test).
- Lab assigns their **ID** (e.g. `03-12345`) and records their chosen **Day-1 start date**.
- Both visits are booked via **Calendly** (Visit 1 now; Visit 2 about 11 days out).
- Lab adds their row to the participants Excel, which switches on the daily reminder emails.

**The hidden manipulation (automatic, never shown to the participant)**
- Every participant practises **both** molecule lists (`C-1` and `C-2`, 48 items each;
  96 total = 24 features × 4 examples).
- One list is studied **spaced** (a little each day, Days 1–4); the other **massed**
  (all in one sitting on Day 4). Which list is which is set automatically by the ID
  (see §4). The words "spaced" / "massed" never appear to the participant.

**Days 1–3 (at home, one short session per day)**
- Each day at their chosen time (default 3 PM): a reminder email with a one-click link (ID
  pre-filled, "Continue" to start).
- **Day 1 (Session 1):** a short **Foundations tutorial** for their spaced list (skeletal
  primer + 7 topic lessons, each with a "how easy to learn" rating), then **12 flashcards**.
- **Days 2 & 3 (Sessions 2 & 3):** 12 flashcards each, no tutorial.
- Each flashcard = a structure image + fill-in-the-blank name, **20-second timer**; they
  rate **confidence** after answering; wrong answers show a one-line naming-rule reminder;
  a **mastery loop** re-shows missed items until each is correct once.
- Before each session they **predict** their score; **no scores are shown back** (the
  no-feedback design). The next session only unlocks **~20–28 h** after the previous one.

**Day 4 (at home, the long day, ~45–60 min)**
- Spaced list **Session 4** (12 items), then a **hard 5-minute break** (Continue is greyed
  out until the timer hits zero), then the **massed list**: its own short Foundations
  tutorial, then all **48 items in four back-to-back blocks of 12**.
- Ends with a **forced-choice** prompt: which set will you remember better? (sets named by
  example molecules; schedule-neutral wording).

**~1 week later — Visit 2 (in the lab, eye-tracker)**
- About Day 11: the **delayed test — 36 items**, recorded with the **Tobii** eye-tracker.
- **The delayed test asks for a session password before it starts** (so a participant
  can't do it at home). The operator types the lab session password — **ask RJ / see the
  lab password store; it is not written in this repo.** A wrong or blank entry just
  re-prompts (no lockout), so a mistype is harmless — retype it. DEV PIDs skip the prompt.
- The forced-choice prompt again (now **after** the test), then a **debrief** screen
  (prediction-vs-actual, scores, and a plain explanation of the spacing effect).
- A separate recognition task at Visit 2 is run by **Ebun, outside the web app**. Study complete.

---

## 2. Enrolling a participant (so reminders fire)

Workbook **`ChemFlashcards_participants.xlsx`** in the lab's **Queen's (work) OneDrive**,
table **`Participants`**. (Flow internals are in `REMINDERS_SETUP.md`.)

1. **Open the shared OneDrive copy** (not a downloaded/personal copy — the flow reads
   that exact file).
2. Add a **new row inside the table** (click the last row, press Tab/↓). Never leave blank
   rows in the table.
3. Fill the columns:
   | Column | What to put | Watch out |
   |---|---|---|
   | `first_name` | Their first name | Used in the greeting |
   | `email` | Their email | Where reminders go |
   | `participant_id` | Exactly as on the assignment sheet, e.g. `03-12345` | **Text** (keeps the leading zero); copy it, never invent it — the first digit sets their condition |
   | `day1_date` | At-home start date as **`yyyy-mm-dd`** text, e.g. `2026-06-20` | **The #1 thing that breaks reminders.** Must be **Text**, not an Excel date, and not `06/20/2026` or `June 20` |
   | `reminder_time` | Whole hour to send (`09:00`, `15:00`…) from the dropdown | **Blank = 3 PM default.** Whole hours only |
   | `status` | `active` to start sending | Anything else (`hold`, `withdrawn`, `example`) = skipped |
   | `visit2_date`, `RI_days` | *(leave blank, auto-calculated)* | Yellow `visit2_date` = a 6- or 8-day retention interval, not 7 |
4. **Set `status = active` only after `day1_date` is filled** (a blank date errors that row).
5. **Save.** The flow sends each email at the participant's reminder time (default 3 PM): Day 1
   on the start date, Days 2–4 the next three days, and a Visit-2 nudge a couple of days before
   the visit.

**The only ways it silently breaks:** `day1_date` / `participant_id` stored as a number or
real date instead of **Text**; a date not in `yyyy-mm-dd`; a blank row in the table; or
editing a personal copy instead of the shared file.

---

## 3. Running the reminders day to day

- **Enrol:** add the row at Visit 1; set `status = active` once `day1_date` is filled.
- **Pause / withdraw:** set `status` to anything but `active` (reminders stop; data untouched).
- **Safeguards:** keep the flow **On**; name a **backup operator**; do a **weekly check**
  that reminders fired (Power Automate run history). A run that errors emails the flow owner.
- **Test anytime:** Test → Run manually with a test row dated relative to today, and set its
  `reminder_time` to the current whole hour so it isn't filtered out (`REMINDERS_SETUP.md` §4).

---

## 4. IDs and conditions (do not improvise these)

- ID format `<digits>-<suffix>`, e.g. `03-12345`. **Copy from the assignment sheet; never invent.**
- Condition is set by the **last digit of the numeric prefix**: **odd → option 1, even →
  option 2**. This counterbalances which molecule list is spaced vs massed. No manual config.
- **DEV IDs** look like `<digits>-DEV…` (e.g. `01-DEV0`, `02-DEV7`). They bypass the time
  gates and the format check and are flagged `dev_mode = 1` (filtered from analysis). Use
  **only DEV IDs** for testing — never let a DEV run be treated as real data, and never
  give a participant a DEV ID.

---

## 5. Before recruiting real participants (go-live checklist)

**Ethics — formally approved by GREB (2026-06-15):**
- [x] Metacognitive layer + Session-0 "easy to learn" rating covered by AB's final amendment.
- [x] App↔ethics gaps resolved with AB (the `48h`-vs-`24h` prose, ID format, the recognition
      task being Ebun's/outside the app, and the LOI "drawing tasks" wording). RJ holds the
      authoritative ethics paperwork.

**Live-copy fix:**
- [ ] Run the two `UPDATE copy_strings_v2` commands on live D1 so the reworded, de-biased
      forced-choice prompts actually show (the code is deployed, but the database rows still
      hold the old wording). Also the "about a week" debrief copy. **Order matters** — the
      token-injecting widget must be live before the tokenised copy.
      (2026-06-09 "later" block).

**Content sign-offs:**
- [ ] **AB:** final forced-choice wording; the 4 debrief paragraphs; `features-v2.js` (24
      naming-rule reminders); Session-0 lessons + ease-rating wording; carbonyl / generic SVG style.
- [ ] **Ebun:** molecule-fix list; eyeball the redrawn aldehydes/generics; confirm the
      recognition task runs outside the app.

**Final verification:**
- [ ] Full **DEV walkthrough on the live site** (gates bypassed): Session 0 renders and
      ratings save; the forced-choice fires **after** the delayed test; the debrief shows
      real numbers; **no "spaced/massed" condition words leak** anywhere.
- [ ] **Pre-pilot timing test** with 3–5 naive people (≈6–8 min/spaced session; Day-4 ≈45–60 min).
- [ ] **Reminder go-live:** flow On; backup operator named; weekly fired-check; delete the
      EXAMPLE/test rows from the live workbook. (Visit-2 nudge is now +8; nominal start+10 vs
      +11 still open — affects only what participants are told.)

> After **any** deploy / push to `master`: **purge the Cloudflare cache** (dashboard →
> chemflashcards.com → Caching → Purge Everything) or changes will not show.

---

## 6. Data and troubleshooting quick reference

- **Monitor progress / export:** `admin.html` on the live site (gated by the `EXPORT_TOKEN`
  secret) — roster, per-participant status, CSV export, and the tester "Edit requests" panel.
- **Query the live DB** (read-only is safest):
  `wrangler d1 execute ssp-study-02 --remote --command "SELECT … "`.
- **Data-integrity rule:** never edit or delete participant rows (`trials_v2`, `sessions_v2`,
  R2 CSV backups) except as a deliberate, reviewed action. No autonomous cleanup.
- **Manual session unlock / schedule fix / any D1 write:** the data model is in
  `db/schema_v2.sql`; do these with RJ. Sessions advance by completion (the next opens ~20–28 h
  after the previous; the delayed test ~1 week after Day 4). DEV IDs are always unlocked.
- **Team test feedback:** the tester hub `chemflashcards.com/test-hub.html` mints DEV IDs;
  notes land in `admin.html` → "Edit requests" (an isolated table that never touches study data).

---

## 7. Where everything lives

| File / folder | What it is |
|---|---|
| `README.md` | Architecture overview. Describes the live within-subjects v2 design. |
| `DESIGN_RATIONALE.md` | Dated design + decision log (authoritative). |
| `instructions/REMINDERS_SETUP.md` | The Power Automate reminder build, click by click, plus the five email bodies. |
| `instructions/ADDING_PARTICIPANTS.md` | Short, plain-language guide for enrolling a participant in the reminder Excel. |
| `instructions/deploy.md` | Deploy steps, schema migrations, test commands. |
| `db/` | The live data model: `schema_v2.sql` + the `*_migration.sql` files (and the frozen v1 `schema.sql`). |
| `docs/` | Archived design, audit, and review notes (code audit, stimulus/SVG audit, v2 design plan, etc.). Reference only; not needed to run the site. |
| `DESIGN_RATIONALE.md` | Why each design choice was made, and what was rejected. |
| `C:\Users\RJ\Desktop\chemflashcards_archive_2026-06-15\` | Local archive of retired material moved out of git: `v1_backup/`, `v2_svg_backup_2026-06-01/`, the `tools/svg-gen/` generator, and the finalized ethics drafts (`ETHICS_RECONCILIATION.md`, `AMENDMENT_DRAFT.md`). |
