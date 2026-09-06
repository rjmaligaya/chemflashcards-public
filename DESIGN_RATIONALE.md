# Design rationale

Why ChemFlashcards is built the way it is. Each entry records what was decided,
the reason, and where relevant what was rejected. Dates are the date of the
decision.

This replaces the running decision log that was kept during development. It is
the reference to read before changing anything that touches the study design,
the data model, or the schedule logic.


## 1. Study design

### 1.1 The core design (2026-05-19)

**Decided:** within-subjects. Every participant practises both matched 48-item lists
(`C-1`, `C-2`; 96 items = 24 features × 4 instances). One list spaced (one session/day ×
4 days), the other massed (4 blocks in one sitting on Day 4).

**Why:**
1. Within-subjects controls individual ability and motivation, and is the modal design in
   the spaced-retrieval STEM literature (Rawson et al., 2024).
2. Latin-square assignment of features to target sets plus counterbalanced list→schedule
   assignment neutralises item difficulty as a confound.
3. Q-full (free production of the full IUPAC name) is the test format most sensitive to
   retrieval-practice benefits (Barenberg & Roelle, 2021).

**Rejected:**
- Reusing v1's 80-item / 20-skill structure — less work, but does not map onto the
  24-feature × 4-instance × 2-group structure.
- A 2-day inter-study interval — better aligned with Cepeda's optimum for very long
  retention intervals, but more logistically demanding; 1-day was already in the
  optimal-gap band.
- (v1, superseded) Removing the immediate posttest — see 1.6.

### 1.2 Stimuli and item structure (2026-05-19; revised 2026-05-30)

- 24 features split into two parallel sets of 12. **C-1**: al, amide, ene, eth, fluoro,
  hex, iodo, ol, pent, prop, pyridine, pyrrole. **C-2**: benzene, bromo, but, chloro, iso,
  methyl, oate, oct, one, tert, toluene, **hept**.
- Within each session the 12 features are partitioned into 4 "target sets" of 3,
  Latin-square counterbalanced across sessions so each feature visits each set position
  once.
- `public/items_v2.csv` is the single source of truth for practice items;
  `public/delayed_posttest_v2.csv` for the delayed test.

**2026-05-30 — `sec` → `hept` swap.** A new stimulus spreadsheet dropped the `sec`
(sec-butyl) feature from C-2 and added `hept` (heptane root). C-1 unchanged. Four `sec`
rows became four `hept` rows in the same target-set slots. Still 96 items, 48/48. The
delayed test was rebuilt around the new picks, and `features-v2.js` swapped its `sec`
entry for `hept`. Four `sec-butyl_*` SVGs became orphans.

### 1.3 Counterbalancing and participant IDs (2026-05-19, resolved round 3)

**Decided:** the counterbalance option is derived from the **parity of the last digit of
the numeric prefix before the hyphen**. Odd → Option 1 (C-1 spaced / C-2 massed). Even →
Option 2 (C-2 spaced / C-1 massed). ID format `<digits>-<suffix>`, e.g. `03-12345`.

**Why:** IDs are issued on a lab slip at the in-person sign-up, so the condition rides
along with the ID and needs no manual configuration or separate assignment sheet.

**Rejected:** the earlier `WS1-NNNN` / `WS2-NNNN` prefix scheme (round 1); random
assignment at signup; sequential alternation. Also rejected the LOI's `P01000` format —
the app regex `^(\d{1,4})-([A-Za-z0-9]{1,8})$` rejects it, and the recommendation was to
fix the documents rather than the app (2026-06-09).

**DEV IDs** (`<digits>-DEV<digits>`, e.g. `01-DEV0`): bypass the ID-format check and the
time gates, flagged `dev_mode = 1`, excluded from analysis. DEV prefixes are chosen so the
parity lands in the desired option.

### 1.4 Schedule and session gating (2026-05-19; redesigned 2026-05-31; relaxed 2026-07-02)

**2026-05-19 (original):** fixed calendar days — Days 1–3 one spaced session each, Day 4
the composite, Day 14 the delayed test.

**2026-05-31 — replaced calendar days with ISI (inter-session interval) windows.**
A session unlocks a fixed number of hours after the *previous* session's `completed_at`,
not at a fixed day since enrollment. `MIN_ISI_HOURS = 20`, `MAX_ISI_HOURS = 28`.
Before 20 h: hard block. Past 28 h: allowed but flagged `offSchedule`. Session 1 has no
time gate.

**Why:** the original gate opened the delayed test on exactly one calendar day while the
approved window was a range, and day-to-day practice needed to tolerate a participant
starting at a different hour each day.

**2026-05-31 — the delayed test opens relative to Session 4's actual completion**, not a
calendar day. `DELAYED_MIN_HOURS = 6 × 24`, open-ended after that; the lab books the visit
at ~1 week.

**Why the floor is 6 days and not 7** (2026-05-31): the floor is a backstop that must sit
*below* the operational 7-day booking. At exactly 7 days (168 h) a participant whose Day 4
finished at 8 pm and whose lab slot is 9 am seven days later would be at 167 h and locked
out of their own booked appointment. The real interval is set by the booking, not the code.

**2026-07-02 — timing gates made advisory (triggered by the P6 incident).**
- The **20 h lower bound still hard-blocks** — a participant must not be able to cram
  "spaced" sessions early, which would defeat the manipulation.
- A gap **beyond the 28 h upper edge is allowed through and flagged**, never blocked. A
  missed day must never lock anyone out; the true interval is recovered post-hoc from the
  stored `completed_at` timestamps.
- **Sequence prerequisites stay** for practice steps (no S3 before S2). That is sequence
  integrity, not timing.
- **The in-lab delayed test is exempt from the prerequisite** (`prereqBlocking: false`): a
  missing `massed-B4` no longer blocks it, so lab staff can run Visit 2 for a
  half-completer.

**Rejected (2026-07-02):** making the lower bound advisory too — explicitly rejected, it
would let a participant cram the spaced condition.

### 1.5 Retention interval (2026-05-19 → 2026-05-30 → 2026-05-31)

Moved from **Day 4 + 10 days** (2026-05-19, confirmed with AB) to **about one week /
Day 4 + 7** (2026-05-30), to match the consent form's "about one week" wording. Finalised
by RJ 2026-05-31. The older 10-day entries are left in the log as historical record.

### 1.6 Immediate posttest — added then removed

**2026-05-19 added:** a 12-item immediate posttest on Day 4, non-overlapping with the 36
delayed items at the `item_id` level, to give the classic massed-wins-immediately /
spaced-wins-at-delay crossover.

**2026-05-30 REMOVED.** AB's new schedule and protocol describe Day 4 as the four massed
blocks only. `immediate_posttest_v2.csv` deleted; the Day-4 composite dropped from 6 to 5
sub-sessions; `"immediate"` removed from the worker's valid phases and session labels.

**Kept deliberately:** the forced-choice checkpoint key `day_4_immediate` is retained as
the historical Day-4 identifier. Renaming it would require a live-DB CHECK-constraint
migration for cosmetic gain. Schema CHECK constraints were also left permissive
(`phase` still allows `'immediate'`) since the worker now rejects it and no rows can be
written.

### 1.7 Day 4 structure (2026-05-19)

Spaced Session 4 first (12 items), then a **hard 5-minute break**, then the massed list:
its own tutorial, then 48 items in four back-to-back blocks of 12. **Massed block order is
fixed 1→2→3→4** — within-block items are already Latin-square counterbalanced across
participants via target-set assignment, so randomising block order would add variance
without isolating anything. Inter-block transition screens carry no enforced delay.

### 1.8 Day 4 resumability (2026-05-22 → reversed 2026-07-02)

**2026-05-22 (original):** strict block. If any Day-4 sub-session was already recorded, the
whole composite refused re-entry. Rejected at the time: an orchestrator skip-resume — "more
code, more edge cases, and Day-4 completion in one sitting is the design."

**2026-07-02 (reversed):** **Day 4 is resumable.** On entry it fetches which sub-sessions
are saved and resumes at the first unfinished one. The only hard stop is "already fully
finished" (`massed-B4` present). On resume it shows a welcome-back screen and skips the
spaced session and the timed break.

**Why the reversal:** P6 finished the spaced session, hit the 5-minute break, walked away
~30 minutes, and the browser tab was discarded. Day 4 held all mid-composite progress in
memory only, so the all-or-nothing gate locked them out of their own massed condition.

### 1.9 In-lab password gate on the delayed test (2026-07-02)

**Decided:** the delayed test requires a **session password** typed by lab staff before it
starts, verified server-side against the Worker secret `LAB_SESSION_PASSWORD`. DEV PIDs
skip it. The four at-home practice sessions are not password-gated.

**Why:** making the delayed gate advisory (1.4) meant a participant who finished Day 4
could otherwise self-start the criterion test at home, with no eye-tracker and no
supervision.

**Failure behaviour, deliberate:** a wrong or empty password, a missing secret
(fail-closed, HTTP 500), or a network error all simply re-prompt. No lockout, nothing
recorded, unlimited retries — a mistyped password must be harmless.

### 1.10 Participant blinding (2026-05-27)

**Decided:** scrub "spaced" and "massed" from every participant-visible string. Session
titles became "Practice session N" / "Practice block N of 4"; the neutral summary card
dropped its `Section: spaced-S1` line; landing descriptions and HTML `<title>` tags were
rewritten.

**Why:** the forced-choice copy was carefully written in temporal terms only so a
participant could not self-classify, but the rest of the UI still used the condition names
and the literal `session_label` values. A participant who reads the page could join those
dots back to their assignment.

**Not changed, deliberately:** code-internal usages — variable names, enum values, the
`spaced-S1` DB session labels, comments, phase identifiers. Internal architecture stays
readable for maintainers; only the participant-visible surface is scrubbed.

### 1.11 The metacognitive layer (2026-05-26; revised 2026-05-27, 2026-06-08, 2026-06-09)

**Decided (2026-05-26):** add four participant-facing measures plus a no-feedback rule
before the first real participant runs.

1. **Pre-session prediction** — "of today's 12, how many will you get right on the first
   try?", integer 0..12, no default, before the first item of every spaced session and
   every massed block.
2. **Per-item confidence** — Guess / Unsure / Fairly sure / Certain (1..4), fired *after*
   the participant submits but *before* correctness is revealed. Confidence-before-feedback
   is the primary design, not a fallback.
3. **Post-session postdiction** — *removed 2026-05-27, see below.*
4. **Forced choice at Day 4 and at the delayed visit** — "which set will you / did you
   remember better?", Set A / Set B / About-the-same plus a 3-level confidence. **Set A is
   always the spaced group, Set B always the massed group**, regardless of whether the
   underlying list is C-1 or C-2.

Plus a **no-feedback rule** for the whole study window: practice-session summaries and the
Day-4 total-trial line are hidden. Per-item correct/incorrect feedback and the position-only
"X of 12" progress bar are unchanged. The rule lifts after the delayed test, unlocking a
debrief screen.

**Rejected:** stricter "items-seen only" progress bar — the position counter is not framed
as accuracy, and the inference a participant could draw is minor relative to restyling the
trial UI. Also rejected: descriptive set labels ("the set you practised across days") in
favour of concise A/B letters; bumping the namespace to v3 (the changes are additive and
v2 had no real data; a `v2-pre-metacog` tag preserves the rollback point).

**2026-05-27 — postdiction dropped entirely.** Per-item feedback during practice already
tells the participant how each answer went, so an end-of-session "how many did I get
right?" estimate is trivially answerable rather than a meaningful metacognitive judgment.
The per-trial feedback is non-negotiable (it is the retrieval-practice design), so the
postdiction cannot be made informative without breaking the practice mechanism.
Reaffirmed 2026-07-22: *rejected* restoring it mid-collection (would create a two-cohort
instrument and likely need a GREB amendment).

**2026-05-27 — confidence prompt: no auto-focus, no keyboard activation.** The Enter that
submitted the answer was carrying over to the auto-focused first button ("Guess"),
recording trials as guesses regardless of intent. Trade-off accepted: keyboard-only users
cannot activate the confidence buttons, because accidental commits are the worse failure
mode for this specific control.

**2026-05-31 — digit keys 1..4 added, deliberately narrow.** This does *not* reverse the
above: the buttons keep `tabindex=-1`, are not auto-focused, and Enter/Space stay blocked.
Only digits 1..4 commit, they arm ~250 ms after the prompt appears, and key auto-repeat is
ignored — so a keystroke still in flight from typing the answer cannot land on a rating.

**2026-06-09 — forced choice kept but de-biased.** AB flagged that the forced choice could
bias the participant and asked to remove it. RJ chose to keep it (it carries the
illusion-of-fluency result) with two changes:
1. **Moved the delayed-visit instance to *after* the delayed test.** Asking which set is
   better immediately before the criterion test risked priming performance on it. The Day-4
   prospective instance stays (a full week ahead, so it cannot contaminate).
2. **Reworded both prompts to drop the schedule contrast.** The old wording recited "Set A
   once a day for four days / Set B four times in one sitting," which cued the hypothesis.
   Each set is now identified by **two example molecule names**, injected per participant
   via `{set_a_examples}` / `{set_b_examples}`.

**Why example-based identification:** removing the schedule wording removes the only handle
the participant had on which set is which. Any time-based handle ("the set you did all
week") *is* the schedule contrast in softer form. Content is the only neutral identifier
left. Examples are picked deterministically (first two distinct names per group from
`items_v2.csv`) so Day 4 and the delayed visit show the same names.

**Rejected:** deleting the forced choice (AB's first suggestion) — would lose the measure;
a neutral *temporal* identifier — still the schedule contrast; dropping the delayed-visit
instance — moving it post-test keeps the data point with zero contamination.

### 1.12 Session 0 / foundations tutorial (2026-05-31; revised 2026-06-08)

**Decided:** two schedule-tied tutorials, **folded into existing pages rather than a
separate gated session**. The spaced list's tutorial runs at the top of Session 1; the
massed list's runs on Day 4 after the break, before the massed blocks. Each covers its
list's topics and ends with ratings.

**Why folded, not separate:** a separate session would need a new `session_label`, phase
CHECK migrations, and routing plus gate changes. Folding avoids all of it; the ratings
table is the data record.

**Flow is linear and forward-only** (unlike the `/demo` clickable TOC) — a baseline
instrument must not let participants skip past the ratings.

**2026-06-08 — the rating construct changed.** The pre-lessons block of 12 per-molecule
*familiarity* ratings was replaced by **one "was the name for [family] easy to learn?"
rating after each topic lesson**, on a 1..7 scale re-anchored "Very hard to learn" .. "Very
easy to learn". Stored in the same `familiarity_ratings_v2` table with `item_id` = the
topic id; no schema change.

**Noted explicitly as a construct change** — pre-instruction familiarity became
post-instruction ease-of-learning (a judgment of learning). Coherent because the paper
questionnaire's Q9 now covers baseline familiarity. Flagged as awaiting AB.

**Also 2026-06-08:** the "methyl" tutorial was split onto its own card (C-2 now has 8 topic
cards, C-1 has 7; no code depends on a fixed count), and cards whose names use a position
number now show **two examples differing only in the number**.

### 1.13 Pre-test removed (2026-06-08)

**Decided:** unlink the in-app 24-item pre-test from the participant flow, but **keep the
files** so it is easily restored. The pre-test entry in `SESSION_FLOW` is commented out;
`pretest.html` / `pretest-page.js` are untouched and the worker's `pretest` validation is
left intact so the page still works for DEV inspection.

**Why:** AB's approved amendment removed the baseline test from Visit 1, folding its
purpose into a new paper demographic questionnaire (Q9 self-rated IUPAC familiarity + Q10
one "name this molecule" item).

**Rejected:** full file deletion plus routing and worker cleanup — deferred; reversible
disable first.

### 1.14 Mastery loop and timeout

- Wrong answers show the correct answer plus a one-line naming-rule reminder (carried over
  from v1 at AB's request).
- A mastery loop re-shows missed items until each is correct once, with a soft cap of 5
  attempts (`MAX_RETRIES`).
- 20-second per-trial timer. A correct answer typed but not submitted before the timer
  expires **is scored correct** — on timeout, `submit()` reads the input box and calls
  `scoreAnswer`; only the confidence rating is skipped.

### 1.15 Eye-tracking (2026-05-19; confirmed 2026-05-31)

**Decided:** external **Tobii** tracker only, on the in-app delayed test. No in-browser
eye-tracking. **No app code change** — the app already stamps `stim_on_ts` / `stim_off_ts`
on every delayed trial for offline gaze alignment. The Tobii pipeline is self-contained;
no merge of Tobii data with the behavioural CSV is performed in this repo.

**Rejected:** in-browser gaze estimation (WebGazer-class) — lower fidelity, unnecessary
once the delayed test is in-lab.

### 1.16 Visit-2 recognition task (2026-06-09)

**Resolved:** the 40-item recognition task named in the protocol is run **outside the web
app** by the eye-tracking collaborator. The app's 36-item delayed test stands. There is no
recognition task anywhere in `public/`.

---

## 2. Data model and data integrity

### 2.1 Database strategy

A fresh D1 instance **`ssp-study-02`** for v2, rather than migrating `ssp-study-01` in
place with a `study_version` flag. `db/schema.sql` is kept frozen as the v1 schema for
read-only access to v1 data.

### 2.2 Confidence lives on `trials_v2`, not a sidecar table (2026-05-26)

**Decided:** `trials_v2.confidence` as a nullable INTEGER (1..4).

**Why:** it is 1:1 with a trial row, so a single CSV row carries both the answer and the
confidence in it, with no join.

**Rejected:** its own sidecar table — would give schema symmetry with the other measures
but force a join every time the analysis wants confidence per trial.

### 2.3 Long-format metacog tables + natural idempotency (2026-05-26)

`pre_session_predictions_v2`, `forced_choices_v2` (and originally
`post_session_postdictions_v2`, dropped 2026-05-27), plus `familiarity_ratings_v2` (added
2026-05-31). All keyed with a UNIQUE constraint — `(participant_id, session_label)`,
`(participant_id, checkpoint)`, `(participant_id, item_id)` — so the worker can use
`INSERT OR IGNORE` and get idempotency for free. `session_label` carries the Day-4 block
distinction (`massed-B1`…`massed-B4`); no separate `block_id` column is needed.

For familiarity ratings specifically, `INSERT OR IGNORE` means **a refresh never overwrites
the first value**, which is what makes it a baseline.

### 2.4 Editable participant-facing copy (2026-05-26)

**Decided:** a `copy_strings_v2` key/value table holding all participant-facing prompts,
labels, CTAs, and debrief paragraphs. Seeded with `INSERT OR IGNORE` so re-running a
migration never overwrites an admin edit. Read by the frontend via unauthenticated
`GET /api/v2/copy`; written via `POST /api/v2/copy` behind the `EXPORT_TOKEN` bearer, which
returns 404 `unknown_key` on a typo so admin mistakes cannot create orphan strings.

**Why:** wording can be changed without a redeploy. Explicitly built so the copy can be
edited by the supervisor or her future students after the original developer leaves.

**Rejected:** a JSON file in `public/` — would require a redeploy on every wording change,
defeating the whole point.

### 2.5 Tester feedback is structurally isolated (2026-06-01)

**Decided:** a separate `edit_requests_v2` table, **append-only**, with **no foreign key**
to `participants_v2`, that nothing reads into any analysis path. `POST /api/v2/feedback` is
open but **server-side rejects any non-DEV pid**, so the table only ever holds test traffic.
The read and resolve endpoints are `EXPORT_TOKEN`-gated.

**Why:** tester feedback must never be able to mix into or corrupt participant data. No
foreign key, because a feedback insert must never be blocked by enrollment state.

**Rejected, hard:** storing feedback in the study tables or any analysis view.

### 2.6 The DEV answer hook (2026-06-01)

`practice-engine.js` exposes `window.__cfcCurrentAnswer` at trial start **only if**
`window.__cfcTesterActive` is set, which only happens under a DEV id. For a real
participant the flag is never set, so the line is a no-op and the answer is never exposed —
zero change to how answers, correctness, `rt_ms`, or `review_ms` are captured.

**Rejected:** a full auto-run to session end — one click per item was chosen so each screen
is actually seen.

### 2.7 Orphan-session recovery and enrollment gating (2026-05-23 audit)

- **C1:** `saveSessionToD1` used `INSERT OR IGNORE` then short-circuited on
  `already_saved`. If the session row inserted but the trial batch then failed, the retry
  would skip the trial insert and the session would be permanently orphaned — counted
  complete by `/api/v2/status` with zero trials. Fixed by counting trials before declaring
  `already_saved`.
- **C2:** unenrolled PIDs could write orphan rows. Fixed with an enrollment check.
- **IMP-3 accepted, not fixed:** DEV PIDs work in production. Accepted with the documented
  mitigation that they are flagged and filterable in analysis.

### 2.8 The P6 incident — how a data problem was handled (2026-07-02)

P6 completed spaced S1–S4 but no massed blocks and arrived for Visit 2 blocked.

**Decided:** let them do the delayed test, flagged as a half-completer, by **temporarily
setting `participants_v2.dev_mode = 1`**, running the test, then setting it back to 0.
`dev_mode` lives only on `participants_v2` and is not stamped on trial or session rows, so
the delayed data is captured as a normal real participant. **Their missing massed practice
is left genuinely missing — that is the true state.**

**Rejected:**
- Fabricating a `massed-B4` row to satisfy the gate — data fabrication.
- Deleting the `spaced-S4` row so they could re-run Day 4 — destructive, and
  scientifically wrong: massed practice a week late is not the massed condition.

This is the reference precedent for handling a data-integrity incident in this study.

### 2.9 De-identified shareable export (2026-07-22)

**Decided:** all results work outside the study team uses a de-identified copy produced by
`analysis/make_shareable_export.py`, never the raw export. The tool:
1. renames participants to `R01..Rn` in a **fresh random order on every run**, so two
   shareable exports cannot be linked to each other, writing the real mapping to a local
   `..._PID_MAPPING_DO_NOT_SHARE.csv`;
2. **date-shifts** every timestamp so each participant's timeline starts at a synthetic
   2000-01-01 epoch — ISI gaps, retention intervals, recency, and trial order survive
   exactly, while calendar dates, time-of-day (which mirrors the per-person reminder hour),
   and enrolment order are destroyed;
3. renumbers `session_id` / `trial_id` (global counters leak collection order) and drops
   `participant_tz`.

**Why, with evidence:** blanking PIDs alone was demonstrated insufficient the same day —
all nine participants were reconstructible from `enrollment_date` + `option_id` in an
ID-removed export.

**Rejected:** stable pseudonyms across exports — weaker privacy; can be added later via a
salt file if longitudinal tracking is ever needed.

### 2.10 Pre-launch database reset (2026-06-15)

Before recruiting, every participant-keyed table in live `ssp-study-02` was emptied to
remove pre-launch test data; `copy_strings_v2` was left intact. Verified all six tables at
COUNT = 0. R2 test backups under the `sessions_v2/` prefix cleared. No real participants
had started, so no study data was destroyed.

---

## 3. Frontend

### 3.1 Vanilla JS, no framework, ES modules

A single-page app of plain ES modules under `public/`. HTML entry points are thin loaders
that import a page module which calls `practice-engine.startSession({...})`.
`practice-engine.js` is the single owner of the trial UI; no page reaches into the trial
DOM directly.

### 3.2 Session-entry gate (2026-05-22)

**Decided:** `public/session-gate.js`, a pre-flight check every session page runs before
starting the trial loop. It hits `/api/v2/status` and blocks entry if the session is out of
sequence, already completed, or the PID is not enrolled.

**Why:** URL manipulation used to land straight on the trial loop and POST data — a
participant could finish a session on the wrong day and corrupt the spacing pattern in the
analysis. Server-side defence already existed via the UNIQUE constraint and the enrollment
check; the gate stops participants at the entry screen rather than after they have spent
time on trials.

Explicitly framed as **client-side UX layered over server-side defence-in-depth**, not as
the security boundary.

### 3.3 Transient-failure retry on the status read (2026-07-03)

**Decided:** `fetchStatusWithRetry` — 4 attempts, linear 1 s/2 s/3 s backoff, retrying
**only** on a network error or 5xx. A 4xx/404 is returned immediately and never retried.

**Why:** live sessions intermittently 500'd. Diagnosis showed a **Cloudflare D1 cold-start
transient** (`Internal error while starting up D1 DB storage caused object to be reset`) —
not application code. Endpoints not touching the v2 DB stayed at 200. Measured 1 failure in
5 cold, then 0 in 20 once warm. The write paths already retried 3×, so no saved data was
ever at risk; only the read/gate path was exposed.

**Deferred:** a keep-warm cron. The retry covers the participant-facing impact.

### 3.4 Stimulus rendering — three fixes, each superseding the last

This chain matters because the final answer looks arbitrary without it.

1. **2026-07-02 — window-height cap.** The image frame was capped only by width, so on a
   short lab desktop the card exceeded the viewport and the Submit button fell below the
   fold. Added a `dvh`-based height cap. Reserve set to 360 px.
2. **2026-07-03 — reserve retuned 360 → 500 px.** The *measured* overhead of the delayed
   card is ~483 px, not 360, so on a ~650 px window the image never shrank. Also documented
   the iframe caveat: inside an `<iframe>`, `100dvh` is the iframe's height, not the visible
   screen, so if Tobii embeds the page in a frame taller than the visible area **no reserve
   value can fix it** — the fix there is operational (run full-screen).
3. **2026-07-03 (later) — `aspect-ratio` removed in favour of an explicit height.** Tobii's
   embedded browser is an older Chromium/CEF build without `aspect-ratio` (Chromium 88+).
   Without it the box had no defined height, so a portrait molecule sized to the box width
   and overflowed. `object-fit` was a red herring: an SVG with a `viewBox` stays contained
   even under `object-fit: fill`, because its own `preserveAspectRatio` handles it. The
   missing box **height** was the cause.
4. **2026-07-03 (later still) — stimulus switched to a CSS `background-image` with
   `background-size: contain`.** Tobii's browser honoured neither `aspect-ratio` nor a
   reliable `object-fit` on SVG-in-`<img>`. `background-size: contain` is supported by far
   older engines (Chromium 4+ / IE9+), contains the SVG in both orientations, and scales the
   small source SVGs up to fill the frame.

**Stimulus timing is unaffected throughout:** `stim_on_ts` is a `new Date()` taken when the
trial starts, never tied to image load. The old `.trial-img` rule is kept for the Session-0
widgets, which run at home in a modern browser.

### 3.5 Reminder-email link auto-loads the PID (2026-05-31)

**Decided:** the landing page reads `?pid=` from the URL, fills the ID field (overriding any
cached value), and automatically runs the enrollment and routing check, stopping at a
"Continue" button.

**Safety:** auto-run fires **only for a URL-supplied PID, never a cached one**, so a
returning visitor on a shared lab browser is not auto-enrolled under someone else's
leftover ID. The enroll call is idempotent. The auto-check stops at the button; it does not
start the session loop.

**Rejected:** pre-fill only (still needs a manual click); a fully automatic redirect into
the session (removes the human checkpoint before a session starts — rejected for a live
research instrument).

### 3.6 Structure SVGs regenerated to one style (2026-06-01)

**Decided:** regenerate all 71 unique structure SVGs from scratch with a small Node
generator in a ChemDraw-matched style, replacing the 17 existing 0.0667-scale files and
filling the 54 gaps. Plain and numbered variants for everything except molecules where
numbering is meaningless (benzene, toluene, the halobenzenes, pyridine, pyrrole, the
cycloalkanes, the iso/tert-butyl compounds, methyl methanoate).

**Rejected:** keeping the 17 existing files — mixing two bond sizes in a within-subjects
instrument; reproducing ChemDraw's markup byte-for-byte — unnecessary, matching the
rendered appearance is enough.

**Noted for item review:** `3-methylbutane` is kept as named even though IUPAC would be
2-methylbutane, because the methyl is shown at C3 to match the stimulus. Participants are
not taught numbering rules, so the non-standard name is acceptable in the stimulus.

### 3.7 Carbon-numbering button on wrong-answer feedback (2026-06-01)

A "Show numbering of carbons" button appears only after a wrong answer and only when a
numbered variant exists. It swaps the displayed image source and nothing else — it does not
touch the recorded trial or how `review_ms` is measured.

**Flagged as a measurement consequence:** participants who use it linger longer on the
feedback screen, so `review_ms` on wrong trials legitimately includes that voluntary extra
review time. Intended, but it must be known when interpreting `review_ms`.

### 3.8 Design system (2026-05-23)

A warm academic palette (cream/almond/matcha/eclipse) with light and dark themes, Sora
sans throughout, IBM Plex Mono for the timer and PID, a 4-px spacing grid, and motion that
gates on `prefers-reduced-motion`. Borrowed from Duolingo: chunky touch targets, generous
card padding, celebratory micro-animations. Explicitly not borrowed: gamification, mascot,
neon saturation, points. Constraint: existing token names keep their identity so the rest
of the codebase keeps working; only the values change.

**Deferred:** a serif accent font for hero headlines; a circular-progress ring on the
timer; a bento layout (set aside because the chosen style is "academic instrument," not
"bento grid").

---

## 4. Worker / backend

### 4.1 Single Worker serving static assets and the API (2026-05-21)

**Decided:** one Cloudflare Worker named `chemflashcards` that serves both `public/` (via
the `[assets]` block) and the `/api/v2/*` endpoints.

**Why:** the originally-planned Pages-plus-Worker split was blocked by a platform
limitation — Cloudflare does not retrofit Git integration onto a Direct Upload Pages
project, and creating a replacement Git-connected project produced a Workers Build project
anyway because `wrangler.toml` at the repo root triggered Workers auto-detection. Rather
than fight the auto-detection, the newer Worker + Static Assets pattern was adopted: one
project, one deploy pipeline, one origin, so no CORS is needed for production traffic.

**Rejected:** the Pages + Workers split (could have been done via a parallel rebuild and
domain swap, but the single-Worker pattern came out cleaner).

**Side effect since tightened:** with the asset directory originally set to the repo root,
non-frontend files were publicly readable at their URLs. As of 2026-05-22 only `public/` is
served.

### 4.2 Endpoint auth model (2026-05-26)

- `GET /api/v2/copy` — no auth, participant-facing read.
- `POST /api/v2/copy` — `EXPORT_TOKEN` bearer.
- `POST /api/v2/metacog/*`, `POST /api/v2/familiarity` — no bearer (participant-initiated
  mid-session), but enrollment-checked and idempotent via UNIQUE constraints.
- `GET /api/v2/export`, `/api/v2/export-all` — `EXPORT_TOKEN` bearer.
- `POST /api/v2/verify-session-password` — checks the password itself; no PID, nothing
  stored.

**Rejected:** one unified `POST /api/v2/metacog` with a `kind` discriminator — validation
rules differ per kind (0..12 vs choice enum vs checkpoint enum) and separate endpoints map
directly onto the three storage tables.

### 4.3 Admin export — Excel workbook built client-side (2026-06-24)

**Decided:** three per-table CSV buttons plus a "Download all (Excel)" that builds one
`.xlsx` with four tabs in the browser from the endpoint's JSON response. No worker, API,
schema, or DB change.

**Why:** a CSV is one flat table and cannot hold tabs. Built in the browser so every
data-collection path is untouched and there is zero data-integrity risk. Cells are written
with explicit types so participant IDs and ISO timestamps are not mangled the way Excel
auto-mangles a raw CSV import. SheetJS is vendored locally so the export has no runtime
dependency on an outside CDN.

**Rejected:** server-side xlsx generation (bundles a heavy library into the data-serving
worker); a ZIP of four CSVs or a single stacked CSV (neither is "one file, four tabs").

---

## 5. Deployment and operations

### 5.1 Deploy path

Push to `master` → Cloudflare Workers Build auto-deploys → **the Cloudflare cache must be
purged** or changes will not show. This last step is a standing requirement, not an
optional extra.

### 5.2 Secrets

`ALLOWED_ORIGIN` and `LAB_SESSION_PASSWORD` are Worker secrets, deliberately never written
into the repo. `EXPORT_TOKEN` gates the admin and export endpoints. The delayed-test gate
is **fail-closed**: if `LAB_SESSION_PASSWORD` is unset, the delayed test refuses to start.

### 5.3 Live D1 access

Live SQL is run from the **Cloudflare dashboard D1 console**, not local
`wrangler --remote` — the database lives in a different Cloudflare account than the CLI
login. (Note: this was intermittent; `--remote` worked again after a re-login on 2026-06-15,
then the dashboard was again the documented path. `instructions/deploy.md` and
`instructions/LAB_HANDOFF.md` still show `--remote` commands and contradict `README.md`
on this point.)

### 5.4 Reminder system — Power Automate, not Qualtrics (2026-06-11 → 2026-06-15)

**2026-06-11 (superseded):** a participant-filled Qualtrics logistics form driving five
date-anchored emails.

**2026-06-15 (final):** built in **Microsoft Power Automate**, reading a OneDrive Excel
table and sending via Outlook.

**Why Qualtrics was dropped for sending** (researched against Qualtrics documentation):
- Workflow task delays cap at 7 days total, max 5, evaluated up front — cannot reach Day 11
  and cannot anchor to a future participant-chosen date.
- Distribution Automations are calendar-only; they cannot fire relative to a per-contact
  date field.
- Contact filters do date *ranges* only — there is no "equals today / exactly N days ago"
  operator.

The only Qualtrics-native option was a daily manual send — reliable but an ongoing chore
and a single point of failure. Kept as a documented fallback.

**Rejected:** a Qualtrics → Power Automate hybrid (needs a premium connector; the
all-Microsoft path uses standard connectors and is included with the institutional M365).

**2026-06-15 (later) — three refinements:**
1. **Per-participant send time, default 3 PM** (was a single 9 AM run). A `reminder_time`
   column holds a whole hour; blank means 15:00. The flow runs hourly 7 AM–9 PM Eastern and
   filters to rows whose send-hour equals the current hour.
   - *Why a column, not a separate preferred-time table:* the Excel connector cannot join
     two tables; a column rides along in the existing read.
   - *Why whole-hour matching, not exact HH:mm:* robust to a 1–2 minute run delay. An
     exact-minute match could silently skip a day if a run fired a minute late.
2. **Visit-2 nudge moved from +10 to +8**, so it arrives a couple of days before the visit
   rather than the day of. +8 lands before Visit 2 in every weekend case.
3. **Weekend-aware `visit2_date` in the workbook** (sheet-only; the flow ignores it):
   `day1_date + 10`, shifted off weekends — Saturday to the Friday before (6-day RI),
   Sunday to the Monday after (8-day RI) — conditionally formatted yellow when the interval
   is not 7.

**Locked-in gotchas:** derive "today" via `convertTimeZone(... 'Eastern Standard Time' ...)`,
never raw `utcNow()`; `day1_date` must be Text `yyyy-mm-dd` or the ticks math breaks; the
link must be a single `@{outputs('LinkURL')}` token in the `href` and the body must be
edited in code view, because the rich-text editor mangles a mixed literal+expression href.

**Rejected:** reminding relative to the computed `visit2_date` instead of a fixed +8 offset
— would need the flow to read a real date cell, and the Excel connector returns date
serials, which is the whole reason `day1_date` is stored as text.

### 5.5 Repo cleanup (2026-06-15)

**Decided:** archives-only scope. `v1_backup/` (238 files, 1.6 MB) removed from git after a
local backup; the SVG generator and SVG backups moved out of the working tree; **all `.md`
docs kept in git**.

**Why:** the actual clutter was the dead v1 code, not the text docs. Text docs are tiny,
versioned, and are the irreplaceable design record, so git is the *safest* home for them —
stripping them to a local folder would make them less safe.

**Rejected:** a website-only strip that also moved the working docs to a local backup.

Root docs were then trimmed from 18 to 7 and later to 4, with design/audit notes moved to
`docs/` and the finalised ethics drafts removed from git entirely (the supervisor holds the
authoritative paperwork). `instructions/` and `db/` folders were created;
**Participant PII was checked:** the participants workbook is not and never was in the
repo; it lives in the lab's institutional OneDrive.

---

## 6. Analysis

### 6.1 The toolkit (2026-07-21)

**Decided:** a standalone **offline** Python package under `analysis/` that turns any
export into the Section 4.2 results, so any lab member can re-run the analyses without
help. Scripts read only the file they are given and write local tables and plots; nothing
touches the live site and no participant data leaves the machine.

**Sections built:** 4.2.i spacing effect, 4.2.ii acquisition curves, 4.2.iii calibration,
4.2.vi baseline and exclusions. **Deferred:** 4.2.iv gaze and 4.2.v recognition — those
come from the eye-tracking pipeline and their measures are not finalised.

**Input:** the 4-sheet export-all `.xlsx` or a folder of per-table CSVs; both accepted.

**Ease of use for the lab:** `run_all.py` plus double-click launchers so a lab member can
drop an export in a folder and run with no coding.

Verified end-to-end on a synthetic fixture, **never on real participant data**.

### 6.2 SPSS parity (2026-07-21)

**Decided:** because the supervisor works in SPSS and the developer in Python, tests run
via `pingouin` (whose output mirrors SPSS) with a scipy/statsmodels fallback; SPSS-default
effect sizes are computed explicitly (paired Cohen's **d = d_z**; partial η²); each result
prints its SPSS menu path; SPSS-shaped tables are written; and every analysis exports a
`.sav` file so the same prepared dataset can be opened in SPSS and the test reproduced.

**Rejected:** running SPSS's engine from Python — not possible without SPSS installed.

**Noted:** because every within factor in the 2×2 has only two levels, Mauchly's test is
not applicable and no Greenhouse-Geisser correction is needed. The scripts say so in their
output, so its absence is not mistaken for an omission.

### 6.3 Analysis-sample policy (decided 2026-07-21)

Centralised in a `CONFIG` block in `common.py` so it can be tightened in one place.

| Rule | Setting |
|---|---|
| `dev_mode = 1` | always excluded |
| Practice completers only (all 4 spaced + 4 massed) | yes |
| Missing delayed test | **not** an exclusion (completers assumed to have done it) |
| ISI violations (gaps outside 20–28 h) | flagged, kept |
| Baseline-ceiling exclusion | off |
| Mastery soft cap | 5 attempts |

**Rejected:** tightening exclusions now — deferred while N is small.

### 6.4 The eight analysis-plan decisions (2026-07-22)

Made after a critical review, with a timeout sweep as the evidence base.

**Evidence — the timeout sweep.** Of 32 timed-out trials in the 2026-07-20 export, **zero
were correct** under either the lenient instrument rule or the strict rule: 20 empty
answers, 12 wrong fragments. Bonus integrity check: stored `correct` matched an exact
rescore from `raw_answer` on **all 1,155 rows**.

1. **Calibration timeouts: exclusion stays primary**, with the sweep cited as evidence that
   exclusion cannot hide miscalibration — every excluded trial was a failure the
   participant never claimed to know.
   *Rejected:* imputing confidence = 1 ("Guess") on timeouts, as primary or as sensitivity.
   It rates answers that were never submitted (the prompt is skipped by design; 20 of 32
   typed nothing) and is mechanically self-flattering, since timeouts are empirically always
   wrong.
2. **Postdiction stays dropped** (see 1.11). The chapter acknowledges the missing
   prediction-vs-postdiction comparison as a limitation.
   *Rejected:* mid-collection restoration — a two-cohort instrument and likely a GREB
   amendment.
3. **Delayed-test scoring: strict primary for Q-full items only**; Q-blank keeps the
   lenient instrument rule. The taught/not-taught tier from the near-miss audit becomes a
   named sensitivity tier. Controlled by `QFULL_PRIMARY_RULE` in `common.py`, a one-line
   flip. **Flagged awaiting supervisor sign-off.**
4. **No per-item confidence added to the delayed test.** Recorded as *decided*, not
   drifted-into: the retention side of RQ2 rests on the set-preference item alone, and the
   chapter says so plainly. *Rejected:* mid-collection addition.
5. **Power framed as sensitivity-at-analyzable-N.** At the observed ~67% completion,
   enrolling 100 gives ~67 completers and an MDE of dz ≈ 0.35 — not the 0.28 computed on
   enrolment. Holding dz = 0.28 needs ~155 enrolled.
6. **Recency covariate: the simple route** — within-format paired t-tests plus a
   descriptive last-practice-recency table by schedule × format.
   *Rejected for now:* fully specifying a mixed logistic model just to host the covariate.
7. **Multiple comparisons, committed before looking at data:** the **Q-blank retention
   paired t-test is the sole confirmatory test**; **Holm** correction within the
   metacognitive DV family; gaze measures labelled exploratory. Everything else is
   secondary or exploratory.
8. **The Q-full delayed-RT companion filters on *lenient*-correct** — a formatting slip
   does not invalidate a latency. H4's primary RT is Q-blank/lenient and is unaffected.
   *Rejected:* a strict-correct filter, which would empty the massed Q-full RT cells
   (3.3% accuracy even lenient).

### 6.5 Near-miss scoring audit (2026-07-15)

All 60 delayed Q-full answers and all 45 wrong Q-blank answers were audited against the
Session-0 lesson text — the only place naming conventions are taught — under the criterion
that a convention is fairly scored wrong **only if it was actually taught**.

- **Hyphenation was never stated as a rule**, only modelled in examples. So
  `2-bromo-butane` / `iodo-ethane` are the legitimate "technically correct given what they
  learned" cases.
- **Explicitly taught, so fairly scored wrong:** the halide locant requirement, suffix-locant
  placement (so `3-hexene` violates the taught style even though it is chemically valid),
  and the two-word ester structure.
- **Spelling slips** are performance errors and form a separate sensitivity tier. `sept` for
  hept stays wrong — a systematic Latin/Greek confusion, not a typo. Likewise `ethyl` for
  methyl: edit distance 1, but a real alternative prefix, so a knowledge error.

**Result:** the spacing headline is robust under every re-scoring rule. **Decided:**
automated scoring stays primary; the sensitivity table is reported alongside.

### 6.6 Figure conventions (2026-07-22)

**Decided:** one standalone figure per analysis (18 total) in addition to the multi-panel
compilations. Fixed conventions: **spaced = blue #2a78d6, massed = orange #eb6834** in every
chart — the pair validated for colour-vision deficiency and distinct in greyscale; neutral
grey for non-schedule charts; labelled axes with units; ±1 SE error bars across
participants; and **per-participant thin lines on paired slopegraphs so individual reversals
stay visible**.

Chart forms: slopegraphs for paired spaced-vs-massed outcomes; interaction plots for the H2
crossover and schedule × format; position-1–4 curves for practice measures; labelled bar
charts for calibration, scoring rules, recency, the list check, set preference, and timeout
rate.

### 6.7 Two bugs the synthetic fixture could never have caught

Worth keeping because they are the argument for testing against real-shaped data:

1. **Timezone mismatch (2026-07-22).** `common.py` parsed the real export's `Z`-suffixed ISO
   timestamps as timezone-aware while the synthetic fixture loaded naive, so
   `last_practice_recency` would have **crashed on the first real-data run**. `_coerce_types`
   now normalises every timestamp column to naive UTC at load.
2. **First-pass restriction missing (2026-07-22).** The 4.2.iii calibration analysis was
   *not* first-pass-only before, despite being specified that way — caught during
   implementation.

Also: `analysis_42ii`'s `median_latency` had to be changed to exclude timed-out trials,
whose `rt_ms` is censored at 20 s.

### 6.8 Open items carried at the end of the log

- **Supervisor:** primary contrast version A/B; delayed-scoring version A/B; whether to
  fully specify or demote the mixed-effects model; the prior-knowledge exclusion threshold
  (the baseline-ceiling exclusion stays off in `common.py` until it is set).
- **Coordinator:** questionnaire transcription; execute the approved deletion of the
  certified lab test run `01-12345` (delayed-only rows, still present in exports and
  auto-excluded by the completer policy).
- **Eye-tracking collaborator:** the gaze DV set and the recognition task — 4.2.iv and
  4.2.v are scaffolds waiting on them.
- **Named limitation:** a Day-4 / fatigue confound — massing is always last, only the list
  is counterbalanced, not the timing.

---

## 7. Rejected alternatives — quick index

| Rejected | In favour of | Where |
|---|---|---|
| Between-subjects v1 design | within-subjects v2 | 1.1 |
| 2-day inter-study interval | 1-day | 1.1 |
| `WS1-`/`WS2-` ID prefixes | last-digit parity | 1.3 |
| Fully advisory timing (both bounds) | hard lower bound, advisory upper | 1.4 |
| Day-4 all-or-nothing block | resumable Day 4 | 1.8 |
| Deleting the forced choice | move post-test + reword | 1.11 |
| Confidence sidecar table | column on `trials_v2` | 2.2 |
| JSON file for editable copy | `copy_strings_v2` table | 2.4 |
| Feedback in study tables | isolated `edit_requests_v2` | 2.5 |
| Fabricating a `massed-B4` row | leave the gap genuinely missing | 2.8 |
| Stable pseudonyms across exports | fresh shuffle every run | 2.9 |
| Pages + Workers split | single Worker + Static Assets | 4.1 |
| Unified metacog endpoint | three separate endpoints | 4.2 |
| Server-side xlsx generation | client-side workbook build | 4.3 |
| Qualtrics for date-anchored sending | Power Automate + Excel + Outlook | 5.4 |
| Website-only doc strip | archives-only cleanup | 5.5 |
| Imputing confidence on timeouts | exclusion, with the sweep as evidence | 6.4 |
| Strict-correct RT filter on Q-full | lenient-correct filter | 6.4 |

---
