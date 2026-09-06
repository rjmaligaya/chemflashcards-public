/**
 * session-gate.js — pre-flight check for entry to a session page.
 *
 * Each session page (spaced-session 1-3, delayed) calls `gateSessionEntry`
 * BEFORE starting the trial loop. The gate:
 *   1. Hits /api/v2/status for the PID.
 *   2. Confirms the participant is enrolled (404 → blocked).
 *   3. Checks timing: the LOWER inter-session bound is a hard block (too early
 *      → "come back later"); the UPPER bound is advisory (a missed day is
 *      allowed and flagged, never blocked); and a missing SEQUENCE prerequisite
 *      blocks. The in-lab delayed test opts out of all three (advisoryTiming).
 *      DEV PIDs bypass the whole timing check.
 *   4. Confirms none of the requested session(s) have already been
 *      completed (repeat protection; DEV PIDs ARE NOT BYPASSED).
 *
 * The repeat check takes a list of session labels. The Day-4 composite does
 * not route through this gate: day4-page.js runs its own resume-aware gating,
 * skipping already-saved sub-sessions and blocking only once the whole day
 * (massed-B4) is recorded.
 *
 * DEV path: a DEV PID skips the timing check but is still subject to the
 * repeat check, so a session_label that has been recorded for that PID stays
 * blocked. When the blocked PID is a DEV id the returned message carries an
 * extra hint, and gateSessionEntry logs a console warning; neither is shown
 * for a real participant, whose dev_mode is false.
 *
 * `evaluateGate` is the pure decision function (exported for tests).
 * `gateSessionEntry` is the network-bound wrapper used by pages.
 */

import { SESSION_FLOW, evaluateTiming } from "./routing-v2.js";
import { workerUrl, API } from "./config-v2.js";

/**
 * Pure decision function. Takes a parsed /api/v2/status response and the
 * session the participant is trying to enter, and returns whether entry is
 * allowed.
 *
 *   status                — parsed body of /api/v2/status
 *   expectedSessionLabels — one or more labels. For non-Day-4 pages this
 *                           is a single-element array; for Day-4 it's
 *                           every sub-session label.
 *   expectedPhase         — "pretest" | "spaced" | "day4" | "delayed"
 *   expectedSessionId     — for "spaced", the session number (1-3);
 *                           for "day4" it's 4; otherwise null.
 *   now                   — Date for "today" computation (defaults to new Date())
 *
 * Returns { ok: true } or { ok: false, message: string }.
 */
export function evaluateGate({ status, expectedSessionLabels, expectedPhase, expectedSessionId, now = new Date() }) {
  if (!Array.isArray(expectedSessionLabels) || expectedSessionLabels.length === 0) {
    return { ok: false, message: "Gate misconfigured (no expectedSessionLabels)." };
  }

  // 1. Repeat check. A session label already present in sessions_completed is
  // blocked, for DEV PIDs as well. A DEV PID additionally receives the hint
  // text appended below.
  const completedSet = new Set((status.sessions_completed || []).map(s => s.session_label));
  const alreadyDone = expectedSessionLabels.find(l => completedSet.has(l));
  if (alreadyDone) {
    const baseMsg = `This session has already been recorded (${alreadyDone}). It cannot be repeated. Please contact the researcher if you believe this is an error.`;
    const devHint = status.dev_mode
      ? `\n\nDEV mode: to re-run this session you have two options:\n  (a) Use a fresh DEV PID (e.g. 01-DEV02 instead of 01-DEV01) — same parity, no prior data.\n  (b) Delete the existing rows:\n      wrangler d1 execute ssp-study-02 --remote --command "DELETE FROM trials_v2 WHERE participant_id='${status.pid}' AND session_id IN (SELECT id FROM sessions_v2 WHERE participant_id='${status.pid}' AND session_label='${alreadyDone}')"\n      wrangler d1 execute ssp-study-02 --remote --command "DELETE FROM sessions_v2 WHERE participant_id='${status.pid}' AND session_label='${alreadyDone}'"`
      : "";
    return { ok: false, message: baseMsg + devHint };
  }

  // 2. Timing check (ISI-based: each session unlocks a fixed number of hours
  //    after the previous one completed). DEV PIDs bypass.
  if (!status.dev_mode) {
    const step = SESSION_FLOW.find(
      s => s.phase === expectedPhase && s.sessionId === expectedSessionId
    );
    if (!step) {
      return { ok: false, message: "This session is not recognised. Please start from the landing page." };
    }
    const completedMap = new Map(
      (status.sessions_completed || []).map(s => [s.session_label, s.completed_at])
    );
    const timing = evaluateTiming(step, completedMap, now);
    if (!timing.ok) {
      return { ok: false, message: timing.message };
    }
    // An off-schedule entry (a gap beyond the 28h window) is allowed through.
    // The gap remains readable from the stored completed_at timestamps.
  }

  return { ok: true };
}

/**
 * Fetches /api/v2/status with a bounded retry.
 *
 * Retry policy: retries only on a network or transport error, or on a 5xx
 * response. A 4xx, including a 404 for a PID that is not enrolled, is returned
 * immediately and never retried.
 *
 * Returns { res }, where res is the final Response, which may be a 5xx when
 * every attempt failed, or null when every attempt hit a network error.
 */
const STATUS_MAX_ATTEMPTS = 4;      // 1 initial try + 3 retries
const STATUS_BACKOFF_MS   = 1000;   // linear: waits 1s, 2s, 3s between tries

export async function fetchStatusWithRetry(pid) {
  const url = workerUrl(API.STATUS) + "?pid=" + encodeURIComponent(pid);
  let lastRes = null;
  for (let attempt = 1; attempt <= STATUS_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, STATUS_BACKOFF_MS * (attempt - 1)));
    }
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      // Network or transport failure: retry while attempts remain, otherwise
      // return a null response.
      if (attempt === STATUS_MAX_ATTEMPTS) return { res: null };
      continue;
    }
    // 5xx responses are retried while attempts remain; a 2xx or 4xx is final
    // and returned straight away.
    if (res.status >= 500 && attempt < STATUS_MAX_ATTEMPTS) {
      lastRes = res;
      continue;
    }
    return { res };
  }
  return { res: lastRes };
}

/**
 * Network-bound gate. Fetches /api/v2/status and runs evaluateGate.
 *
 * Returns { ok: true } if entry is allowed, or { ok: false, message } if not.
 * A network, HTTP or parse failure also returns { ok: false, message }, so the
 * page shows an error rather than proceeding.
 */
export async function gateSessionEntry({ pid, expectedSessionLabels, expectedPhase, expectedSessionId }) {
  if (!pid) {
    return { ok: false, message: "No participant ID. Please start from the landing page." };
  }

  // A null res means every attempt hit a network error.
  const { res } = await fetchStatusWithRetry(pid);
  if (!res) {
    return { ok: false, message: "Could not reach the study server. Please check your connection and try again." };
  }
  if (res.status === 404) {
    return { ok: false, message: "You are not enrolled. Please start from the landing page." };
  }
  if (!res.ok) {
    return { ok: false, message: `Could not verify your session status (HTTP ${res.status}). Please contact the researcher.` };
  }

  let status;
  try { status = await res.json(); }
  catch { return { ok: false, message: "Could not parse the study server's response. Please contact the researcher." }; }

  // Console notice logged whenever a DEV PID is used. Real participants have
  // dev_mode false, so nothing is logged for them.
  if (status.dev_mode && typeof console !== "undefined") {
    console.warn(
      `[session-gate] DEV mode active for ${status.pid}. Day check bypassed; ` +
      `repeat check still enforced. To re-run a completed session, switch to ` +
      `a fresh DEV suffix (e.g. ${status.pid.replace(/\d*$/, "")}02) or delete ` +
      `the session_v2 + trials_v2 rows via wrangler. See public/session-gate.js ` +
      `header comment for the exact commands.`
    );
  }

  return evaluateGate({ status, expectedSessionLabels, expectedPhase, expectedSessionId });
}
