/**
 * familiarity-widget.js — Session 0 self-rating screens (1..7 bubble scale).
 *
 * Two screens share the same bubble UI and commit behaviour: tap a bubble to
 * select it, then tap the CTA to commit. There is no skip or back path.
 *
 *   showEaseRating(container, opts) -> Promise<int 1..7>
 *     A per-topic "Was the name for [family] easy to learn?" rating, shown after
 *     each Session 0 lesson card. Anchored "Very hard to learn" .. "Very easy to
 *     learn". This is the rating the current tutorial flow uses.
 *     opts.family   — short noun phrase interpolated into the prompt.
 *     opts.progress — { current, total } -> "Topic X of Y".
 *     opts.ctaText  — button label (default "Next"; "Start practice" on the last).
 *
 *   showFamiliarityRating(container, opts) -> Promise<int 1..7>
 *     A per-molecule incoming-familiarity rating (structure + name, anchored
 *     "Not at all familiar" .. "Very familiar"). The current tutorial flow does
 *     not call it.
 *     opts.item / opts.imgSrc / opts.progress.
 *
 * Title, prompt, anchors, and CTA all read from copy_strings_v2 via getCopy.
 * The ease keys (ease_prompt, ease_anchor_low, ease_anchor_high, ease_cta)
 * have defaults in copy-strings.js and render without a DB row.
 */

import { preloadCopyStrings, getCopy } from "./copy-strings.js";

const SCALE_MIN = 1;
const SCALE_MAX = 7;

/* Escapes the five HTML-significant characters for safe interpolation. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * Per-molecule familiarity rating: shows the structure and name with a 1..7
 * bubble scale. Returns the chosen integer once the participant confirms.
 */
export async function showFamiliarityRating(container, opts = {}) {
  const { item = {}, imgSrc = "", progress = null } = opts;

  await preloadCopyStrings();
  const prompt     = getCopy("familiarity_prompt");
  const anchorLow  = getCopy("familiarity_anchor_low");
  const anchorHigh = getCopy("familiarity_anchor_high");
  const ctaText    = getCopy("familiarity_cta");
  const progressText = progress ? `Molecule ${progress.current} of ${progress.total}` : "";

  const bubbles = Array.from({ length: SCALE_MAX - SCALE_MIN + 1 }, (_, i) => {
    const v = SCALE_MIN + i;
    return `
      <button class="familiarity-bubble" type="button" data-value="${v}"
              aria-pressed="false" aria-label="${v} out of ${SCALE_MAX}">
        <span class="familiarity-bubble-num">${v}</span>
      </button>`;
  }).join("");

  container.innerHTML = `
    <section class="card familiarity-card" role="group" aria-labelledby="famTitle">
      <header class="card__header">
        <h2 class="card__title" id="famTitle">${escapeHtml(prompt)}</h2>
      </header>
      <div class="card__body">
        ${progressText ? `<p class="familiarity-progress hint-sm">${escapeHtml(progressText)}</p>` : ""}
        <div class="familiarity-stimulus">
          <div class="trial-img-wrap">
            <img class="trial-img" alt="Chemical structure of ${escapeHtml(item.full_name || "")}">
            <div class="trial-img-fallback hint-sm" hidden></div>
          </div>
          <p class="familiarity-name">${escapeHtml(item.full_name || "")}</p>
        </div>
        <div class="familiarity-scale">
          <span class="familiarity-anchor">${escapeHtml(anchorLow)}</span>
          <div class="familiarity-bubbles" role="radiogroup" aria-label="${escapeHtml(prompt)}">
            ${bubbles}
          </div>
          <span class="familiarity-anchor">${escapeHtml(anchorHigh)}</span>
        </div>
        <p class="familiarity-hint hint-sm" id="famHint">Tap a circle to choose, then continue.</p>
      </div>
      <div class="card__footer">
        <button class="btn btn--primary familiarity-next" type="button" disabled>${escapeHtml(ctaText)}</button>
      </div>
    </section>
  `;

  // Structure image: the error handler is assigned before the src, and swaps
  // the image for a text fallback when the file is missing.
  const img      = container.querySelector(".trial-img");
  const fallback = container.querySelector(".trial-img-fallback");
  if (img) {
    img.onerror = () => {
      img.hidden = true;
      fallback.hidden = false;
      fallback.textContent = `[Structure image not yet drawn: ${item.full_name || ""}]`;
    };
    if (imgSrc) img.src = imgSrc;
    else img.onerror();
  }

  const bubbleBtns = Array.from(container.querySelectorAll(".familiarity-bubble"));
  const nextBtn    = container.querySelector(".familiarity-next");
  const hint       = container.querySelector("#famHint");

  return new Promise(resolve => {
    let selected = null;
    const ac = new AbortController();

    bubbleBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        selected = Number(btn.dataset.value);
        bubbleBtns.forEach(b => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
        nextBtn.disabled = false;
        hint.textContent = `You chose ${selected} out of ${SCALE_MAX}. Tap ${ctaText} to continue, or pick another.`;
      }, { signal: ac.signal });
    });

    nextBtn.addEventListener("click", () => {
      if (selected == null) return;
      // Disable the controls before resolving.
      bubbleBtns.forEach(b => { b.disabled = true; });
      nextBtn.disabled = true;
      ac.abort();
      resolve(selected);
    }, { signal: ac.signal });
  });
}

/**
 * Per-topic "easy to learn" rating. Uses the same bubble UI as
 * showFamiliarityRating with no molecule stimulus, asking about the topic
 * just taught. Returns the chosen integer 1..7.
 */
export async function showEaseRating(container, opts = {}) {
  const { family = "these names", progress = null, ctaText = "Next" } = opts;

  await preloadCopyStrings();
  const promptTpl  = getCopy("ease_prompt");   // "Was the name for {family} easy to learn?"
  const prompt     = promptTpl.replace("{family}", family);
  const anchorLow  = getCopy("ease_anchor_low");
  const anchorHigh = getCopy("ease_anchor_high");
  const cta        = ctaText || getCopy("ease_cta");
  const progressText = progress ? `Topic ${progress.current} of ${progress.total}` : "";

  const bubbles = Array.from({ length: SCALE_MAX - SCALE_MIN + 1 }, (_, i) => {
    const v = SCALE_MIN + i;
    return `
      <button class="familiarity-bubble" type="button" data-value="${v}"
              aria-pressed="false" aria-label="${v} out of ${SCALE_MAX}">
        <span class="familiarity-bubble-num">${v}</span>
      </button>`;
  }).join("");

  container.innerHTML = `
    <section class="card familiarity-card" role="group" aria-labelledby="easeTitle">
      <header class="card__header">
        <h2 class="card__title" id="easeTitle">${escapeHtml(prompt)}</h2>
      </header>
      <div class="card__body">
        ${progressText ? `<p class="familiarity-progress hint-sm">${escapeHtml(progressText)}</p>` : ""}
        <div class="familiarity-scale">
          <span class="familiarity-anchor">${escapeHtml(anchorLow)}</span>
          <div class="familiarity-bubbles" role="radiogroup" aria-label="${escapeHtml(prompt)}">
            ${bubbles}
          </div>
          <span class="familiarity-anchor">${escapeHtml(anchorHigh)}</span>
        </div>
        <p class="familiarity-hint hint-sm" id="easeHint">Tap a circle to choose, then continue.</p>
      </div>
      <div class="card__footer">
        <button class="btn btn--primary familiarity-next" type="button" disabled>${escapeHtml(cta)}</button>
      </div>
    </section>
  `;

  const bubbleBtns = Array.from(container.querySelectorAll(".familiarity-bubble"));
  const nextBtn    = container.querySelector(".familiarity-next");
  const hint       = container.querySelector("#easeHint");

  return new Promise(resolve => {
    let selected = null;
    const ac = new AbortController();

    bubbleBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        selected = Number(btn.dataset.value);
        bubbleBtns.forEach(b => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
        nextBtn.disabled = false;
        hint.textContent = `You chose ${selected} out of ${SCALE_MAX}. Tap ${cta} to continue, or pick another.`;
      }, { signal: ac.signal });
    });

    nextBtn.addEventListener("click", () => {
      if (selected == null) return;
      // Disable the controls before resolving.
      bubbleBtns.forEach(b => { b.disabled = true; });
      nextBtn.disabled = true;
      ac.abort();
      resolve(selected);
    }, { signal: ac.signal });
  });
}
