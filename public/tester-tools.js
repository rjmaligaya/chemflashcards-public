/**
 * tester-tools.js — in-page tester toolbar + click-to-pin edit-request tool.
 *
 * Included on every participant-facing page. It renders itself ONLY when the
 * page's ?pid= query parameter is a DEV id (isDevMode). Under a normal id, or
 * with no id at all, this module does nothing: no DOM is added, no listeners
 * attach, and no network call fires.
 *
 * What it gives a tester (someone who arrived via test-hub.html, which hands
 * out fresh DEV ids):
 *   - A small floating toolbar (bottom-right, visually distinct dark overlay):
 *       · their current test id,
 *       · an optional "your name" field (remembered locally),
 *       · a "Pages" menu to jump to any other page with a fresh test id,
 *       · a "Restart" action to reload THIS page under a brand-new test id
 *         (handy because finishing a session locks it for that id),
 *       · a "Request edit" button.
 *   - Click-to-pin edit requests: after pressing "Request edit", clicking any
 *     element on the page opens a note box. Each note records the page, the
 *     element (a CSS-ish path + a text snippet), any text the tester
 *     highlighted, and the note itself. Multiple pins can be dropped, then
 *     "Send" posts them all to /api/v2/feedback for review in admin.html.
 *
 * The exported helpers (TESTER_PAGES, mintDevPid, openAsFreshTester) are also
 * imported by test-hub.html so the launcher and the toolbar share one source
 * of truth for the page list and the fresh-id logic.
 */

import { isDevMode, deriveOption } from "./routing-v2.js";
import { workerUrl, API } from "./config-v2.js";

/* ── Shared: the page list + fresh-id logic (also used by test-hub.html) ──── */

// Every participant-facing page, in the order a tester would walk the study.
export const TESTER_PAGES = [
  { file: "index.html",            label: "Public homepage",               note: "The marketing landing page." },
  { file: "study.html",            label: "Start / enter participant ID",  note: "Enrollment + routing page." },
  { file: "pretest.html",          label: "Pretest (in-lab)",              note: "24 items, no feedback." },
  { file: "study-session1.html",   label: "Practice session 1",            note: "Includes the Session 0 primer + baseline familiarity ratings." },
  { file: "study-session2.html",   label: "Practice session 2",            note: "Spaced practice, 12 items." },
  { file: "study-session3.html",   label: "Practice session 3",            note: "Spaced practice, 12 items." },
  { file: "study-session4.html",   label: "Day 4 (final practice day)",    note: "Session 4 + four massed blocks + forced-choice." },
  { file: "posttest-delayed.html", label: "Delayed test (in-lab)",         note: "36 items, eye-tracked, no feedback." },
  { file: "demo.html",             label: "Demo (no data saved)",          note: "Standalone showcase page." },
];

// Cache key the enrollment page (study.html via landing-v2.js) reads to
// pre-fill the most-recent participant. Seeding it lets that page cooperate
// with a hub-launched test id too.
const ENROLL_CACHE_KEY = "cfc-v2-participant";
const REPORTER_KEY      = "cfc-tt-reporter";

// Generates a fresh DEV id for the requested counterbalance option (1 or 2).
// Prefix parity selects the option (odd -> option1, even -> option2). A new
// suffix each time means the id has no completed sessions, so any page opens
// with a clean slate. The suffix is digits only, matching the server's DEV id
// pattern (^\d{1,4}-DEV\d*$), and short enough for the 64-character id cap.
export function mintDevPid(option = 1) {
  const prefix = Number(option) === 2 ? "02" : "01";
  const suffix = String(Date.now()).slice(-6) +
                 String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `${prefix}-DEV${suffix}`;
}

// Enrolls a fresh DEV id, then navigates to `file` as that tester. Seeds both
// the URL (?pid=, read by the session pages) and the enrollment cache (read by
// study.html), so every page picks up the id. A failed enrollment does not
// stop the navigation; the destination page's own gate reports any problem.
export async function openAsFreshTester(file, option = 1) {
  const pid = mintDevPid(option);
  try {
    const res = await fetch(workerUrl(API.ENROLL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "" }),
    });
    if (res.ok) {
      const data = await res.json();
      try { localStorage.setItem(ENROLL_CACHE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
    }
  } catch { /* offline / worker down — navigate anyway */ }
  const url = new URL(file, window.location.href);
  url.searchParams.set("pid", pid);
  window.location.href = url.toString();
}

/* ── On-page tooling (only runs under a DEV id) ───────────────────────────── */

// Returns the ?pid= value from the page URL, or "" if it is absent.
function getUrlPid() {
  try { return new URLSearchParams(window.location.search).get("pid") || ""; }
  catch { return ""; }
}

// Returns the current page's filename, defaulting to index.html.
function currentFile() {
  const last = window.location.pathname.split("/").pop();
  return last || "index.html";
}

// Tiny DOM builder. props.style is an object; everything else is set as a
// property (onclick, textContent, className, ...) or attribute.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style" && v && typeof v === "object") Object.assign(node.style, v);
    else if (k === "class") node.className = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// Module state for the pin session.
const state = {
  pinning: false,
  popoverOpen: false,
  pins: [],          // { note, selector, element_text, selected_text, pos, marker }
  els: {},           // cached UI nodes
};

// Appends the toolbar's own stylesheet to the document head, once per page.
// The rules are self-contained and do not rely on the page's own stylesheet.
function injectStyles() {
  if (document.getElementById("cfc-tt-styles")) return;
  const css = `
  .cfc-tt-ui, .cfc-tt-ui * { box-sizing: border-box; }
  .cfc-tt-bar {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147482000;
    display: flex; flex-direction: column; gap: 8px; width: 268px;
    background: #11161d; color: #e8edf2; border: 1px solid #2b3947;
    border-radius: 12px; padding: 10px 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; line-height: 1.4; box-shadow: 0 8px 28px rgba(0,0,0,.45);
  }
  .cfc-tt-bar[data-collapsed="1"] { width: auto; gap: 0; padding: 0; background: transparent; border: 0; box-shadow: none; }
  .cfc-tt-bar[data-collapsed="1"] .cfc-tt-body { display: none; }
  .cfc-tt-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .cfc-tt-title { font-weight: 700; letter-spacing: .02em; display: flex; align-items: center; gap: 6px; }
  .cfc-tt-dot { width: 8px; height: 8px; border-radius: 50%; background: #2dd4bf; }
  .cfc-tt-puck {
    width: 40px; height: 40px; border-radius: 50%; border: 1px solid #2b3947;
    background: #11161d; color: #2dd4bf; font-size: 18px; cursor: pointer;
    display: none; align-items: center; justify-content: center;
    box-shadow: 0 8px 28px rgba(0,0,0,.45);
  }
  .cfc-tt-bar[data-collapsed="1"] .cfc-tt-puck { display: flex; }
  .cfc-tt-body { display: flex; flex-direction: column; gap: 8px; }
  .cfc-tt-pid {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 12px; color: #9fb3c8; cursor: copy; word-break: break-all;
  }
  .cfc-tt-bar input.cfc-tt-name {
    width: 100%; background: #0b0f14; color: #e8edf2; border: 1px solid #2b3947;
    border-radius: 7px; padding: 6px 8px; font-size: 12px;
  }
  .cfc-tt-row { display: flex; gap: 6px; }
  .cfc-tt-btn {
    flex: 1; cursor: pointer; border: 1px solid #2b3947; background: #1b2530;
    color: #e8edf2; border-radius: 7px; padding: 7px 8px; font-size: 12px;
    font-weight: 600; text-align: center; text-decoration: none;
  }
  .cfc-tt-btn:hover { background: #24323f; }
  .cfc-tt-btn--accent { background: #0d9488; border-color: #0d9488; color: #fff; }
  .cfc-tt-btn--accent:hover { background: #14b8a6; }
  .cfc-tt-btn--mini { flex: 0 0 auto; padding: 4px 8px; font-size: 14px; line-height: 1; }
  .cfc-tt-menu {
    position: absolute; right: 0; bottom: calc(100% + 8px); width: 280px;
    max-height: 60vh; overflow: auto; background: #11161d; border: 1px solid #2b3947;
    border-radius: 10px; padding: 6px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
  }
  .cfc-tt-menu-item {
    display: block; width: 100%; text-align: left; cursor: pointer;
    background: transparent; border: 0; color: #e8edf2; border-radius: 7px;
    padding: 7px 9px; font-size: 12.5px;
  }
  .cfc-tt-menu-item:hover { background: #1f2a36; }
  .cfc-tt-menu-item small { display: block; color: #8aa0b4; font-size: 11px; margin-top: 1px; }
  .cfc-tt-menu-head { color: #8aa0b4; font-size: 11px; padding: 6px 9px 4px; text-transform: uppercase; letter-spacing: .05em; }
  .cfc-tt-seg { display: flex; gap: 4px; padding: 4px 9px 6px; }
  .cfc-tt-seg button {
    flex: 1; cursor: pointer; border: 1px solid #2b3947; background: #0b0f14;
    color: #cfe0ee; border-radius: 6px; padding: 5px; font-size: 11.5px; font-weight: 600;
  }
  .cfc-tt-seg button[aria-pressed="true"] { background: #0d9488; border-color: #0d9488; color: #fff; }

  /* Pin mode */
  body.cfc-tt-pinning, body.cfc-tt-pinning * { cursor: crosshair !important; }
  body.cfc-tt-pinning .cfc-tt-ui, body.cfc-tt-pinning .cfc-tt-ui * { cursor: auto !important; }
  .cfc-tt-banner {
    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483000;
    background: #0d9488; color: #fff; padding: 9px 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; display: flex; align-items: center; gap: 12px; justify-content: center;
    box-shadow: 0 2px 10px rgba(0,0,0,.3);
  }
  .cfc-tt-banner strong { font-weight: 700; }
  .cfc-tt-marker {
    position: absolute; z-index: 2147482500; width: 22px; height: 22px;
    margin: -11px 0 0 -11px; border-radius: 50%; background: #0d9488; color: #fff;
    border: 2px solid #fff; box-shadow: 0 2px 8px rgba(0,0,0,.4);
    font: 700 12px/18px -apple-system, sans-serif; text-align: center; cursor: pointer;
  }
  .cfc-tt-pop {
    position: fixed; z-index: 2147483001; width: 290px; background: #11161d;
    color: #e8edf2; border: 1px solid #2b3947; border-radius: 10px; padding: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,.55);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .cfc-tt-pop label { font-size: 11px; color: #8aa0b4; display: block; margin-bottom: 5px; }
  .cfc-tt-pop .cfc-tt-ctx {
    font-size: 11px; color: #9fb3c8; background: #0b0f14; border: 1px solid #2b3947;
    border-radius: 6px; padding: 5px 7px; margin-bottom: 8px; max-height: 54px; overflow: auto;
    word-break: break-word;
  }
  .cfc-tt-pop textarea {
    width: 100%; min-height: 72px; resize: vertical; background: #0b0f14;
    color: #e8edf2; border: 1px solid #2b3947; border-radius: 7px; padding: 8px; font-size: 13px;
    font-family: inherit;
  }
  .cfc-tt-toast {
    position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%);
    z-index: 2147483002; background: #11161d; color: #e8edf2; border: 1px solid #2b3947;
    border-left: 4px solid #2dd4bf; border-radius: 8px; padding: 10px 16px; font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    box-shadow: 0 8px 28px rgba(0,0,0,.5); max-width: 80vw;
  }
  .cfc-tt-toast--err { border-left-color: #f87171; }
  `;
  document.head.appendChild(el("style", { id: "cfc-tt-styles", textContent: css }));
}

let toastTimer = null;
// Shows a short message at the bottom of the page, replacing any previous one.
function toast(msg, isError = false) {
  const old = document.querySelector(".cfc-tt-toast");
  if (old) old.remove();
  const t = el("div", { class: "cfc-tt-toast cfc-tt-ui" + (isError ? " cfc-tt-toast--err" : ""), textContent: msg });
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

/* ── Toolbar ──────────────────────────────────────────────────────────────── */

// Builds the floating toolbar for the given test id and appends it to the body.
function buildToolbar(pid) {
  const option = deriveOption(pid) === "option2" ? 2 : 1;

  const nameInput = el("input", {
    class: "cfc-tt-name", type: "text", placeholder: "Your name (optional)",
    value: (() => { try { return localStorage.getItem(REPORTER_KEY) || ""; } catch { return ""; } })(),
    oninput: e => { try { localStorage.setItem(REPORTER_KEY, e.target.value.trim()); } catch {} },
  });

  const pidLine = el("div", {
    class: "cfc-tt-pid", title: "Click to copy this test id", textContent: pid,
    onclick: () => { navigator.clipboard?.writeText(pid).then(() => toast("Test id copied."), () => {}); },
  });

  const pagesBtn = el("button", { class: "cfc-tt-btn", textContent: "Pages ▾",
    onclick: () => togglePagesMenu(pagesBtn, option) });
  const editBtn = el("button", { class: "cfc-tt-btn cfc-tt-btn--accent", textContent: "✎ Request edit",
    onclick: enterPinMode });
  const hubLink = el("a", { class: "cfc-tt-btn", href: "test-hub.html", textContent: "⌂ Hub" });

  // Walkthrough helper: fill the correct answer for the current practice item.
  const fillBtn = el("button", { class: "cfc-tt-btn", textContent: "⏩ Fill answer",
    title: "Type the correct answer for the current practice item and submit (one click per item)",
    onclick: fillAnswer });

  const collapseBtn = el("button", { class: "cfc-tt-btn cfc-tt-btn--mini", title: "Minimize", textContent: "—",
    onclick: () => setCollapsed(true) });
  const puck = el("button", { class: "cfc-tt-puck", title: "Tester tools", textContent: "🧪",
    onclick: () => setCollapsed(false) });

  const body = el("div", { class: "cfc-tt-body" }, [
    pidLine,
    nameInput,
    el("div", { class: "cfc-tt-row" }, [fillBtn]),
    el("div", { class: "cfc-tt-row" }, [pagesBtn, editBtn]),
    el("div", { class: "cfc-tt-row" }, [
      el("button", { class: "cfc-tt-btn", textContent: "↻ Restart",
        title: "Reload this page under a brand-new test id (re-runs a finished session)",
        onclick: () => openAsFreshTester(currentFile(), option) }),
      hubLink,
    ]),
  ]);

  const bar = el("div", { class: "cfc-tt-bar cfc-tt-ui" }, [
    puck,
    el("div", { class: "cfc-tt-head" }, [
      el("div", { class: "cfc-tt-title" }, [el("span", { class: "cfc-tt-dot" }), "Tester"]),
      collapseBtn,
    ]),
    body,
  ]);

  state.els.bar = bar;
  state.els.nameInput = nameInput;
  document.body.appendChild(bar);

  // Collapses the toolbar to its puck, or expands it again.
  function setCollapsed(v) { bar.dataset.collapsed = v ? "1" : "0"; }
}

let openMenu = null;
// Opens the page menu, or closes it if it is already open. Each entry opens
// that page under a fresh test id for the selected option.
function togglePagesMenu(anchorBtn, option) {
  if (openMenu) { openMenu.remove(); openMenu = null; return; }

  let opt = option;
  // One option-selector button; clicking it sets which option the pages open as.
  const segBtn = (n, label) => el("button", { textContent: label, "aria-pressed": String(opt === n),
    onclick: () => { opt = n; menu.querySelectorAll(".cfc-tt-seg button").forEach((b, i) => b.setAttribute("aria-pressed", String((i + 1) === n))); } });

  const items = TESTER_PAGES.map(p => el("button", {
    class: "cfc-tt-menu-item",
    onclick: () => { openMenu?.remove(); openMenu = null; openAsFreshTester(p.file, opt); },
  }, [ p.label, p.note ? el("small", {}, p.note) : null ]));

  const menu = el("div", { class: "cfc-tt-menu cfc-tt-ui" }, [
    el("div", { class: "cfc-tt-menu-head" }, "Open with a fresh test id as…"),
    el("div", { class: "cfc-tt-seg" }, [segBtn(1, "Option 1"), segBtn(2, "Option 2")]),
    ...items,
  ]);
  state.els.bar.querySelector(".cfc-tt-body").appendChild(menu);
  openMenu = menu;

  // Close on outside click (next tick so this click doesn't immediately close it).
  setTimeout(() => {
    const onDoc = e => {
      if (!menu.contains(e.target) && e.target !== anchorBtn) {
        menu.remove(); openMenu = null; document.removeEventListener("click", onDoc, true);
      }
    };
    document.addEventListener("click", onDoc, true);
  }, 0);
}

/* ── Pin mode ─────────────────────────────────────────────────────────────── */

// Turns on pin mode: shows the banner and starts intercepting page clicks.
function enterPinMode() {
  if (state.pinning) return;
  state.pinning = true;
  document.body.classList.add("cfc-tt-pinning");

  const sendBtn = el("button", { class: "cfc-tt-btn cfc-tt-btn--accent", style: { flex: "0 0 auto" },
    textContent: "Send 0", onclick: sendPins });
  const doneBtn = el("button", { class: "cfc-tt-btn", style: { flex: "0 0 auto" },
    textContent: "Done", onclick: exitPinMode });

  const banner = el("div", { class: "cfc-tt-banner cfc-tt-ui" }, [
    el("span", {}, [el("strong", {}, "Edit mode: "), "click anything you'd like changed, then write a note."]),
    sendBtn, doneBtn,
  ]);
  document.body.appendChild(banner);
  state.els.banner = banner;
  state.els.sendBtn = sendBtn;

  // Capture-phase click handler so a click creates a pin instead of triggering
  // the page's own buttons/links. Clicks on the tester UI pass through.
  document.addEventListener("click", onPagePick, true);
  document.addEventListener("keydown", onPinKey, true);
  toast("Edit mode on. Click an element to attach a note.");
}

// Turns off pin mode: removes the banner and the click and key handlers.
// Existing pin markers stay on the page.
function exitPinMode() {
  if (!state.pinning) return;
  state.pinning = false;
  document.body.classList.remove("cfc-tt-pinning");
  document.removeEventListener("click", onPagePick, true);
  document.removeEventListener("keydown", onPinKey, true);
  state.els.banner?.remove();
  closePopover();
}

// Escape closes an open note box, or leaves pin mode when none is open.
function onPinKey(e) {
  if (e.key === "Escape") {
    if (state.popoverOpen) { e.preventDefault(); e.stopPropagation(); closePopover(); }
    else exitPinMode();
  }
}

// Handles a click while pin mode is on: suppresses the page's own handling
// and opens a note box for the clicked element.
function onPagePick(e) {
  // Let clicks on the tester UI (toolbar, banner, popover, markers) work.
  if (e.target.closest(".cfc-tt-ui") || e.target.closest(".cfc-tt-marker")) return;
  e.preventDefault();
  e.stopPropagation();
  if (state.popoverOpen) return;             // finish the open note first
  const selectedText = (window.getSelection?.().toString() || "").trim().slice(0, 500);
  openPopover(e.target, e.clientX, e.clientY, selectedText);
}

// Returns a { selector, element_text } description of a clicked element. For
// an image the text is its alt attribute or filename, otherwise its visible
// text, truncated.
function describeElement(node) {
  let element_text = "";
  if (node.tagName === "IMG") {
    element_text = node.getAttribute("alt") || (node.getAttribute("src") || "").split("/").pop() || "[image]";
  } else {
    element_text = (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
  }
  return { selector: cssPath(node), element_text };
}

// Builds a short, readable CSS-style path to an element. It stops at the first
// id and climbs at most 5 levels, and it ignores the tester UI's own classes.
function cssPath(node) {
  if (!(node instanceof Element)) return "";
  const parts = [];
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) { parts.unshift(`${part}#${node.id}`); break; }
    const cls = node.classList ? Array.from(node.classList).filter(c => !c.startsWith("cfc-tt")).slice(0, 2) : [];
    if (cls.length) part += "." + cls.join(".");
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(c => c.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

// Opens the note box for a clicked element, positioned near the click and
// clamped into the viewport. Saving the note drops a numbered pin.
function openPopover(targetEl, clientX, clientY, selectedText) {
  const { selector, element_text } = describeElement(targetEl);
  state.popoverOpen = true;

  const ta = el("textarea", { placeholder: "What should change here?" });
  const ctxText = selectedText ? `“${selectedText}”` : (element_text || selector || "(element)");

  // Adds the pin when the note is non-empty, then closes the box.
  const save = () => {
    const note = ta.value.trim();
    if (!note) { ta.focus(); return; }
    addPin({ note, selector, element_text, selected_text: selectedText || null }, clientX, clientY);
    closePopover();
  };

  const pop = el("div", { class: "cfc-tt-pop cfc-tt-ui" }, [
    el("label", {}, "Pinned to:"),
    el("div", { class: "cfc-tt-ctx" }, ctxText),
    ta,
    el("div", { class: "cfc-tt-row", style: { marginTop: "8px" } }, [
      el("button", { class: "cfc-tt-btn cfc-tt-btn--accent", textContent: "Save note", onclick: save }),
      el("button", { class: "cfc-tt-btn", textContent: "Cancel", onclick: closePopover }),
    ]),
  ]);

  // Position near the click, clamped into the viewport.
  document.body.appendChild(pop);
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(clientX + 12, window.innerWidth - w - 12);
  let top  = Math.min(clientY + 12, window.innerHeight - h - 12);
  pop.style.left = Math.max(12, left) + "px";
  pop.style.top  = Math.max(12, top) + "px";
  state.els.popover = pop;
  setTimeout(() => ta.focus(), 0);
}

// Removes the note box, if one is open.
function closePopover() {
  state.els.popover?.remove();
  state.els.popover = null;
  state.popoverOpen = false;
}

// Records a pin and drops its numbered marker at the click position. Clicking
// the marker removes that pin.
function addPin(data, clientX, clientY) {
  const n = state.pins.length + 1;
  const marker = el("div", {
    class: "cfc-tt-marker cfc-tt-ui", textContent: String(n),
    title: "Click to remove this note",
    style: { left: (clientX + window.scrollX) + "px", top: (clientY + window.scrollY) + "px" },
    onclick: () => removePin(pin),
  });
  document.body.appendChild(marker);
  const pin = { ...data, pos: posFraction(clientX, clientY), marker };
  state.pins.push(pin);
  updateSendCount();
}

// Deletes one pin and its marker, then renumbers the markers that remain.
function removePin(pin) {
  const i = state.pins.indexOf(pin);
  if (i === -1) return;
  pin.marker?.remove();
  state.pins.splice(i, 1);
  // Renumber the remaining markers.
  state.pins.forEach((p, idx) => { if (p.marker) p.marker.textContent = String(idx + 1); });
  updateSendCount();
}

// Expresses a click position as "x,y" fractions of the viewport width and the
// full document height.
function posFraction(clientX, clientY) {
  const x = (clientX / Math.max(1, window.innerWidth)).toFixed(3);
  const y = ((clientY + window.scrollY) / Math.max(1, document.documentElement.scrollHeight)).toFixed(3);
  return `${x},${y}`;
}

// Updates the Send button to show how many notes are queued.
function updateSendCount() {
  if (state.els.sendBtn) state.els.sendBtn.textContent = `Send ${state.pins.length}`;
}

// POSTs every queued note to /api/v2/feedback. On success the pins and their
// markers are cleared and pin mode ends; on failure the pins are kept.
async function sendPins() {
  if (!state.pins.length) { toast("No notes to send yet — click something first.", true); return; }
  const reporter = (state.els.nameInput?.value || "").trim();
  const payload = {
    pid: getUrlPid(),
    reporter: reporter || null,
    page: currentFile(),
    page_url: window.location.href,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    pins: state.pins.map(p => ({
      note: p.note, selector: p.selector, element_text: p.element_text,
      selected_text: p.selected_text, pos: p.pos,
    })),
  };

  const btn = state.els.sendBtn;
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    const res = await fetch(workerUrl(API.FEEDBACK), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const e = await res.json(); detail = e.error || detail; } catch {}
      throw new Error(detail);
    }
    const count = payload.pins.length;
    state.pins.forEach(p => p.marker?.remove());
    state.pins = [];
    updateSendCount();
    toast(`Sent ${count} edit request${count === 1 ? "" : "s"} ✓`);
    exitPinMode();
  } catch (err) {
    toast(`Could not send: ${err.message}. Your notes are still here — try again.`, true);
  } finally {
    if (btn) { btn.disabled = false; updateSendCount(); }
  }
}

/* ── Fill-answer (DEV walkthrough helper) ─────────────────────────────────── */

// Types the correct answer for the current practice item into the input and
// submits it. The engine exposes window.__cfcCurrentAnswer only while tester
// tools are active. One click handles one item; the confidence, feedback, and
// Next screens are still driven by the tester.
function fillAnswer() {
  const card   = document.querySelector(".trial-card");
  const input  = card && card.querySelector(".trial-input");
  const submit = card && card.querySelector(".trial-submit");
  if (!input || input.disabled) {
    toast("No answer to fill right now — submit or press Next as needed.");
    return;
  }
  const ans = window.__cfcCurrentAnswer;
  if (ans == null || ans === "") { toast("This page has no auto-answer."); return; }
  input.value = ans;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (submit) submit.click();
}

/* ── Init (auto-runs on every page; no-op unless a DEV id is in the URL) ───── */

// Builds the toolbar when the page URL carries a DEV id, and returns without
// touching the page otherwise.
function init() {
  if (!isDevMode(getUrlPid())) return;   // the safety gate: nothing for real participants
  // Signals the practice engine that tester tools are active, so it exposes
  // the current item's correct answer for the "Fill answer" button. This flag
  // is set here only, under a DEV id, and never for a real participant.
  window.__cfcTesterActive = true;
  injectStyles();
  buildToolbar(getUrlPid());
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
