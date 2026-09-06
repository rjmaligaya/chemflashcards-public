/**
 * posttest-delayed-page.js — Day-14 in-lab delayed posttest.
 *
 * The test:
 *   - 36 items from delayed_posttest_v2.csv:
 *       24 Q-blank from session-4 exemplars (12 from each group)
 *       12 Q-full  from session 2-3 exemplars (6 from each group)
 *   - No feedback shown (silent test).
 *   - Single pass, no mastery loop.
 *   - In-lab. The Tobii eye-tracker records gaze in parallel, and the
 *     stimulus on/off timestamps captured by runTrial in practice-engine.js
 *     (`stim_on_ts`, `stim_off_ts`) let the two streams be merged offline.
 *
 * Item selection:
 *   The CSV is the single source of truth. Q-blank and Q-full items are
 *   shuffled together, so the format of the next item is not visible until
 *   its prompt renders. The mix and the per-format answer UI are handled
 *   inside startSession via the `qtype` field on each item.
 *
 * Day-14 forced choice (metacognitive layer):
 *   Fires after the delayed test and before the results screen, and
 *   identifies the two sets by example names rather than by practice
 *   schedule.
 */

import { deriveOption, isDevMode } from "./routing-v2.js";
import {
  loadItems, shuffle, startSession,
} from "./practice-engine.js";
import { saveSessionToWorker, buildSessionPayload } from "./session-save.js";
import { gateSessionEntry } from "./session-gate.js";
import { workerUrl, API } from "./config-v2.js";
import { showForcedChoiceWidget, pickSetExamples } from "./forced-choice-widget.js";
import { saveForcedChoice } from "./metacog-save.js";
import { showDebriefScreen } from "./debrief-page.js";

/* Replaces the page body with a warning message and a link back to the start. */
function fail(msg) {
  document.getElementById("practice-app").innerHTML = `
    <p class="warn" style="max-width:600px;margin:80px auto;text-align:center;">
      ${msg} <a href="study.html">Return to start</a>
    </p>
  `;
}

/**
 * In-lab session password gate. Renders a password prompt and resolves only
 * when the correct password is entered. Verification happens server-side, so
 * the password does not live in this file. A wrong or empty password, a server
 * misconfiguration, and a network error each show a message and re-prompt:
 * there is no lockout, no attempt record, and no retry limit. The caller skips
 * this for DEV PIDs.
 */
function promptSessionPassword(container) {
  return new Promise((resolve) => {
    container.innerHTML = `
      <section class="card" style="max-width:460px;margin:80px auto;padding:32px;">
        <h2 style="margin-top:0;">Session password</h2>
        <p>This is an in-lab session. Please have the researcher enter the session password to begin.</p>
        <form id="pw-form" autocomplete="off">
          <input id="pw-input" type="password" autocomplete="off" aria-label="Session password"
                 style="width:100%;padding:10px;font-size:1rem;box-sizing:border-box;" />
          <p id="pw-error" class="warn" role="alert" aria-live="polite" hidden style="margin:12px 0 0;"></p>
          <button id="pw-submit" class="btn btn--primary" type="submit" style="margin-top:16px;">Begin session</button>
        </form>
      </section>
    `;
    const form    = container.querySelector("#pw-form");
    const input   = container.querySelector("#pw-input");
    const errorEl = container.querySelector("#pw-error");
    const submit  = container.querySelector("#pw-submit");

    // Shows the inline error line above the submit button.
    function showError(msg) { errorEl.textContent = msg; errorEl.hidden = false; }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      submit.disabled = true;
      submit.textContent = "Checking…";

      let ok = false, notConfigured = false, networkError = false;
      try {
        const res = await fetch(workerUrl(API.VERIFY_PASSWORD), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: input.value }),
        });
        if (res.status >= 500) {
          notConfigured = true;   // secret unset (fail-closed) or server error
        } else {
          const data = await res.json().catch(() => ({}));
          ok = data.ok === true;
        }
      } catch { networkError = true; }

      submit.disabled = false;
      submit.textContent = "Begin session";

      if (ok) { resolve(); return; }

      if (notConfigured)     showError("This session isn't set up yet. Please contact the researcher.");
      else if (networkError) showError("Could not reach the study server. Check the connection and try again.");
      else                   showError("Incorrect password. Please try again.");
      input.value = "";
      input.focus();
    });

    setTimeout(() => input.focus(), 30);
  });
}

/* Entry point for posttest-delayed.html: validates the PID, runs the in-lab
 * password gate and the session gate, runs the 36-item silent test, saves it,
 * then shows the forced choice and the debrief. */
export async function runPosttestDelayedPage() {
  // 1. PID + option.
  const params = new URLSearchParams(window.location.search);
  const pid    = params.get("pid") || "";
  if (!pid) return fail("No participant ID. Please start from the landing page.");

  const option = deriveOption(pid);
  if (!option) return fail("Participant ID format not recognised.");

  const container = document.getElementById("practice-app");
  if (!container) return fail("Page failed to load.");

  // 1b. In-lab password gate (server-verified). The prompt loops until the
  //     correct password is entered, and nothing below runs until then.
  //     DEV PIDs skip it.
  if (!isDevMode(pid)) {
    await promptSessionPassword(container);
  }

  // Set A is always the spaced group and Set B the massed group in the
  // participant-facing scheme. These identify which stimulus group supplies
  // the example names in the forced-choice prompt.
  const spacedGroup = (option === "option1") ? "C-1" : "C-2";
  const massedGroup = (option === "option1") ? "C-2" : "C-1";

  // 2. Gate: delayed posttest is only available in its window (about one week
  //    after Day 4) and only once. DEV PIDs bypass the day check.
  const gate = await gateSessionEntry({
    pid,
    expectedSessionLabels: ["delayed"],
    expectedPhase: "delayed",
    expectedSessionId: null,
  });
  if (!gate.ok) return fail(gate.message);

  // 3. Load the curated 36-item delayed set.
  let items;
  try { items = await loadItems("delayed_posttest_v2.csv"); }
  catch (e) { return fail("Could not load the delayed posttest items. " + e.message); }

  if (items.length !== 36) {
    return fail(`Expected 36 delayed-posttest items, got ${items.length}. Check delayed_posttest_v2.csv.`);
  }

  // 4. Normalize the item shape so it matches what runTrial expects.
  //    delayed_posttest_v2.csv columns: item_id, group, qtype, session, target_set, feature, full_name
  //    runTrial reads: item_id, group, feature, full_name, qtype
  //    Already lined up. No transformation needed beyond shuffle.
  const delayedItems = shuffle([...items]);

  // 4b. Example names that identify each set in the post-test forced choice.
  //     Taken from the full practice pool (items_v2.csv), falling back to the
  //     delayed set if that load fails. Selection follows CSV order, so these
  //     are the same examples the Day-4 prompt used.
  let practiceItems = [];
  try { practiceItems = await loadItems("items_v2.csv"); }
  catch (e) { console.warn("[delayed] items_v2 load for examples failed; using delayed set", e); }
  const exampleSource = practiceItems.length ? practiceItems : items;
  const examplesA = pickSetExamples(exampleSource, spacedGroup);
  const examplesB = pickSetExamples(exampleSource, massedGroup);

  // 5. Run the session.
  container.innerHTML    = "";
  const sessionStartedAt = new Date().toISOString();
  const tz               = Intl.DateTimeFormat().resolvedOptions().timeZone || null;

  await startSession({
    container,
    items: delayedItems,
    sessionLabel:  "delayed",
    sessionTitle:  "Delayed test",
    masteryLoop:   false,
    showFeedback:  false,
    showTimer:     true,
    timerMs:       20000,
    summaryStyle:  "silent",
    guardBeforeUnload: !isDevMode(pid),
    onTrial: (t) => { /* per-trial logging hook reserved */ },
    onComplete: async (summary) => {
      const payload = buildSessionPayload(summary, {
        pid,
        session_label:   "delayed",
        phase:           "delayed",
        group_practiced: null,         // covers both groups
        started_at:      sessionStartedAt,
        completed_at:    new Date().toISOString(),
        device_w:        window.innerWidth,
        device_h:        window.innerHeight,
        tz,
        session_context: "in_person",  // in-lab, eye-tracker session
      });
      const result = await saveSessionToWorker(payload);
      console.log("delayed posttest saved:", result);
    },
    // After the silent posttest summary: ask the Day-14 forced choice, then
    // show the debrief screen. The debrief fetches the participant's results,
    // predictions, and forced-choice answers, and navigates to study.html when
    // they click its own dismiss button. A failed forced-choice save is logged
    // and the debrief still opens.
    summaryCta: {
      text: "Continue",
      onClick: async () => {
        try {
          const fc = await showForcedChoiceWidget(container, {
            promptKey: "forced_choice_day14_prompt",
            examplesA,
            examplesB,
          });
          try { await saveForcedChoice(pid, "day_14_delayed", fc.choice, fc.confidence); }
          catch (e) { console.error("[day_14_delayed] forced-choice save failed:", e); }
        } catch (e) {
          console.error("[day_14_delayed] forced-choice widget error:", e);
        }
        showDebriefScreen(container, pid);
      },
    },
  });
}
