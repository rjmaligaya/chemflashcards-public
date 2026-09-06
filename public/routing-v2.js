/**
 * routing-v2.js — v2 within-subjects routing + session-timing logic.
 *
 * Session timing model:
 *   - Sessions advance by COMPLETION, not by calendar day. The next session
 *     unlocks minHours after the previous session's completed_at.
 *   - LOWER bound is a HARD BLOCK: a participant cannot start the next
 *     session before minHours (20h) have elapsed and sees a "come back later"
 *     message. Session 1 has no lower gate and is available once enrolled.
 *   - UPPER bound is ADVISORY: past maxHours (28h) the session is still
 *     allowed, and evaluateTiming returns offSchedule: true. The actual
 *     interval stays recoverable from the stored completed_at timestamps.
 *   - SEQUENCE blocks: a session cannot start before the one that precedes it
 *     has been recorded (for example S3 before S2).
 *   - The in-lab delayed test opts out of all of the above with
 *     advisoryTiming: true. Neither its 6-day floor nor a missing massed-B4
 *     blocks entry; it is flagged off-schedule instead.
 *
 * Exports:
 *   deriveOption(pid)                      "option1" | "option2" | "" (invalid)
 *   isDevMode(pid)                         boolean
 *   getTodayDay(enrollmentDate[, now])     whole days since enrollment (display only)
 *   PHASES                                 phase-name constants
 *   SESSION_FLOW                           ordered list of session steps
 *   nextStep(completedLabels)              next uncompleted step (for routing)
 *   evaluateTiming(step, completedMap, now){ ok, offSchedule, message }
 *
 * Pure logic, no DOM access, fully unit-testable in Node.
 */

/* ── PID format ─────────────────────────────────────────────────────────
 * <numeric_prefix>-<alnum_suffix>. Prefix 1-4 digits, suffix 1-8 alnum.
 * DEV variant: any numeric prefix + "DEV" + optional digits as suffix.
 * The parity of the LAST DIGIT of the prefix selects the counterbalance
 * option: odd -> option1, even -> option2.
 *   "03-12345"  -> 3 odd  -> option1 (C-1 spaced, C-2 massed)
 *   "202-67890" -> 2 even -> option2 (C-2 spaced, C-1 massed)
 *   "01-DEV01"  -> 1 odd  -> option1 (dev bypass)
 *   "02-DEV01"  -> 2 even -> option2 (dev bypass)
 */
export const PID_RE     = /^(\d{1,4})-([A-Za-z0-9]{1,8})$/;
export const PID_DEV_RE = /^(\d{1,4})-DEV\d*$/i;

// Returns "option1" or "option2" from the parity of the last digit of the
// PID prefix, or "" when the PID does not match either PID pattern.
export function deriveOption(pid) {
  if (!pid) return "";
  if (!PID_RE.test(pid) && !PID_DEV_RE.test(pid)) return "";
  const prefix = pid.split("-")[0];
  const lastDigit = Number(prefix.slice(-1));
  if (!Number.isFinite(lastDigit)) return "";
  return (lastDigit % 2 === 1) ? "option1" : "option2";
}

// Returns true when the PID is a DEV id, which bypasses the time gates and is
// flagged dev_mode in the database.
export function isDevMode(pid) {
  return !!pid && PID_DEV_RE.test(pid);
}

/* ── Phase constants ──────────────────────────────────────────────────── */

export const PHASES = {
  PRETEST: "pretest",   // in-lab, at the consent visit
  SPACED:  "spaced",    // at-home practice sessions 1-3
  DAY4:    "day4",      // at-home: spaced session 4 + 4 massed blocks
  WAITING: "waiting",   // between the final practice day and the delayed test
  DELAYED: "delayed",   // in-lab (Tobii), ~1 week after the final practice day
  DONE:    "done",      // study complete
};

/* ── Timing constants ─────────────────────────────────────────────────── */

export const MIN_ISI_HOURS    = 20;   // earliest the next spaced session opens
export const MAX_ISI_HOURS    = 28;   // past this, allowed but flagged off-schedule
export const DELAYED_MIN_HOURS = 6 * 24; // 6 days ≈ "one week after the final practice day"

/* ── Session flow ─────────────────────────────────────────────────────────
 * Ordered list of the steps a participant moves through. A step is "done"
 * when its doneLabel appears in sessions_completed. The Day-4 composite is
 * done when its LAST sub-session (massed-B4) is recorded.
 *
 * prevLabel = the session whose completed_at gates this step's unlock
 *             (null means no time gate — available once enrolled).
 * minHours  = hours after prevLabel.completed_at before this step opens.
 * maxHours  = upper edge of the "on schedule" window (null = no upper edge).
 */
export const SESSION_FLOW = [
  // The flow contains no in-app pre-test step: a newly enrolled participant
  // routes straight to session 1.
  {
    phase: PHASES.SPACED, sessionId: 1, page: "study-session1.html",
    locationRequired: "at-home", doneLabel: "spaced-S1",
    prevLabel: null, minHours: 0, maxHours: null,
    shortLabel: "session 1",
    description: "Practice session 1 of 4 (at home).",
  },
  {
    phase: PHASES.SPACED, sessionId: 2, page: "study-session2.html",
    locationRequired: "at-home", doneLabel: "spaced-S2",
    prevLabel: "spaced-S1", minHours: MIN_ISI_HOURS, maxHours: MAX_ISI_HOURS,
    shortLabel: "session 2",
    description: "Practice session 2 of 4 (at home).",
  },
  {
    phase: PHASES.SPACED, sessionId: 3, page: "study-session3.html",
    locationRequired: "at-home", doneLabel: "spaced-S3",
    prevLabel: "spaced-S2", minHours: MIN_ISI_HOURS, maxHours: MAX_ISI_HOURS,
    shortLabel: "session 3",
    description: "Practice session 3 of 4 (at home).",
  },
  {
    phase: PHASES.DAY4, sessionId: 4, page: "study-session4.html",
    locationRequired: "at-home", doneLabel: "massed-B4",
    prevLabel: "spaced-S3", minHours: MIN_ISI_HOURS, maxHours: MAX_ISI_HOURS,
    shortLabel: "final practice day",
    description: "Final practice day (at home): one practice session and four practice blocks.",
  },
  {
    phase: PHASES.DELAYED, sessionId: null, page: "posttest-delayed.html",
    locationRequired: "in-lab", doneLabel: "delayed",
    prevLabel: "massed-B4", minHours: DELAYED_MIN_HOURS, maxHours: null,
    // In-lab, lab-launched test. advisoryTiming: true makes both the 6-day
    // floor and a missing massed-B4 non-blocking: the entry is flagged
    // off-schedule and allowed through.
    advisoryTiming: true,
    shortLabel: "delayed test",
    description: "Delayed test (in the lab, with the eye-tracker).",
  },
];

/* ── Display-only day counter ─────────────────────────────────────────────
 * Returns the whole days since enrollment, for display on the landing page.
 * Not used for gating, which is based on inter-session intervals. Returns -1
 * when enrollmentDate is missing or unparseable.
 */
export function getTodayDay(enrollmentDate, now = new Date()) {
  if (!enrollmentDate) return -1;
  const enroll = new Date(enrollmentDate);
  if (isNaN(enroll.getTime())) return -1;
  const e0 = new Date(enroll.getFullYear(), enroll.getMonth(), enroll.getDate());
  const n0 = new Date(now.getFullYear(),    now.getMonth(),    now.getDate());
  return Math.floor((n0 - e0) / 86_400_000);
}

/* ── Routing: which step is the participant on? ───────────────────────────
 * Returns the first step whose doneLabel is NOT in completedLabels, or a
 * DONE descriptor if every step is complete.
 */
export function nextStep(completedLabels = []) {
  const done = new Set(completedLabels);
  for (const step of SESSION_FLOW) {
    if (!done.has(step.doneLabel)) return step;
  }
  return {
    phase: PHASES.DONE, sessionId: null, page: null, locationRequired: null,
    doneLabel: null, prevLabel: null, minHours: null, maxHours: null,
    shortLabel: "done",
    description: "Study complete. Thank you for participating.",
  };
}

/* ── Timing: is this step open, and is it on schedule? ────────────────────
 * step          — a SESSION_FLOW entry (or nextStep() result).
 * completedMap  — Map(session_label -> completed_at ISO string).
 * now           — Date (defaults to new Date()).
 *
 * Returns { ok, offSchedule, message }.
 *   ok=false     -> blocked: too EARLY (before minHours), a missing sequence
 *                   prerequisite, or a DONE step.
 *   offSchedule  -> allowed, but the gap exceeded maxHours.
 * A step with advisoryTiming: true (the in-lab delayed test) never blocks on
 * the lower bound or on a missing prerequisite; it is flagged instead.
 */
export function evaluateTiming(step, completedMap, now = new Date()) {
  if (!step || step.phase === PHASES.DONE) {
    return { ok: false, offSchedule: false, message: "Study complete." };
  }
  // No gate at all: session 1 is available as soon as the participant
  // is enrolled.
  if (!step.prevLabel) return { ok: true, offSchedule: false, message: "" };

  const prevIso = completedMap instanceof Map
    ? completedMap.get(step.prevLabel)
    : (completedMap || {})[step.prevLabel];

  // Sequence prerequisite: the preceding session must have been recorded.
  // Practice steps block; an advisoryTiming step allows a missing prerequisite
  // through and flags it off-schedule.
  if (!prevIso) {
    if (step.advisoryTiming) {
      return { ok: true, offSchedule: true, message: "" };
    }
    return { ok: false, offSchedule: false, message: "Please complete your previous session first." };
  }
  const prev = new Date(prevIso);
  if (isNaN(prev.getTime())) {
    return { ok: false, offSchedule: false, message: "Could not read your previous session time. Please contact the researcher." };
  }

  const gapH = (now.getTime() - prev.getTime()) / 3_600_000;

  // Lower bound: a hard block. Returning before the minimum inter-session
  // interval is refused with a "come back later" message. An advisoryTiming
  // step is allowed through and flagged off-schedule instead.
  if (gapH < step.minHours) {
    if (step.advisoryTiming) {
      return { ok: true, offSchedule: true, message: "" };
    }
    return { ok: false, offSchedule: false, message: notYetMessage(step.minHours - gapH, step) };
  }

  // Upper bound: advisory. A gap beyond maxHours does not block entry; the
  // step is returned with offSchedule set to true.
  const offSchedule = step.maxHours != null && gapH > step.maxHours;
  return { ok: true, offSchedule, message: "" };
}

// Builds the "not open yet" message for a blocked step, phrased in days for
// the delayed test and in hours for a practice session.
function notYetMessage(remainingHours, step) {
  if (step.phase === PHASES.DELAYED) {
    const days = Math.max(1, Math.ceil(remainingHours / 24));
    return `Your in-lab delayed test opens about one week after your final practice day (about ${days} more day${days === 1 ? "" : "s"}). The lab will arrange your visit.`;
  }
  const h = Math.max(1, Math.ceil(remainingHours));
  return `Your next practice session is not open yet. It unlocks in about ${h} hour${h === 1 ? "" : "s"}. Spacing your practice out across days is part of the study, so please come back then.`;
}
