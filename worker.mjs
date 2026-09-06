/**
 * worker.mjs — Cloudflare Worker for ChemFlashcards.
 *
 * Handles every request that does not match a static file under public/.
 * Static files are served by the [assets] binding declared in wrangler.toml.
 *
 * Routes:
 *   GET  /api/status                      v1 session history for a participant id
 *   POST /api/ingest                      v1 trial ingest: writes the D1 sessions and
 *                                         trials tables and a raw CSV copy to R2
 *   POST /api/v2/enroll                   creates or returns a participants_v2 row
 *   GET  /api/v2/status                   v2 enrollment record and completed sessions
 *   POST /api/v2/session-complete         saves one v2 session and its trials
 *   GET  /api/v2/export                   one participant's data as JSON or CSV
 *   GET  /api/v2/export-all               every participant's data as JSON or CSV
 *   GET  /api/v2/list-participants        roster with a per-participant session count
 *   GET  /api/v2/debrief                  per-participant summary for the debrief screen
 *   GET  /api/v2/copy                     participant-facing copy strings
 *   POST /api/v2/copy                     updates one copy string
 *   POST /api/v2/metacog/prediction       saves a pre-session prediction
 *   POST /api/v2/metacog/forced-choice    saves a forced-choice response
 *   POST /api/v2/familiarity              saves one baseline familiarity rating
 *   POST /api/v2/verify-session-password  checks the in-lab session password
 *   POST /api/v2/feedback                 stores tester edit requests
 *   GET  /api/v2/feedback                 lists tester edit requests
 *   POST /api/v2/feedback/resolve         marks edit requests resolved or reopened
 *
 * Bindings (see wrangler.toml):
 *   DB      — D1 database holding the v1 tables
 *   DB_V2   — D1 database holding the v2 tables
 *   RESULTS — R2 bucket holding raw session backups
 *
 * Secrets:
 *   ALLOWED_ORIGIN       — comma-separated CORS allowlist. Each entry is an exact
 *                          origin, a "https://*.example.com" wildcard, or "*".
 *   EXPORT_TOKEN         — bearer token required by the export and admin routes.
 *   LAB_SESSION_PASSWORD — password checked by /api/v2/verify-session-password.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TRIALS      = 2000;
const MAX_PID_LEN     = 64;
// -1 = pretest (in-person), 0 = Session 0 intro, 1-4 = practice sessions,
//  5 = T1 posttest (online), 6 = T2 posttest (in-person)
const VALID_SESSIONS  = new Set([-1, 0, 1, 2, 3, 4, 5, 6]);
const CONFIG_MAX_ANSWER = 200;

// ── Condition detection ───────────────────────────────────────────────────────

// Returns the v1 condition for a participant id, taken from its numeric prefix.
function detectCondition(pid) {
  if (pid.startsWith("01")) return "spaced";
  if (pid.startsWith("02")) return "massed";
  return "unknown";
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();
    const path   = url.pathname;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      // ── v1 endpoints (read and write the DB binding) ──
      if (path === "/api/status" && method === "GET")
        return await handleStatus(url, request, env);

      if (path === "/api/ingest" && method === "POST")
        return await handleIngest(request, env);

      // ── v2 endpoints (active — within-subjects rebuild) ──────────
      if (path === "/api/v2/enroll" && method === "POST")
        return await handleV2Enroll(request, env);

      if (path === "/api/v2/status" && method === "GET")
        return await handleV2Status(url, request, env);

      if (path === "/api/v2/session-complete" && method === "POST")
        return await handleV2SessionComplete(request, env);

      if (path === "/api/v2/export" && method === "GET")
        return await handleV2Export(url, request, env);

      if (path === "/api/v2/export-all" && method === "GET")
        return await handleV2ExportAll(url, request, env);

      if (path === "/api/v2/list-participants" && method === "GET")
        return await handleV2ListParticipants(request, env);

      // ── v2 metacognitive endpoints (new) ─────────────────────────
      if (path === "/api/v2/copy" && method === "GET")
        return await handleV2GetCopy(request, env);

      if (path === "/api/v2/copy" && method === "POST")
        return await handleV2UpdateCopy(request, env);

      if (path === "/api/v2/metacog/prediction" && method === "POST")
        return await handleV2MetacogPrediction(request, env);

      if (path === "/api/v2/metacog/forced-choice" && method === "POST")
        return await handleV2MetacogForcedChoice(request, env);

      if (path === "/api/v2/familiarity" && method === "POST")
        return await handleV2Familiarity(request, env);

      if (path === "/api/v2/debrief" && method === "GET")
        return await handleV2Debrief(url, request, env);

      // Server-side check of the in-lab session password.
      if (path === "/api/v2/verify-session-password" && method === "POST")
        return await handleV2VerifySessionPassword(request, env);

      // ── v2 tester edit-request (feedback) endpoints ──────────────
      // Submit takes no auth; list and resolve require EXPORT_TOKEN.
      if (path === "/api/v2/feedback" && method === "POST")
        return await handleV2FeedbackSubmit(request, env);

      if (path === "/api/v2/feedback" && method === "GET")
        return await handleV2FeedbackList(url, request, env);

      if (path === "/api/v2/feedback/resolve" && method === "POST")
        return await handleV2FeedbackResolve(request, env);

      return jsonResponse({ error: "not_found" }, 404, request, env);

    } catch (err) {
      console.error("Unhandled error:", err);
      return jsonResponse({ error: "internal_error" }, 500, request, env);
    }
  }
};

// ── GET /api/status ───────────────────────────────────────────────────────────

// Returns the completed-session rows for one participant from the v1 sessions table.
async function handleStatus(url, request, env) {
  const pid = sanitizePid(url.searchParams.get("pid") || "");
  if (!pid) return jsonResponse({ error: "invalid_pid" }, 400, request, env);

  const rows = await env.DB.prepare(
    `SELECT session_id, completed_at, 0 AS reattempt
     FROM sessions
     WHERE participant_id = ?
     ORDER BY session_id ASC`
  ).bind(pid).all();

  return jsonResponse({ history: rows.results ?? [] }, 200, request, env);
}

// ── POST /api/ingest ──────────────────────────────────────────────────────────

// Validates a v1 session payload, then writes the session row, the trial rows,
// and a CSV copy of the session to R2.
async function handleIngest(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json" }, 400, request, env); }

  const pid       = sanitizePid(String(body.participant_id ?? ""));
  const sessionId = Number(body.session_id);
  const studyId   = sanitizeStr(String(body.study_id ?? ""), 64);
  const condition = detectCondition(pid);

  if (!pid)
    return jsonResponse({ error: "invalid_participant_id" }, 400, request, env);
  if (!VALID_SESSIONS.has(sessionId))
    return jsonResponse({ error: "invalid_session_id" }, 400, request, env);

  // Massed participants may submit only the pretest (-1), the introduction (0),
  // practice session 1, and the two posttests (5, 6). Any other session id is rejected.
  const massedAllowed = new Set([-1, 0, 1, 5, 6]);
  if (condition === "massed" && !massedAllowed.has(sessionId))
    return jsonResponse({ error: "massed_condition_invalid_session" }, 400, request, env);

  if (!Array.isArray(body.trials) || body.trials.length === 0)
    return jsonResponse({ error: "no_trials" }, 400, request, env);
  if (body.trials.length > MAX_TRIALS)
    return jsonResponse({ error: "too_many_trials" }, 400, request, env);

  const isReattempt = Boolean(body.reattempt);
  const completedAt = sanitizeStr(String(body.completed_at ?? ""), 30) || new Date().toISOString();
  const startedAt   = sanitizeStr(String(body.started_at   ?? ""), 30) || completedAt;

  const device = body.device ?? {};
  const ua = sanitizeStr(String(device.ua ?? ""), 300);
  const dw = Number.isFinite(Number(device.w)) ? Number(device.w) : null;
  const dh = Number.isFinite(Number(device.h)) ? Number(device.h) : null;
  const tz = sanitizeStr(String(device.tz ?? ""), 60);

  const pretestLagDays = Number.isFinite(Number(body.pretest_lag_days))
    ? Number(body.pretest_lag_days)
    : null;

  const rawCtx = sanitizeStr(String(body.session_context ?? ""), 20);
  const sessionContext = (rawCtx === "in_person" || rawCtx === "online") ? rawCtx : "online";

  // ── 1. Write to sessions table ────────────────────────────
  // Only the first attempt inserts a row; a reattempt leaves completed_at unchanged.
  if (!isReattempt) {
    await env.DB.prepare(`
      INSERT INTO sessions
        (participant_id, study_id, condition, session_id, started_at, completed_at, ua, device_w, device_h, tz, pretest_lag_days, session_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (participant_id, session_id) DO NOTHING
    `).bind(pid, studyId, condition, sessionId, startedAt, completedAt, ua, dw, dh, tz, pretestLagDays, sessionContext).run();
  }

  // ── 2. Write trials to D1 ────────────────────────────────

  const stmts = body.trials.map(t => {
    return env.DB.prepare(`
      INSERT INTO trials
        (participant_id, study_id, condition, session_id, reattempt,
         trial_index, item_id, skill, anchor, phase, attempt_num, task_type,
         rt_ms, review_ms, answer_raw, answer_norm, correct, timed_out,
         trial_ts, started_at, completed_at, ua, device_w, device_h, tz)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      pid,
      studyId,
      condition,
      sessionId,
      isReattempt ? 1 : 0,
      Number.isFinite(Number(t.trial_index)) ? Number(t.trial_index) : null,
      sanitizeStr(String(t.id      ?? ""), 10),
      Number.isFinite(Number(t.skill)) ? Number(t.skill) : null,
      sanitizeStr(String(t.anchor  ?? ""), 60),
      sanitizeStr(String(t.phase   ?? ""), 20),
      Number.isFinite(Number(t.attempt)) ? Number(t.attempt) : null,
      sanitizeStr(String(t.task_type ?? "retrieval"), 30) || "retrieval",
      Number.isFinite(Number(t.rt_ms))     ? Number(t.rt_ms)     : null,
      Number.isFinite(Number(t.review_ms)) ? Number(t.review_ms) : null,
      sanitizeStr(String(t.answer_raw  ?? ""), CONFIG_MAX_ANSWER),
      sanitizeStr(String(t.answer_norm ?? ""), CONFIG_MAX_ANSWER),
      t.correct === 1 ? 1 : (t.correct === 0 ? 0 : null),
      t.timed_out === 1 ? 1 : 0,
      sanitizeStr(String(t.ts ?? ""), 30),
      startedAt,
      completedAt,
      ua, dw, dh, tz,
    );
  });

  await env.DB.batch(stmts);

  // ── 3. Write raw CSV backup to R2 ────────────────────────

  const csv    = buildCSV(pid, studyId, condition, sessionId, isReattempt, startedAt, completedAt, ua, dw, dh, tz, pretestLagDays, sessionContext, body.trials);
  const folder = isReattempt ? "reattempts" : "sessions";
  const suffix = isReattempt ? `_${Date.now()}` : "";
  const r2Key  = `${studyId}/${folder}/s${sessionId}_${pid}${suffix}.csv`;

  await env.RESULTS.put(r2Key, csv, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" }
  });

  return jsonResponse({ ok: true, condition, reattempt: isReattempt }, 200, request, env);
}

// ── CSV builder ───────────────────────────────────────────────────────────────

// Renders one v1 session as CSV, one row per trial, with the session fields
// repeated on every row.
function buildCSV(pid, studyId, condition, sessionId, reattempt, startedAt, completedAt, ua, dw, dh, tz, pretestLagDays, sessionContext, trials) {
  const header = [
    "participant_id", "study_id", "condition", "session_context", "session_id", "reattempt",
    "trial_index", "item_id", "skill", "anchor", "phase", "attempt_num", "task_type",
    "rt_ms", "review_ms", "answer_raw", "answer_norm", "correct", "timed_out",
    "trial_ts", "started_at", "completed_at", "pretest_lag_days",
    "ua", "device_w", "device_h", "tz"
  ];

  const rows = [header.join(",")];

  for (const t of trials) {
    const row = [
      csvCell(pid),
      csvCell(studyId),
      csvCell(condition),
      csvCell(sessionContext),
      sessionId,
      reattempt ? 1 : 0,
      t.trial_index ?? "",
      csvCell(t.id     ?? ""),
      t.skill          ?? "",
      csvCell(t.anchor ?? ""),
      csvCell(t.phase  ?? ""),
      t.attempt        ?? "",
      csvCell(t.task_type ?? "retrieval"),
      t.rt_ms          ?? "",
      t.review_ms      ?? "",
      csvCell(t.answer_raw  ?? ""),
      csvCell(t.answer_norm ?? ""),
      t.correct === 1 ? 1 : (t.correct === 0 ? 0 : ""),
      t.timed_out === 1 ? 1 : 0,
      csvCell(t.ts ?? ""),
      csvCell(startedAt),
      csvCell(completedAt),
      pretestLagDays ?? "",
      csvCell(ua),
      dw ?? "",
      dh ?? "",
      csvCell(tz),
    ];
    rows.push(row.join(","));
  }

  return rows.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Renders one CSV field. Prefixes a leading =, +, -, @, tab, or carriage return
// with an apostrophe so spreadsheet software treats the cell as text, then wraps
// the field in quotes if it contains a comma, quote, or newline.
export function csvCell(v) {
  let s = String(v ?? "");
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Trims a participant id to MAX_PID_LEN and returns it if it contains only
// letters, digits, underscores, and hyphens. Returns an empty string otherwise.
function sanitizePid(raw) {
  const s = String(raw).trim().slice(0, MAX_PID_LEN);
  return /^[a-zA-Z0-9_\-]+$/.test(s) ? s : "";
}

// Trims and truncates to max length. Used for all string fields before DB insert.
function sanitizeStr(s, max) {
  return String(s ?? "").trim().slice(0, max);
}

// ── v2: PID parity + validation ──────────────────────────────────────────────
//
// PID format:  <1-4 digit prefix>-<1-8 alphanumeric suffix>
// DEV variant: <prefix>-DEV<digits>
// Parity of the last prefix digit: odd -> option1, even -> option2

const V2_PID_RE     = /^(\d{1,4})-([A-Za-z0-9]{1,8})$/;
const V2_PID_DEV_RE = /^(\d{1,4})-DEV\d*$/i;

// Returns "option1" or "option2" from the parity of the last prefix digit,
// or an empty string if the id does not match either PID pattern.
function v2DeriveOption(pid) {
  if (!pid) return "";
  if (!V2_PID_RE.test(pid) && !V2_PID_DEV_RE.test(pid)) return "";
  const lastDigit = Number(pid.split("-")[0].slice(-1));
  if (!Number.isFinite(lastDigit)) return "";
  return (lastDigit % 2 === 1) ? "option1" : "option2";
}

// Returns true if the id is a DEV id.
function v2IsDev(pid) {
  return !!pid && V2_PID_DEV_RE.test(pid);
}

// Returns true if the participant id has a row in participants_v2.
export async function checkEnrollment(db, pid) {
  if (!pid) return false;
  const row = await db.prepare(
    `SELECT 1 AS ok FROM participants_v2 WHERE pid = ?`
  ).bind(pid).first();
  return !!row;
}

// ── POST /api/v2/enroll ──────────────────────────────────────────────────────
//
// Body: {pid: "03-12345"}
// Returns: {pid, option_id, enrollment_date, dev_mode, is_new}
//
// If pid already exists in participants_v2, returns the existing record
// unchanged (idempotent). The enrollment_date is locked on first insert
// and never updated.

async function handleV2Enroll(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json" }, 400, request, env); }

  const pid = sanitizePid(body?.pid || "");
  if (!pid) return jsonResponse({ error: "invalid_pid" }, 400, request, env);

  const optionId = v2DeriveOption(pid);
  if (!optionId) return jsonResponse({ error: "invalid_pid_format" }, 400, request, env);

  const devMode  = v2IsDev(pid) ? 1 : 0;
  const ua       = sanitizeStr(request.headers.get("User-Agent") || "", 500);
  const tz       = sanitizeStr(body?.tz || "", 64);
  const nowIso   = new Date().toISOString();

  // Idempotent insert: only insert if pid doesn't exist.
  await env.DB_V2.prepare(
    `INSERT OR IGNORE INTO participants_v2
       (pid, option_id, enrollment_date, dev_mode, ua, tz)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(pid, optionId, nowIso, devMode, ua, tz).run();

  // Read the row back to determine whether this call created it.
  const row = await env.DB_V2.prepare(
    `SELECT pid, option_id, enrollment_date, dev_mode
     FROM participants_v2 WHERE pid = ?`
  ).bind(pid).first();

  if (!row) return jsonResponse({ error: "enrollment_failed" }, 500, request, env);

  const isNew = row.enrollment_date === nowIso;
  return jsonResponse({
    pid: row.pid,
    option_id: row.option_id,
    enrollment_date: row.enrollment_date,
    dev_mode: !!row.dev_mode,
    is_new: isNew,
  }, 200, request, env);
}

// ── GET /api/v2/status ───────────────────────────────────────────────────────
//
// Query: ?pid=03-12345
// Returns: {pid, option_id, enrollment_date, dev_mode, sessions_completed: [...]}
//          or {error: "not_enrolled"} (404) if no record.

async function handleV2Status(url, request, env) {
  const pid = sanitizePid(url.searchParams.get("pid") || "");
  if (!pid) return jsonResponse({ error: "invalid_pid" }, 400, request, env);

  const p = await env.DB_V2.prepare(
    `SELECT pid, option_id, enrollment_date, dev_mode
     FROM participants_v2 WHERE pid = ?`
  ).bind(pid).first();

  if (!p) return jsonResponse({ error: "not_enrolled" }, 404, request, env);

  const sessions = await env.DB_V2.prepare(
    `SELECT session_label, phase, completed_at
     FROM sessions_v2
     WHERE participant_id = ? AND completed_at IS NOT NULL
     ORDER BY completed_at ASC`
  ).bind(pid).all();

  return jsonResponse({
    pid: p.pid,
    option_id: p.option_id,
    enrollment_date: p.enrollment_date,
    dev_mode: !!p.dev_mode,
    sessions_completed: sessions.results ?? [],
  }, 200, request, env);
}

// ── POST /api/v2/session-complete ────────────────────────────────────────────
//
// Body: see validateSessionPayload below.
// Returns: { session_id, n_trials_saved, status: "saved" | "already_saved" }
//
// Idempotent: the `UNIQUE (participant_id, session_label)` constraint on
// sessions_v2 makes a second POST of the same session a no-op.

const V2_VALID_PHASES = new Set(["pretest","spaced","massed","delayed"]);
const V2_VALID_GROUPS = new Set(["C-1","C-2"]);
const V2_VALID_QTYPES = new Set(["Q-blank","Q-full"]);
// The accepted session_label values. Any other label is rejected.
const V2_VALID_LABELS = new Set([
  "pretest",
  "spaced-S1", "spaced-S2", "spaced-S3", "spaced-S4",
  "massed-B1", "massed-B2", "massed-B3", "massed-B4",
  "delayed",
]);
const V2_MAX_TRIALS_PER_SESSION = 200;  // 48 massed items * ~4 retries = ~192 absolute worst case
const V2_MAX_RAW_ANSWER_LEN = 200;      // upper bound on a stored raw answer
const V2_MAX_RT_MS          = 600_000;  // 10 minutes; the trial timer auto-submits at 20s
const V2_MAX_REVIEW_MS      = 600_000;  // same cap for time on the feedback screen
// Accepted range for submitted timestamps.
const V2_TS_MIN_MS = Date.UTC(2024, 0, 1);   // 2024-01-01 UTC
const V2_TS_MAX_MS = Date.UTC(2030, 0, 1);   // 2030-01-01 UTC

// Returns true if s is null, undefined, or an ISO timestamp inside the accepted range.
function isValidTimestamp(s) {
  if (s == null) return true;                  // null/undefined are allowed
  if (typeof s !== "string" || !s) return false;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return false;
  return ms >= V2_TS_MIN_MS && ms <= V2_TS_MAX_MS;
}

// Returns true if v is null, undefined, or an integer between 0 and max inclusive.
function isNonNegIntInRange(v, max) {
  if (v == null) return true;                  // null/undefined are allowed
  return Number.isInteger(v) && v >= 0 && v <= max;
}

// Checks a session-complete payload and its trials. Returns an array of error
// strings, or null when the payload is valid.
export function validateSessionPayload(p) {
  const errors = [];
  if (!p || typeof p !== "object")           errors.push("body must be a JSON object");
  if (!p.pid || typeof p.pid !== "string")   errors.push("pid required (string)");
  if (!p.session_label)                      errors.push("session_label required");
  else if (!V2_VALID_LABELS.has(p.session_label))
                                             errors.push(`session_label must be one of ${[...V2_VALID_LABELS].join(",")}`);
  if (!V2_VALID_PHASES.has(p.phase))         errors.push(`phase must be one of ${[...V2_VALID_PHASES].join(",")}`);
  if (p.group_practiced && !V2_VALID_GROUPS.has(p.group_practiced))
                                             errors.push("group_practiced must be C-1, C-2, or null");
  if (!isValidTimestamp(p.started_at))       errors.push("started_at must be an ISO timestamp in 2024-2029");
  if (!isValidTimestamp(p.completed_at))     errors.push("completed_at must be an ISO timestamp in 2024-2029");
  if (!Array.isArray(p.trials))              errors.push("trials must be an array");
  if (Array.isArray(p.trials) && p.trials.length > V2_MAX_TRIALS_PER_SESSION)
                                             errors.push(`trials array exceeds max (${V2_MAX_TRIALS_PER_SESSION})`);

  if (Array.isArray(p.trials)) {
    p.trials.forEach((t, i) => {
      if (!t.item_id)                          errors.push(`trials[${i}].item_id required`);
      if (!V2_VALID_GROUPS.has(t.group_id))    errors.push(`trials[${i}].group_id invalid`);
      if (!t.feature)                          errors.push(`trials[${i}].feature required`);
      if (!t.full_name)                        errors.push(`trials[${i}].full_name required`);
      if (!V2_VALID_QTYPES.has(t.qtype))       errors.push(`trials[${i}].qtype invalid`);
      if (typeof t.trial_order !== "number")   errors.push(`trials[${i}].trial_order required (number)`);
      if (t.raw_answer != null && typeof t.raw_answer === "string" && t.raw_answer.length > V2_MAX_RAW_ANSWER_LEN)
                                               errors.push(`trials[${i}].raw_answer exceeds ${V2_MAX_RAW_ANSWER_LEN} chars`);
      if (!isNonNegIntInRange(t.rt_ms,     V2_MAX_RT_MS))
                                               errors.push(`trials[${i}].rt_ms out of range (0..${V2_MAX_RT_MS})`);
      if (!isNonNegIntInRange(t.review_ms, V2_MAX_REVIEW_MS))
                                               errors.push(`trials[${i}].review_ms out of range (0..${V2_MAX_REVIEW_MS})`);
      if (!isValidTimestamp(t.stim_on_ts))     errors.push(`trials[${i}].stim_on_ts invalid`);
      if (!isValidTimestamp(t.stim_off_ts))    errors.push(`trials[${i}].stim_off_ts invalid`);
      // confidence is optional. Practice trials carry 1..4; test trials omit it (null/undefined).
      if (t.confidence != null && (!Number.isInteger(t.confidence) || t.confidence < 1 || t.confidence > 4))
                                               errors.push(`trials[${i}].confidence must be an integer 1..4 or null`);
    });
  }

  return errors.length ? errors : null;
}

/**
 * Takes a D1 binding and a validated payload, inserts the session row and its
 * trials, and returns { session_id, n_trials_saved, status }. The session
 * insert is idempotent on (participant_id, session_label).
 *
 * opts:
 *   ua          — user-agent string stored on the session row
 *   r2Bucket    — optional R2 binding. When it is supplied and the session row
 *                 was newly inserted, the raw payload is also written to
 *                 `<r2KeyPrefix>/<pid>/<session_label>.json`. An R2 write
 *                 failure is logged and does not fail the save.
 *   r2KeyPrefix — R2 key prefix (default `sessions_v2`).
 */
export async function saveSessionToD1(db, payload, opts = {}) {
  const ua          = opts.ua || "";
  const r2Bucket    = opts.r2Bucket || null;
  const r2KeyPrefix = opts.r2KeyPrefix || "sessions_v2";

  // Step 1: insert session (or no-op if (pid, session_label) already exists).
  const insRes = await db.prepare(
    `INSERT OR IGNORE INTO sessions_v2
       (participant_id, phase, session_label, group_practiced,
        started_at, completed_at, ua, device_w, device_h, tz, session_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    payload.pid,
    payload.phase,
    payload.session_label,
    payload.group_practiced || null,
    payload.started_at      || null,
    payload.completed_at    || null,
    ua,
    payload.device_w        || null,
    payload.device_h        || null,
    payload.tz              || null,
    payload.session_context || "online",
  ).run();

  const inserted = insRes?.meta?.changes === 1;

  // Step 2: read back the session_id, whether or not the insert added a row.
  const row = await db.prepare(
    `SELECT id FROM sessions_v2 WHERE participant_id = ? AND session_label = ?`
  ).bind(payload.pid, payload.session_label).first();

  if (!row) throw new Error("session row not found after insert");

  const sessionId = row.id;

  // When the session row already existed, check whether its trials are present.
  // If they are, the call reports "already_saved" and writes nothing further.
  // If they are not, it falls through and inserts the trials now.
  if (!inserted) {
    const existing = await db.prepare(
      `SELECT COUNT(*) AS n FROM trials_v2 WHERE session_id = ?`
    ).bind(sessionId).first();
    if ((existing?.n ?? 0) > 0) {
      return { session_id: sessionId, n_trials_saved: 0, status: "already_saved" };
    }
    // The session row exists without trials. Fall through to insert them below.
  }

  // Step 3: insert the trials in a single batch.
  const trials = Array.isArray(payload.trials) ? payload.trials : [];
  if (trials.length > 0) {
    const stmts = trials.map(t => db.prepare(
      `INSERT INTO trials_v2
         (session_id, participant_id, item_id, group_id, feature, full_name,
          qtype, raw_answer, correct, rt_ms, review_ms,
          stim_on_ts, stim_off_ts, trial_order,
          timed_out, retry_attempt, soft_capped, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sessionId,
      payload.pid,
      t.item_id,
      t.group_id,
      t.feature,
      t.full_name,
      t.qtype,
      t.raw_answer ?? null,
      (t.correct === true || t.correct === 1) ? 1 : (t.correct === false || t.correct === 0) ? 0 : null,
      t.rt_ms        ?? null,
      t.review_ms    ?? null,
      t.stim_on_ts   ?? null,
      t.stim_off_ts  ?? null,
      t.trial_order,
      t.timed_out      ? 1 : 0,
      t.retry_attempt  ?? 1,
      t.soft_capped    ? 1 : 0,
      (Number.isInteger(t.confidence) && t.confidence >= 1 && t.confidence <= 4) ? t.confidence : null,
    ));
    await db.batch(stmts);
  }

  // Write a copy of the payload to R2. An idempotent retry returns above and
  // never reaches this point.
  if (r2Bucket) {
    const key  = `${r2KeyPrefix}/${payload.pid}/${payload.session_label}.json`;
    const body = JSON.stringify({
      saved_at:   new Date().toISOString(),
      session_id: sessionId,
      payload,
    });
    try {
      await r2Bucket.put(key, body, {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (e) {
      // Log and continue. The D1 writes have already succeeded.
      console.error(`R2 backup failed for ${key}:`, e);
    }
  }

  return { session_id: sessionId, n_trials_saved: trials.length, status: "saved" };
}

// Validates the posted session, checks that the participant is enrolled, and
// saves the session and its trials.
async function handleV2SessionComplete(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json" }, 400, request, env); }

  // Normalize the participant id before validation.
  if (body && typeof body.pid === "string") {
    body.pid = sanitizePid(body.pid);
  }

  const errors = validateSessionPayload(body);
  if (errors) {
    return jsonResponse({ error: "invalid_payload", details: errors }, 400, request, env);
  }

  // Format-check: PID must match the v2 regex.
  const derivedOption = v2DeriveOption(body.pid);
  if (!derivedOption) {
    return jsonResponse({ error: "invalid_pid_format" }, 400, request, env);
  }

  // Reject saves for a participant id that has no participants_v2 row.
  const enrolled = await checkEnrollment(env.DB_V2, body.pid);
  if (!enrolled) {
    return jsonResponse({ error: "not_enrolled", pid: body.pid }, 404, request, env);
  }

  const ua = sanitizeStr(request.headers.get("User-Agent") || "", 500);

  try {
    const result = await saveSessionToD1(env.DB_V2, body, {
      ua,
      r2Bucket: env.RESULTS,   // optional R2 copy of the payload
    });
    return jsonResponse(result, 200, request, env);
  } catch (e) {
    console.error("session-complete error:", e);
    return jsonResponse({ error: "save_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// ── GET /api/v2/export ───────────────────────────────────────────────────────
//
// Query: ?pid=<id>&format=json|csv (default json)
// Auth:  Authorization: Bearer <EXPORT_TOKEN>  (token stored as secret)
// Returns: full participant data — participant row + sessions + trials.
//   json  → nested:  { participant, sessions: [{ ..., trials: [...] }] }
//   csv   → flat: one row per trial with all parent fields denormalized
//
// 401 if no/wrong token. 404 if PID not enrolled. 500 on DB failure.

const EXPORT_SESSION_COLS = "id, phase, session_label, group_practiced, started_at, completed_at, ua, device_w, device_h, tz, session_context, created_at";
const EXPORT_TRIAL_COLS   = "id, item_id, group_id, feature, full_name, qtype, raw_answer, correct, rt_ms, review_ms, stim_on_ts, stim_off_ts, trial_order, timed_out, retry_attempt, soft_capped, confidence, created_at";

// Reads one participant's full record: the participant row, their sessions with
// trials nested under each, and the metacognitive measures as flat arrays.
// Returns null if the participant id is not enrolled.
export async function exportParticipantFromD1(db, pid) {
  const participant = await db.prepare(
    `SELECT pid, option_id, enrollment_date, dev_mode, ua, tz, created_at
     FROM participants_v2 WHERE pid = ?`
  ).bind(pid).first();
  if (!participant) return null;

  const sessions = await db.prepare(
    `SELECT ${EXPORT_SESSION_COLS} FROM sessions_v2
     WHERE participant_id = ?
     ORDER BY id ASC`
  ).bind(pid).all();

  const trials = await db.prepare(
    `SELECT session_id, ${EXPORT_TRIAL_COLS} FROM trials_v2
     WHERE participant_id = ?
     ORDER BY session_id ASC, trial_order ASC`
  ).bind(pid).all();

  // Group trials under their session.
  const trialsBySession = new Map();
  for (const t of (trials.results || [])) {
    if (!trialsBySession.has(t.session_id)) trialsBySession.set(t.session_id, []);
    // Drop session_id from the per-trial row since it's redundant under nesting.
    const { session_id, ...rest } = t;
    trialsBySession.get(session_id).push(rest);
  }
  const sessionsWithTrials = (sessions.results || []).map(s => ({
    ...s,
    trials: trialsBySession.get(s.id) || [],
  }));

  // Metacognitive tables in long format, one row per measurement, returned as
  // flat arrays at the participant level.
  const predictions = await db.prepare(
    `SELECT session_label, value, created_at
     FROM pre_session_predictions_v2
     WHERE participant_id = ?
     ORDER BY created_at ASC`
  ).bind(pid).all();

  const forcedChoices = await db.prepare(
    `SELECT checkpoint, choice, confidence, created_at
     FROM forced_choices_v2
     WHERE participant_id = ?
     ORDER BY created_at ASC`
  ).bind(pid).all();

  const familiarity = await db.prepare(
    `SELECT checkpoint, item_id, group_id, feature, full_name, value, created_at
     FROM familiarity_ratings_v2
     WHERE participant_id = ?
     ORDER BY created_at ASC`
  ).bind(pid).all();

  return {
    participant,
    sessions:       sessionsWithTrials,
    predictions:    predictions.results    || [],
    forced_choices: forcedChoices.results  || [],
    familiarity:    familiarity.results    || [],
  };
}

// Renders one participant's export as flat CSV, one row per trial, with the
// participant and session fields repeated on every row. A participant with no
// trials produces a header-only file.
function exportToCsv(data) {
  const headers = [
    // participant
    "pid", "option_id", "enrollment_date", "dev_mode", "participant_tz",
    // session
    "session_id", "session_label", "phase", "group_practiced",
    "session_started_at", "session_completed_at", "session_context",
    // trial
    "trial_id", "item_id", "group_id", "feature", "full_name", "qtype",
    "raw_answer", "correct", "rt_ms", "review_ms",
    "stim_on_ts", "stim_off_ts", "trial_order",
    "timed_out", "retry_attempt", "soft_capped", "confidence", "trial_created_at",
  ];
  const lines = [headers.join(",")];
  const p = data.participant;
  for (const s of data.sessions) {
    for (const t of s.trials) {
      const row = [
        p.pid, p.option_id, p.enrollment_date, p.dev_mode, p.tz,
        s.id, s.session_label, s.phase, s.group_practiced,
        s.started_at, s.completed_at, s.session_context,
        t.id, t.item_id, t.group_id, t.feature, t.full_name, t.qtype,
        t.raw_answer, t.correct, t.rt_ms, t.review_ms,
        t.stim_on_ts, t.stim_off_ts, t.trial_order,
        t.timed_out, t.retry_attempt, t.soft_capped, t.confidence, t.created_at,
      ].map(csvCell);
      lines.push(row.join(","));
    }
  }
  return lines.join("\n") + "\n";
}

// CSV emitters for the metacognitive tables. One row per measurement, with pid
// on every row, so the per-participant and bulk exports share the same header.

const VALID_EXPORT_TABLES = new Set(["trials","predictions","forced_choices","familiarity"]);

// Renders pre-session prediction rows as CSV.
function predictionsToCsv(participantRows) {
  // participantRows: [{pid, session_label, value, created_at}, ...]
  const headers = ["pid", "session_label", "value", "created_at"];
  const lines = [headers.join(",")];
  for (const r of participantRows) {
    lines.push([r.pid, r.session_label, r.value, r.created_at].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

// Renders forced-choice rows as CSV.
function forcedChoicesToCsv(participantRows) {
  const headers = ["pid", "checkpoint", "choice", "confidence", "created_at"];
  const lines = [headers.join(",")];
  for (const r of participantRows) {
    lines.push([r.pid, r.checkpoint, r.choice, r.confidence, r.created_at].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

// Renders familiarity-rating rows as CSV.
function familiarityToCsv(participantRows) {
  const headers = ["pid", "checkpoint", "item_id", "group_id", "feature", "full_name", "value", "created_at"];
  const lines = [headers.join(",")];
  for (const r of participantRows) {
    lines.push([r.pid, r.checkpoint, r.item_id, r.group_id, r.feature, r.full_name, r.value, r.created_at].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

// Flattens one participant's export into a per-table array with pid attached to
// every row.
function flattenForTableCsv(data, table) {
  const pid = data?.participant?.pid;
  if (table === "predictions")    return (data.predictions    || []).map(r => ({ ...r, pid }));
  if (table === "forced_choices") return (data.forced_choices || []).map(r => ({ ...r, pid }));
  if (table === "familiarity")    return (data.familiarity    || []).map(r => ({ ...r, pid }));
  return [];
}

// Flatten the bulk-export structure into per-table arrays with pid attached
// to every row.
function flattenAllForTableCsv(rows, table) {
  const out = [];
  for (const r of rows) {
    const pid = r.participant.pid;
    const arr = (
      table === "predictions"    ? r.predictions    :
      table === "forced_choices" ? r.forced_choices :
      table === "familiarity"    ? r.familiarity    :
      []
    );
    for (const row of (arr || [])) out.push({ ...row, pid });
  }
  return out;
}

// Dispatches to the CSV emitter for the named metacognitive table.
function metacogTableToCsv(rows, table) {
  if (table === "predictions")    return predictionsToCsv(rows);
  if (table === "forced_choices") return forcedChoicesToCsv(rows);
  if (table === "familiarity")    return familiarityToCsv(rows);
  return "";
}

// Serves one participant's export as JSON or CSV for the requested table.
async function handleV2Export(url, request, env) {
  // Auth: Authorization: Bearer <EXPORT_TOKEN>.
  const expected = env?.EXPORT_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "export_disabled", message: "EXPORT_TOKEN secret not configured" }, 500, request, env);
  }
  const authHeader = request.headers.get("Authorization") || "";
  const supplied   = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!supplied || supplied !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401, request, env);
  }

  const pid    = sanitizePid(url.searchParams.get("pid") || "");
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  const table  = (url.searchParams.get("table")  || "trials").toLowerCase();
  if (!pid)                              return jsonResponse({ error: "invalid_pid" }, 400, request, env);
  if (!["json", "csv"].includes(format)) return jsonResponse({ error: "invalid_format" }, 400, request, env);
  if (!VALID_EXPORT_TABLES.has(table))   return jsonResponse({ error: "invalid_table", allowed: [...VALID_EXPORT_TABLES] }, 400, request, env);

  let data;
  try {
    data = await exportParticipantFromD1(env.DB_V2, pid);
  } catch (e) {
    console.error("export error:", e);
    return jsonResponse({ error: "export_failed", message: String(e?.message || e) }, 500, request, env);
  }
  if (!data) {
    return jsonResponse({ error: "not_enrolled", pid }, 404, request, env);
  }

  if (format === "csv") {
    const body = (table === "trials")
      ? exportToCsv(data)
      : metacogTableToCsv(flattenForTableCsv(data, table), table);
    const filename = (table === "trials") ? `${pid}.csv` : `${pid}_${table}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...corsHeaders(request, env),
      },
    });
  }
  return jsonResponse(data, 200, request, env);
}

// ── GET /api/v2/export-all ───────────────────────────────────────────────────
//
// Bulk variant of /api/v2/export. Returns every enrolled participant's full
// data in one response.
//
// Query: ?format=json|csv (default csv)
// Auth:  Authorization: Bearer <EXPORT_TOKEN>
//
// One query per table; the rows are joined in memory in the worker.

// Reads every participant's full record and returns them as an array of the
// same nested shape exportParticipantFromD1 produces.
export async function exportAllFromD1(db) {
  const pRes = await db.prepare(
    `SELECT pid, option_id, enrollment_date, dev_mode, ua, tz, created_at
     FROM participants_v2
     ORDER BY pid ASC`
  ).all();
  const sRes = await db.prepare(
    `SELECT participant_id, ${EXPORT_SESSION_COLS}
     FROM sessions_v2
     ORDER BY participant_id ASC, id ASC`
  ).all();
  const tRes = await db.prepare(
    `SELECT session_id, ${EXPORT_TRIAL_COLS}
     FROM trials_v2
     ORDER BY session_id ASC, trial_order ASC`
  ).all();
  const predRes = await db.prepare(
    `SELECT participant_id, session_label, value, created_at
     FROM pre_session_predictions_v2
     ORDER BY participant_id ASC, created_at ASC`
  ).all();
  const fcRes = await db.prepare(
    `SELECT participant_id, checkpoint, choice, confidence, created_at
     FROM forced_choices_v2
     ORDER BY participant_id ASC, created_at ASC`
  ).all();
  const famRes = await db.prepare(
    `SELECT participant_id, checkpoint, item_id, group_id, feature, full_name, value, created_at
     FROM familiarity_ratings_v2
     ORDER BY participant_id ASC, created_at ASC`
  ).all();

  const participants = pRes.results     || [];
  const sessionsAll  = sRes.results     || [];
  const trialsAll    = tRes.results     || [];
  const predsAll     = predRes.results  || [];
  const fcAll        = fcRes.results    || [];
  const famAll       = famRes.results   || [];

  // Build the nested structure: participant -> sessions -> trials, plus the
  // three metacognitive arrays bucketed per participant.
  const byPid = new Map();
  for (const p of participants) {
    byPid.set(p.pid, {
      participant:    p,
      sessions:       [],
      predictions:    [],
      forced_choices: [],
      familiarity:    [],
    });
  }
  const sessionById = new Map();
  for (const s of sessionsAll) {
    const entry = byPid.get(s.participant_id);
    if (!entry) continue;  // session with no matching participant row
    const { participant_id, ...rest } = s;
    const sessionObj = { ...rest, trials: [] };
    entry.sessions.push(sessionObj);
    sessionById.set(s.id, sessionObj);
  }
  for (const t of trialsAll) {
    const sessionObj = sessionById.get(t.session_id);
    if (!sessionObj) continue;
    const { session_id, ...rest } = t;
    sessionObj.trials.push(rest);
  }
  for (const r of predsAll) {
    const entry = byPid.get(r.participant_id);
    if (!entry) continue;
    const { participant_id, ...rest } = r;
    entry.predictions.push(rest);
  }
  for (const r of fcAll) {
    const entry = byPid.get(r.participant_id);
    if (!entry) continue;
    const { participant_id, ...rest } = r;
    entry.forced_choices.push(rest);
  }
  for (const r of famAll) {
    const entry = byPid.get(r.participant_id);
    if (!entry) continue;
    const { participant_id, ...rest } = r;
    entry.familiarity.push(rest);
  }

  return Array.from(byPid.values());
}

// Renders the bulk export as flat CSV. Takes the array of
// { participant, sessions: [{ ..., trials: [...] }] } produced by
// exportAllFromD1 and emits every participant's trials under one header.
function exportAllToCsv(rows) {
  const headers = [
    "pid", "option_id", "enrollment_date", "dev_mode", "participant_tz",
    "session_id", "session_label", "phase", "group_practiced",
    "session_started_at", "session_completed_at", "session_context",
    "trial_id", "item_id", "group_id", "feature", "full_name", "qtype",
    "raw_answer", "correct", "rt_ms", "review_ms",
    "stim_on_ts", "stim_off_ts", "trial_order",
    "timed_out", "retry_attempt", "soft_capped", "confidence", "trial_created_at",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const p = row.participant;
    for (const s of row.sessions) {
      for (const t of s.trials) {
        lines.push([
          p.pid, p.option_id, p.enrollment_date, p.dev_mode, p.tz,
          s.id, s.session_label, s.phase, s.group_practiced,
          s.started_at, s.completed_at, s.session_context,
          t.id, t.item_id, t.group_id, t.feature, t.full_name, t.qtype,
          t.raw_answer, t.correct, t.rt_ms, t.review_ms,
          t.stim_on_ts, t.stim_off_ts, t.trial_order,
          t.timed_out, t.retry_attempt, t.soft_capped, t.confidence, t.created_at,
        ].map(csvCell).join(","));
      }
    }
  }
  return lines.join("\n") + "\n";
}

// Serves every participant's export as JSON or CSV for the requested table.
async function handleV2ExportAll(url, request, env) {
  const expected = env?.EXPORT_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "export_disabled", message: "EXPORT_TOKEN secret not configured" }, 500, request, env);
  }
  const authHeader = request.headers.get("Authorization") || "";
  const supplied   = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!supplied || supplied !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401, request, env);
  }

  const format = (url.searchParams.get("format") || "csv").toLowerCase();
  const table  = (url.searchParams.get("table")  || "trials").toLowerCase();
  if (!["json", "csv"].includes(format))     return jsonResponse({ error: "invalid_format" }, 400, request, env);
  if (!VALID_EXPORT_TABLES.has(table))       return jsonResponse({ error: "invalid_table", allowed: [...VALID_EXPORT_TABLES] }, 400, request, env);

  let rows;
  try {
    rows = await exportAllFromD1(env.DB_V2);
  } catch (e) {
    console.error("export-all error:", e);
    return jsonResponse({ error: "export_failed", message: String(e?.message || e) }, 500, request, env);
  }

  if (format === "csv") {
    const stamp = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
    const body = (table === "trials")
      ? exportAllToCsv(rows)
      : metacogTableToCsv(flattenAllForTableCsv(rows, table), table);
    const filename = (table === "trials")
      ? `chemflashcards_all_${stamp}.csv`
      : `chemflashcards_all_${table}_${stamp}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...corsHeaders(request, env),
      },
    });
  }
  return jsonResponse({ n_participants: rows.length, participants: rows }, 200, request, env);
}

// ── GET /api/v2/list-participants ────────────────────────────────────────────
//
// Returns a roster of enrolled participants with a per-participant session
// count.
//
// Auth: Authorization: Bearer <EXPORT_TOKEN>
// Returns: { n_participants: N, participants: [{ pid, option_id,
//            enrollment_date, dev_mode, n_sessions }] } sorted by
//            enrollment_date DESC (most recent first).

// Reads the participant roster and the session count for each participant.
// The two tables are queried separately and n_sessions is computed in JS.
export async function listParticipantsFromD1(db) {
  const pRes = await db.prepare(
    `SELECT pid, option_id, enrollment_date, dev_mode
     FROM participants_v2
     ORDER BY enrollment_date DESC, pid ASC`
  ).all();
  const cRes = await db.prepare(
    `SELECT participant_id, COUNT(*) AS n
     FROM sessions_v2
     GROUP BY participant_id`
  ).all();
  const counts = new Map();
  for (const r of (cRes.results || [])) counts.set(r.participant_id, r.n);
  return (pRes.results || []).map(p => ({
    ...p,
    n_sessions: counts.get(p.pid) || 0,
  }));
}

// Serves the participant roster to a caller holding EXPORT_TOKEN.
async function handleV2ListParticipants(request, env) {
  const expected = env?.EXPORT_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "export_disabled", message: "EXPORT_TOKEN secret not configured" }, 500, request, env);
  }
  const authHeader = request.headers.get("Authorization") || "";
  const supplied   = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!supplied || supplied !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401, request, env);
  }

  try {
    const participants = await listParticipantsFromD1(env.DB_V2);
    return jsonResponse({ n_participants: participants.length, participants }, 200, request, env);
  } catch (e) {
    console.error("list-participants error:", e);
    return jsonResponse({ error: "list_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// ── GET /api/v2/debrief?pid=X ────────────────────────────────────────────────
//
// Participant-facing data feed for the Day-14 debrief screen. Returns the
// shape the debrief UI needs in one round-trip:
//   - per-session score (first-attempt-correct for practice; total-correct for tests)
//   - predictions, postdictions, forced-choice answers
//   - Set A / Set B actual scores on each test checkpoint, mapped per the
//     participant's spaced/massed counterbalance assignment
//   - the Set-A-is-spaced / Set-B-is-massed mapping itself, so the frontend
//     can label things without re-deriving from option_id
//
// No bearer token is required. The endpoint is keyed by participant id and
// returns only that participant's own data.

// Reads the rows behind the debrief screen and aggregates them in JS: a
// per-session score summary, the predictions and forced choices, and the Set A
// and Set B scores on the delayed test. Returns null if the id is not enrolled.
export async function getDebriefDataFromD1(db, pid) {
  const participant = await db.prepare(
    `SELECT pid, option_id, enrollment_date, dev_mode, ua, tz, created_at
     FROM participants_v2 WHERE pid = ?`
  ).bind(pid).first();
  if (!participant) return null;

  // Pull the raw rows for the participant.
  const sessionsRes = await db.prepare(
    `SELECT ${EXPORT_SESSION_COLS} FROM sessions_v2
     WHERE participant_id = ?
     ORDER BY id ASC`
  ).bind(pid).all();

  const trialsRes = await db.prepare(
    `SELECT session_id, ${EXPORT_TRIAL_COLS} FROM trials_v2
     WHERE participant_id = ?
     ORDER BY session_id ASC, trial_order ASC`
  ).bind(pid).all();

  const predRes = await db.prepare(
    `SELECT session_label, value, created_at
     FROM pre_session_predictions_v2
     WHERE participant_id = ?
     ORDER BY created_at ASC`
  ).bind(pid).all();

  const fcRes = await db.prepare(
    `SELECT checkpoint, choice, confidence, created_at
     FROM forced_choices_v2
     WHERE participant_id = ?
     ORDER BY created_at ASC`
  ).bind(pid).all();

  const sessions = sessionsRes.results || [];
  const trials   = trialsRes.results   || [];

  // Bucket trials by session id.
  const trialsBySession = new Map();
  for (const t of trials) {
    if (!trialsBySession.has(t.session_id)) trialsBySession.set(t.session_id, []);
    trialsBySession.get(t.session_id).push(t);
  }

  // Per-session score summary. first_attempt_correct counts trials with
  // retry_attempt === 1 and correct === 1, and n_items counts distinct item_ids.
  // On the single-pass sessions (pretest and delayed) every trial has
  // retry_attempt 1, so first_attempt_correct equals total_correct.
  const sessionSummaries = sessions.map(s => {
    const sTrials = trialsBySession.get(s.id) || [];
    const uniqueItems = new Set(sTrials.map(t => t.item_id));
    let firstPassCorrect = 0;
    let totalCorrect     = 0;
    for (const t of sTrials) {
      if (t.correct === 1) totalCorrect++;
      if (t.correct === 1 && t.retry_attempt === 1) firstPassCorrect++;
    }
    return {
      session_label:          s.session_label,
      phase:                  s.phase,
      group_practiced:        s.group_practiced,
      n_items:                uniqueItems.size,
      first_attempt_correct:  firstPassCorrect,
      total_correct:          totalCorrect,
    };
  });

  // Set A is the participant's spaced group and Set B is the massed group.
  const spacedGroup = participant.option_id === "option1" ? "C-1" : "C-2";
  const massedGroup = participant.option_id === "option1" ? "C-2" : "C-1";

  // Set scores on the delayed posttest: the delayed session's trials bucketed
  // by group_id into Set A and Set B.
  const setScores = {
    day_14_delayed:  { set_a: 0, set_b: 0, n_items_a: 0, n_items_b: 0 },
  };
  for (const s of sessions) {
    let key = null;
    if (s.session_label === "delayed")   key = "day_14_delayed";
    if (!key) continue;
    for (const t of (trialsBySession.get(s.id) || [])) {
      const setLetter = t.group_id === spacedGroup ? "a"
                      : t.group_id === massedGroup ? "b"
                      : null;
      if (!setLetter) continue;
      setScores[key][`n_items_${setLetter}`]++;
      if (t.correct === 1) setScores[key][`set_${setLetter}`]++;
    }
  }

  return {
    pid:            participant.pid,
    option_id:      participant.option_id,
    spaced_group:   spacedGroup,
    massed_group:   massedGroup,
    sessions:       sessionSummaries,
    predictions:    predRes.results  || [],
    forced_choices: fcRes.results    || [],
    set_scores:     setScores,
  };
}

// Serves the debrief summary for one participant id.
async function handleV2Debrief(url, request, env) {
  const pid = sanitizePid(url.searchParams.get("pid") || "");
  if (!pid) return jsonResponse({ error: "invalid_pid" }, 400, request, env);

  try {
    const data = await getDebriefDataFromD1(env.DB_V2, pid);
    if (!data) return jsonResponse({ error: "not_enrolled", pid }, 404, request, env);
    return jsonResponse(data, 200, request, env);
  } catch (e) {
    console.error("debrief error:", e);
    return jsonResponse({ error: "debrief_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// ── GET/POST /api/v2/copy ────────────────────────────────────────────────────
//
// Editable participant-facing copy. The forced-choice prompts and the Day-14
// debrief read their text from copy_strings_v2 at render time, so a key can be
// changed without redeploying the frontend.
//
// GET  /api/v2/copy           — no auth; returns every key as
//                                { strings: { key: value, ... } }, so the client
//                                fetches once at page load.
// POST /api/v2/copy           — bearer-token auth; body {key, value}; updates a
//                                single existing key. Returns 404 unknown_key
//                                if the key is not already in the table.

// Reads every copy string and returns them as a { key: value } object.
export async function listCopyStrings(db) {
  const res = await db.prepare(
    `SELECT key, value FROM copy_strings_v2 ORDER BY key ASC`
  ).all();
  const out = {};
  for (const r of (res.results || [])) out[r.key] = r.value;
  return out;
}

// Serves every copy string to the client.
async function handleV2GetCopy(request, env) {
  try {
    const strings = await listCopyStrings(env.DB_V2);
    return jsonResponse({ strings }, 200, request, env);
  } catch (e) {
    console.error("get-copy error:", e);
    return jsonResponse({ error: "copy_fetch_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// Updates the value of one existing copy string. Returns
// { ok: false, reason: "unknown_key" } if the key is not already in the table.
export async function updateCopyString(db, key, value) {
  const existing = await db.prepare(
    `SELECT 1 AS ok FROM copy_strings_v2 WHERE key = ?`
  ).bind(key).first();
  if (!existing) return { ok: false, reason: "unknown_key" };

  await db.prepare(
    `UPDATE copy_strings_v2
        SET value = ?, updated_at = datetime('now')
      WHERE key = ?`
  ).bind(value, key).run();
  return { ok: true };
}

// Updates one copy string for a caller holding EXPORT_TOKEN.
async function handleV2UpdateCopy(request, env) {
  const expected = env?.EXPORT_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "admin_disabled", message: "EXPORT_TOKEN secret not configured" }, 500, request, env);
  }
  const authHeader = request.headers.get("Authorization") || "";
  const supplied   = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!supplied || supplied !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401, request, env);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json" }, 400, request, env); }

  const key   = sanitizeStr(String(body?.key   ?? ""), 100);
  const value = String(body?.value ?? "");
  if (!key)                      return jsonResponse({ error: "key_required" }, 400, request, env);
  if (value.length > 4000)       return jsonResponse({ error: "value_too_long", max: 4000 }, 400, request, env);

  try {
    const res = await updateCopyString(env.DB_V2, key, value);
    if (!res.ok) return jsonResponse({ error: res.reason, key }, 404, request, env);
    return jsonResponse({ ok: true, key }, 200, request, env);
  } catch (e) {
    console.error("update-copy error:", e);
    return jsonResponse({ error: "update_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// ── POST /metacog/prediction, /metacog/forced-choice, /familiarity ───────────
//
// Save endpoints for the metacognitive measures that fire outside the trial
// loop. Per-item confidence travels with each trial in trials_v2.confidence and
// is handled by /session-complete instead.
//
// All three are:
//   - PID-format and enrollment checked, as session-complete is.
//   - Idempotent on the table's UNIQUE constraint. A second POST returns
//     status "already_saved" and does not overwrite the stored value.
//   - Callable without EXPORT_TOKEN, since the frontend posts them during the
//     participant's session.

// Session labels that accept a pre-session prediction. The test labels
// (pretest, delayed) are not in the set and are rejected.
const V2_PRACTICE_LABELS = new Set([
  "spaced-S1","spaced-S2","spaced-S3","spaced-S4",
  "massed-B1","massed-B2","massed-B3","massed-B4",
]);

// Checkpoints at which a forced choice is recorded, and the accepted answers.
// "day_4_immediate" is the key for the forced choice at the end of Day 4.
const V2_FORCED_CHOICE_CHECKPOINTS = new Set(["day_4_immediate","day_14_delayed"]);
const V2_FORCED_CHOICE_CHOICES     = new Set(["set_a","set_b","same"]);

// Session 0 baseline familiarity ratings. 'spaced_intro' fires before Session 1
// (the spaced list); 'massed_intro' fires on Day 4 after the break (the massed
// list). One rating per Session-1 stimulus, value on a 1..7 bubble scale.
const V2_FAMILIARITY_CHECKPOINTS = new Set(["spaced_intro","massed_intro"]);
const V2_FAMILIARITY_GROUP_IDS   = new Set(["C-1","C-2"]);

// Checks a prediction payload. Returns an array of error strings, or null when
// the payload is valid.
export function validatePredictionPayload(p) {
  const errors = [];
  if (!p || typeof p !== "object")           errors.push("body must be a JSON object");
  if (!p?.pid || typeof p.pid !== "string")  errors.push("pid required (string)");
  if (!V2_PRACTICE_LABELS.has(p?.session_label))
    errors.push(`session_label must be one of ${[...V2_PRACTICE_LABELS].join(",")}`);
  if (!Number.isInteger(p?.value) || p.value < 0 || p.value > 12)
    errors.push("value must be an integer 0..12");
  return errors.length ? errors : null;
}

// Checks a forced-choice payload. Returns an array of error strings, or null
// when the payload is valid.
export function validateForcedChoicePayload(p) {
  const errors = [];
  if (!p || typeof p !== "object")           errors.push("body must be a JSON object");
  if (!p?.pid || typeof p.pid !== "string")  errors.push("pid required (string)");
  if (!V2_FORCED_CHOICE_CHECKPOINTS.has(p?.checkpoint))
    errors.push(`checkpoint must be one of ${[...V2_FORCED_CHOICE_CHECKPOINTS].join(",")}`);
  if (!V2_FORCED_CHOICE_CHOICES.has(p?.choice))
    errors.push(`choice must be one of ${[...V2_FORCED_CHOICE_CHOICES].join(",")}`);
  if (!Number.isInteger(p?.confidence) || p.confidence < 1 || p.confidence > 3)
    errors.push("confidence must be an integer 1..3");
  return errors.length ? errors : null;
}

// Stores one pre-session prediction. Returns status "saved", or "already_saved"
// when a row for this participant and session_label is already present.
export async function savePrediction(db, pid, session_label, value) {
  const res = await db.prepare(
    `INSERT OR IGNORE INTO pre_session_predictions_v2
       (participant_id, session_label, value)
     VALUES (?, ?, ?)`
  ).bind(pid, session_label, value).run();
  return { status: res?.meta?.changes === 1 ? "saved" : "already_saved" };
}

// Stores one forced choice. Returns status "saved", or "already_saved" when a
// row for this participant and checkpoint is already present.
export async function saveForcedChoice(db, pid, checkpoint, choice, confidence) {
  const res = await db.prepare(
    `INSERT OR IGNORE INTO forced_choices_v2
       (participant_id, checkpoint, choice, confidence)
     VALUES (?, ?, ?, ?)`
  ).bind(pid, checkpoint, choice, confidence).run();
  return { status: res?.meta?.changes === 1 ? "saved" : "already_saved" };
}

// Checks a familiarity-rating payload. Returns an array of error strings, or
// null when the payload is valid.
export function validateFamiliarityPayload(p) {
  const errors = [];
  if (!p || typeof p !== "object")                      errors.push("body must be a JSON object");
  if (!p?.pid || typeof p.pid !== "string")             errors.push("pid required (string)");
  if (!V2_FAMILIARITY_CHECKPOINTS.has(p?.checkpoint))
    errors.push(`checkpoint must be one of ${[...V2_FAMILIARITY_CHECKPOINTS].join(",")}`);
  if (!p?.item_id || typeof p.item_id !== "string")     errors.push("item_id required (string)");
  if (!V2_FAMILIARITY_GROUP_IDS.has(p?.group_id))
    errors.push(`group_id must be one of ${[...V2_FAMILIARITY_GROUP_IDS].join(",")}`);
  if (!p?.feature || typeof p.feature !== "string")     errors.push("feature required (string)");
  if (!p?.full_name || typeof p.full_name !== "string") errors.push("full_name required (string)");
  if (!Number.isInteger(p?.value) || p.value < 1 || p.value > 7)
    errors.push("value must be an integer 1..7");
  return errors.length ? errors : null;
}

// Stores one familiarity rating, where rating is
// { checkpoint, item_id, group_id, feature, full_name, value }. UNIQUE
// (participant_id, item_id) with INSERT OR IGNORE keeps the first value stored
// for an item, so a re-shown screen returns status "already_saved".
export async function saveFamiliarity(db, pid, rating) {
  const { checkpoint, item_id, group_id, feature, full_name, value } = rating;
  const res = await db.prepare(
    `INSERT OR IGNORE INTO familiarity_ratings_v2
       (participant_id, checkpoint, item_id, group_id, feature, full_name, value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(pid, checkpoint, item_id, group_id, feature, full_name, value).run();
  return { status: res?.meta?.changes === 1 ? "saved" : "already_saved" };
}

// Shared pre-flight for the three metacog POSTs: parse JSON, sanitize PID,
// format-check, enrollment-check. Returns {ok: true, body} or {ok: false,
// response} where the response is the 4xx to short-circuit with.
async function metacogPreflight(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return { ok: false, response: jsonResponse({ error: "invalid_json" }, 400, request, env) }; }

  if (body && typeof body.pid === "string") body.pid = sanitizePid(body.pid);
  if (!body?.pid) return { ok: false, response: jsonResponse({ error: "invalid_pid" }, 400, request, env) };
  if (!v2DeriveOption(body.pid)) {
    return { ok: false, response: jsonResponse({ error: "invalid_pid_format" }, 400, request, env) };
  }

  const enrolled = await checkEnrollment(env.DB_V2, body.pid);
  if (!enrolled) {
    return { ok: false, response: jsonResponse({ error: "not_enrolled", pid: body.pid }, 404, request, env) };
  }

  return { ok: true, body };
}

// Validates and stores a pre-session prediction.
async function handleV2MetacogPrediction(request, env) {
  const pf = await metacogPreflight(request, env);
  if (!pf.ok) return pf.response;

  const errors = validatePredictionPayload(pf.body);
  if (errors) return jsonResponse({ error: "invalid_payload", details: errors }, 400, request, env);

  try {
    const result = await savePrediction(env.DB_V2, pf.body.pid, pf.body.session_label, pf.body.value);
    return jsonResponse(result, 200, request, env);
  } catch (e) {
    console.error("prediction save error:", e);
    return jsonResponse({ error: "save_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// Validates and stores a forced-choice response.
async function handleV2MetacogForcedChoice(request, env) {
  const pf = await metacogPreflight(request, env);
  if (!pf.ok) return pf.response;

  const errors = validateForcedChoicePayload(pf.body);
  if (errors) return jsonResponse({ error: "invalid_payload", details: errors }, 400, request, env);

  try {
    const result = await saveForcedChoice(
      env.DB_V2, pf.body.pid, pf.body.checkpoint, pf.body.choice, pf.body.confidence,
    );
    return jsonResponse(result, 200, request, env);
  } catch (e) {
    console.error("forced-choice save error:", e);
    return jsonResponse({ error: "save_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// Validates and stores one baseline familiarity rating.
async function handleV2Familiarity(request, env) {
  const pf = await metacogPreflight(request, env);
  if (!pf.ok) return pf.response;

  const errors = validateFamiliarityPayload(pf.body);
  if (errors) return jsonResponse({ error: "invalid_payload", details: errors }, 400, request, env);

  try {
    const result = await saveFamiliarity(env.DB_V2, pf.body.pid, pf.body);
    return jsonResponse(result, 200, request, env);
  } catch (e) {
    console.error("familiarity save error:", e);
    return jsonResponse({ error: "save_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// ── POST /api/v2/feedback  +  GET /api/v2/feedback  +  POST /api/v2/feedback/resolve ──
//
// The tester edit-request ("feedback") feature. A tester running under a DEV id
// pins notes to page elements and submits them; the notes are listed and marked
// resolved from admin.html.
//
// All three endpoints write only to edit_requests_v2. That table has no foreign
// key to the study tables and no analysis path reads it.
//
//   POST /api/v2/feedback          open  — submit a batch of pins
//   GET  /api/v2/feedback          token — list requests (optional ?resolved=0|1)
//   POST /api/v2/feedback/resolve  token — mark one (id) or a batch (batch_id) done

const V2_FEEDBACK_MAX_PINS      = 50;    // pins per submission
const V2_FEEDBACK_MAX_NOTE_LEN  = 2000;  // a single note
const V2_FEEDBACK_MAX_PAGE_LEN  = 200;
const V2_FEEDBACK_MAX_URL_LEN   = 500;
const V2_FEEDBACK_MAX_SHORT_LEN = 500;   // selector / element_text / selected_text

// Returns the id that groups the pins submitted together, using
// crypto.randomUUID where it is available and a timestamp-plus-random token
// otherwise.
function newBatchId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Checks an edit-request payload. Returns an array of error strings, or null
// when the payload is valid.
export function validateEditRequestPayload(p) {
  const errors = [];
  if (!p || typeof p !== "object")            errors.push("body must be a JSON object");
  if (!p?.pid || typeof p.pid !== "string")   errors.push("pid required (string)");
  // Feedback is accepted only from a DEV id.
  else if (!v2IsDev(p.pid))                   errors.push("pid must be a DEV id (feedback is tester-only)");
  if (!p?.page || typeof p.page !== "string") errors.push("page required (string)");
  if (!Array.isArray(p?.pins) || p.pins.length === 0) {
    errors.push("pins required (non-empty array)");
  } else if (p.pins.length > V2_FEEDBACK_MAX_PINS) {
    errors.push(`pins exceeds ${V2_FEEDBACK_MAX_PINS}`);
  } else {
    p.pins.forEach((pin, i) => {
      if (!pin || typeof pin !== "object") { errors.push(`pin[${i}] must be an object`); return; }
      if (!pin.note || typeof pin.note !== "string" || !pin.note.trim()) {
        errors.push(`pin[${i}].note required (non-empty string)`);
      } else if (pin.note.length > V2_FEEDBACK_MAX_NOTE_LEN) {
        errors.push(`pin[${i}].note exceeds ${V2_FEEDBACK_MAX_NOTE_LEN}`);
      }
    });
  }
  return errors.length ? errors : null;
}

// Inserts one row per pin, all sharing batch_id, where meta is
// { pid, reporter, page, page_url, viewport, ua }. Uses db.batch when the
// binding provides it and runs the statements in sequence otherwise.
export async function saveEditRequests(db, batch_id, meta, pins) {
  const stmts = pins.map(pin => db.prepare(
    `INSERT INTO edit_requests_v2
       (batch_id, pid, reporter, page, page_url, viewport, ua,
        note, selector, element_text, selected_text, pos)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    batch_id, meta.pid, meta.reporter ?? null, meta.page, meta.page_url ?? null,
    meta.viewport ?? null, meta.ua ?? null,
    pin.note, pin.selector ?? null, pin.element_text ?? null,
    pin.selected_text ?? null, pin.pos ?? null,
  ));
  if (typeof db.batch === "function") {
    await db.batch(stmts);
  } else {
    for (const s of stmts) await s.run();
  }
  return { batch_id, n_saved: pins.length };
}

// Reads edit requests, newest first. resolved: null = all, 0 = open only,
// 1 = resolved only.
export async function listEditRequests(db, { resolved = null } = {}) {
  let sql = `SELECT id, batch_id, created_at, pid, reporter, page, page_url,
                    viewport, ua, note, selector, element_text, selected_text,
                    pos, resolved, resolved_at
             FROM edit_requests_v2`;
  const binds = [];
  if (resolved === 0 || resolved === 1) { sql += ` WHERE resolved = ?`; binds.push(resolved); }
  sql += ` ORDER BY created_at DESC, id DESC`;
  const stmt = db.prepare(sql);
  const res  = await (binds.length ? stmt.bind(...binds) : stmt).all();
  return res.results || [];
}

// Mark a single request (by id) or a whole batch (by batch_id) resolved /
// reopened. Returns { n_changed }.
export async function markEditRequestResolved(db, { id = null, batch_id = null, resolved = 1 }) {
  const val = resolved ? 1 : 0;
  const at  = val ? new Date().toISOString() : null;
  if (id != null) {
    const res = await db.prepare(
      `UPDATE edit_requests_v2 SET resolved = ?, resolved_at = ? WHERE id = ?`
    ).bind(val, at, id).run();
    return { n_changed: res?.meta?.changes ?? 0 };
  }
  if (batch_id != null) {
    const res = await db.prepare(
      `UPDATE edit_requests_v2 SET resolved = ?, resolved_at = ? WHERE batch_id = ?`
    ).bind(val, at, batch_id).run();
    return { n_changed: res?.meta?.changes ?? 0 };
  }
  return { n_changed: 0 };
}

// Validates a batch of pins and stores one edit-request row per pin.
async function handleV2FeedbackSubmit(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json" }, 400, request, env); }

  // Normalize the participant id. Enrollment is not checked here; the id is
  // stored as context only.
  if (body && typeof body.pid === "string") body.pid = sanitizePid(body.pid);

  const errors = validateEditRequestPayload(body);
  if (errors) return jsonResponse({ error: "invalid_payload", details: errors }, 400, request, env);

  // Truncate every field before insert. The user agent is read from the request.
  const meta = {
    pid:      body.pid,
    reporter: body.reporter != null ? sanitizeStr(body.reporter, 100) : null,
    page:     sanitizeStr(body.page, V2_FEEDBACK_MAX_PAGE_LEN),
    page_url: body.page_url != null ? sanitizeStr(body.page_url, V2_FEEDBACK_MAX_URL_LEN) : null,
    viewport: body.viewport != null ? sanitizeStr(body.viewport, 32) : null,
    ua:       sanitizeStr(request.headers.get("User-Agent") || "", 500),
  };
  const pins = body.pins.map(pin => ({
    note:          sanitizeStr(pin.note, V2_FEEDBACK_MAX_NOTE_LEN),
    selector:      pin.selector      != null ? sanitizeStr(pin.selector,      V2_FEEDBACK_MAX_SHORT_LEN) : null,
    element_text:  pin.element_text  != null ? sanitizeStr(pin.element_text,  V2_FEEDBACK_MAX_SHORT_LEN) : null,
    selected_text: pin.selected_text != null ? sanitizeStr(pin.selected_text, V2_FEEDBACK_MAX_SHORT_LEN) : null,
    pos:           pin.pos           != null ? sanitizeStr(String(pin.pos), 32) : null,
  }));

  try {
    const result = await saveEditRequests(env.DB_V2, newBatchId(), meta, pins);
    return jsonResponse({ status: "saved", ...result }, 200, request, env);
  } catch (e) {
    console.error("feedback submit error:", e);
    return jsonResponse({ error: "save_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// Serves the edit-request list to a caller holding EXPORT_TOKEN.
async function handleV2FeedbackList(url, request, env) {
  const expected = env?.EXPORT_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "admin_disabled", message: "EXPORT_TOKEN secret not configured" }, 500, request, env);
  }
  const authHeader = request.headers.get("Authorization") || "";
  const supplied   = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!supplied || supplied !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401, request, env);
  }

  const rParam   = url.searchParams.get("resolved");
  const resolved = rParam === "0" ? 0 : rParam === "1" ? 1 : null;
  try {
    const requests = await listEditRequests(env.DB_V2, { resolved });
    return jsonResponse({ n: requests.length, requests }, 200, request, env);
  } catch (e) {
    console.error("feedback list error:", e);
    return jsonResponse({ error: "list_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// Marks one edit request or a whole batch resolved or reopened for a caller
// holding EXPORT_TOKEN.
async function handleV2FeedbackResolve(request, env) {
  const expected = env?.EXPORT_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "admin_disabled", message: "EXPORT_TOKEN secret not configured" }, 500, request, env);
  }
  const authHeader = request.headers.get("Authorization") || "";
  const supplied   = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!supplied || supplied !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401, request, env);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json" }, 400, request, env); }

  const id       = Number.isInteger(body?.id) ? body.id : null;
  const batch_id = typeof body?.batch_id === "string" ? sanitizeStr(body.batch_id, 64) : null;
  if (id == null && !batch_id) {
    return jsonResponse({ error: "id_or_batch_id_required" }, 400, request, env);
  }
  // Default to resolving; pass resolved:false / resolved:0 to reopen.
  const resolved = (body?.resolved === 0 || body?.resolved === false) ? 0 : 1;

  try {
    const result = await markEditRequestResolved(env.DB_V2, { id, batch_id, resolved });
    return jsonResponse({ ok: true, ...result }, 200, request, env);
  } catch (e) {
    console.error("feedback resolve error:", e);
    return jsonResponse({ error: "resolve_failed", message: String(e?.message || e) }, 500, request, env);
  }
}

// ── End v2 endpoints ─────────────────────────────────────────────────────────


// Match a request origin against an allowed-origin pattern. Supports:
//   "*"                           — match anything (dev only)
//   "https://example.com"         — exact match
//   "https://*.example.com"       — wildcard subdomain match
//
// Wildcard match accepts any single-or-multi-label subdomain in front of
// the suffix, so "https://*.chemflashcards.pages.dev" matches both
// "https://abc123.chemflashcards.pages.dev" and "https://x.y.chemflashcards.pages.dev".
function originMatches(requestOrigin, pattern) {
  if (pattern === "*") return true;
  if (pattern === requestOrigin) return true;
  if (pattern.startsWith("https://*.")) {
    const suffix = pattern.slice("https://*.".length);
    return requestOrigin.startsWith("https://")
        && requestOrigin.endsWith("." + suffix)
        && requestOrigin.length > ("https://." + suffix).length;
  }
  return false;
}

// Builds the CORS response headers. ALLOWED_ORIGIN is a comma-separated list
// whose entries are literal origins or wildcard patterns (see originMatches).
// A request whose origin matches an entry is echoed back; one that matches none
// receives the first entry instead.
function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin") || "";
  let allowedOrigin = "*";

  if (env?.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== "*") {
    const allowed = env.ALLOWED_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
    const matched = allowed.find(p => originMatches(requestOrigin, p));
    allowedOrigin = matched ? requestOrigin : (allowed[0] || "*");
  }

  return {
    "Access-Control-Allow-Origin":  allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

// ── POST /api/v2/verify-session-password ──────────────────────────────────────
//
// Body: { password }.  Returns: { ok: true } | { ok: false }.
//
// Gates the in-lab delayed test. The password is the Worker secret
// LAB_SESSION_PASSWORD, which is never sent to the client, and no attempt is
// recorded. When the secret is unset the endpoint returns 500 rather than
// opening the gate.

// Compares the supplied password against the LAB_SESSION_PASSWORD secret.
// Returns true, false, or the string "not_configured" when the secret is unset.
export function verifySessionPassword(env, supplied) {
  const expected = env?.LAB_SESSION_PASSWORD;
  if (!expected) return "not_configured";
  const s = (typeof supplied === "string" ? supplied : "").trim();
  return s.length > 0 && s === expected;
}

// Checks the posted password against the LAB_SESSION_PASSWORD secret.
async function handleV2VerifySessionPassword(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json" }, 400, request, env); }

  const result = verifySessionPassword(env, body?.password);
  if (result === "not_configured") {
    // The secret is not set, so the request is refused.
    return jsonResponse({ ok: false, error: "password_not_configured" }, 500, request, env);
  }
  return jsonResponse({ ok: result === true }, 200, request, env);
}

// Serializes data as a JSON response with the given status and the CORS headers.
function jsonResponse(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}
