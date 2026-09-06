/**
 * pretest-page.js — Day-0 in-lab pretest (24 Q-blank items, silent, single-pass).
 *
 * The test:
 *   - 24 items, one per feature (12 from C-1 + 12 from C-2).
 *   - Q-blank format only.
 *   - No feedback shown (silent test).
 *   - Single pass, no mastery loop.
 *   - In-lab and supervised. The participant sees it once.
 *
 * Item selection:
 *   The session-1 exemplars from items_v2.csv, one molecule per feature.
 *   The same molecules appear again in spaced practice session 1. They do
 *   not overlap with the delayed posttest, which uses session-4 Q-blank
 *   exemplars and session 2-3 Q-full exemplars.
 */

import { deriveOption, isDevMode } from "./routing-v2.js";
import {
  loadItems, pickSessionItems, shuffle, startSession,
} from "./practice-engine.js";
import { saveSessionToWorker, buildSessionPayload } from "./session-save.js";
import { gateSessionEntry } from "./session-gate.js";

/* Replaces the page body with a warning message and a link back to the start. */
function fail(msg) {
  document.getElementById("practice-app").innerHTML = `
    <p class="warn" style="max-width:600px;margin:80px auto;text-align:center;">
      ${msg} <a href="study.html">Return to start</a>
    </p>
  `;
}

/* Entry point for pretest.html: validates the PID, checks the session gate,
 * builds the 24-item set, runs the silent test, and saves the result. */
export async function runPretestPage() {
  // 1. PID + option.
  const params = new URLSearchParams(window.location.search);
  const pid    = params.get("pid") || "";
  if (!pid) return fail("No participant ID. Please start from the landing page.");

  const option = deriveOption(pid);
  if (!option) return fail("Participant ID format not recognised.");

  // 2. Gate: pretest is only available on Day 0 and only once. DEV PIDs
  //    bypass the day check.
  const gate = await gateSessionEntry({
    pid,
    expectedSessionLabels: ["pretest"],
    expectedPhase: "pretest",
    expectedSessionId: null,
  });
  if (!gate.ok) return fail(gate.message);

  // 3. Load items.
  let items;
  try { items = await loadItems("items_v2.csv"); }
  catch (e) { return fail("Could not load study items. " + e.message); }

  // 4. Build the 24-item pretest set: session-1 exemplars from both groups.
  //    Independent of the participant's option (everyone sees all 24 features
  //    at baseline).
  const c1 = items.filter(it => it.group === "C-1" && Number(it.session) === 1);
  const c2 = items.filter(it => it.group === "C-2" && Number(it.session) === 1);
  if (c1.length !== 12 || c2.length !== 12) {
    return fail(`Expected 12 + 12 = 24 pretest items, got ${c1.length} + ${c2.length}. Check items_v2.csv.`);
  }
  const pretestItems = shuffle([...c1, ...c2]);

  // 5. Run the session: silent, single-pass.
  const container        = document.getElementById("practice-app");
  container.innerHTML    = "";
  const sessionStartedAt = new Date().toISOString();
  const tz               = Intl.DateTimeFormat().resolvedOptions().timeZone || null;

  await startSession({
    container,
    items: pretestItems,
    sessionLabel:  "pretest",
    sessionTitle:  "Pretest",
    masteryLoop:   false,   // single-pass; no retries
    showFeedback:  false,   // silent — no sound, no button morph, no panel
    showTimer:     true,
    timerMs:       20000,
    summaryStyle:  "silent",
    guardBeforeUnload: !isDevMode(pid),
    onTrial: (t) => { /* per-trial logging hook reserved */ },
    onComplete: async (summary) => {
      const payload = buildSessionPayload(summary, {
        pid,
        session_label:   "pretest",
        phase:           "pretest",
        group_practiced: null,        // covers both groups
        started_at:      sessionStartedAt,
        completed_at:    new Date().toISOString(),
        device_w:        window.innerWidth,
        device_h:        window.innerHeight,
        tz,
        session_context: "in_person", // in-lab session
      });
      const result = await saveSessionToWorker(payload);
      console.log("pretest saved:", result);
    },
    summaryCta: { text: "Finish for today", href: "study.html" },
  });
}
