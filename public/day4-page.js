/**
 * day4-page.js — Day-4 composite engine.
 *
 * Orchestrates the within-page state machine:
 *   1. Intro screen ("Welcome to Day 4")
 *   2. Spaced session 4              (12 items, spaced group, mastery loop, feedback)
 *   3. Hard-blocked 5-minute break   (countdown timer; Continue disabled until 0:00)
 *   4. Massed block 1                (12 items, massed group, session 1 exemplars, mastery loop, feedback)
 *   5. Transition (soft)
 *   6. Massed block 2                (session 2 exemplars)
 *   7. Transition
 *   8. Massed block 3                (session 3 exemplars)
 *   9. Transition
 *   10. Massed block 4               (session 4 exemplars)
 *   11. Day-4 forced-choice prompt
 *   12. Day-complete screen
 *
 * The spaced session always runs before the massed blocks, the massed blocks
 * run in the fixed order 1 to 4, the 5-minute break is hard-blocked (Continue
 * stays disabled until the timer expires), and the day ends after the fourth
 * massed block.
 *
 * Each sub-session is saved on its own as it completes, and the page is
 * resumable: sub-sessions already recorded are skipped on re-entry.
 */

import { deriveOption, isDevMode, SESSION_FLOW, evaluateTiming, PHASES } from "./routing-v2.js";
import {
  loadItems, pickSessionItems, shuffle, startSession,
  installBeforeUnloadGuard, removeBeforeUnloadGuard,
} from "./practice-engine.js";
import { saveSessionToWorker, buildSessionPayload } from "./session-save.js";
import { showPredictionWidget } from "./prediction-widget.js";
import { showForcedChoiceWidget, pickSetExamples } from "./forced-choice-widget.js";
import { savePrediction, saveForcedChoice } from "./metacog-save.js";
import { fetchStatusWithRetry } from "./session-gate.js";
import { runSession0Tutorial } from "./session0-tutorial.js";

const BREAK_MS                = 5 * 60 * 1000;   // 5 minutes

// Returns the string with HTML-special characters replaced by entities.
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Replaces the page with a warning message and a link back to study.html.
function fail(msg) {
  document.getElementById("practice-app").innerHTML = `
    <p class="warn" style="max-width:600px;margin:80px auto;text-align:center;">
      ${msg} <a href="study.html">Return to start</a>
    </p>
  `;
}

/* ── Interstitial screens ───────────────────────────────────────────────────
 * renderInterstitial(container, opts) -> Promise that resolves on advance.
 *   opts.title         : h2 string
 *   opts.bodyHtml      : body content (already-escaped HTML)
 *   opts.ctaText       : button label (default "Continue")
 *   opts.waitMs        : ms before button enables; 0 = instant
 *   opts.showCountdown : if true, render a visible mm:ss countdown
 *   opts.allowSkip     : if true (DEV mode), render a corner skip button
 *                        that immediately ends the countdown and enables CTA
 */
function renderInterstitial(container, opts) {
  const { title, bodyHtml, ctaText = "Continue", waitMs = 0, showCountdown = false, allowSkip = false } = opts;
  return new Promise(resolve => {
    const skipBtnHtml = (allowSkip && waitMs > 0)
      ? `<button class="interstitial-skip" type="button" title="Skip the timer (DEV mode only)">Skip timer (DEV)</button>`
      : "";

    container.innerHTML = `
      <section class="card interstitial-card">
        <header class="card__header">
          <h2 class="card__title">${escapeHtml(title)}</h2>
        </header>
        <div class="card__body">
          ${bodyHtml}
          ${showCountdown ? `<p class="interstitial-countdown" aria-live="polite">${fmtTime(waitMs)}</p>` : ""}
        </div>
        <div class="card__footer">
          <button class="btn btn--primary interstitial-cta" type="button"${waitMs > 0 ? " disabled" : ""}>${escapeHtml(ctaText)}</button>
        </div>
      </section>
      ${skipBtnHtml}
    `;
    const cta       = container.querySelector(".interstitial-cta");
    const countdown = container.querySelector(".interstitial-countdown");
    const skipBtn   = container.querySelector(".interstitial-skip");

    let tick = null;
    // Stops the countdown, enables and focuses the CTA, and removes the DEV
    // skip button.
    function endCountdown() {
      if (tick) { clearInterval(tick); tick = null; }
      if (countdown) countdown.textContent = "Ready";
      cta.disabled = false;
      cta.focus();
      if (skipBtn) skipBtn.remove();
    }

    if (waitMs > 0) {
      let remaining = waitMs;
      tick = setInterval(() => {
        remaining -= 1000;
        if (countdown) countdown.textContent = remaining > 0 ? fmtTime(remaining) : "Ready";
        if (remaining <= 0) endCountdown();
      }, 1000);
    } else {
      setTimeout(() => cta.focus(), 20);
    }

    if (skipBtn) {
      skipBtn.addEventListener("click", endCountdown, { once: true });
    }

    cta.addEventListener("click", () => resolve(), { once: true });
  });
}

// Formats a duration in milliseconds as m:ss.
function fmtTime(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/* ── Per-phase runners ──────────────────────────────────────────────────────
 * Each one mounts a fresh session shell, runs trials, and returns the summary.
 * The CTA is wired so clicking it resolves runPhase's Promise; the orchestrator
 * then advances to the next phase.
 *
 * For practice phases (showFeedback === true) the runner shows a pre-session
 * prediction prompt before the trial loop and saves it via
 * /api/v2/metacog/prediction. A failed prediction save is logged to the
 * console and the phase continues. Test phases (showFeedback === false) skip
 * the prompt; on Day 4 every phase is a practice phase.
 */
async function runPhase(container, { items, sessionLabel, sessionTitle, phase, groupPracticed, masteryLoop, showFeedback, ctaText, onTrial, pid, tz, summaryStyle }) {
  // Mount a fresh container shell so each phase starts clean.
  container.innerHTML = '<div id="phase-shell"></div>';
  const phaseShell = container.querySelector("#phase-shell");
  const startedAt  = new Date().toISOString();

  // Pre-session prediction (practice phases only).
  if (showFeedback) {
    try {
      const predValue = await showPredictionWidget(phaseShell, {
        promptKey: "prediction_prompt",
        titleKey:  "prediction_title",
        ctaKey:    "prediction_cta",
      });
      try { await savePrediction(pid, sessionLabel, predValue); }
      catch (e) { console.error(`[${sessionLabel}] prediction save failed:`, e); }
    } catch (e) {
      console.error(`[${sessionLabel}] prediction widget error:`, e);
    }
  }

  // capturedSummary is set when startSession resolves, which happens after the
  // summary card has rendered and the save has finished. The CTA click handler
  // reads it when the participant continues to the next phase.
  return new Promise(resolve => {
    let capturedSummary = null;
    startSession({
      container: phaseShell,
      items,
      sessionLabel,
      sessionTitle,
      masteryLoop,
      showFeedback,
      showTimer:   true,
      timerMs:     20000,
      summaryStyle,
      onTrial,
      onComplete: async (summary) => {
        const payload = buildSessionPayload(summary, {
          pid,
          session_label:   sessionLabel,
          phase,
          group_practiced: groupPracticed,
          started_at:      startedAt,
          completed_at:    new Date().toISOString(),
          device_w:        window.innerWidth,
          device_h:        window.innerHeight,
          tz,
          session_context: "online",
        });
        const result = await saveSessionToWorker(payload);
        console.log(`[${sessionLabel}] saved:`, result);
      },
      summaryCta: { text: ctaText, onClick: () => resolve(capturedSummary) },
    }).then(summary => { capturedSummary = summary; });
  });
}

/* ── Main orchestrator ──────────────────────────────────────────────────────*/

// Runs the whole Day-4 flow: reads the PID, gates and resumes, then steps
// through the intro, spaced session 4, the break, the tutorial, the four
// massed blocks, the forced-choice prompt and the day-complete screen.
export async function runDay4Page() {
  // 1. PID + option
  const params = new URLSearchParams(window.location.search);
  const pid    = params.get("pid") || "";
  if (!pid) return fail("No participant ID. Please start from the landing page.");
  const option = deriveOption(pid);
  if (!option) return fail("Participant ID format not recognised.");
  const guardOn = !isDevMode(pid);

  const container = document.getElementById("practice-app");
  if (!container) return fail("Page failed to load.");

  // Gate and resume. Day 4 is a five-part composite (spaced-S4 plus four
  // massed blocks) saved one sub-session at a time. If the page reloads part
  // way through, this fetch reports which sub-sessions are already saved and
  // the flow below skips them, so the participant carries on from where they
  // stopped. The one hard stop is a day that is already finished, marked by
  // massed-B4. Enrollment is still required.
  let completedSet = new Set();
  const completedMap = new Map();
  let devMode = false;
  try {
    // Fetches the participant's status with a bounded retry on 5xx and network
    // errors. A null res means every attempt hit a network error.
    const { res } = await fetchStatusWithRetry(pid);
    if (res && res.status === 404) {
      return fail("You are not enrolled. Please start from the landing page.");
    }
    if (res && res.ok) {
      const status = await res.json();
      devMode = !!status.dev_mode;
      for (const s of (status.sessions_completed || [])) {
        completedSet.add(s.session_label);
        completedMap.set(s.session_label, s.completed_at);
      }
    }
    // Any non-404 error falls through with an empty set, so the flow runs as
    // if nothing were completed. The worker's saves are idempotent, so a
    // re-done sub-session does not create a duplicate row.
  } catch {
    // Network failure: continue with an empty set.
  }

  // Already finished the whole day? Nothing to resume.
  if (completedSet.has("massed-B4")) {
    return fail("You have already completed your final practice day. Your next visit is the in-lab delayed test; the lab will be in touch.");
  }

  const spacedDone    = completedSet.has("spaced-S4");
  const anyMassedDone = [1, 2, 3, 4].some(n => completedSet.has(`massed-B${n}`));
  const resuming      = spacedDone || anyMassedDone;

  // Fresh-entry timing gate. On a first entry, with nothing in this composite
  // recorded yet, the 20h-after-S3 lower bound applies as a hard block, the
  // same as for the other practice sessions. It is skipped on a resume and for
  // DEV PIDs. A gap beyond 28h is allowed through and flagged off-schedule.
  if (!resuming && !devMode) {
    const step = SESSION_FLOW.find(s => s.phase === PHASES.DAY4 && s.sessionId === 4);
    const timing = evaluateTiming(step, completedMap, new Date());
    if (!timing.ok) return fail(timing.message);
  }

  // Guards the whole composite, so closing the tab during the break or a
  // transition also warns the participant. startSession installs its own
  // ref-counted guard around each trial loop inside this one.
  if (guardOn) installBeforeUnloadGuard();

  // Metadata reused across all phases for session-save payloads.
  const tz          = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  const spacedGroup = (option === "option1") ? "C-1" : "C-2";
  const massedGroup = (option === "option1") ? "C-2" : "C-1";

  try {

  // 2. Load all practice items.
  let items;
  try {
    items = await loadItems("items_v2.csv");
  } catch (e) {
    return fail("Could not load study items. " + e.message);
  }

  // Per-trial console logging and a running trial count. Trials themselves are
  // saved per phase by runPhase's onComplete via saveSessionToWorker; this
  // counter is not saved anywhere.
  let totalTrials = 0;
  const onTrial = (sessionLabel) => (trial) => {
    totalTrials++;
    console.log(`[${sessionLabel}] trial:`, trial);
  };

  // Phase A: the Day-4 intro screen, or a "welcome back" screen when the day
  // is being resumed.
  if (resuming) {
    await renderInterstitial(container, {
      title: "Welcome back — let's finish your last practice day",
      bodyHtml: `
        <p>It looks like this day was interrupted earlier. That's okay: we'll pick up right where you left off and skip anything you already finished.</p>
        <p>You can step away and come back at any time; your progress is saved after each part.</p>
      `,
      ctaText: "Continue",
    });
  } else {
    await renderInterstitial(container, {
      title: "Day 4: your last practice day",
      bodyHtml: `
        <p>Today you'll work through two parts:</p>
        <ol>
          <li><strong>A final practice session</strong> on one set of terms (about 8 minutes).</li>
          <li>After a short break and a brief introduction to the second set, <strong>four practice blocks</strong> on that set (about 30 to 40 minutes total, with brief transitions).</li>
        </ol>
        <p>There is a mandatory 5-minute break between the practice session and the introduction to the second set.</p>
        <p>Total time: about 45 to 60 minutes. Plan to complete it in one sitting.</p>
      `,
      ctaText: "Begin",
    });
  }

  // Phase B: spaced session 4, then the mandatory 5-minute break. Both are
  // skipped when spaced-S4 is already recorded.
  if (!spacedDone) {
    const sessionItems = shuffle(pickSessionItems({
      items, optionId: option, sessionId: 4, phase: "spaced",
    }));
    if (!sessionItems.length) return fail("No items found for the spaced session 4.");
    await runPhase(container, {
      items: sessionItems,
      sessionLabel: "spaced-S4",
      // Participant-facing title. Internal label "spaced-S4" stays in the DB.
      sessionTitle: "Practice session 4 (final)",
      phase: "spaced",
      groupPracticed: spacedGroup,
      masteryLoop: true,
      showFeedback: true,
      summaryStyle: "neutral",
      ctaText: "Continue to break",
      onTrial: onTrial("spaced-S4"),
      pid, tz,
    });

    // Phase C: the hard-blocked 5-minute break, with a skip button under a DEV
    // PID. The Continue button stays disabled until the timer reaches zero and
    // then waits for a click; the screen never advances on its own.
    await renderInterstitial(container, {
      title: "5-minute break",
      bodyHtml: `
        <p>Please take a 5-minute break before continuing. Stand up, hydrate, stretch, look away from the screen.</p>
        <p>The button below will activate when the timer reaches zero. <strong>Take as long as you need after that</strong> — nothing happens until you choose to continue, and it's safe to step away and come back to this page.</p>
      `,
      ctaText: "I'm ready — start the practice blocks",
      waitMs: BREAK_MS,
      showCountdown: true,
      allowSkip: isDevMode(pid),
    });
  }

  // Session 0 tutorial for the massed list, shown after the break and before
  // the first massed block. It matches the session 1 tutorial but omits the
  // skeletal-structure primer. It writes familiarity_ratings_v2 rows only,
  // idempotently, and creates no sessions_v2 row. It is skipped when any
  // massed block is already recorded.
  if (!anyMassedDone) {
    try {
      await runSession0Tutorial(container, {
        pid, optionId: option, schedule: "massed",
        checkpoint: "massed_intro", items, includeSkeletalPrimer: false,
      });
    } catch (e) {
      console.error("[massed_intro] Session 0 tutorial error:", e);
    }
  }

  // Phases D-G: Massed blocks 1-4. On a resume, any block already saved is
  // skipped so the participant continues from the first unfinished one.
  for (let blockNum = 1; blockNum <= 4; blockNum++) {
    if (completedSet.has(`massed-B${blockNum}`)) continue;
    const blockItems = shuffle(pickSessionItems({
      items, optionId: option, sessionId: blockNum, phase: "massed",
    }));
    if (!blockItems.length) return fail(`No items found for massed block ${blockNum}.`);
    const isLast = blockNum === 4;
    await runPhase(container, {
      items: blockItems,
      sessionLabel: `massed-B${blockNum}`,
      // Participant-facing title. Internal label "massed-B${blockNum}" stays in the DB.
      sessionTitle: `Practice block ${blockNum} of 4`,
      phase: "massed",
      groupPracticed: massedGroup,
      masteryLoop: true,
      showFeedback: true,
      summaryStyle: "neutral",
      ctaText: isLast ? "Continue" : `Continue to block ${blockNum + 1}`,
      onTrial: onTrial(`massed-B${blockNum}`),
      pid, tz,
    });
    if (!isLast) {
      // No separate interstitial is shown between blocks: the summary card
      // and its "Continue to block N" button serve as the transition.
    }
  }

  // Phase H: the Day-4 forced-choice prompt, shown right after the final
  // massed block. It asks which of the two sets the participant expects to
  // remember better at the delayed test, plus a 3-level confidence rating. A
  // failed save is logged to the console and the day still reaches the done
  // screen. The checkpoint key for this prompt is "day_4_immediate".
  try {
    const fc = await showForcedChoiceWidget(container, {
      promptKey: "forced_choice_day4_prompt",
      examplesA: pickSetExamples(items, spacedGroup),
      examplesB: pickSetExamples(items, massedGroup),
    });
    try { await saveForcedChoice(pid, "day_4_immediate", fc.choice, fc.confidence); }
    catch (e) { console.error("[day_4_immediate] forced-choice save failed:", e); }
  } catch (e) {
    console.error("[day_4_immediate] forced-choice widget error:", e);
  }

  // Phase I: the day-complete screen. The card shows the wrap-up message only,
  // with no trial counts or performance information. The totalTrials counter
  // is written to the console below instead.
  container.innerHTML = `
    <section class="card card--success" style="max-width:560px;margin:80px auto;padding:32px;">
      <h2 style="margin-top:0;">All done for today</h2>
      <p>Thank you for completing Day 4.</p>
      <p>Your next visit is the <strong>delayed test in the lab, about one week from now</strong>. The lab will be in touch with the exact date and time.</p>
      <a class="btn btn--primary" href="study.html">Return to start</a>
    </section>
  `;

  console.log("Day 4 complete. Total trials:", totalTrials);

  } finally {
    // Always lift the composite-level guard so the participant can navigate
    // freely off the done screen.
    if (guardOn) removeBeforeUnloadGuard();
  }
}
