/**
 * practice-engine.js — v2 trial engine.
 *
 * Used by:
 *   study-session1.html ... study-session4.html   practice sessions
 *   pretest.html                                  pretest (no feedback)
 *   posttest-delayed.html                         delayed posttest (no feedback)
 *
 * Sections:
 *   - Pure utilities: makePrompt, normalizeAnswer, scoreAnswer,
 *     parseCSV, loadItems, pickSessionItems, shuffle.
 *   - Asset helpers: imagePathFor.
 *   - Trial UI: mountSessionShell, runTrial, renderSummary.
 *   - Session orchestrator: startSession.
 */

import { getFeatureCopy } from "./features-v2.js";
import { preloadCopyStrings, getCopy } from "./copy-strings.js";

/* ── Prompt generation ──────────────────────────────────────────────────────
 * For a Q-blank trial, the participant sees the structure plus a fill-in prompt
 * where the target feature has been replaced by an underscore blank. Example:
 *   makePrompt("ethanal", "al")             -> "eth_______"
 *   makePrompt("1-fluoropropane", "fluoro") -> "1-_______propane"
 *   makePrompt("octan-4-one",     "one")    -> "octan-4-_______"
 *   makePrompt("benzene",         "benzene")-> "_______"       (whole-word)
 */

// Text-mode blank placeholder. Used by makePrompt and any non-DOM caller;
// renderPromptIntoEl renders a styled span instead.
const BLANK = "_______";

// Returns the fill-in-the-blank prompt text for an item: full_name with the
// feature substring replaced by BLANK, or a bare BLANK if the feature is
// missing or not present in full_name.
export function makePrompt(full_name, feature) {
  if (!full_name || !feature) return BLANK;
  const lower = full_name.toLowerCase();
  const ftr   = feature.toLowerCase();
  const idx   = lower.indexOf(ftr);
  if (idx === -1) return BLANK;
  return full_name.slice(0, idx) + BLANK + full_name.slice(idx + feature.length);
}

/**
 * DOM variant of makePrompt, used by runTrial for Q-blank trials. Replaces the
 * contents of `el` with prefix text, a <span class="blank"> element, and suffix
 * text, so the blank renders as a single underline of fixed CSS width rather
 * than literal underscore characters. Falls back to a bare blank when the
 * feature is missing or not found in full_name.
 */
export function renderPromptIntoEl(el, full_name, feature) {
  el.replaceChildren();  // wipe previous trial's content

  // Appends an empty styled blank span to the prompt element.
  function appendBlank() {
    const span = document.createElement("span");
    span.className = "blank";
    span.setAttribute("aria-label", "blank to fill in");
    el.appendChild(span);
  }

  if (!full_name || !feature) { appendBlank(); return; }
  const lower = full_name.toLowerCase();
  const ftr   = feature.toLowerCase();
  const idx   = lower.indexOf(ftr);
  if (idx === -1) { appendBlank(); return; }

  const prefix = full_name.slice(0, idx);
  const suffix = full_name.slice(idx + feature.length);
  if (prefix) el.appendChild(document.createTextNode(prefix));
  appendBlank();
  if (suffix) el.appendChild(document.createTextNode(suffix));
}

/**
 * Replaces the .blank span inside a prompt element with a coloured
 * .blank-filled span holding the correct feature text, after a Q-blank trial
 * is submitted.
 *
 * Colour comes from `correct`:
 *   true  -> green text on a sage-tinted chip
 *   false -> red   text on a coral-tinted chip
 *
 * No-op when the prompt has no .blank, which is the case for Q-full prompts.
 */
export function revealPromptAnswer(el, feature, correct) {
  const blank = el.querySelector(".blank");
  if (!blank) return;
  const filled = document.createElement("span");
  filled.className = "blank-filled " + (correct ? "blank-filled--correct" : "blank-filled--wrong");
  filled.textContent = feature || "";
  filled.setAttribute("aria-label", correct ? "correct answer" : "correct answer was");
  blank.replaceWith(filled);
}

/* ── Answer normalization ───────────────────────────────────────────────────
 * Returns a comparison form of an answer string:
 *   - lower-cased and NFKC-normalized
 *   - hyphens and underscores treated as spaces
 *   - runs of whitespace collapsed, then trimmed
 * Null or undefined input returns an empty string.
 */

export function normalizeAnswer(raw) {
  if (raw == null) return "";
  return String(raw)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ── Scoring ────────────────────────────────────────────────────────────────
 * Returns true when the normalized answer matches any of the acceptable
 * targets, which may be a single string or an array. An empty answer is
 * always false. The caller supplies the target: the feature for Q-blank
 * trials, the full name for Q-full trials.
 */

export function scoreAnswer(rawAnswer, acceptable) {
  const a = normalizeAnswer(rawAnswer);
  if (!a) return false;
  const list = Array.isArray(acceptable) ? acceptable : [acceptable];
  return list.some(x => normalizeAnswer(x) === a);
}

/* ── CSV loader ─────────────────────────────────────────────────────────── */

// Fetches a CSV of items (items_v2.csv by default) and returns the parsed
// rows. Throws when the request fails.
export async function loadItems(url = "items_v2.csv") {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`loadItems ${url}: ${res.status}`);
  const text = await res.text();
  return parseCSV(text);
}

// Parses comma-separated text into an array of objects keyed by the header
// row. Blank lines are dropped; commas inside fields are not supported.
export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(s => s.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

/* ── Session filter ─────────────────────────────────────────────────────────
 * Given the full items pool and the participant's option + the session's
 * properties, returns the items that belong in this session.
 *
 * Counterbalance rules:
 *   option1 -> C-1 spaced, C-2 massed
 *   option2 -> C-2 spaced, C-1 massed
 *
 * pickSessionItems({items, optionId, sessionId, phase})
 *   phase = 'spaced' | 'massed'
 *   sessionId for 'spaced': 1, 2, 3, or 4 (which spaced session)
 *   sessionId for 'massed': 1, 2, 3, or 4 (which massed block, all session=N in csv)
 *
 * Examples:
 *   pickSessionItems({items, optionId:"option1", sessionId:1, phase:"spaced"})
 *     -> all C-1 items with session==1 (12 items)
 *   pickSessionItems({items, optionId:"option2", sessionId:3, phase:"massed"})
 *     -> all C-1 items with session==3 (12 items — C-1 is massed for option2)
 */

export function pickSessionItems({ items, optionId, sessionId, phase }) {
  const spacedGroup = optionId === "option1" ? "C-1" : "C-2";
  const massedGroup = optionId === "option1" ? "C-2" : "C-1";
  const wantedGroup = phase === "spaced" ? spacedGroup : massedGroup;
  return items.filter(it => it.group === wantedGroup && Number(it.session) === Number(sessionId));
}

/* ── Shuffle ────────────────────────────────────────────────────────────────
 * Fisher-Yates in-place shuffle. Returns the same array for chaining.
 * Accepts an optional random-number generator in place of Math.random.
 */

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── Mastery-loop disposition (pure, testable) ──────────────────────────────
 * Given the outcome of a trial and the current loop state, decide what to
 * do with the item: master it, soft-cap it, or re-queue it at a depth.
 *
 *   correct      — boolean: did the participant get this trial right?
 *   attempt      — 1-based attempt count for this item this session
 *   maxRetries   — soft cap (item is dropped after this many wrong attempts)
 *   requeueDepth — positions from the front to re-insert a missed item
 *   deckLength   — current length of the active deck (after popping this item)
 *
 * Returns: { action: "master"|"soft_cap"|"requeue", reinsertAt: number|null, softCapped: boolean }
 */
export function decideTrialDisposition({ correct, attempt, maxRetries, requeueDepth, deckLength }) {
  if (correct) {
    return { action: "master", reinsertAt: null, softCapped: false };
  }
  if (attempt >= maxRetries) {
    return { action: "soft_cap", reinsertAt: null, softCapped: true };
  }
  return {
    action: "requeue",
    reinsertAt: Math.min(deckLength, requeueDepth),
    softCapped: false,
  };
}

/* ── Mastery-loop simulator (pure, testable) ────────────────────────────────
 * Replays a session's deck mechanics with a scripted outcome per item.
 * Used by the test suite to verify the loop's behaviour without a DOM.
 *
 *   items                — array of items with item_id
 *   outcomesByItem       — Map<item_id, boolean[]>: outcomes[i] is the result
 *                          of the (i+1)-th attempt at that item
 *   opts                 — { maxRetries, requeueDepth }
 *
 * Returns { sequence, mastered, softCapped }.
 */
export function simulateMasteryLoop(items, outcomesByItem, opts = {}) {
  const { maxRetries = 5, requeueDepth = 3 } = opts;
  const activeDeck = [...items];
  const retryByItem = new Map();
  const mastered    = [];
  const softCapped  = [];
  const sequence    = [];

  while (activeDeck.length > 0) {
    const item = activeDeck.shift();
    const attempt = (retryByItem.get(item.item_id) || 0) + 1;
    retryByItem.set(item.item_id, attempt);

    const outcomes = outcomesByItem.get(item.item_id) || [];
    const correct = !!outcomes[attempt - 1];
    sequence.push({ item_id: item.item_id, attempt, correct });

    const d = decideTrialDisposition({
      correct, attempt, maxRetries, requeueDepth, deckLength: activeDeck.length,
    });
    if (d.action === "master")   mastered.push(item.item_id);
    else if (d.action === "soft_cap") softCapped.push(item.item_id);
    else activeDeck.splice(d.reinsertAt, 0, item);
  }

  return { sequence, mastered, softCapped };
}

/* ── Asset helpers ──────────────────────────────────────────────────────────
 * Returns the structure-image path for an item, or "" when it has no
 * full_name. Filename convention: lowercase, spaces become underscores,
 * hyphens preserved.
 *   "iso-butyl chloride" -> "images/structures/iso-butyl_chloride.svg"
 *   "1-fluoropropane"    -> "images/structures/1-fluoropropane.svg"
 */

export function imagePathFor(item) {
  if (!item?.full_name) return "";
  const file = item.full_name.toLowerCase().replace(/\s+/g, "_");
  return `images/structures/${file}.svg`;
}

/**
 * Shows the "show numbering of carbons" button on the wrong-answer feedback
 * screen and toggles the displayed structure image between the plain and the
 * numbered variant. Display only: it does not touch the recorded trial or
 * review_ms. The button appears only when a numbered SVG exists for the
 * molecule, which is probed by loading it.
 */
function offerCarbonNumbering(els, plainPath, abortSignal) {
  const numberedPath = plainPath.replace(/\.svg$/, "_numbered.svg");
  const probe = new Image();
  probe.onload = () => {
    if (abortSignal.aborted) return;        // the trial has already advanced
    els.numberBtn.hidden = false;
    let showing = false;
    els.numberBtn.onclick = () => {
      showing = !showing;
      els.img.style.backgroundImage = `url("${showing ? numberedPath : plainPath}")`;
      els.numberBtn.textContent =
        showing ? "Hide numbering of carbons" : "Show numbering of carbons";
    };
  };
  probe.onerror = () => {};                  // no numbered variant: button stays hidden
  probe.src = numberedPath;
}

/* ── Trial UI ─────────────────────────────────────────────────────────────*/

// Markup for the single trial card, reused for every trial in a session.
const TRIAL_CARD_HTML = `
  <section class="trial-card card">
    <div class="trial-img-wrap">
      <div class="trial-structure" role="img" aria-label="Chemical structure"></div>
      <div class="trial-img-fallback hint-sm" hidden></div>
    </div>
    <p class="prompt-text" aria-live="polite"></p>
    <div class="trial-timer-row" hidden>
      <div class="trial-timer-bar" aria-hidden="true"><div class="trial-timer-bar__fill"></div></div>
      <p class="trial-timer" aria-live="polite"></p>
    </div>
    <label class="field__label trial-label">Your answer</label>
    <div class="trial-input-row">
      <input class="field__input trial-input" type="text"
             placeholder="Type your answer..."
             autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <button class="btn btn--primary trial-submit" type="button">Submit</button>
    </div>
    <p class="warn trial-warn" hidden>Please enter an answer.</p>
    <div class="confidence-block" hidden role="group" aria-labelledby="confidenceLabel">
      <p class="confidence-prompt" id="confidenceLabel"></p>
      <div class="confidence-options">
        <button class="btn btn--ghost confidence-btn" type="button" data-confidence="1"></button>
        <button class="btn btn--ghost confidence-btn" type="button" data-confidence="2"></button>
        <button class="btn btn--ghost confidence-btn" type="button" data-confidence="3"></button>
        <button class="btn btn--ghost confidence-btn" type="button" data-confidence="4"></button>
      </div>
    </div>
    <div class="feedback-block" hidden>
      <div class="feedback-pills">
        <span class="pill">Your answer: <strong class="fb-your"></strong></span>
        <span class="pill fb-correct-pill">Correct answer: <strong class="fb-correct"></strong></span>
      </div>
    </div>
    <div class="correction-panel" hidden></div>
    <button class="btn btn--ghost trial-number-btn" type="button" hidden>Show numbering of carbons</button>
    <div class="trial-next-row">
      <button class="btn btn--ghost btn--next trial-next" type="button" hidden>Next question</button>
      <p class="hint-enter trial-next-hint" hidden>Press <kbd>Enter</kbd> to continue.</p>
    </div>
  </section>
`;

// Builds the session header, progress bar, trial slot and summary slot inside
// the container, and returns an object of element references that the session
// orchestrator reuses for every trial.
function mountSessionShell(container, { title, total }) {
  container.innerHTML = `
    <header class="session-header">
      <h1 class="session-title">${title}</h1>
      <p class="session-progress hint-sm"><span class="session-progress-num">0</span> of ${total}</p>
    </header>
    <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="progress-bar__fill" style="width: 0%"></div>
    </div>
    <div class="session-trial-slot">${TRIAL_CARD_HTML}</div>
    <div class="session-summary-slot" hidden></div>
    <audio class="session-snd-ok"  src="sounds/correct.mp3"   preload="auto"></audio>
    <audio class="session-snd-bad" src="sounds/incorrect.mp3" preload="auto"></audio>
  `;
  const trialSlot = container.querySelector(".session-trial-slot");
  return {
    container,
    trialSlot,
    summarySlot: container.querySelector(".session-summary-slot"),
    progressNum: container.querySelector(".session-progress-num"),
    progressFill: container.querySelector(".progress-bar__fill"),
    progressBar:  container.querySelector(".progress-bar"),
    sndOk:        container.querySelector(".session-snd-ok"),
    sndBad:       container.querySelector(".session-snd-bad"),
    // Trial-card refs (single instance, reused per trial):
    img:           trialSlot.querySelector(".trial-structure"),
    imgFallback:   trialSlot.querySelector(".trial-img-fallback"),
    promptText:    trialSlot.querySelector(".prompt-text"),
    timer:         trialSlot.querySelector(".trial-timer"),
    timerRow:      trialSlot.querySelector(".trial-timer-row"),
    timerBar:      trialSlot.querySelector(".trial-timer-bar"),
    timerBarFill:  trialSlot.querySelector(".trial-timer-bar__fill"),
    input:         trialSlot.querySelector(".trial-input"),
    submitBtn:     trialSlot.querySelector(".trial-submit"),
    warn:          trialSlot.querySelector(".trial-warn"),
    confidence:    trialSlot.querySelector(".confidence-block"),
    confidencePrompt:  trialSlot.querySelector(".confidence-prompt"),
    confidenceBtns: Array.from(trialSlot.querySelectorAll(".confidence-btn")),
    feedback:      trialSlot.querySelector(".feedback-block"),
    fbYour:        trialSlot.querySelector(".fb-your"),
    fbCorrect:     trialSlot.querySelector(".fb-correct"),
    fbCorrectPill: trialSlot.querySelector(".fb-correct-pill"),
    correction:    trialSlot.querySelector(".correction-panel"),
    numberBtn:     trialSlot.querySelector(".trial-number-btn"),
    nextBtn:       trialSlot.querySelector(".trial-next"),
    nextHint:      trialSlot.querySelector(".trial-next-hint"),
  };
}

/* ── beforeunload guard ─────────────────────────────────────────────────────
 * Ref-counted install and removal of a "your progress will be lost if you
 * leave" prompt. The guard is installed on the first install call and removed
 * only when the count returns to zero, so a per-phase guard can nest inside a
 * whole-composite one. Both functions are a no-op where `window` is undefined.
 */

let _beforeUnloadRefCount = 0;
// beforeunload listener that asks the browser to show its leave-page prompt.
function _beforeUnloadHandler(e) {
  e.preventDefault();
  e.returnValue = "Your progress for this session will be lost if you leave.";
  return e.returnValue;
}

// Increments the guard ref count, adding the beforeunload listener on the
// first call.
export function installBeforeUnloadGuard() {
  if (_beforeUnloadRefCount === 0 && typeof window !== "undefined") {
    window.addEventListener("beforeunload", _beforeUnloadHandler);
  }
  _beforeUnloadRefCount++;
}

// Decrements the guard ref count, removing the beforeunload listener once it
// reaches zero.
export function removeBeforeUnloadGuard() {
  _beforeUnloadRefCount = Math.max(0, _beforeUnloadRefCount - 1);
  if (_beforeUnloadRefCount === 0 && typeof window !== "undefined") {
    window.removeEventListener("beforeunload", _beforeUnloadHandler);
  }
}

// For tests only — read-only snapshot of the current ref count.
export function _getBeforeUnloadRefCount() { return _beforeUnloadRefCount; }

// Plays the correct or incorrect feedback sound. Playback failures are
// ignored.
function playFeedbackSound(els, correct) {
  const audio = correct ? els.sndOk : els.sndBad;
  if (!audio) return;
  try {
    audio.currentTime = 0;
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* ignore */ }
}

/* ── Button animations ──────────────────────────────────────────────────────
 * The .popping and .shaking classes are defined in style.css
 * (.btn.popping / .btn.shaking). Each function removes the class, forces a
 * reflow so the animation restarts, then re-adds it and clears it on
 * animationend.
 */

// Runs the pop scale animation on a button.
function popBtn(btn) {
  if (!btn) return;
  btn.classList.remove("popping");
  void btn.offsetWidth;
  btn.classList.add("popping");
  btn.addEventListener("animationend", () => btn.classList.remove("popping"), { once: true });
}

// Runs the horizontal shake animation on a button.
function shakeBtn(btn) {
  if (!btn) return;
  btn.classList.remove("shaking");
  void btn.offsetWidth;
  btn.classList.add("shaking");
  btn.addEventListener("animationend", () => btn.classList.remove("shaking"), { once: true });
}

/* ── Confetti ───────────────────────────────────────────────────────────────
 * Fountain confetti: particles shoot upward from the top-centre of the
 * given element (the submit button), spread no wider than the button,
 * fall under gravity, and stop after FRAMES requestAnimationFrame ticks.
 * The canvas removes itself when the animation ends.
 */

const CONFETTI = { PIECES: 34, SPEED: 1.8, GRAVITY: 0.09, FRAMES: 75 };
const CONFETTI_COLORS = ["#22c55e", "#16a34a", "#34d87a", "#f0b429", "#ffffff"];

// Draws a burst of confetti from the top edge of the given element on a
// full-screen overlay canvas.
function launchConfetti(fromEl) {
  if (!fromEl) return;
  const rect    = fromEl.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top;
  const halfW   = rect.width / 2;

  let canvas = document.getElementById("confettiCanvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "confettiCanvas";
    canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999;";
    document.body.appendChild(canvas);
  }
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const onResize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  window.addEventListener("resize", onResize);

  const rand = (a, b) => a + Math.random() * (b - a);
  const pieces = Array.from({ length: CONFETTI.PIECES }, () => ({
    x: originX + rand(-halfW * 0.4, halfW * 0.4),
    y: originY,
    vx: rand(-halfW * 0.055, halfW * 0.055) * CONFETTI.SPEED,
    vy: rand(-4.5, -2.0) * CONFETTI.SPEED,
    rx: rand(0, 6.28),
    vr: rand(0.1, 0.4),
    w: rand(3, 7),
    h: rand(6, 12),
    color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
  }));

  const ctx   = canvas.getContext("2d");
  let   frame = 0;

  (function tick() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.vy += CONFETTI.GRAVITY; p.x += p.vx; p.y += p.vy; p.rx += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rx);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (frame < CONFETTI.FRAMES) {
      requestAnimationFrame(tick);
    } else {
      window.removeEventListener("resize", onResize);
      canvas.remove();
    }
  })();
}

// Updates the "N of M" counter and the progress bar width and aria value.
function updateProgress(els, completed, total) {
  els.progressNum.textContent = String(completed);
  const pct = total ? Math.round(100 * completed / total) : 0;
  els.progressFill.style.width = pct + "%";
  els.progressBar.setAttribute("aria-valuenow", String(pct));
}

/* ── Single trial state machine ─────────────────────────────────────────────
 * runTrial(item, els, opts) returns a Promise that resolves with a trial-data
 * object once the participant presses Next (or auto-advances on timeout if
 * feedback is disabled).
 *
 * Trial data shape:
 *   { item_id, group, feature, full_name, qtype,
 *     raw_answer, correct, rt_ms, stim_on_ts, stim_off_ts, timed_out }
 */

function runTrial(item, els, opts) {
  return new Promise(resolve => {
    // Two AbortControllers per trial: trialAc holds the question-phase
    // listeners (submit click, input keydown) and advanceAc holds the
    // answer-phase listeners (Next button, advance keydown). Aborting a
    // controller removes all of its listeners at once.
    const trialAc   = new AbortController();
    const advanceAc = new AbortController();
    let alreadyResolved = false;
    // Resolves the trial once, drops both sets of listeners, and clears the
    // DEV answer hook.
    function finish(trial) {
      if (alreadyResolved) return;
      alreadyResolved = true;
      trialAc.abort();
      advanceAc.abort();
      if (typeof window !== "undefined" && window.__cfcTesterActive) {
        window.__cfcCurrentAnswer = null;
      }
      resolve(trial);
    }

    // Reset UI from previous trial
    els.feedback.hidden    = true;
    els.correction.hidden  = true;
    els.correction.innerHTML = "";
    els.numberBtn.hidden      = true;
    els.numberBtn.textContent = "Show numbering of carbons";
    els.numberBtn.onclick     = null;
    els.fbYour.textContent     = "";
    els.fbCorrect.textContent  = "";
    els.fbCorrectPill.classList.remove("pill--correct", "pill--wrong");
    els.nextBtn.hidden     = true;
    els.nextHint.hidden    = true;
    els.warn.hidden        = true;
    els.confidence.hidden  = true;
    els.input.disabled     = false;
    els.submitBtn.disabled = false;
    els.input.value        = "";
    // Reset the submit button's state class + text from the previous trial.
    els.submitBtn.classList.remove("trial-submit--correct", "trial-submit--incorrect");
    els.submitBtn.textContent = "Submit";

    // Stimulus. Painted as a CSS background image with background-size:contain
    // so the structure fits the frame in both orientations.
    const imgPath = imagePathFor(item);
    els.img.hidden = false;
    els.imgFallback.hidden = true;
    els.img.setAttribute("aria-label", `Chemical structure of ${item.full_name}`);
    els.img.style.backgroundImage = `url("${imgPath}")`;
    // Probes the image file separately and swaps in a text placeholder when the
    // structure has not been drawn yet. A probe that fails after the trial has
    // advanced is ignored.
    const stimProbe = new Image();
    stimProbe.onerror = () => {
      if (trialAc.signal.aborted) return;
      els.img.hidden = true;
      els.img.style.backgroundImage = "";
      els.imgFallback.hidden = false;
      els.imgFallback.textContent = `[Structure image not yet drawn: ${item.full_name}]`;
    };
    stimProbe.src = imgPath;

    // Prompt
    const qtype = item.qtype || "Q-blank";
    if (qtype === "Q-full") {
      els.promptText.textContent = "Type the full IUPAC name.";
    } else {
      // Renders the blank as a fixed-width styled underline span rather than
      // literal underscore characters.
      renderPromptIntoEl(els.promptText, item.full_name, item.feature);
    }

    // ── DEV testing hook (read-only; no effect on scoring, timing, or data) ────
    // Exposes the current item's correct answer for the tester bar's "Fill
    // answer" button. Runs only when the tester tools are active, which happens
    // under a DEV id (see tester-tools.js); otherwise `__cfcTesterActive` is
    // unset and this is a no-op.
    if (typeof window !== "undefined" && window.__cfcTesterActive) {
      window.__cfcCurrentAnswer = (qtype === "Q-full") ? item.full_name : item.feature;
    }

    // Timer
    const stim_on_ts = new Date().toISOString();
    const stim_on_ms = performance.now();
    let timerId = null;
    let timeLeft = Math.round((opts.timerMs ?? 20000) / 1000);
    if (opts.showTimer) {
      if (els.timerRow) els.timerRow.hidden = false;
      els.timer.textContent = `${timeLeft}s`;
      // Visual countdown bar. Display only: the setInterval below is the
      // authoritative timeout and rt_ms is measured from performance.now().
      // The forced reflow restarts the CSS animation on every trial.
      if (els.timerBarFill) {
        els.timerBarFill.style.animation = "none";
        void els.timerBarFill.offsetWidth;
        els.timerBarFill.style.animation =
          `trial-timer-deplete ${opts.timerMs ?? 20000}ms linear forwards`;
      }
      timerId = setInterval(() => {
        timeLeft -= 1;
        els.timer.textContent = `${timeLeft}s`;
        if (timeLeft <= 0) {
          clearInterval(timerId);
          timerId = null;
          submit({ timedOut: true });
        }
      }, 1000);
    } else {
      if (els.timerRow) els.timerRow.hidden = true;
    }

    // Focus input
    setTimeout(() => els.input.focus(), 20);

    // Scores the answer, builds the trial record, then runs the confidence
    // prompt and feedback before resolving the trial. Called by the submit
    // button, the Enter key, and the timeout.
    async function submit({ timedOut = false } = {}) {
      // A second submit for the same trial is ignored.
      if (els.submitBtn.disabled) return;
      els.submitBtn.disabled = true;
      els.input.disabled     = true;
      if (timerId) { clearInterval(timerId); timerId = null; }
      if (els.timerRow) els.timerRow.hidden = true;
      if (els.timerBarFill) els.timerBarFill.style.animation = "none";   // reset for next trial

      // Remove the question-phase listeners now that the question is answered.
      trialAc.abort();

      const raw_answer = els.input.value.trim();
      const stim_off_ts = new Date().toISOString();
      const rt_ms = Math.round(performance.now() - stim_on_ms);

      // For Q-blank, target is the feature word. For Q-full, target is full_name.
      const target = (qtype === "Q-full") ? item.full_name : item.feature;
      const correct = scoreAnswer(raw_answer, target);

      const trial = {
        item_id: item.item_id,
        group: item.group,
        feature: item.feature,
        full_name: item.full_name,
        qtype,
        raw_answer,
        correct,
        rt_ms,
        stim_on_ts,
        stim_off_ts,
        timed_out: timedOut,
      };

      // ── Per-item confidence prompt (metacognitive layer) ──────────
      // Runs after the answer is recorded and before any UI element reveals
      // correctness. The submit-button morph (Correct/Incorrect text plus
      // confetti or shake) and the feedback pills all wait until the
      // participant has committed to a confidence rating.
      //
      // Skipped on:
      //   - tests (opts.showFeedback === false; no correctness ever shown)
      //   - timeouts (the participant did not submit a deliberate answer)
      //   - opts.askConfidence explicitly false (host page override)
      const askConfidence =
        opts.askConfidence !== false &&
        opts.showFeedback   === true   &&
        !timedOut;
      trial.confidence = askConfidence ? await showConfidencePrompt(els) : null;

      // Morphs the submit button to reflect the outcome before feedback is
      // shown. The pop and shake animations are defined in style.css; the
      // .trial-submit--correct / --incorrect colour classes are defined in
      // v2-style.css.
      if (opts.showFeedback) {
        if (correct) {
          els.submitBtn.textContent = "Correct";
          els.submitBtn.classList.add("trial-submit--correct");
          popBtn(els.submitBtn);
          launchConfetti(els.submitBtn);
        } else {
          els.submitBtn.textContent = "Incorrect";
          els.submitBtn.classList.add("trial-submit--incorrect");
          shakeBtn(els.submitBtn);
        }
      }

      // Feedback / auto-advance
      if (opts.showFeedback) {
        // Reveals the correct feature inline in the prompt. Q-blank only;
        // Q-full has no blank to replace.
        if (qtype !== "Q-full") {
          revealPromptAnswer(els.promptText, item.feature, correct);
        }
        showTrialFeedback(els, trial);
        // Offers the carbon-numbering toggle on wrong answers only, and only
        // when a numbered variant of the structure exists.
        if (!correct) offerCarbonNumbering(els, imgPath, advanceAc.signal);
        // review_ms runs from the moment feedback renders to the moment the
        // participant advances, and includes the 250 ms lockout below.
        const feedback_shown_ms = performance.now();
        els.nextBtn.hidden  = false;
        els.nextHint.hidden = false;
        // Records review_ms and ends the trial.
        const advance = () => {
          trial.review_ms = Math.round(performance.now() - feedback_shown_ms);
          finish(trial);
        };
        // The Next-button click and Enter-key listeners are registered 250 ms
        // after feedback appears; key presses before that do not advance.
        setTimeout(() => {
          if (advanceAc.signal.aborted) return;
          els.nextBtn.addEventListener("click", advance, { signal: advanceAc.signal });
          document.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); advance(); }
          }, { signal: advanceAc.signal });
          els.nextBtn.focus();
        }, 250);
      } else {
        // No-feedback mode: advances after a short pause. review_ms stays
        // undefined and session-save stores it as NULL.
        setTimeout(() => finish(trial), 250);
      }
    }

    // Submits the typed answer, or shows the "please enter an answer" warning
    // and leaves the trial open when the input is empty.
    function onSubmitClick() {
      const raw = els.input.value.trim();
      if (!raw) {
        els.warn.hidden = false;
        return;
      }
      els.warn.hidden = true;
      submit({ timedOut: false });
    }

    // Submits the answer when Enter is pressed in the answer input.
    function onKeyDown(e) {
      if (e.key === "Enter" && !els.input.disabled) {
        e.preventDefault();
        onSubmitClick();
      }
    }

    els.submitBtn.addEventListener("click", onSubmitClick, { signal: trialAc.signal });
    els.input.addEventListener("keydown", onKeyDown, { signal: trialAc.signal });
  });
}

/**
 * Renders the per-item confidence prompt (4 buttons: Guess / Unsure / Fairly
 * sure / Certain) and resolves with the integer 1 to 4 the participant chose.
 *
 * The caller runs this after the answer has been submitted and before
 * correctness is shown anywhere on screen.
 *
 * There is no default selection and no separate submit step: one tap or one
 * number key commits the rating and resolves the promise.
 *
 * The prompt text and the four button labels are read from copy_strings_v2 via
 * getCopy, with English fallbacks built into copy-strings.js.
 */
function showConfidencePrompt(els) {
  return new Promise(resolve => {
    els.confidencePrompt.textContent = getCopy("confidence_prompt");
    const labels = [
      getCopy("confidence_option_guess"),
      getCopy("confidence_option_unsure"),
      getCopy("confidence_option_fairly_sure"),
      getCopy("confidence_option_certain"),
    ];
    els.confidenceBtns.forEach((btn, i) => {
      // Each button holds a number-key badge and a label, built as DOM nodes.
      // A CSS media query shows the .confidence-key badge on keyboard devices
      // only; on touch devices just the label is visible.
      btn.textContent = "";
      const key = document.createElement("kbd");
      key.className = "confidence-key";
      key.textContent = String(i + 1);
      const lab = document.createElement("span");
      lab.className = "confidence-label";
      lab.textContent = labels[i];
      btn.append(key, lab);
      btn.disabled = false;
      // The buttons stay out of the tab order and are never auto-focused;
      // Enter and Space are blocked below, so a rating is committed only by a
      // click or a 1 to 4 key press.
      btn.setAttribute("tabindex", "-1");
    });

    els.confidence.hidden = false;

    const ac = new AbortController();

    // The 1 to 4 keyboard shortcuts arm 250 ms after the prompt appears and
    // ignore auto-repeat.
    let armed = false;
    const armTimer = setTimeout(() => { armed = true; }, 250);

    // Records a rating of 1 to 4, disables the buttons, hides the prompt and
    // resolves. Values outside that range are ignored.
    function commit(v) {
      if (!Number.isInteger(v) || v < 1 || v > 4) return;
      els.confidenceBtns.forEach(b => { b.disabled = true; });
      clearTimeout(armTimer);
      ac.abort();
      els.confidence.hidden = true;
      resolve(v);
    }

    // Commits the rating carried in the clicked button's data-confidence value.
    function onClick(e) {
      commit(Number(e.currentTarget.dataset.confidence));
    }
    // Blocks Enter and Space from activating a focused confidence button.
    function onKeyBlock(e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    // Commits a rating from a 1 to 4 key press once the shortcuts are armed.
    function onShortcut(e) {
      if (!armed || e.repeat) return;
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        commit(Number(e.key));
      }
    }

    els.confidenceBtns.forEach(btn => {
      btn.addEventListener("click",   onClick,    { signal: ac.signal });
      btn.addEventListener("keydown", onKeyBlock, { signal: ac.signal });
    });
    document.addEventListener("keydown", onShortcut, { signal: ac.signal });
    // No confidence button is auto-focused.
  });
}

// Fills in and shows the feedback block for a submitted trial: the
// participant's answer, the correct answer, the outcome colour, the entrance
// animation, the feedback sound and, on a wrong answer, the naming-rule
// reminder for the feature.
function showTrialFeedback(els, trial) {
  els.feedback.hidden = false;
  els.fbYour.textContent = trial.raw_answer || "(no answer)";
  els.fbCorrect.textContent = (trial.qtype === "Q-full") ? trial.full_name : trial.feature;
  // Colours the correct-answer pill green or red according to the outcome.
  els.fbCorrectPill.classList.toggle("pill--correct", trial.correct);
  els.fbCorrectPill.classList.toggle("pill--wrong",  !trial.correct);

  // Entrance animation. Toggling the class triggers the CSS keyframe.
  els.feedback.classList.remove("feedback-block--pop");
  void els.feedback.offsetWidth;  // force reflow so animation re-runs each trial
  els.feedback.classList.add("feedback-block--pop");

  playFeedbackSound(els, trial.correct);

  // The naming-rule reminder appears only on a wrong answer.
  if (!trial.correct) {
    const copy = getFeatureCopy(trial.feature);
    if (copy) {
      els.correction.hidden = false;
      els.correction.innerHTML = `
        <h3 class="correction-title">${escapeHtml(copy.displayName)}</h3>
        <p class="correction-rule">${escapeHtml(copy.rule)}</p>
      `;
    }
  }
}

// Returns the string with HTML-special characters replaced by entities.
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * Renders the end-of-session summary card.
 *
 * Three styles:
 *   "default"  verbose: shows first-attempt accuracy, mastery count and mean
 *              response time. Used for development and debugging.
 *   "neutral"  shown to participants after practice sessions. Confirms the
 *              session was saved and shows no accuracy, mastery or
 *              response-time information.
 *   "silent"   shown after tests (pretest, delayed posttest). Same content as
 *              "neutral", kept as a separate style so the two can differ.
 *
 * The CTA starts in a disabled "Saving…" state. The caller (startSession)
 * runs the save via onComplete, then calls the returned `enableCta()` to
 * move the button to its ready state, or `enableCta(errorMsg)` to show a
 * save-failure state.
 *
 * Returns: { enableCta(errorMsg?) }
 */
function renderSummary(els, summary, sessionLabel, summaryCta, summaryStyle = "default") {
  const {
    trials, nMastered, nSoftCapped, nTotalItems,
  } = summary;

  els.trialSlot.hidden = true;
  els.summarySlot.hidden = false;

  let bodyHtml;
  let titleText;
  if (summaryStyle === "silent") {
    titleText = "Thank you";
    bodyHtml = `
      <p>You have completed this section. Your responses have been recorded.</p>
    `;
  } else if (summaryStyle === "neutral") {
    // Copy is read from the editable copy_strings_v2 rows. The session label
    // is not shown on this card.
    titleText = getCopy("summary_neutral_title", "Thank you");
    bodyHtml  = `<p>${escapeHtml(getCopy("summary_neutral_body", "Your responses have been saved."))}</p>`;
  } else {
    const totalTrials = trials.length;
    const meanRt = totalTrials ? Math.round(trials.reduce((s, t) => s + t.rt_ms, 0) / totalTrials) : 0;
    const firstPassCorrect = trials.filter(t => t.retry_attempt === 1 && t.correct).length;
    const firstPassRate = nTotalItems ? Math.round(100 * firstPassCorrect / nTotalItems) : 0;
    const softCapNote = nSoftCapped > 0
      ? `<p class="hint-sm">${nSoftCapped} item(s) needed extra practice. You will see related items again in later sessions.</p>`
      : "";
    titleText = "Session complete";
    bodyHtml = `
      <p><strong>${nMastered} of ${nTotalItems}</strong> items mastered.</p>
      <p>First-attempt accuracy: ${firstPassRate}%.</p>
      <p>Total trials: ${totalTrials}. Average response time: ${meanRt} ms.</p>
      ${softCapNote}
      <p class="hint-sm">Session: ${escapeHtml(sessionLabel || "")}</p>
    `;
  }

  els.summarySlot.innerHTML = `
    <section class="session-summary card card--success">
      <header class="card__header">
        <h2 class="card__title">${escapeHtml(titleText)}</h2>
        <p class="card__subtitle">Thanks for completing this section.</p>
      </header>
      <div class="card__body">${bodyHtml}</div>
      <div class="card__footer">
        <button class="btn btn--primary session-summary-cta" type="button" disabled>Saving…</button>
        <p class="hint-sm session-summary-cta-hint">Saving your results…</p>
      </div>
    </section>
  `;

  const btn  = els.summarySlot.querySelector(".session-summary-cta");
  const hint = els.summarySlot.querySelector(".session-summary-cta-hint");

  return {
    /**
     * Moves the CTA out of its "Saving…" state.
     *   enableCta()                           success: the button becomes the
     *                                         ready CTA.
     *   enableCta("Save failed: …")           failure with no retry: the button
     *                                         stays disabled.
     *   enableCta("Save failed: …", onRetry)  failure with retry: the button
     *                                         shows "Try saving again" and a
     *                                         click re-runs onRetry. Trial data
     *                                         stays in memory across retries.
     */
    enableCta(errorMsg = null, onRetry = null) {
      if (errorMsg) {
        if (onRetry) {
          btn.textContent  = "Try saving again";
          btn.disabled     = false;
          hint.textContent = errorMsg + " Click to retry. If the issue persists, contact your researcher; your data is still in this browser tab.";
          hint.style.color = "#b91c1c";
          // The handler runs once per click wiring; each onRetry call ends in
          // another enableCta call, which wires a fresh handler.
          btn.addEventListener("click", async () => {
            btn.textContent  = "Saving…";
            btn.disabled     = true;
            hint.textContent = "Saving your results…";
            hint.style.color = "";
            await onRetry();
          }, { once: true });
          return;
        }
        // No-retry path, used when the caller supplies no retry callback: the
        // button stays disabled.
        btn.textContent  = "Save failed";
        btn.disabled     = true;
        hint.textContent = errorMsg + " Please contact your researcher; your data is still in this browser tab.";
        hint.style.color = "#b91c1c";
        return;
      }
      btn.textContent  = summaryCta?.text || "Return to start";
      btn.disabled     = false;
      hint.textContent = "Saved.";
      hint.style.color = "var(--color-muted)";
      // CTA precedence: explicit onClick > explicit href > default (study.html)
      const handler =
        summaryCta?.onClick ||
        (summaryCta?.href ? (() => { window.location.href = summaryCta.href; }) : null) ||
        (() => { window.location.href = "study.html"; });
      btn.addEventListener("click", handler, { once: true });
      setTimeout(() => btn.focus(), 20);
    },
  };
}

/* ── Session orchestrator (successive relearning) ───────────────────────────
 * Public entry point. The host page imports this, gathers items, and calls.
 *
 * The trial loop is a drop-out-with-replacement deck. An item drops out of
 * the deck when it is retrieved correctly once in the session; a missed item
 * is re-queued 3 positions back. After 5 wrong attempts an item is soft
 * capped: it is logged with `soft_capped: true` and leaves the deck after its
 * final feedback.
 *
 * With opts.masteryLoop === false the loop runs single-pass instead, one
 * trial per item, which is what the pretest and posttests use.
 *
 * opts:
 *   container        — DOM element to render into
 *   items            — array of items (filtered + shuffled by the host page)
 *   sessionLabel     — string label used in summary + (later) sent to worker
 *   sessionTitle     — header text, e.g. "Spaced session 1"
 *   showFeedback     — bool (default true). False = no feedback, no sound,
 *                      no button colour change (used by the silent tests).
 *   showTimer        — bool (default true)
 *   timerMs          — per-trial time limit (default 20_000)
 *   masteryLoop      — bool (default true for practice). When false, runs
 *                      the single-pass loop instead.
 *   maxRetries       — soft cap before an item is dropped (default 5).
 *   requeueDepth     — positions from the front to re-insert a missed
 *                      item (default 3). Caps at end-of-deck if shorter.
 *   onTrial          — optional callback (trialData) => void, per-trial
 *   onComplete       — optional callback (summary)   => void, at end
 */

export async function startSession(opts) {
  const {
    container, items, sessionLabel, sessionTitle,
    showFeedback = true, showTimer = true, timerMs = 20000,
    masteryLoop  = true,
    maxRetries   = 5,
    requeueDepth = 3,
    guardBeforeUnload = true,
    // askConfidence follows showFeedback unless the host page passes it
    // explicitly: practice sessions ask for a confidence rating, tests do not.
    askConfidence = undefined,
    onTrial, onComplete,
  } = opts;

  if (!container) throw new Error("startSession: container is required");
  if (!Array.isArray(items) || !items.length) {
    container.innerHTML = `<p class="warn">No items available for this session.</p>`;
    return { trials: [], nMastered: 0, nSoftCapped: 0, nTotalItems: 0 };
  }

  // Loads the editable copy strings (confidence prompt labels and so on)
  // before the first trial. The call is idempotent and does not throw; if the
  // fetch fails the built-in English defaults stay in place.
  if (showFeedback) {
    await preloadCopyStrings();
  }

  const nTotalItems = items.length;
  const els = mountSessionShell(container, { title: sessionTitle || sessionLabel || "Session", total: nTotalItems });
  updateProgress(els, 0, nTotalItems);

  // Mastery-loop state
  const activeDeck   = [...items];                 // mutated as items drop out
  const retryByItem  = new Map();                  // item_id -> # attempts so far
  const mastered     = new Set();                  // item_ids successfully retrieved this session
  const softCapped   = new Set();                  // item_ids that hit maxRetries without mastery
  const trials       = [];

  // Warns the participant if they try to close the tab mid-session. The guard
  // is ref-counted, so a caller can hold its own guard around this one.
  if (guardBeforeUnload) installBeforeUnloadGuard();

  try {
  while (activeDeck.length > 0) {
    const item = activeDeck.shift();
    const attempt = (retryByItem.get(item.item_id) || 0) + 1;
    retryByItem.set(item.item_id, attempt);

    const trial = await runTrial(item, els, {
      showFeedback, showTimer, timerMs,
      askConfidence,   // undefined falls back to showFeedback inside runTrial
    });
    trial.retry_attempt = attempt;

    if (masteryLoop) {
      const d = decideTrialDisposition({
        correct: trial.correct, attempt,
        maxRetries, requeueDepth, deckLength: activeDeck.length,
      });
      trial.soft_capped = d.softCapped;
      if (d.action === "master")        mastered.add(item.item_id);
      else if (d.action === "soft_cap") softCapped.add(item.item_id);
      else                              activeDeck.splice(d.reinsertAt, 0, item);
    } else {
      // Single-pass mode, used by the pretest and posttests.
      trial.soft_capped = false;
      if (trial.correct) mastered.add(item.item_id);
      else               softCapped.add(item.item_id);
    }

    trials.push(trial);
    updateProgress(els, mastered.size + softCapped.size, nTotalItems);
    try { onTrial && onTrial(trial); } catch (e) { console.error("onTrial error:", e); }
  }
  } finally {
    // Lifts the guard once the trial loop is over, so the summary screen and
    // its CTA navigate without a warning.
    if (guardBeforeUnload) removeBeforeUnloadGuard();
  }

  const summary = {
    trials,
    nMastered:   mastered.size,
    nSoftCapped: softCapped.size,
    nTotalItems,
  };

  // Renders the summary card in its "Saving…" state. The page-level
  // onComplete below performs the save; the CTA then moves to its ready state,
  // or to a failure state that keeps the participant on this screen.
  // summaryStyle defaults to "default"; host pages pass "neutral" or "silent"
  // to hide the accuracy and mastery numbers.
  const summaryHandle = renderSummary(els, summary, sessionLabel, opts.summaryCta, opts.summaryStyle || "default");

  // Runs the save. On success the CTA becomes the advance button; on failure
  // it becomes "Try saving again", which calls trySave once more. Every retry
  // re-submits the same `summary` payload held in this closure.
  const trySave = async () => {
    if (!onComplete) { summaryHandle.enableCta(); return; }
    try {
      await onComplete(summary);
      summaryHandle.enableCta();
    } catch (e) {
      console.error("onComplete error:", e);
      summaryHandle.enableCta(`Save failed: ${e?.message || e}.`, trySave);
    }
  };
  await trySave();
  return summary;
}
