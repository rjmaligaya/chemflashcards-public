/**
 * debrief-page.js — Day-14 debrief screen.
 *
 * Renders after the delayed posttest submits. Fetches the participant's
 * scores, predictions, and forced-choice answers via
 * GET /api/v2/debrief?pid=X, then walks the participant through:
 *
 *   1. Title + intro paragraph
 *   2. Per-session prediction-vs-actual comparison (CSS bar chart)
 *   3. Delayed test scores per set
 *   4. Day 4 + Day 14 forced-choice answers, alongside which set actually
 *      scored higher on the relevant test
 *   5. Explanatory copy (spacing effect, illusion of fluency, what was
 *      measured), read from copy_strings_v2
 *   6. Return-to-start button
 *
 * Single export: showDebriefScreen(container, pid) -> Promise<void>.
 * Resolves when the participant clicks the dismiss button.
 *
 * If the /api/v2/debrief fetch fails, the screen renders the title, the
 * explanatory copy, and a "Return to start" link instead of the results.
 */

import { workerUrl, API } from "./config-v2.js";
import { preloadCopyStrings, getCopy } from "./copy-strings.js";

/* Escapes the five HTML-significant characters for safe interpolation. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Display order for the practice-session rows: the four spaced sessions, then
// the four Day-4 massed blocks. The API returns them in DB-id order.
const PRACTICE_LABEL_ORDER = [
  "spaced-S1", "spaced-S2", "spaced-S3", "spaced-S4",
  "massed-B1", "massed-B2", "massed-B3", "massed-B4",
];

// Returns the sessions in PRACTICE_LABEL_ORDER, dropping any that are absent.
function practiceSessionsSorted(sessions) {
  const byLabel = new Map(sessions.map(s => [s.session_label, s]));
  return PRACTICE_LABEL_ORDER
    .map(label => byLabel.get(label))
    .filter(Boolean);
}

// Copy keys for the practice-session display labels. Set A is always the
// spaced group and Set B the massed group in the participant-facing scheme.
// The wording itself lives in copy_strings_v2.
const PRACTICE_LABEL_KEYS = {
  "spaced-S1": "practice_label_spaced_s1",
  "spaced-S2": "practice_label_spaced_s2",
  "spaced-S3": "practice_label_spaced_s3",
  "spaced-S4": "practice_label_spaced_s4",
  "massed-B1": "practice_label_massed_b1",
  "massed-B2": "practice_label_massed_b2",
  "massed-B3": "practice_label_massed_b3",
  "massed-B4": "practice_label_massed_b4",
};
// Returns the display label for a session, falling back to the raw label.
function displayLabelFor(sessionLabel) {
  const key = PRACTICE_LABEL_KEYS[sessionLabel];
  return key ? getCopy(key, sessionLabel) : sessionLabel;
}

// "set_a" -> "Set A", "set_b" -> "Set B", "same" -> "About the same".
function fcChoiceLabel(choice) {
  if (choice === "set_a") return getCopy("forced_choice_option_set_a");
  if (choice === "set_b") return getCopy("forced_choice_option_set_b");
  if (choice === "same")  return getCopy("forced_choice_option_same");
  return "—";
}

// 1 | 2 | 3 -> the matching confidence label, or an em dash if unrecognised.
function fcConfidenceLabel(level) {
  if (level === 1) return getCopy("forced_choice_confidence_low");
  if (level === 2) return getCopy("forced_choice_confidence_mid");
  if (level === 3) return getCopy("forced_choice_confidence_high");
  return "—";
}

// Which set actually scored higher on a checkpoint, expressed as "set_a",
// "set_b", or "same". Used to display "actual winner" next to the
// participant's forced-choice answer.
function actualWinner(setScoresForCheckpoint) {
  const { set_a, set_b, n_items_a, n_items_b } = setScoresForCheckpoint;
  // Compares proportions rather than counts, since the two sets can have
  // different item totals.
  const pa = n_items_a > 0 ? set_a / n_items_a : 0;
  const pb = n_items_b > 0 ? set_b / n_items_b : 0;
  if (pa > pb) return "set_a";
  if (pb > pa) return "set_b";
  return "same";
}

// Turns an actualWinner result into a display label.
function winnerLabel(winner) {
  if (winner === "set_a") return getCopy("forced_choice_option_set_a");
  if (winner === "set_b") return getCopy("forced_choice_option_set_b");
  return "Tie";
}

/**
 * Build the per-session prediction-vs-actual chart as HTML. Each practice
 * session is one row with two horizontal bars (prediction on top, actual
 * below) and the numeric values to the right.
 *
 * "actual" is the first-attempt-correct count, the same measure the
 * participant was asked to predict.
 */
function renderPredictionChart(sessions, predictions) {
  const predMap = new Map(predictions.map(p => [p.session_label, p.value]));
  const rows = practiceSessionsSorted(sessions).map(s => {
    const pred   = predMap.get(s.session_label);
    const actual = s.first_attempt_correct;
    const nItems = s.n_items || 12;
    const predPct   = (pred != null)   ? Math.round(100 * pred / nItems)   : null;
    const actualPct = (actual != null) ? Math.round(100 * actual / nItems) : null;
    return `
      <div class="debrief-bar-row">
        <div class="debrief-bar-label">${escapeHtml(displayLabelFor(s.session_label))}</div>
        <div class="debrief-bar-stack">
          <div class="debrief-bar debrief-bar--pred"   title="Predicted">
            <div class="debrief-bar-fill" style="width:${predPct ?? 0}%"></div>
            <span class="debrief-bar-val">${pred ?? "—"} / ${nItems}<small> predicted</small></span>
          </div>
          <div class="debrief-bar debrief-bar--actual" title="Actual">
            <div class="debrief-bar-fill" style="width:${actualPct ?? 0}%"></div>
            <span class="debrief-bar-val">${actual ?? "—"} / ${nItems}<small> actual</small></span>
          </div>
        </div>
      </div>
    `;
  }).join("");
  return `
    <div class="debrief-chart">
      ${rows}
      <p class="debrief-chart-legend hint-sm">
        Predicted = your estimate of first-try-correct items before the session began.
        Actual    = number you got right on your first try.
      </p>
    </div>
  `;
}

// Builds the delayed-test score table, one column per set.
function renderTestScoresBlock(setScores) {
  const fmt = (n_correct, n_items) => `${n_correct ?? "—"} / ${n_items ?? "—"}`;
  return `
    <table class="debrief-table">
      <thead>
        <tr>
          <th></th>
          <th>${escapeHtml(getCopy("forced_choice_option_set_a"))}</th>
          <th>${escapeHtml(getCopy("forced_choice_option_set_b"))}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">Delayed test</th>
          <td>${fmt(setScores.day_14_delayed.set_a, setScores.day_14_delayed.n_items_a)}</td>
          <td>${fmt(setScores.day_14_delayed.set_b, setScores.day_14_delayed.n_items_b)}</td>
        </tr>
      </tbody>
    </table>
  `;
}

// Builds the table comparing each forced-choice answer with the set that
// actually scored higher.
function renderForcedChoiceBlock(forcedChoices, setScores) {
  const fcByCheckpoint = new Map(forcedChoices.map(f => [f.checkpoint, f]));
  const day4 = fcByCheckpoint.get("day_4_immediate");
  const day14 = fcByCheckpoint.get("day_14_delayed");

  // For the Day-4 forced choice (which asked "in about a week, which set will
  // you remember better?"), the relevant actual outcome is the delayed test.
  const day4Winner  = actualWinner(setScores.day_14_delayed);
  // For the delayed-test forced choice (which asked "which set did you remember
  // better just now?"), the relevant outcome is the delayed test.
  const day14Winner = actualWinner(setScores.day_14_delayed);

  // One table row for a checkpoint, or a "(not answered)" row when absent.
  function row(checkpointLabel, fc, winner, winnerExplanation) {
    if (!fc) {
      return `
        <tr>
          <th scope="row">${escapeHtml(checkpointLabel)}</th>
          <td colspan="3" class="hint-sm">(not answered)</td>
        </tr>
      `;
    }
    return `
      <tr>
        <th scope="row">${escapeHtml(checkpointLabel)}</th>
        <td>${escapeHtml(fcChoiceLabel(fc.choice))}</td>
        <td class="hint-sm">${escapeHtml(fcConfidenceLabel(fc.confidence))}</td>
        <td>${escapeHtml(winnerLabel(winner))} <small class="hint-sm">${escapeHtml(winnerExplanation)}</small></td>
      </tr>
    `;
  }

  return `
    <table class="debrief-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Your choice</th>
          <th>Your confidence</th>
          <th>Actually scored higher</th>
        </tr>
      </thead>
      <tbody>
        ${row("Day 4 (predicting the delayed test)", day4,  day4Winner,  "on the delayed test")}
        ${row("At the delayed test (just now)",       day14, day14Winner, "on the delayed test")}
      </tbody>
    </table>
  `;
}

// Renders the reduced debrief shown when the results fetch fails.
function renderErrorFallback(container) {
  container.innerHTML = `
    <section class="card debrief-card" style="max-width:640px;margin:80px auto;padding:32px;">
      <h2 style="margin-top:0;">${escapeHtml(getCopy("debrief_title"))}</h2>
      <p>${escapeHtml(getCopy("debrief_intro"))}</p>
      <p class="hint-sm warn">We could not load your personal results just now. Your data is still saved; please contact the researcher if you would like a copy of your results.</p>
      <a class="btn btn--primary" href="study.html">Return to start</a>
    </section>
  `;
}

/**
 * showDebriefScreen(container, pid) -> Promise<void>
 *
 * Renders the full debrief into `container` and resolves when the
 * participant clicks the dismiss button.
 */
export async function showDebriefScreen(container, pid) {
  await preloadCopyStrings();

  // Fetch the participant's debrief payload. On failure, render the
  // fallback shell so the participant still sees a sensible screen.
  let data = null;
  try {
    const res = await fetch(workerUrl(API.DEBRIEF) + "?pid=" + encodeURIComponent(pid), { cache: "no-store" });
    if (!res.ok) throw new Error(`debrief http_${res.status}`);
    data = await res.json();
  } catch (e) {
    console.error("[debrief] fetch failed:", e);
    return new Promise(resolve => {
      renderErrorFallback(container);
      container.querySelector("a")?.addEventListener("click", () => resolve(), { once: true });
    });
  }

  const title              = getCopy("debrief_title");
  const intro              = getCopy("debrief_intro");
  const spacingEffectCopy  = getCopy("debrief_spacing_effect");
  const illusionCopy       = getCopy("debrief_illusion_of_fluency");
  const measuredCopy       = getCopy("debrief_what_we_measured");

  container.innerHTML = `
    <section class="card debrief-card">
      <header class="card__header">
        <h1 class="card__title">${escapeHtml(title)}</h1>
      </header>

      <div class="card__body debrief-body">
        ${intro ? `<p class="debrief-intro">${escapeHtml(intro)}</p>` : ""}

        <section class="debrief-section">
          <h2 class="debrief-section-title">Your predictions vs your scores</h2>
          ${renderPredictionChart(data.sessions, data.predictions)}
        </section>

        <section class="debrief-section">
          <h2 class="debrief-section-title">Your test scores</h2>
          ${renderTestScoresBlock(data.set_scores)}
        </section>

        <section class="debrief-section">
          <h2 class="debrief-section-title">Which set you said you would remember better</h2>
          ${renderForcedChoiceBlock(data.forced_choices, data.set_scores)}
        </section>

        <section class="debrief-section">
          <h2 class="debrief-section-title">About this study</h2>
          ${spacingEffectCopy ? `<p>${escapeHtml(spacingEffectCopy)}</p>` : ""}
          ${illusionCopy      ? `<p>${escapeHtml(illusionCopy)}</p>`      : ""}
          ${measuredCopy      ? `<p>${escapeHtml(measuredCopy)}</p>`      : ""}
        </section>
      </div>

      <div class="card__footer">
        <button class="btn btn--primary debrief-dismiss" type="button">Return to start</button>
      </div>
    </section>
  `;

  return new Promise(resolve => {
    container.querySelector(".debrief-dismiss")?.addEventListener("click", () => {
      // Resolve first, then navigate to study.html.
      resolve();
      window.location.href = "study.html";
    }, { once: true });
  });
}
