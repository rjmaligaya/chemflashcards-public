/**
 * prediction-widget.js — pre-session prediction UI.
 *
 * Used by spaced-session-page.js (sessions 1-3) and day4-page.js (Spaced-S4
 * and each of the four massed blocks). The test pages do not use it.
 *
 * Single export: showPredictionWidget(container, opts) -> Promise<number 0..12>.
 *
 * Behaviour:
 *   - 13 number buttons (0..12), none selected at first render.
 *   - The participant taps one to highlight it, then taps Confirm to commit.
 *   - There is no skip or back path; a value is required to continue.
 *   - The widget wipes its container DOM on commit, leaving the caller free
 *     to render the next screen.
 *
 * Copy strings come from copy_strings_v2 via getCopy with English fallbacks.
 */

import { preloadCopyStrings, getCopy } from "./copy-strings.js";

/* Escapes the five HTML-significant characters for safe interpolation. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * showPredictionWidget(container, opts) -> Promise<int>
 *
 * opts (all are copy_strings_v2 keys, looked up via getCopy with English
 * fallbacks in copy-strings.js):
 *   promptKey   — the question text. Defaults to "prediction_prompt".
 *   titleKey    — card heading. Defaults to "prediction_title".
 *   ctaKey      — confirm-button label. Defaults to "prediction_cta".
 *
 * Resolves with the integer 0..12 the participant selected.
 */
export async function showPredictionWidget(container, opts = {}) {
  const {
    promptKey = "prediction_prompt",
    titleKey  = "prediction_title",
    ctaKey    = "prediction_cta",
  } = opts;

  // Load the copy before rendering. The call is idempotent.
  await preloadCopyStrings();

  const promptText = getCopy(promptKey);
  const title      = getCopy(titleKey);
  const ctaText    = getCopy(ctaKey);

  // 13 buttons, 0..12.
  const buttonsHtml = Array.from({ length: 13 }, (_, n) => `
    <button class="btn btn--ghost prediction-num-btn" type="button"
            data-value="${n}" aria-pressed="false"
            aria-label="${n} ${n === 1 ? "item" : "items"} correct">
      ${n}
    </button>
  `).join("");

  container.innerHTML = `
    <section class="card prediction-card" role="group" aria-labelledby="predictionTitle">
      <header class="card__header">
        <h2 class="card__title" id="predictionTitle">${escapeHtml(title)}</h2>
      </header>
      <div class="card__body">
        <p class="prediction-prompt">${escapeHtml(promptText)}</p>
        <div class="prediction-options">
          ${buttonsHtml}
        </div>
        <p class="prediction-hint hint-sm" id="predictionHint">
          Tap a number to select it, then confirm.
        </p>
      </div>
      <div class="card__footer">
        <button class="btn btn--primary prediction-confirm" type="button" disabled>
          ${escapeHtml(ctaText)}
        </button>
      </div>
    </section>
  `;

  const numBtns    = Array.from(container.querySelectorAll(".prediction-num-btn"));
  const confirmBtn = container.querySelector(".prediction-confirm");
  const hint       = container.querySelector("#predictionHint");

  return new Promise(resolve => {
    let selected = null;
    const ac = new AbortController();

    // Records the clicked value, marks its button pressed, and enables Confirm.
    function onNumberClick(e) {
      const v = Number(e.currentTarget.dataset.value);
      if (!Number.isInteger(v) || v < 0 || v > 12) return;
      selected = v;
      // Visual selection: aria-pressed toggling drives CSS [aria-pressed="true"]
      numBtns.forEach(b => {
        const isThis = b === e.currentTarget;
        b.setAttribute("aria-pressed", isThis ? "true" : "false");
      });
      confirmBtn.disabled = false;
      // Update the hint so screen readers announce the change.
      hint.textContent = `You selected ${v}. Tap the button below to confirm, or pick a different number.`;
    }

    // Commits the selected value: disables the controls and resolves.
    function onConfirm() {
      if (selected == null) return;
      numBtns.forEach(b => { b.disabled = true; });
      confirmBtn.disabled = true;
      ac.abort();
      resolve(selected);
    }

    numBtns.forEach(btn => {
      btn.addEventListener("click", onNumberClick, { signal: ac.signal });
    });
    confirmBtn.addEventListener("click", onConfirm, { signal: ac.signal });

    // Move keyboard focus to the first number button.
    setTimeout(() => numBtns[0]?.focus(), 20);
  });
}
