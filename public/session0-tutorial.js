/**
 * session0-tutorial.js — the Session 0 introduction, folded into the start of
 * Session 1 (spaced list) and the Day-4 page after the break (massed list).
 *
 * Flow:
 *
 *   1. A quick introduction card.
 *   2. Skeletal-structures primer (Day 1 only by default; the participant has
 *      seen it by Day 4). Reuses the shared skeletal-picker component.
 *   3. For each topic lesson of this list: the lesson card (rule + one or more
 *      worked examples), then an "easy to learn" rating for that topic.
 *
 * The rating is a post-instruction ease-of-learning measure, asked once per
 * topic card. It runs for every id.
 *
 * Storage: each rating is saved to familiarity_ratings_v2 with item_id = the
 * TOPIC id (e.g. "a-aldehydes") and full_name = the topic title. Saved one at
 * a time, idempotently. No sessions_v2 row.
 *
 *   runSession0Tutorial(container, opts) -> Promise<void>
 *     opts.pid                 — participant id
 *     opts.optionId            — "option1" | "option2" (counterbalance)
 *     opts.schedule            — "spaced" | "massed" (which schedule this list is on)
 *     opts.checkpoint          — "spaced_intro" | "massed_intro"
 *     opts.includeSkeletalPrimer — default true (false on Day 4)
 */

import { mountSkeletalPicker } from "./skeletal-picker.js";
import { showEaseRating } from "./familiarity-widget.js";
import { topicsForGroup } from "./session0-content.js";
import { saveFamiliarity } from "./metacog-save.js";
import { preloadCopyStrings } from "./copy-strings.js";
import { imagePathFor } from "./practice-engine.js";

/* Escapes the five HTML-significant characters for safe interpolation. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* A simple full-card step that resolves when the participant clicks its CTA. */
function step(container, { title, bodyHtml, ctaText = "Continue" }) {
  return new Promise(resolve => {
    container.innerHTML = `
      <section class="card s0-card">
        <header class="card__header"><h2 class="card__title">${escapeHtml(title)}</h2></header>
        <div class="card__body">${bodyHtml}</div>
        <div class="card__footer">
          <button class="btn btn--primary" type="button" data-cta>${escapeHtml(ctaText)}</button>
        </div>
      </section>
    `;
    container.querySelector("[data-cta]").addEventListener("click", () => resolve(), { once: true });
  });
}

/* Skeletal-structures primer with the shared interactive picker. */
function skeletalPrimerStep(container) {
  return new Promise(resolve => {
    container.innerHTML = `
      <section class="card s0-card">
        <header class="card__header"><h2 class="card__title">How to read these diagrams</h2></header>
        <div class="card__body">
          <p class="s0-intro">Each line in a structure is a bond between two carbon atoms. Corners and the ends of lines are carbons, and hydrogen atoms on carbon are not drawn. Use the controls below to explore different chain lengths and rings, and turn on carbon numbering to see how the carbons are counted.</p>
          <div data-skeletal-host></div>
        </div>
        <div class="card__footer">
          <button class="btn btn--primary" type="button" data-cta>Continue</button>
        </div>
      </section>
    `;
    mountSkeletalPicker(container.querySelector("[data-skeletal-host]"));
    container.querySelector("[data-cta]").addEventListener("click", () => resolve(), { once: true });
  });
}

/* HTML for one worked-example figure (image + caption). The image src + error
   fallback are wired after innerHTML by wireExampleImg. */
function exampleFigureHtml(ex) {
  return `
    <figure class="s0-example">
      <div class="trial-img-wrap">
        <img class="trial-img" alt="Chemical structure of ${escapeHtml(ex.full_name || "")}">
        <div class="trial-img-fallback hint-sm" hidden></div>
      </div>
      ${ex.caption ? `<figcaption class="s0-figure-caption">${escapeHtml(ex.caption)}</figcaption>` : ""}
    </figure>`;
}

/* Wires one figure's image: the onerror handler is assigned before the src and
   swaps in a text fallback when the file is missing. */
function wireExampleImg(figureEl, ex) {
  const img = figureEl.querySelector(".trial-img");
  if (!img) return;
  const fb = figureEl.querySelector(".trial-img-fallback");
  const imgSrc = ex.image || (ex.full_name ? imagePathFor({ full_name: ex.full_name }) : "");
  img.onerror = () => {
    img.hidden = true;
    if (fb) { fb.hidden = false; fb.textContent = `[Structure image not yet drawn: ${ex.full_name || ""}]`; }
  };
  if (imgSrc) img.src = imgSrc; else img.onerror();
}

/* One topic lesson: rule + one or more worked-example structures. Renders
   `topic.examples` (array) when present and falls back to a single
   `topic.example`. The CTA is always "Next"; an ease rating follows. */
function lessonStep(container, topic, idx, total) {
  return new Promise(resolve => {
    const examples = topic.examples || (topic.example ? [topic.example] : []);
    container.innerHTML = `
      <section class="card s0-card">
        <header class="card__header">
          <p class="familiarity-progress hint-sm">Topic ${idx} of ${total}</p>
          <h2 class="card__title">${escapeHtml(topic.title)}</h2>
        </header>
        <div class="card__body">
          <p class="s0-intro">${topic.body}</p>
          ${examples.length ? `<div class="s0-examples">${examples.map(exampleFigureHtml).join("")}</div>` : ""}
        </div>
        <div class="card__footer">
          <button class="btn btn--primary" type="button" data-cta>Next</button>
        </div>
      </section>
    `;
    // Wire each example image's fallback (DOM order matches examples[]).
    Array.from(container.querySelectorAll(".s0-example")).forEach((figEl, i) => wireExampleImg(figEl, examples[i]));
    container.querySelector("[data-cta]").addEventListener("click", () => resolve(), { once: true });
  });
}

/* One per-topic "easy to learn" rating, shown right after that topic's lesson.
   Saved to familiarity_ratings_v2 with the TOPIC id as item_id (see header).
   The save is fire-and-forget: the POST is idempotent on
   (participant_id, item_id), and a failure is logged without blocking. */
async function easeRatingStep(container, topic, { pid, checkpoint, group }, idx, total) {
  const value = await showEaseRating(container, {
    family:   topic.family || topic.title,
    progress: { current: idx, total },
    ctaText:  idx === total ? "Start practice" : "Next",
  });
  saveFamiliarity(pid, {
    checkpoint,
    item_id:   topic.id,                          // topic-level row, e.g. "a-aldehydes"
    group_id:  group,                             // "C-1" | "C-2"
    feature:   (topic.features || []).join("+"),  // audit trail of features taught
    full_name: topic.title,                       // human-readable topic label
    value,                                        // 1..7 ease-of-learning rating
  }).catch(e => console.error(`[${checkpoint}] ease rating save failed for ${topic.id}:`, e));
}

/* Runs the whole tutorial for one list: introduction card, optional skeletal
   primer, then each topic lesson followed by its ease rating. */
export async function runSession0Tutorial(container, opts = {}) {
  const {
    pid, optionId, schedule, checkpoint,
    includeSkeletalPrimer = true,
  } = opts;
  if (!container) return;

  await preloadCopyStrings();

  const spacedGroup = (optionId === "option1") ? "C-1" : "C-2";
  const massedGroup = (optionId === "option1") ? "C-2" : "C-1";
  const group = (schedule === "spaced") ? spacedGroup : massedGroup;

  // 1. Quick introduction.
  await step(container, {
    title: "A quick introduction",
    bodyHtml: `<p class="s0-intro">Before you start, here is a short introduction to the names you are about to practise. You will see how to read the structure diagrams, then read a few short notes on the naming rules. After each note we will ask how easy that set of names was to learn. This is not a test, and nothing here is graded.</p>`,
    ctaText: "Begin",
  });

  // 2. Skeletal primer (Day 1 only by default).
  if (includeSkeletalPrimer) await skeletalPrimerStep(container);

  // 3. Each topic lesson, followed immediately by its "easy to learn" rating.
  const topics = topicsForGroup(group);
  for (let i = 0; i < topics.length; i++) {
    await lessonStep(container, topics[i], i + 1, topics.length);
    await easeRatingStep(container, topics[i], { pid, checkpoint, group }, i + 1, topics.length);
  }
  // Resolves; the caller clears the container and starts the practice trials.
}
