/**
 * spaced-session-page.js — shared loader for spaced-practice sessions 1-3.
 *
 * Each of study-session1.html, study-session2.html, study-session3.html
 * imports this and calls runSpacedSessionPage(sessionId). The page handles
 *   1. Parsing the PID from the URL query string.
 *   2. Deriving the participant's counterbalance option from PID parity.
 *   3. Loading items_v2.csv and filtering to today's session.
 *   4. Shuffling the items into a fully randomised order.
 *   5. Running the trial loop via practice-engine.startSession.
 *
 * Session 4 is a composite of the spaced session and the massed blocks and
 * uses its own loader, day4-page.js, not this file.
 */

import { deriveOption, isDevMode } from "./routing-v2.js";
import {
  loadItems, pickSessionItems, shuffle, startSession,
} from "./practice-engine.js";
import { saveSessionToWorker, buildSessionPayload } from "./session-save.js";
import { gateSessionEntry } from "./session-gate.js";
import { showPredictionWidget } from "./prediction-widget.js";
import { savePrediction } from "./metacog-save.js";
import { runSession0Tutorial } from "./session0-tutorial.js";

// Replaces the page with a warning message and a link back to study.html.
function failWithMessage(msg) {
  document.getElementById("practice-app").innerHTML = `
    <p class="warn" style="max-width:600px;margin:80px auto;text-align:center;">
      ${msg} <a href="study.html">Return to start</a>
    </p>
  `;
}

// Runs one spaced practice session (1 to 3): reads the PID, gates entry,
// loads and filters the items, shows the tutorial before session 1 and the
// prediction prompt, then runs the trial loop and saves the session.
export async function runSpacedSessionPage(sessionId) {
  if (![1, 2, 3].includes(sessionId)) {
    return failWithMessage(`Invalid session number: ${sessionId}.`);
  }

  // 1. PID from URL.
  const params = new URLSearchParams(window.location.search);
  const pid    = params.get("pid") || "";
  if (!pid) return failWithMessage("No participant ID. Please start from the landing page.");

  // 2. Counterbalance option from PID parity. The derivation is deterministic
  //    and matches the option the worker stored at enrollment.
  const option = deriveOption(pid);
  if (!option) return failWithMessage("Participant ID format not recognised.");

  // 3. Gate: confirms the participant is enrolled, that the inter-session
  //    timing allows this session, and that it has not already been recorded.
  //    DEV PIDs bypass the timing check but not the repeat check.
  const gate = await gateSessionEntry({
    pid,
    expectedSessionLabels: [`spaced-S${sessionId}`],
    expectedPhase: "spaced",
    expectedSessionId: sessionId,
  });
  if (!gate.ok) return failWithMessage(gate.message);

  // 4. Load items.
  let items;
  try { items = await loadItems("items_v2.csv"); }
  catch (e) { return failWithMessage("Could not load study items. " + e.message); }

  // 5. Filter to this spaced session and shuffle (fully randomised).
  const sessionItems = pickSessionItems({
    items, optionId: option, sessionId, phase: "spaced",
  });
  if (!sessionItems.length) {
    return failWithMessage(`No items found for ${option} spaced session ${sessionId}.`);
  }
  shuffle(sessionItems);

  // 6. Run the session with mastery looping.
  const container = document.getElementById("practice-app");
  container.innerHTML = "";  // clear the "Loading..." placeholder

  // Session 0 tutorial for the spaced list, shown before session 1 only: the
  // diagram-reading primer, 12 baseline familiarity ratings, then the 7 topic
  // lessons. It writes familiarity_ratings_v2 rows only, idempotently, and
  // creates no sessions_v2 row, so the gate and routing are unaffected. A
  // tutorial error is logged to the console and the session continues.
  if (sessionId === 1) {
    try {
      await runSession0Tutorial(container, {
        pid, optionId: option, schedule: "spaced",
        checkpoint: "spaced_intro", items, includeSkeletalPrimer: true,
      });
    } catch (e) {
      console.error("[spaced-S1] Session 0 tutorial error:", e);
    }
    container.innerHTML = "";
  }

  // Per-session metadata sent with the save at the end of the session.
  const sessionStartedAt = new Date().toISOString();
  const tz               = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  const groupPracticed   = (option === "option1") ? "C-1" : "C-2";
  const sessionLabel     = `spaced-S${sessionId}`;

  // 6a. Pre-session prediction, shown before the first trial. A failed save
  //     is logged to the console and the session continues.
  try {
    const predValue = await showPredictionWidget(container, {
      promptKey: "prediction_prompt",
      titleKey:  "prediction_title",
      ctaKey:    "prediction_cta",
    });
    try {
      await savePrediction(pid, sessionLabel, predValue);
    } catch (e) {
      console.error(`[${sessionLabel}] prediction save failed:`, e);
    }
  } catch (e) {
    console.error(`[${sessionLabel}] prediction widget error:`, e);
  }

  await startSession({
    container,
    items: sessionItems,
    sessionLabel,
    // Participant-facing title. The internal label stored in the database
    // remains `spaced-S${sessionId}`.
    sessionTitle: `Practice session ${sessionId}`,
    showFeedback: true,
    showTimer:    true,
    timerMs:      20000,
    masteryLoop:  true,
    // The neutral summary style confirms the session was saved and shows no
    // accuracy, response-time or mastery information.
    summaryStyle: "neutral",
    guardBeforeUnload: !isDevMode(pid),
    onComplete: async (summary) => {
      const payload = buildSessionPayload(summary, {
        pid,
        session_label:   sessionLabel,
        phase:           "spaced",
        group_practiced: groupPracticed,
        started_at:      sessionStartedAt,
        completed_at:    new Date().toISOString(),
        device_w:        window.innerWidth,
        device_h:        window.innerHeight,
        tz,
        session_context: "online",
      });
      const result = await saveSessionToWorker(payload);
      console.log("session saved:", result);
    },
  });
}
