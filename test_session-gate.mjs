/**
 * Self-test for public/session-gate.js (ISI-timing model).
 *
 * Only exercises the pure decision function `evaluateGate`. The network
 * wrapper `gateSessionEntry` is integration-tested implicitly by running the
 * live frontend against the live worker.
 *
 * Run with: node test_session-gate.mjs
 */
import { evaluateGate } from "./public/session-gate.js";

let pass = 0, fail = 0;
// Compares an actual value with an expected one and records a pass or a fail.
function check(name, actual, expected) {
  const ok = (typeof expected === "object")
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  if (ok) { console.log(`  pass: ${name}`); pass++; }
  else    { console.error(`  FAIL: ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); fail++; }
}

// Build a /api/v2/status response body. `completed` is an array of
// { label, at } where `at` is the session's completed_at ISO string.
function statusBody({ devMode = false, completed = [] } = {}) {
  return {
    pid: devMode ? "01-DEV01" : "03-12345",
    option_id: "option1",
    dev_mode: devMode,
    sessions_completed: completed.map(({ label, at }) => ({
      session_label: label,
      phase: label.startsWith("spaced") ? "spaced"
           : label.startsWith("massed") ? "massed"
           : label,
      completed_at: at,
    })),
  };
}

// Returns a Date h hours after the given ISO timestamp.
const hoursAfter = (iso, h) => new Date(new Date(iso).getTime() + h * 3_600_000);
const S1_AT = "2026-05-20T08:00:00.000Z";
const S2_AT = "2026-05-21T08:30:00.000Z";
const S3_AT = "2026-05-22T09:00:00.000Z";
const B4_AT = "2026-05-23T10:00:00.000Z";

// Session 1 has no timing prerequisite, so it opens as soon as a participant is
// enrolled.
console.log("\n== Session 1: no time gate (available once enrolled) ==");
{
  const r = evaluateGate({
    status: statusBody({ completed: [] }),
    expectedSessionLabels: ["spaced-S1"], expectedPhase: "spaced", expectedSessionId: 1,
    now: new Date(S1_AT),
  });
  check("S1 allowed with no prior sessions", r.ok, true);
}

// A session that is already recorded cannot be entered a second time.
console.log("\n== Repeat blocked (session already completed) ==");
{
  const r = evaluateGate({
    status: statusBody({ completed: [{ label: "spaced-S1", at: S1_AT }] }),
    expectedSessionLabels: ["spaced-S1"], expectedPhase: "spaced", expectedSessionId: 1,
    now: hoursAfter(S1_AT, 1),
  });
  check("ok=false", r.ok, false);
  check("message mentions already recorded", /already been recorded/.test(r.message), true);
}

// Session 2 stays closed until the 20 hour minimum after Session 1 has passed.
console.log("\n== S2 too early (only 10h after S1): still blocked (20h minimum) ==");
{
  const r = evaluateGate({
    status: statusBody({ completed: [{ label: "spaced-S1", at: S1_AT }] }),
    expectedSessionLabels: ["spaced-S2"], expectedPhase: "spaced", expectedSessionId: 2,
    now: hoursAfter(S1_AT, 10),
  });
  check("ok=false (before 20h minimum)", r.ok, false);
  check("message says not open yet", /not open yet/.test(r.message), true);
}

// Session 2 opens 24 hours after Session 1.
console.log("\n== S2 on schedule (24h after S1) ==");
{
  const r = evaluateGate({
    status: statusBody({ completed: [{ label: "spaced-S1", at: S1_AT }] }),
    expectedSessionLabels: ["spaced-S2"], expectedPhase: "spaced", expectedSessionId: 2,
    now: hoursAfter(S1_AT, 24),
  });
  check("S2 allowed at 24h", r.ok, true);
}

// The upper bound is advisory, so Session 2 still opens 40 hours after Session 1.
console.log("\n== S2 off-schedule but ALLOWED (40h after S1) ==");
{
  const r = evaluateGate({
    status: statusBody({ completed: [{ label: "spaced-S1", at: S1_AT }] }),
    expectedSessionLabels: ["spaced-S2"], expectedPhase: "spaced", expectedSessionId: 2,
    now: hoursAfter(S1_AT, 40),
  });
  check("S2 still allowed past 28h (no hard block)", r.ok, true);
}

// Session 2 is blocked while the previous session has no completion record.
console.log("\n== S2 blocked when S1 not completed ==");
{
  const r = evaluateGate({
    status: statusBody({ completed: [] }),
    expectedSessionLabels: ["spaced-S2"], expectedPhase: "spaced", expectedSessionId: 2,
    now: new Date(S2_AT),
  });
  check("ok=false (previous session missing)", r.ok, false);
  check("message mentions previous session", /previous session/.test(r.message), true);
}

// A DEV participant id skips the timing gate.
console.log("\n== DEV PID bypasses the timing gate ==");
{
  const r = evaluateGate({
    status: statusBody({ devMode: true, completed: [{ label: "spaced-S1", at: S1_AT }] }),
    expectedSessionLabels: ["spaced-S2"], expectedPhase: "spaced", expectedSessionId: 2,
    now: hoursAfter(S1_AT, 2),   // way too early for a non-DEV
  });
  check("DEV bypasses timing", r.ok, true);
}

// A DEV participant id is still blocked from repeating a completed session.
console.log("\n== DEV PID still blocked from repeats ==");
{
  const r = evaluateGate({
    status: statusBody({ devMode: true, completed: [{ label: "spaced-S1", at: S1_AT }] }),
    expectedSessionLabels: ["spaced-S1"], expectedPhase: "spaced", expectedSessionId: 1,
    now: hoursAfter(S1_AT, 2),
  });
  check("DEV blocked from repeating", r.ok, false);
}

// evaluateGate with a set of several expected labels: entry is open while none of
// them is complete, blocked before the minimum interval, and blocked once any one
// of them is recorded.
console.log("\n== evaluateGate repeat check with a multi-label set (generic) ==");
{
  const labels = ["spaced-S4", "massed-B1", "massed-B2", "massed-B3", "massed-B4"];

  // Allowed: no label in the set is completed yet (interval is advisory).
  const allowed = evaluateGate({
    status: statusBody({ completed: [{ label: "spaced-S3", at: S3_AT }] }),
    expectedSessionLabels: labels, expectedPhase: "day4", expectedSessionId: 4,
    now: hoursAfter(S3_AT, 24),
  });
  check("allowed when no label in the set is done", allowed.ok, true);

  // Early entry is still blocked (10h after S3, before the 20h minimum).
  const early = evaluateGate({
    status: statusBody({ completed: [{ label: "spaced-S3", at: S3_AT }] }),
    expectedSessionLabels: labels, expectedPhase: "day4", expectedSessionId: 4,
    now: hoursAfter(S3_AT, 10),
  });
  check("early entry blocked (before 20h minimum)", early.ok, false);

  // Any completed label in the set still blocks (repeat protection).
  const partial = evaluateGate({
    status: statusBody({ completed: [{ label: "spaced-S3", at: S3_AT }, { label: "spaced-S4", at: hoursAfter(S3_AT, 24).toISOString() }] }),
    expectedSessionLabels: labels, expectedPhase: "day4", expectedSessionId: 4,
    now: hoursAfter(S3_AT, 25),
  });
  check("blocked when a label in the set is already done", partial.ok, false);
}

// A participant sent to the pretest label is blocked, because pretest is not a
// recognised SESSION_FLOW step and the timing lookup fails.
console.log("\n== Pretest removed from the flow (2026-06-08): real participants blocked ==");
{
  const blocked = evaluateGate({
    status: statusBody({ completed: [] }),
    expectedSessionLabels: ["pretest"], expectedPhase: "pretest", expectedSessionId: null,
    now: new Date(S1_AT),
  });
  check("pretest blocked for real participant", blocked.ok, false);
  check("pretest block says not recognised", /not recognised/.test(blocked.message), true);
}

// Delayed test: timing is advisory, so an early or late arrival still starts.
console.log("\n== Delayed test: in-lab, advisory timing (2026-07-02) ==");
{
  // Allowed at 7 days after massed-B4 (on schedule).
  const allowed = evaluateGate({
    status: statusBody({ completed: [
      { label: "massed-B4", at: B4_AT },
    ] }),
    expectedSessionLabels: ["delayed"], expectedPhase: "delayed", expectedSessionId: null,
    now: hoursAfter(B4_AT, 7 * 24),
  });
  check("delayed allowed 7 days after Day 4", allowed.ok, true);

  // Earlier than 6 days is allowed, because the delayed-test timing is advisory.
  const early = evaluateGate({
    status: statusBody({ completed: [{ label: "massed-B4", at: B4_AT }] }),
    expectedSessionLabels: ["delayed"], expectedPhase: "delayed", expectedSessionId: null,
    now: hoursAfter(B4_AT, 2 * 24),
  });
  check("delayed allowed 2 days after Day 4 (advisory)", early.ok, true);

  // Spaced practice complete with no massed-B4 recorded: the delayed test still
  // opens, with no dev_mode override.
  const halfDone = evaluateGate({
    status: statusBody({ completed: [
      { label: "spaced-S1", at: S1_AT }, { label: "spaced-S2", at: S2_AT },
      { label: "spaced-S3", at: S3_AT },
      { label: "spaced-S4", at: hoursAfter(S3_AT, 24).toISOString() },
    ] }),
    expectedSessionLabels: ["delayed"], expectedPhase: "delayed", expectedSessionId: null,
    now: hoursAfter(S3_AT, 10 * 24),
  });
  check("delayed opens for a half-completed participant (no massed-B4)", halfDone.ok, true);

  // Once the delayed test is recorded, it cannot be entered again.
  const repeat = evaluateGate({
    status: statusBody({ completed: [{ label: "massed-B4", at: B4_AT }, { label: "delayed", at: hoursAfter(B4_AT, 7 * 24).toISOString() }] }),
    expectedSessionLabels: ["delayed"], expectedPhase: "delayed", expectedSessionId: null,
    now: hoursAfter(B4_AT, 8 * 24),
  });
  check("delayed blocked once already recorded", repeat.ok, false);
}

// An empty list of expected session labels is rejected.
console.log("\n== Defensive: empty expectedSessionLabels ==");
{
  const r = evaluateGate({
    status: statusBody({ completed: [] }),
    expectedSessionLabels: [], expectedPhase: "spaced", expectedSessionId: 1,
    now: new Date(S1_AT),
  });
  check("empty labels rejected", r.ok, false);
}

console.log(`\nresult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
