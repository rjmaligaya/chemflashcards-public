/**
 * forced-choice-widget.js — Day-4 + delayed-visit forced-choice prompt.
 *
 * Fires at two checkpoints:
 *   - End of Day 4, after the final massed block, before the wrap-up screen.
 *     promptKey: "forced_choice_day4_prompt"
 *   - At the delayed visit, after the delayed posttest and before the results
 *     screen. promptKey: "forced_choice_day14_prompt"
 *
 * Two question groups on one card:
 *   1. Which set do you think you'll / did you remember better?
 *      Choices: Set A | Set B | About the same
 *   2. How confident are you in that answer?
 *      Confidence: Not very | Somewhat | Very
 *
 * The prompt identifies the two sets by example names, injected via the
 * {set_a_examples} / {set_b_examples} placeholders, and never names the
 * practice schedule.
 *
 * Both groups must be answered before Submit enables. Single export:
 *   showForcedChoiceWidget(container, opts) -> Promise<{choice, confidence}>
 *     choice:     "set_a" | "set_b" | "same"
 *     confidence: 1 | 2 | 3
 *
 * All wording, including the labels Set A / Set B, "About the same", and the
 * three confidence labels, reads from copy_strings_v2 via getCopy.
 */

import { preloadCopyStrings, getCopy } from "./copy-strings.js";

/* Escapes the five HTML-significant characters for safe interpolation. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * pickSetExamples(items, group, n) -> "name1 and name2"
 *
 * Returns the first n distinct full_names for the given stimulus group,
 * formatted as a natural-language list. The forced-choice prompt uses these
 * names to identify each set. Selection follows CSV order, so the same
 * examples appear on Day 4 and at the delayed visit. Touches no DOM.
 */
export function pickSetExamples(items, group, n = 2) {
  const seen = new Set();
  const names = [];
  for (const it of (items || [])) {
    if (!it || it.group !== group) continue;
    const name = it.full_name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= n) break;
  }
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * showForcedChoiceWidget(container, opts) -> Promise<{choice, confidence}>
 *
 * opts:
 *   promptKey — copy_strings_v2 key for the main question text.
 *               Use "forced_choice_day4_prompt" on Day 4 and
 *               "forced_choice_day14_prompt" at the delayed visit.
 *   examplesA — string of example names for Set A (the spaced set). Fills the
 *               prompt's {set_a_examples} placeholder.
 *   examplesB — same for Set B (the massed set); fills {set_b_examples}.
 *   title     — optional card heading. Defaults to a generic "One more
 *               question before you continue".
 */
export async function showForcedChoiceWidget(container, opts = {}) {
  const {
    promptKey,
    title = "One more question before you continue",
    examplesA = "",
    examplesB = "",
  } = opts;
  if (!promptKey) throw new Error("showForcedChoiceWidget: promptKey is required");

  await preloadCopyStrings();

  // Fill the {set_a_examples} / {set_b_examples} placeholders the copy string
  // carries. A prompt without placeholders is left unchanged.
  const promptText      = getCopy(promptKey)
    .replace(/\{set_a_examples\}/g, examplesA)
    .replace(/\{set_b_examples\}/g, examplesB);
  const labelSetA       = getCopy("forced_choice_option_set_a");
  const labelSetB       = getCopy("forced_choice_option_set_b");
  const labelSame       = getCopy("forced_choice_option_same");
  const labelConfPrompt = getCopy("forced_choice_confidence_label");
  const labelConfLow    = getCopy("forced_choice_confidence_low");
  const labelConfMid    = getCopy("forced_choice_confidence_mid");
  const labelConfHigh   = getCopy("forced_choice_confidence_high");
  const labelSubmit     = getCopy("forced_choice_submit");

  container.innerHTML = `
    <section class="card forced-choice-card" role="form" aria-labelledby="fcTitle">
      <header class="card__header">
        <h2 class="card__title" id="fcTitle">${escapeHtml(title)}</h2>
      </header>
      <div class="card__body">
        <fieldset class="forced-choice-fieldset">
          <legend class="forced-choice-legend">${escapeHtml(promptText)}</legend>
          <div class="forced-choice-options">
            <label class="forced-choice-option">
              <input type="radio" name="fcChoice" value="set_a">
              <span>${escapeHtml(labelSetA)}</span>
            </label>
            <label class="forced-choice-option">
              <input type="radio" name="fcChoice" value="set_b">
              <span>${escapeHtml(labelSetB)}</span>
            </label>
            <label class="forced-choice-option">
              <input type="radio" name="fcChoice" value="same">
              <span>${escapeHtml(labelSame)}</span>
            </label>
          </div>
        </fieldset>

        <fieldset class="forced-choice-fieldset">
          <legend class="forced-choice-legend">${escapeHtml(labelConfPrompt)}</legend>
          <div class="forced-choice-options">
            <label class="forced-choice-option">
              <input type="radio" name="fcConfidence" value="1">
              <span>${escapeHtml(labelConfLow)}</span>
            </label>
            <label class="forced-choice-option">
              <input type="radio" name="fcConfidence" value="2">
              <span>${escapeHtml(labelConfMid)}</span>
            </label>
            <label class="forced-choice-option">
              <input type="radio" name="fcConfidence" value="3">
              <span>${escapeHtml(labelConfHigh)}</span>
            </label>
          </div>
        </fieldset>
      </div>
      <div class="card__footer">
        <button class="btn btn--primary forced-choice-submit" type="button" disabled>
          ${escapeHtml(labelSubmit)}
        </button>
      </div>
    </section>
  `;

  const choiceRadios     = Array.from(container.querySelectorAll('input[name="fcChoice"]'));
  const confidenceRadios = Array.from(container.querySelectorAll('input[name="fcConfidence"]'));
  const submitBtn        = container.querySelector(".forced-choice-submit");

  return new Promise(resolve => {
    const ac = new AbortController();

    // Enables Submit once both question groups have an answer.
    function updateSubmitState() {
      const choicePicked     = choiceRadios.some(r => r.checked);
      const confidencePicked = confidenceRadios.some(r => r.checked);
      submitBtn.disabled = !(choicePicked && confidencePicked);
    }

    choiceRadios.forEach(r => {
      r.addEventListener("change", updateSubmitState, { signal: ac.signal });
    });
    confidenceRadios.forEach(r => {
      r.addEventListener("change", updateSubmitState, { signal: ac.signal });
    });

    submitBtn.addEventListener("click", () => {
      const choice     = choiceRadios.find(r => r.checked)?.value;
      const confidence = Number(confidenceRadios.find(r => r.checked)?.value);
      // Guard on the recorded values before resolving.
      if (!choice || !Number.isInteger(confidence) || confidence < 1 || confidence > 3) return;
      submitBtn.disabled = true;
      // Disable the radios so the recorded values cannot change.
      choiceRadios.forEach(r => { r.disabled = true; });
      confidenceRadios.forEach(r => { r.disabled = true; });
      ac.abort();
      resolve({ choice, confidence });
    }, { signal: ac.signal });

    // Move keyboard focus into the first radio of the choice group.
    setTimeout(() => choiceRadios[0]?.focus(), 20);
  });
}
