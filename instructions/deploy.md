# Deploy workflow

## Architecture (post-2026-05-21)

The v2 site is a **single Cloudflare Worker** named `chemflashcards` that
does two things:

1. **Serves static files** (HTML, JS, CSS, CSVs, SVGs, sounds) at any URL
   that matches a file in the repo, via the `[assets]` block in
   `wrangler.toml`.
2. **Runs the `/api/v2/*` API** via `worker.mjs`'s fetch handler when the
   request path is not a static file.

Both functions live under the same origin (`chemflashcards.com`), so the
frontend uses relative URLs to call the API. No CORS handling needed at
runtime for production traffic.

The Worker is **git-connected**: every push to `master` on
`rjmaligaya/chemflashcards` triggers a CI build that runs
`npx wrangler deploy`. There is no separate Pages project.

---

## Routine deploy (most changes)

```
git add .
git commit -m "..."
git push origin master
```

The Cloudflare CI picks up the push and deploys automatically.

Dashboard: Workers & Pages → `chemflashcards` → **Deployments** shows the
new build in seconds, completing in 1–2 minutes.

Hard refresh the site (`Ctrl+Shift+R` / `Cmd+Shift+R`) to bypass the
browser cache for HTML/JS/CSS.

If you change assets that may be aggressively cached (sounds, images),
also purge the Cloudflare cache:
- Dashboard → `chemflashcards.com` → Caching → Configuration → **Purge Everything**

---

## D1 schema changes

`schema_v2.sql` is the v2 schema. If you ADD columns or tables (pre-launch,
no real participant data yet):

```
wrangler d1 execute ssp-study-02 --command "DROP TABLE IF EXISTS trials_v2; DROP TABLE IF EXISTS sessions_v2;" --remote
wrangler d1 execute ssp-study-02 --file=db/schema_v2.sql --remote
```

`participants_v2` survives (not in the drop list). IF NOT EXISTS in
`schema_v2.sql` recreates the dropped tables with the new shape.

For post-launch migrations, use `ALTER TABLE` statements in a dated
migration file. The metacognitive layer (2026-05-26) shipped this way:
`schema_v2_metacog_migration.sql` adds the `confidence` column to
`trials_v2`, creates four new tables, and seeds the editable copy
strings. Safe to run on a live DB:

```
wrangler d1 execute ssp-study-02 --file=db/schema_v2_metacog_migration.sql --remote
```

The `ALTER TABLE` line will error on a second run (SQLite doesn't support
IF NOT EXISTS for columns); the rest of the file is idempotent thanks to
`CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE`.

---

## Updating the `ALLOWED_ORIGIN` secret

Only needed if you change your domain or test from a new preview URL.
Same-origin production traffic doesn't trigger the CORS path, but the
Worker still honors the secret for cross-origin requests (e.g. the
workers.dev preview URL):

```
wrangler secret put ALLOWED_ORIGIN
```

Paste the comma-separated list:
```
https://chemflashcards.com,https://chemflashcards.rjmaligaya.workers.dev
```

(Patterns with `https://*.foo` work too — see `worker.mjs`'s `originMatches`.)

## Setting the `LAB_SESSION_PASSWORD` secret (REQUIRED for the delayed test)

The in-lab delayed test is protected by a session password that lab staff type
before it starts (so a participant can't self-start it at home). The password is
a Worker secret, verified server-side by `POST /api/v2/verify-session-password`.
**The gate is fail-closed: if this secret is unset, the delayed test refuses to
start** (shows a "contact the researcher" message). Set it once:

```
wrangler secret put LAB_SESSION_PASSWORD
```

Paste the password when prompted. The value is deliberately **not written into
this repo** — keep it in the lab's password store / share it with operators
out-of-band. You can also set it in the Cloudflare dashboard: Worker → Settings →
Variables and Secrets → add secret `LAB_SESSION_PASSWORD`. Changing it later takes
effect immediately, with no code redeploy. DEV PIDs skip the password prompt
entirely.

---

## Manual worker-only deploy (rare)

If for some reason you want to deploy `worker.mjs` without going through
the CI (e.g., the GitHub side is broken):

```
wrangler deploy
```

Note: this overrides the CI's deploy and may put the production Worker
out of sync with what's on `master`. Use sparingly.

---

## Local development (rare)

For testing without deploying:

```
wrangler dev
```

This runs the Worker locally with bindings to the production D1 and R2.
Visit `http://localhost:8787/study.html` to hit it.

For local-only D1 (so you don't accidentally write to production):

```
wrangler dev --local
```

You'll need to seed the local D1 with the schema first:
```
wrangler d1 execute ssp-study-02 --file=db/schema_v2.sql --local
```

---

## Tests

```
npm test
```

Runs all four suites:
- `test_routing-v2.mjs` (PID parsing, advisory-timing router) — 46 assertions
- `test_practice-engine.mjs` (engine + mastery loop) — 94 assertions
- `test_worker-v2.mjs` (session-save + metacog + familiarity endpoints + debrief
  + csv-cell injection + orphan recovery + enrollment check + session-password
  gate) — 280 assertions
- `test_session-gate.mjs` (URL-gate decision logic) — 21 assertions

Total: 441 assertions, all expected to pass (delayed-test password gate + advisory
timing + Day-4 resume added 2026-07-02).

---

## Quick sanity checks after a deploy

| What | How |
|---|---|
| CI build went green | Dashboard → Deployments → latest row shows ✅ |
| Worker version is fresh | `wrangler deployments list` shows recent timestamp |
| API endpoint live | `curl https://chemflashcards.com/api/v2/status?pid=test` returns JSON |
| Static files served | Open chemflashcards.com/study.html in a browser |
| D1 schema in place | `wrangler d1 execute ssp-study-02 --command "SELECT name FROM sqlite_master WHERE type='table';" --remote` |

---

## What gets deployed

As of 2026-05-22, only files under `public/` are served by the Worker's
asset handler. The repo root (containing `worker.mjs`, `wrangler.toml`,
`schema*.sql`, `test_*.mjs`, and the `*.md` docs) is private — those
files are pushed to git but never served at a URL on chemflashcards.com.

If you add a new file the participants need to load (HTML, JS, CSS,
CSV, image, sound, etc.), put it under `public/`. Test/server/config
files stay at the repo root.

---

## Metacognitive measurement layer (added 2026-05-26)

A v2.1 layer adds four participant-facing prompts and a no-feedback
rule. See `DESIGN_RATIONALE.md` (2026-05-26 entry) for the design rationale and
the files below for the implementation. (The plain-language amendment
summary was finalized with AB and now lives outside the repo.)

### Frontend modules

| File | Responsibility |
|---|---|
| `public/practice-engine.js` | Per-item confidence prompt is integrated into `runTrial` between answer-submit and feedback. Hosts can opt out via `askConfidence: false`. |
| `public/prediction-widget.js` | `showPredictionWidget(container, opts)` — 0..12 chooser, two-tap commit. Used for both pre-session prediction and post-session postdiction. |
| `public/forced-choice-widget.js` | `showForcedChoiceWidget(container, opts)` — Set A / Set B / About-the-same + 3-level confidence. |
| `public/debrief-page.js` | `showDebriefScreen(container, pid)` — Day-14 debrief with chart + tables + copy. |
| `public/metacog-save.js` | POST helpers for the three out-of-trial-loop measures (prediction, postdiction, forced-choice). |
| `public/copy-strings.js` | Fetch + cache the editable copy from `/api/v2/copy`. English fallbacks bake in if the network fetch fails. |
| `public/spaced-session-page.js` | Wires pre + post prediction around `startSession` for sessions 1-3. |
| `public/day4-page.js` | Wires pre + post prediction around each practice phase, plus the Day-4 forced-choice. |
| `public/posttest-delayed-page.js` | Wires the Day-14 forced-choice before `startSession`, and the debrief after the silent summary CTA. |

### Backend endpoints (worker.mjs)

| Endpoint | Auth | Notes |
|---|---|---|
| `GET  /api/v2/copy` | none | Returns the editable copy strings as `{strings: {key: value, ...}}`. Frontend caches per session. |
| `POST /api/v2/copy` | `EXPORT_TOKEN` bearer | Update a single existing key. Returns 404 unknown_key on typos. |
| `POST /api/v2/metacog/prediction` | none (PID enrollment-checked) | Save pre-session prediction. Idempotent on (pid, session_label). |
| `POST /api/v2/metacog/forced-choice` | none | Save Day 4 or Day 14 forced-choice answer. Idempotent on (pid, checkpoint). |
| `POST /api/v2/familiarity` | none (PID enrollment-checked) | Save one Session-0 baseline familiarity rating (1..7). Idempotent on (pid, item_id). |
| `GET  /api/v2/debrief?pid=X` | none (same model as `/status`) | Returns the debrief data shape: per-session scores, predictions, forced choices, per-set scores on both test checkpoints. |
| `POST /api/v2/verify-session-password` | none (checks the password itself) | In-lab delayed-test gate. Body `{password}` → `{ok:true\|false}`, checked against the `LAB_SESSION_PASSWORD` secret. Fail-closed 500 if the secret is unset. No PID, nothing stored. |
| `GET  /api/v2/export?pid=X&table=Y` | `EXPORT_TOKEN` bearer | `table` defaults to `trials` (unchanged) and also accepts `predictions`, `forced_choices`, `familiarity` for long-format CSVs. |
| `GET  /api/v2/export-all?table=Y` | `EXPORT_TOKEN` bearer | Same `table` parameter for bulk export. |

### Database

Per `schema_v2_metacog_migration.sql`:
- `trials_v2.confidence INTEGER` — nullable, range 1..4 (Guess/Unsure/Fairly sure/Certain).
- `pre_session_predictions_v2 (id, participant_id, session_label, value 0..12, created_at)`. UNIQUE (participant_id, session_label).
- `forced_choices_v2 (id, participant_id, checkpoint, choice, confidence 1..3, created_at)`. UNIQUE (participant_id, checkpoint).
- `familiarity_ratings_v2 (id, participant_id, checkpoint 'spaced_intro'|'massed_intro', item_id, group_id, feature, full_name, value 1..7, created_at)`. UNIQUE (participant_id, item_id). Added 2026-05-31 (Session 0) — run the migration on deploy.
- `copy_strings_v2 (key PK, value, updated_at)` — seeded copy, including the 6 `familiarity_*` keys (Session 0 scale wording).

(A `post_session_postdictions_v2` table was originally part of this
layer and was removed 2026-05-27. See DESIGN_RATIONALE.md for rationale. The
migration script's `DROP TABLE IF EXISTS` line cleans it up on re-run.)

### Editing participant-facing copy without redeploying

Any of the 34 copy strings can be edited by anyone with the
`EXPORT_TOKEN` secret. Two ways:

**Via wrangler** (researcher with CLI access):
```
wrangler d1 execute ssp-study-02 --remote --command "UPDATE copy_strings_v2 SET value = 'New wording...' WHERE key = 'forced_choice_day4_prompt';"
```

**Via the API** (any HTTP client):
```
curl -X POST https://chemflashcards.com/api/v2/copy \
  -H "Authorization: Bearer $EXPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "forced_choice_day4_prompt", "value": "New wording..."}'
```

The frontend reads copy on every page load (no caching beyond the
current session), so changes appear on the next session start with no
deploy needed.

To see all current keys and values:
```
wrangler d1 execute ssp-study-02 --remote --command "SELECT key, value FROM copy_strings_v2 ORDER BY key;"
```

If you want to edit a copy string and the change does not appear, check
the spelling of the key. Unknown keys are rejected by the POST endpoint
(returns 404 `unknown_key`) but a wrangler UPDATE on an unknown key is
a silent no-op (`changes: 0`). The frontend never reads a key that is
not in the seed list — see `public/copy-strings.js` for the
authoritative list.
