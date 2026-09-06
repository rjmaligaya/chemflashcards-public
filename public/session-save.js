/**
 * session-save.js — POST a session's data to the worker, with retry.
 *
 * Used by spaced-session-page.js and day4-page.js inside each phase's
 * `onComplete` callback.
 *
 * Retry policy: up to 3 attempts with linear backoff (1s, then 2s). The worker
 * endpoint is idempotent on `UNIQUE (participant_id, session_label)` in
 * sessions_v2, so a retry after a partial commit does not duplicate a row.
 *
 * On final failure it throws, and the calling page shows the error through the
 * summary card's "Save failed" state.
 */

import { workerUrl, API } from "./config-v2.js";

const DEFAULTS = {
  maxAttempts: 3,
  backoffMs:   1000,   // attempt N waits N * backoffMs before retrying
};

// POSTs a session-complete payload to the worker and returns the parsed
// response. Retries per the policy above and throws once attempts run out.
export async function saveSessionToWorker(payload, opts = {}) {
  const { maxAttempts, backoffMs } = { ...DEFAULTS, ...opts };
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, backoffMs * (attempt - 1)));
    }
    if (attempt === 1) {
      // Logs a summary of the payload once, on the first attempt only.
      console.log("[session-save] POSTing session-complete:",
        { pid: payload.pid, session_label: payload.session_label, n_trials: payload.trials?.length });
    }
    try {
      const res = await fetch(workerUrl(API.SESSION_COMPLETE), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let err = {};
        try { err = await res.json(); } catch {}
        // The worker returns { error, message, details } on failure. The raw
        // response is logged and the three fields are joined into the thrown
        // error message.
        console.error(`[session-save] worker ${res.status}:`, err);
        const bits = [err.error, err.message, Array.isArray(err.details) ? err.details.join("; ") : err.details].filter(Boolean);
        throw new Error(bits.join(" / ") || `http_${res.status}`);
      }
      return await res.json();   // { session_id, n_trials_saved, status }
    } catch (e) {
      // Keeps the error and moves on to the next attempt, if any remain.
      lastError = e;
    }
  }

  throw lastError || new Error("save_failed");
}

/**
 * Builds the session-complete payload from a startSession summary, mapping
 * each trial to the field names the worker expects.
 *   summary: returned by startSession (contains trials[], nMastered, etc.)
 *   meta:    { pid, session_label, phase, group_practiced, started_at,
 *              completed_at, tz, device_w, device_h }
 */
export function buildSessionPayload(summary, meta) {
  return {
    pid:             meta.pid,
    session_label:   meta.session_label,
    phase:           meta.phase,
    group_practiced: meta.group_practiced ?? null,
    started_at:      meta.started_at,
    completed_at:    meta.completed_at,
    device_w:        meta.device_w ?? null,
    device_h:        meta.device_h ?? null,
    tz:              meta.tz ?? null,
    session_context: meta.session_context ?? "online",
    trials:          summary.trials.map((t, i) => ({
      item_id:       t.item_id,
      group_id:      t.group,
      feature:       t.feature,
      full_name:     t.full_name,
      qtype:         t.qtype,
      raw_answer:    t.raw_answer,
      correct:       t.correct === true ? 1 : t.correct === false ? 0 : null,
      rt_ms:         t.rt_ms,
      review_ms:     t.review_ms ?? null,
      stim_on_ts:    t.stim_on_ts,
      stim_off_ts:   t.stim_off_ts,
      trial_order:   t.trial_order ?? (i + 1),
      timed_out:     !!t.timed_out,
      retry_attempt: t.retry_attempt ?? 1,
      soft_capped:   !!t.soft_capped,
      // Per-item confidence rating of 1 to 4, set by practice-engine.js when
      // the confidence prompt runs and null on trials where it does not.
      confidence:    Number.isInteger(t.confidence) ? t.confidence : null,
    })),
  };
}
