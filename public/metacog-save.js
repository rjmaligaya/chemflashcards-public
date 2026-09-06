/**
 * metacog-save.js — POST helpers for the metacognitive measures that are
 * collected outside the trial loop.
 *
 *   savePrediction(pid, session_label, value)        -> /api/v2/metacog/prediction
 *   saveForcedChoice(pid, checkpoint, choice, conf)  -> /api/v2/metacog/forced-choice
 *   saveFamiliarity(pid, rating)                     -> /api/v2/familiarity
 *
 * Each helper retries up to 3 times with linear backoff, matching
 * session-save's policy. The worker endpoints are idempotent on their UNIQUE
 * constraints: a second call for the same row returns
 * `{status: "already_saved"}` and does not overwrite the first value.
 *
 * On final failure they throw, and the caller decides whether to block the
 * session or carry on.
 */

import { workerUrl, API } from "./config-v2.js";

const DEFAULTS = { maxAttempts: 3, backoffMs: 1000 };

// POSTs a JSON body to the given URL and returns the parsed response,
// retrying on failure and throwing once the attempts run out.
async function postJson(url, body, opts = {}) {
  const { maxAttempts, backoffMs } = { ...DEFAULTS, ...opts };
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, backoffMs * (attempt - 1)));
    }
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        let err = {};
        try { err = await res.json(); } catch {}
        const bits = [err.error, err.message, Array.isArray(err.details) ? err.details.join("; ") : err.details].filter(Boolean);
        throw new Error(bits.join(" / ") || `http_${res.status}`);
      }
      return await res.json();   // { status: "saved" | "already_saved" }
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("metacog_save_failed");
}

// Saves a participant's pre-session prediction for one session label.
export function savePrediction(pid, session_label, value) {
  return postJson(workerUrl(API.METACOG_PREDICTION), { pid, session_label, value });
}

// Saves a forced-choice answer and its confidence rating for one checkpoint.
export function saveForcedChoice(pid, checkpoint, choice, confidence) {
  return postJson(workerUrl(API.METACOG_FORCED), { pid, checkpoint, choice, confidence });
}

// Saves one Session-0 baseline familiarity rating of 1 to 7. The rating object
// is { checkpoint, item_id, group_id, feature, full_name, value }. The
// endpoint is idempotent on (participant_id, item_id).
export function saveFamiliarity(pid, rating) {
  return postJson(workerUrl(API.METACOG_FAMILIARITY), { pid, ...rating });
}
