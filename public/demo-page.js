/**
 * demo-page.js — public /demo route orchestrator.
 *
 * A two-pane tutorial demo. Left pane is the table of contents; right pane is
 * the active section. The TOC includes both "live" sections (which render
 * content) and "preview" sections (which render a placeholder card standing in
 * for the full Session 0 scope).
 *
 * Live sections, in order:
 *   1. Welcome
 *   2. Skeletal structures & carbon chains (10 prefix buttons, Chain<->Cyclo
 *      toggle, carbon-numbering overlay) — rendered by the shared
 *      skeletal-picker.js component (also used by the Session 0 tutorial).
 *   3. Cyclo– ring prefix (rule box + cyclohexane with carbon-numbering)
 *   4. Practice question (one Q-blank trial via practice-engine.startSession,
 *      no onComplete — never POSTs anywhere)
 *   5. Complete (end card with Restart)
 *
 * Preview sections (6 entries) render a "preview" placeholder so collaborators
 * see the eventual scope without 24 individual stubs.
 *
 * Isolation guarantees:
 *   - No PID, no enrollment, no session-gate, no prediction widget.
 *   - No /api/v2/session-complete call (no onComplete).
 *   - No /api/v2/metacog/* call.
 *   - One read-only GET /api/v2/copy from preloadCopyStrings; falls back
 *     to baked-in defaults on failure.
 */

import { startSession } from "./practice-engine.js";
import { mountSkeletalPicker } from "./skeletal-picker.js";

/* ── TOC structure ───────────────────────────────────────────────────────── */
/*
 * `kind` values:
 *   "live"     — clickable, renders its section
 *   "preview"  — clickable, renders the "preview" placeholder card
 *   "locked"   — visible but not clickable until a precondition is met
 */
const TUTORIALS = [
  { key: "welcome",      label: "Welcome",                              kind: "live"    },
  { key: "skeletal",     label: "Skeletal structures & carbon chains",  kind: "live"    },
  { key: "functional",   label: "Functional groups",                    kind: "preview" },
  { key: "cyclo",        label: "Cyclo– ring prefix",                   kind: "live"    },
  { key: "fam-chains",   label: "Carbon-chain roots",     sublabel: "eth, prop, but, pent, hex, oct",         kind: "preview" },
  { key: "fam-halogens", label: "Halogens",               sublabel: "bromo, chloro, fluoro, iodo",            kind: "preview" },
  { key: "fam-subs",     label: "Substituents",           sublabel: "methyl, iso, tert",                      kind: "preview" },
  { key: "fam-aroma",    label: "Aromatics",              sublabel: "benzene, toluene, pyridine, pyrrole",    kind: "preview" },
  { key: "fam-suffix",   label: "Suffix functional groups", sublabel: "ene, ol, al, one, oate, amide",        kind: "preview" },
  { key: "practice",     label: "Practice question",                    kind: "live"    },
  { key: "complete",     label: "Complete",                             kind: "locked"  },
];

/* ── State (module-level; reset by resetDemoState) ───────────────────────── */
let activeSection       = "welcome";
let cycloIntroNumbering = false;  // cyclo tutorial-card numbering
let trialCompleted      = false;

/* Returns the module state to its initial values. */
function resetDemoState() {
  activeSection       = "welcome";
  cycloIntroNumbering = false;
  trialCompleted      = false;
}

/* ── Public entry point ──────────────────────────────────────────────────── */
/* Renders the TOC and opens the active section. */
export function runDemoPage() {
  renderToc();
  activateSection(activeSection);
}

/* ── TOC sidebar ─────────────────────────────────────────────────────────── */
/* Rebuilds the sidebar list and attaches its click handlers. */
function renderToc() {
  const toc = document.getElementById("demo-toc");
  if (!toc) return;
  toc.innerHTML = `
    <h3>Tutorial outline</h3>
    <ul class="toc-list" role="list">
      ${TUTORIALS.map(renderTocItem).join("")}
    </ul>
  `;
  toc.querySelectorAll(".toc-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const entry = TUTORIALS.find(t => t.key === key);
      if (!entry) return;
      if (entry.kind === "locked" && !(key === "complete" && trialCompleted)) {
        // Locked and the precondition is unmet: ignore the click.
        return;
      }
      activateSection(key);
    });
  });
}

/* Markup for one TOC entry, carrying its active, preview, or locked state. */
function renderTocItem(entry) {
  const isActive = entry.key === activeSection;
  const isLocked = entry.kind === "locked" && !(entry.key === "complete" && trialCompleted);
  const classes = ["toc-item"];
  if (isActive) classes.push("is-active");
  if (entry.kind === "preview") classes.push("is-preview");
  if (isLocked) classes.push("is-locked");
  const aria = isActive ? `aria-current="step"` : "";
  const disabled = isLocked ? "disabled" : "";
  const subline = entry.sublabel ? `<span class="toc-sublabel">${escapeHtml(entry.sublabel)}</span>` : "";
  return `
    <li>
      <button type="button" class="${classes.join(" ")}" data-key="${entry.key}" ${aria} ${disabled}>
        ${escapeHtml(entry.label)}${subline}
      </button>
    </li>
  `;
}

/* ── Section dispatcher ──────────────────────────────────────────────────── */
/* Makes `key` the active section and renders it into the right pane. */
function activateSection(key) {
  activeSection = key;
  renderToc();   // refresh active highlight
  const entry = TUTORIALS.find(t => t.key === key);
  if (!entry) return;

  if (entry.kind === "preview") {
    renderPreview(entry);
    return;
  }
  switch (key) {
    case "welcome":   renderWelcome();   break;
    case "skeletal":  renderSkeletal();  break;
    case "cyclo":     renderCyclo();     break;
    case "practice":  renderTrial();     break;
    case "complete":  renderComplete();  break;
    default:          renderPreview(entry);
  }
}

/* ── Section: Welcome ────────────────────────────────────────────────────── */
/* Renders the opening card listing what the demo covers. */
function renderWelcome() {
  const root = document.getElementById("demo-content");
  root.innerHTML = `
    <div class="demo-card">
      <h2 class="card__title" style="margin-top:0;">Welcome to the ChemFlashcards demo</h2>
      <p class="card__subtitle" style="margin-bottom:var(--space-lg);">
        A short walkthrough of what a learner sees during the introduction phase of the study, followed by one practice question.
      </p>
      <p>This demo includes:</p>
      <ol style="padding-left:1.4em; line-height:1.7;">
        <li><strong>Skeletal structures &amp; carbon chains</strong> — how to read the diagrams used in every question, with chain↔ring toggle.</li>
        <li><strong>Cyclo– ring prefix</strong> — a short worked example of one IUPAC concept.</li>
        <li><strong>One practice question</strong> — the same trial format participants see in the real study (no data is recorded).</li>
      </ol>
      <p>Sections marked as <em>preview</em> in the outline are placeholders for the full Session 0 tutorial that participants will see when the study runs.</p>
      <div class="demo-footer">
        <button type="button" class="btn btn--primary" data-next="skeletal">Begin tutorial →</button>
      </div>
    </div>
  `;
  wireNextButton(root);
}

/* ── Section: Skeletal structures ─────────────────────────────────────────── */
/* Renders the how-to-read-diagrams card and mounts the shared picker in it. */
function renderSkeletal() {
  const root = document.getElementById("demo-content");
  root.innerHTML = `
    <div class="demo-card">
      <h2 class="card__title" style="margin-top:0;">Skeletal structures &amp; carbon chains</h2>
      <p class="card__subtitle">Each line in a skeletal structure is a bond between two carbon atoms. Corners and line endpoints are carbons. Hydrogen atoms on carbon are not shown.</p>

      <div data-skeletal-host></div>

      <div class="demo-footer">
        <button type="button" class="btn btn--primary" data-next="cyclo">Continue →</button>
      </div>
    </div>
  `;
  mountSkeletalPicker(root.querySelector("[data-skeletal-host]"));
  wireNextButton(root);
}

/* ── Section: Cyclo– tutorial card ───────────────────────────────────────── */
/* Renders the cyclo rule card with a cyclohexane structure whose carbon
   numbering can be toggled on and off. */
function renderCyclo() {
  const root = document.getElementById("demo-content");
  root.innerHTML = `
    <div class="demo-card">
      <h2 class="card__title" style="margin-top:0;">Cyclo– ring prefix</h2>
      <p class="card__subtitle">
        Some structures use <em>cyclo&ndash;</em> as a prefix to indicate that the carbon chain closes into a ring.
      </p>
      <p class="demo-rule-box">
        <strong>cyclo&ndash;</strong> + <em>[chain name]</em> = a closed carbon ring (e.g. <strong>cyclohexane</strong>).
      </p>
      <div class="demo-mol-wrap">
        ${cyclohexaneSvgMarkup()}
        <button id="cycloIntroToggle" type="button"
                class="btn btn--ghost btn--sm"
                style="min-width:200px;"
                aria-pressed="${cycloIntroNumbering}">
          ${cycloIntroNumbering ? "Hide carbon numbering" : "Show carbon numbering"}
        </button>
      </div>
      <div class="demo-footer">
        <button type="button" class="btn btn--primary" data-next="practice">Continue to the question →</button>
      </div>
    </div>
  `;
  // Reflect persisted numbering state on the inline SVG
  const numbers = document.querySelector(".demo-mol-svg .carbon-numbers");
  if (numbers) numbers.style.display = cycloIntroNumbering ? "" : "none";

  document.getElementById("cycloIntroToggle").addEventListener("click", () => {
    cycloIntroNumbering = !cycloIntroNumbering;
    const btn = document.getElementById("cycloIntroToggle");
    btn.setAttribute("aria-pressed", String(cycloIntroNumbering));
    btn.textContent = cycloIntroNumbering ? "Hide carbon numbering" : "Show carbon numbering";
    const numbers = document.querySelector(".demo-mol-svg .carbon-numbers");
    if (numbers) numbers.style.display = cycloIntroNumbering ? "" : "none";
  });
  wireNextButton(root);
}

/* Inline SVG for the cyclohexane ring, with the carbon numbers in a group
   that starts hidden. */
function cyclohexaneSvgMarkup() {
  const M = `transform="matrix(0.0666667 0 0 0.0666667 -187.333 -183.333)"`;
  return `
    <svg class="demo-mol-svg" viewBox="-7 -8 51 57"
         role="img" aria-label="Cyclohexane skeletal structure"
         xmlns="http://www.w3.org/2000/svg">
      <g class="ring-bonds">
        <path ${M} d="M 3306.26,3178.94 L 3323.26,3188.76 L 3093.75,3321.26 L 3093.75,3301.64 Z"/>
        <path ${M} d="M 3093.75,3301.64 L 3093.75,3321.26 L 2864.24,3188.76 L 2881.24,3178.94 Z"/>
        <path ${M} d="M 2881.24,3178.94 L 2864.24,3188.76 L 2864.24,2923.74 L 2881.24,2933.56 Z"/>
        <path ${M} d="M 2881.24,2933.56 L 2864.24,2923.74 L 3093.75,2791.24 L 3093.75,2810.86 Z"/>
        <path ${M} d="M 3093.75,2810.86 L 3093.75,2791.24 L 3323.26,2923.74 L 3306.26,2933.56 Z"/>
        <path ${M} d="M 3323.26,3188.76 L 3306.26,3178.94 L 3306.26,2933.56 L 3323.26,2923.74 Z"/>
      </g>
      <g class="carbon-numbers" style="display:none;" aria-hidden="true">
        <text x="18.92"  y="-2"     text-anchor="middle" dominant-baseline="middle">1</text>
        <text x="38.55"  y="11.58"  text-anchor="start"  dominant-baseline="middle">2</text>
        <text x="38.55"  y="29.25"  text-anchor="start"  dominant-baseline="middle">3</text>
        <text x="18.92"  y="42.5"   text-anchor="middle" dominant-baseline="middle">4</text>
        <text x="-0.71"  y="29.25"  text-anchor="end"    dominant-baseline="middle">5</text>
        <text x="-0.71"  y="11.58"  text-anchor="end"    dominant-baseline="middle">6</text>
      </g>
    </svg>
  `;
}

/* ── Section: Practice trial ──────────────────────────────────────────────── */
/* Runs one practice trial on a hand-built demo item. Nothing is saved. */
async function renderTrial() {
  const root = document.getElementById("demo-content");
  root.innerHTML = "";

  // Hand-built demo item. makePrompt(full_name, feature) renders "___hexane".
  const demoItem = {
    item_id:    "DEMO-cyclo",
    group:      "DEMO",
    feature:    "cyclo",
    full_name:  "cyclohexane",
    qtype:      "Q-blank",
    session:    0,
    target_set: 0,
    instance:   1,
  };

  await startSession({
    container:         root,
    items:             [demoItem],
    sessionLabel:      "demo",
    sessionTitle:      "Practice question",
    showFeedback:      true,
    showTimer:         true,
    timerMs:           20000,
    masteryLoop:       false,
    guardBeforeUnload: false,
    summaryStyle:      "neutral",
    summaryCta:        { text: "Continue", onClick: () => { trialCompleted = true; activateSection("complete"); } },
    // onComplete omitted — no /api call, no D1 write.
  });
}

/* ── Section: Complete ────────────────────────────────────────────────────── */
/* Renders the closing card and wires its Restart button. */
function renderComplete() {
  const root = document.getElementById("demo-content");
  root.innerHTML = `
    <div class="demo-card">
      <h2 class="card__title" style="margin-top:0;">Demo complete</h2>
      <p class="card__subtitle">That is the end of the walkthrough. Nothing was recorded.</p>
      <p style="margin-top:var(--space-lg);">
        In a real study run, the participant would now begin Practice Session 1 with their assigned stimulus set.
      </p>
      <div class="demo-footer">
        <button type="button" class="btn btn--primary" id="demoRestart">Restart demo</button>
      </div>
    </div>
  `;
  document.getElementById("demoRestart").addEventListener("click", () => {
    resetDemoState();
    runDemoPage();
  });
}

/* ── Preview placeholders for non-live sections ──────────────────────────── */
/* Renders the placeholder card for a section that the demo does not include. */
function renderPreview(entry) {
  const root = document.getElementById("demo-content");
  const sub  = entry.sublabel ? `<p style="color:var(--color-muted);margin-bottom:var(--space-md);font-style:italic;">${escapeHtml(entry.sublabel)}</p>` : "";
  root.innerHTML = `
    <div class="demo-card">
      <h2 class="card__title" style="margin-top:0;">${escapeHtml(entry.label)}</h2>
      ${sub}
      <div class="preview-card">
        <h3>Section preview</h3>
        <p>
          In the full study, this section will be a short interactive tutorial in the same style as <em>Skeletal structures</em> and <em>Cyclo– ring prefix</em>. It is not part of this demo.
        </p>
        <p style="margin-top:var(--space-sm);">
          Participants will see it during their introduction phase before any practice begins.
        </p>
      </div>
    </div>
  `;
}

/* ── Small utilities ──────────────────────────────────────────────────────── */
/* Wires a card's [data-next] button to open the section it names. */
function wireNextButton(root) {
  const btn = root.querySelector("[data-next]");
  if (!btn) return;
  btn.addEventListener("click", () => activateSection(btn.dataset.next));
}

/* Escapes the five HTML-significant characters for safe interpolation. */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
