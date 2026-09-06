# ChemFlashcards
**Study Schedules & Practice — Chemistry Nomenclature**
GREB File #6046199 · QCER Lab · Queen's University Department of Chemistry

Live site: [chemflashcards.com](https://chemflashcards.com)

ChemFlashcards is the web application for a randomized controlled experiment in
chemistry-education research. It tests how **practice schedule** affects learning of
IUPAC / common chemical nomenclature, using spaced retrieval practice.

> **Operating the study (lab-facing):** [`instructions/LAB_HANDOFF.md`](instructions/LAB_HANDOFF.md).
> **Authoritative design history:** [`DESIGN_RATIONALE.md`](DESIGN_RATIONALE.md).
> **Deploy + schema details:** [`instructions/deploy.md`](instructions/deploy.md).

## The study (v2, within-subjects — live)

Every participant practises **both** of two matched 48-item lists of molecules
(`C-1` and `C-2`; 96 items total = 24 naming features × 4 examples each). One list is
studied **spaced** (a portion each day across four days); the other **massed** (all of
it in one sitting on day 4). Because each person does both schedules, the comparison is
**within-subjects**. Which list is spaced vs. massed is counterbalanced automatically by
participant ID. About one week after the final practice day, participants take a
**36-item delayed test** in the lab with an eye-tracker.

The app also runs a **metacognitive layer** (per-item confidence, pre-session
predictions, a forced-choice "which set will you remember better", a no-feedback rule
during the study window, and an end-of-study debrief) and a short **Session-0
foundations tutorial** with per-card "easy to learn" ratings. There is **no in-app
pre-test** (baseline is collected on paper at the in-lab consent visit) and **no
immediate post-test**.

## Participant IDs & conditions

- Format `<digits>-<suffix>`, e.g. `03-12345`. DEV ids look like `<digits>-DEV<digits>`
  (e.g. `01-DEV0`); they bypass the time gates and are flagged `dev_mode = 1` and
  excluded from analysis.
- The **parity of the last digit of the numeric prefix** sets the counterbalance:
  **odd → option 1, even → option 2** (which list is spaced vs. massed). No manual
  configuration — assign the ID and the app derives the rest.
- Sessions advance **by completion**. The **lower** inter-session bound (~20 h) is a
  **hard block** — coming back too early gets a "come back later" wall, which preserves
  the spacing. The **upper** bound (~28 h) is **advisory** (2026-07-02): a **missed day
  never locks anyone out** — they're allowed through and flagged off-schedule, and the
  true interval is recovered from the stored `completed_at` timestamps. Sequence still
  blocks (you can't do S3 before S2). The **in-lab delayed test** is fully advisory
  (neither its ~1-week floor nor a missing final-practice day blocks it, so lab staff
  can run Visit 2 for a half-completer) but is **protected by a session password**
  (Worker secret `LAB_SESSION_PASSWORD`, verified server-side) so it can't be
  self-started at home; the four at-home practice sessions are not password-gated.
  DEV ids skip everything.
- **Day 4 is resumable**: if the page is lost partway (e.g. the tab is discarded during
  the mandatory 5-minute break), re-entry skips the sub-sessions already saved and
  continues from the first unfinished one instead of locking the participant out.

## Architecture

```
chemflashcards.com
   └── one Cloudflare Worker (worker.mjs)      ← serves the static frontend AND the API
         ├── Static assets = public/           the SPA: HTML + JS modules + CSS + CSVs + images
         ├── D1 database    = ssp-study-02      (binding DB)      structured trial / session / metacog records
         └── R2 bucket      = ssp-results       (binding RESULTS) raw per-session backups
```

- **Frontend:** a vanilla-JS single-page app under `public/`, split into ES modules
  (`routing-v2.js`, `practice-engine.js`, `session-gate.js`, the per-page `*-page.js`
  files, the `session0-*` tutorial, and the metacog widgets). No framework.
- **Backend:** the single Worker `worker.mjs` exposes the `/api/v2/*` endpoints
  (routing/status, session save, metacog saves, editable copy strings, export, tester
  feedback). CORS via the `ALLOWED_ORIGIN` secret.
- **Deploy:** push to `master` → **Cloudflare Workers Build** auto-deploys, then **purge
  the Cloudflare cache**. See [`instructions/deploy.md`](instructions/deploy.md).

## Repository layout

```
/
├── public/         The deployed site (HTML, JS modules, CSS, items_v2.csv, delayed_posttest_v2.csv, images, sounds)
├── worker.mjs      The Cloudflare Worker (serves public/ + the API)
├── wrangler.toml   Cloudflare config (D1 + R2 bindings; [assets] directory = ./public)
├── package.json    Test scripts
├── test_*.mjs      Node test suite (routing, practice engine, worker, session gate)
├── db/             schema_v2.sql + migrations (live data model); schema.sql is the frozen v1 schema
├── instructions/   How to operate the study: LAB_HANDOFF, ADDING_PARTICIPANTS, REMINDERS_SETUP, deploy
├── analysis/       Local, offline Python scripts for the Section 4.2 results analysis (SPSS-parity + .sav export; see analysis/TUTORIAL.md). Never touches the live site.
│                   analysis/participant-data/ holds the real export and every output derived from it — gitignored, local-only, never committed.
├── docs/           Archived design / audit / review notes (reference only)
└── DESIGN_RATIONALE.md  Why the design is what it is (read before changing study logic)
```

(Not in git: `analysis/participant-data/`, which holds the real export and everything
derived from it.)

## Data

The live data model is **[`db/schema_v2.sql`](db/schema_v2.sql)** (plus the
`*_migration.sql` files), in Cloudflare D1 database `ssp-study-02`. Participant-keyed
tables: `participants_v2`, `sessions_v2`, `trials_v2`, `pre_session_predictions_v2`,
`forced_choices_v2`, `familiarity_ratings_v2`. Editable UI copy lives in `copy_strings_v2`;
tester feedback in the isolated `edit_requests_v2`. Monitoring and CSV export are via
`admin.html` (behind the `EXPORT_TOKEN` secret).

> **Run live D1 queries from the Cloudflare dashboard D1 console** (Storage & Databases →
> D1 → `ssp-study-02` → Console). Local `wrangler --remote` currently cannot reach this DB
> — it lives in a different Cloudflare account than the CLI login.

## Tester mode

A self-serve testing toolkit for the research team, invisible to real participants
(everything is gated on a DEV id appearing in the URL). The tester hub at
`chemflashcards.com/test-hub.html` mints throwaway DEV ids; a bottom-right tester bar
offers click-to-pin edit requests and a one-click "fill answer" walkthrough; review is in
`admin.html` → "Edit requests". Feedback is stored in the isolated `edit_requests_v2`
table and cannot affect study data.
