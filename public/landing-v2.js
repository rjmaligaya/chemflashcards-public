/**
 * landing-v2.js — v2 landing page handler for study.html.
 *
 * Wires the PID-submit button to:
 *   1. Validate the PID format (via routing-v2.deriveOption).
 *   2. POST /api/v2/enroll (idempotent: returns the existing record
 *      if the PID is already in participants_v2).
 *   3. GET /api/v2/status to read which sessions are already complete.
 *   4. Pick the next uncompleted step (nextStep) and check whether its
 *      timing window is open (evaluateTiming).
 *   5. Redirect to the page for that step (pretest.html / study-sessionN.html
 *      / posttest-delayed.html), or stay here with a waiting/done message.
 *
 * This file's job ends as soon as the right URL is loaded.
 */

import {
  deriveOption, isDevMode, nextStep, evaluateTiming, PHASES,
} from "./routing-v2.js";
import { workerUrl, API } from "./config-v2.js";

// ── Config ───────────────────────────────────────────────────────────────────

// localStorage key for caching the most-recent PID + enrollment so the user
// doesn't have to retype on a re-visit. Wiped if invalid.
const LS_KEY = "cfc-v2-participant";

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $ = sel => document.querySelector(sel);

// Shows the view with the given id and hides every other .view element.
function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.hidden = (v.id !== id));
}

// Sets the warning line under the PID field, or hides it when msg is empty.
function setWarn(msg) {
  const el = $("#landingWarn");
  el.textContent = msg || "";
  el.hidden = !msg;
}

// Fills the two enrollment-status lines, hiding the block when both are empty.
function setStatus(line1, line2) {
  const wrap = $("#enrollmentStatus");
  $("#enrollmentStatusLine").textContent = line1 || "";
  $("#enrollmentLocationLine").textContent = line2 || "";
  wrap.hidden = !(line1 || line2);
}

// Shows or hides the "this step happens in the lab" hint.
function setInPersonHint(show) {
  $("#inPersonHint").hidden = !show;
}

// ── localStorage cache ───────────────────────────────────────────────────────

// Returns the cached enrollment record, or null if absent or unparseable.
function loadCachedEnrollment() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Writes the enrollment record to localStorage, ignoring storage errors.
function cacheEnrollment(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
}

// ── URL parameter ────────────────────────────────────────────────────────────

// Reads ?pid= from the page URL. Returns "" if absent or malformed.
function pidFromUrl() {
  try {
    return (new URLSearchParams(window.location.search).get("pid") || "").trim();
  } catch {
    return "";
  }
}

// ── Enrollment API call ──────────────────────────────────────────────────────

// POSTs the PID and time zone to /api/v2/enroll and returns the parsed
// record. Throws on a non-OK response.
async function callEnroll(pid) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const res = await fetch(workerUrl(API.ENROLL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid, tz }),
  });
  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch {}
    throw new Error(err.error || `enroll_failed_${res.status}`);
  }
  return res.json();
}

// ── Submit handler ───────────────────────────────────────────────────────────

// Module-level state: holds the redirect URL after a successful enroll.
// On the next click the button just navigates, no second API call.
let pendingRedirect = null;

// Handles a click on the start button: enrolls the PID, resolves the next
// step, and either arms the redirect or reports why the participant waits.
async function handleSubmit() {
  // A redirect target is already stored, so this click just navigates.
  if (pendingRedirect) {
    window.location.href = pendingRedirect;
    return;
  }

  setWarn("");
  setStatus("");
  setInPersonHint(false);

  const pid = $("#participantId").value.trim();
  if (!pid) {
    setWarn("Please enter your participant ID.");
    return;
  }

  // Client-side format check before the network call.
  const option = deriveOption(pid);
  if (!option) {
    setWarn("ID format not recognized. Expected something like 03-12345 or 202-67890.");
    return;
  }

  const btn = $("#startBtn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Checking…";

  try {
    const data = await callEnroll(pid);
    cacheEnrollment(data);

    // Routing is completion-based: fetch the participant's status to see which
    // sessions are done, then pick the next uncompleted step and check whether
    // its timing window is open (ISI-based; see routing-v2.js).
    const completed = [];
    const completedMap = new Map();
    try {
      const statusRes = await fetch(workerUrl(API.STATUS) + "?pid=" + encodeURIComponent(pid));
      if (statusRes.ok) {
        const status = await statusRes.json();
        for (const s of (status.sessions_completed || [])) {
          completed.push(s.session_label);
          completedMap.set(s.session_label, s.completed_at);
        }
      }
    } catch { /* fall through with empty completion data */ }

    const step = nextStep(completed);

    if (step.phase === PHASES.DONE) {
      setStatus(`Welcome back: ${pid}.`, step.description);
      btn.textContent = "Study complete";
      btn.disabled = true;
      return;
    }

    // In-person warning for in-lab steps, unless this is a DEV bypass.
    if (step.locationRequired === "in-lab" && !data.dev_mode) {
      setInPersonHint(true);
    }

    // Timing window. DEV PIDs bypass the ISI gate.
    const timing = data.dev_mode ? { ok: true } : evaluateTiming(step, completedMap, new Date());

    setStatus(
      `${data.is_new ? "Enrolled" : "Welcome back"}: ${pid} (option ${data.option_id.replace("option","")}).`,
      timing.ok ? step.description : timing.message,
    );

    // If the next step's window is not open yet, keep the participant on the
    // landing page with the "come back later" message.
    if (!timing.ok) {
      btn.textContent = "Come back later";
      btn.disabled = true;
      return;
    }

    // Build the redirect URL with PID as a query param so the destination
    // page can pick it up.
    const url = new URL(step.page, window.location.href);
    url.searchParams.set("pid", pid);
    pendingRedirect = url.toString();

    btn.textContent = `Continue to ${step.shortLabel} →`;
    btn.disabled = false;
  } catch (err) {
    console.error("Enroll error:", err);
    setWarn(`Could not enroll: ${err.message}. Please contact the researcher.`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Instructions view ────────────────────────────────────────────────────────
//
// The Instructions topbar button and the "Back to Start" button inside the
// instructions card both live in study.html. This module owns the logic that
// swaps which .view is visible. The instructions body is held in
// <template id="instructionsContentTpl"> at the bottom of study.html and is
// cloned into the page on first open only.

// Clones the instructions template into its mount point once.
function ensureInstructionsRendered() {
  const mount = $("#instrFullContent");
  if (!mount || mount.childElementCount > 0) return;
  const tpl = document.getElementById("instructionsContentTpl");
  if (tpl && tpl.content) mount.appendChild(tpl.content.cloneNode(true));
}

// Wires the buttons that switch between the landing view and the
// instructions view.
function wireInstructionsNav() {
  const instrBtn = $("#instrBtn");
  const backBtn  = $("#backFromInstr");
  if (instrBtn) {
    instrBtn.addEventListener("click", () => {
      ensureInstructionsRendered();
      showView("view-instructions");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      showView("view-landing");
      window.scrollTo({ top: 0, behavior: "smooth" });
      // Hand focus back to the PID field after the view swap.
      setTimeout(() => $("#participantId")?.focus(), 50);
    });
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

// Renders the landing view, pre-fills the PID field, and wires the page.
function init() {
  showView("view-landing");

  // Choose the starting PID: a ?pid= in the URL takes precedence over the
  // cached value from a previous visit. The field stays editable either way.
  const urlPid = pidFromUrl();
  const cached = loadCachedEnrollment();
  const startPid = urlPid || cached?.pid || "";
  if (startPid) {
    $("#participantId").value = startPid;
  }

  $("#startBtn").addEventListener("click", handleSubmit);

  $("#participantId").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  });

  // Reset pendingRedirect if the user changes the PID after a successful enroll.
  $("#participantId").addEventListener("input", () => {
    pendingRedirect = null;
    const btn = $("#startBtn");
    btn.textContent = "Continue";
    btn.disabled = false;
    setStatus("");
    setInPersonHint(false);
  });

  wireInstructionsNav();

  // A PID supplied in the URL runs the enrollment and routing check
  // automatically, so the button is already armed with the next session. A
  // cached PID never triggers this. The check is idempotent and does not start
  // the session: it stops at the confirmation button.
  if (urlPid) {
    handleSubmit();
  }

  setTimeout(() => $("#participantId").focus(), 50);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
