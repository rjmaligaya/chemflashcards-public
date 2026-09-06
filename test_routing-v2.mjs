/**
 * Self-test for routing-v2.js. Run with: node test_routing-v2.mjs
 *
 * Exits with non-zero status if any assertion fails. No deps.
 */
import {
  deriveOption, isDevMode, getTodayDay, nextStep, evaluateTiming, SESSION_FLOW, PHASES,
} from "./public/routing-v2.js";

let pass = 0, fail = 0;
// Compares an actual value with an expected one and records a pass or a fail.
function check(name, actual, expected) {
  const ok = (typeof expected === "object")
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  if (ok) { console.log(`  pass: ${name}`); pass++; }
  else    { console.error(`  FAIL: ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); fail++; }
}

// deriveOption: the counterbalance option derived from a participant id, and the
// empty result returned for ids that do not parse.
console.log("\n== deriveOption (parity-of-last-digit-of-prefix) ==");
check('"03-12345"  -> option1', deriveOption("03-12345"),  "option1");
check('"202-67890" -> option2', deriveOption("202-67890"), "option2");
check('"1-12345"   -> option1', deriveOption("1-12345"),   "option1");
check('"2-12345"   -> option2', deriveOption("2-12345"),   "option2");
check('"99-12345"  -> option1', deriveOption("99-12345"),  "option1");
check('"100-12345" -> option2', deriveOption("100-12345"), "option2");
check('"01-DEV01"  -> option1', deriveOption("01-DEV01"),  "option1");
check('"02-DEV01"  -> option2', deriveOption("02-DEV01"),  "option2");
check('""          -> ""',      deriveOption(""),          "");
check('null        -> ""',      deriveOption(null),        "");
check('"foo"       -> ""',      deriveOption("foo"),       "");
check('"03"        -> ""',      deriveOption("03"),        "");
check('"03-"       -> ""',      deriveOption("03-"),       "");
check('"-12345"    -> ""',      deriveOption("-12345"),    "");

// isDevMode: whether a participant id marks a development run.
console.log("\n== isDevMode ==");
check('"01-DEV01"  -> true',  isDevMode("01-DEV01"),  true);
check('"02-DEV"    -> true',  isDevMode("02-DEV"),    true);
check('"03-12345"  -> false', isDevMode("03-12345"),  false);
check('"01-dev01"  -> true (case-insens)', isDevMode("01-dev01"), true);
check('""          -> false', isDevMode(""),          false);

// getTodayDay: the day index from the enrollment date to a given date, and -1 for
// missing or unparseable input.
console.log("\n== getTodayDay ==");
const sameDay = new Date(2026, 4, 19, 10, 0, 0);
check("same day -> 0",
      getTodayDay(new Date(2026, 4, 19, 8, 0, 0), sameDay), 0);
check("next day -> 1",
      getTodayDay(new Date(2026, 4, 19), new Date(2026, 4, 20)), 1);
check("14 days later -> 14",
      getTodayDay(new Date(2026, 4, 1), new Date(2026, 4, 15)), 14);
check("future enrollment -> negative",
      getTodayDay(new Date(2026, 5, 1), new Date(2026, 4, 19)), -13);
check("missing -> -1",     getTodayDay(null), -1);
check("garbage -> -1",     getTodayDay("not a date"), -1);

// nextStep: the phase, session and page a participant is routed to, given the
// sessions already completed.
console.log("\n== nextStep (completion-based routing) ==");
// The flow contains no pre-test phase, so a participant with nothing completed
// starts at Session 1.
check("pretest not in flow",     SESSION_FLOW.some(s => s.phase === PHASES.PRETEST), false);
check("nothing done -> S1",      nextStep([]).sessionId, 1);
check("S1 done -> S2",           nextStep(["spaced-S1"]).sessionId, 2);
check("S2 done -> S3",           nextStep(["spaced-S1","spaced-S2"]).sessionId, 3);
check("S3 done -> Day 4",        nextStep(["spaced-S1","spaced-S2","spaced-S3"]).phase, PHASES.DAY4);
check("Day 4 page",              nextStep(["spaced-S1","spaced-S2","spaced-S3"]).page, "study-session4.html");
check("Day 4 done -> delayed",   nextStep(["spaced-S1","spaced-S2","spaced-S3","spaced-S4","massed-B1","massed-B2","massed-B3","massed-B4"]).phase, PHASES.DELAYED);
check("delayed done -> done",    nextStep(["spaced-S1","spaced-S2","spaced-S3","spaced-S4","massed-B1","massed-B2","massed-B3","massed-B4","delayed"]).phase, PHASES.DONE);

// evaluateTiming: whether a step is open at a given moment, and whether the entry
// is flagged as off schedule.
console.log("\n== evaluateTiming (2026-07-02: lower bound blocks; missed-day upper bound advisory) ==");
// Returns a Date h hours after the given ISO timestamp.
const at = (iso, h) => new Date(new Date(iso).getTime() + h * 3_600_000);
const S1AT = "2026-05-20T08:00:00.000Z";
const B4AT = "2026-05-23T10:00:00.000Z";
const stepS1      = SESSION_FLOW.find(s => s.phase === PHASES.SPACED && s.sessionId === 1);
const stepS2      = SESSION_FLOW.find(s => s.phase === PHASES.SPACED && s.sessionId === 2);
const stepDelayed = SESSION_FLOW.find(s => s.phase === PHASES.DELAYED);
const mapS1 = new Map([["spaced-S1", S1AT]]);
const mapB4 = new Map([["massed-B4", B4AT]]);

check("S1 has no time gate",             evaluateTiming(stepS1, new Map(), at(S1AT, 0)).ok, true);
// Lower bound is a HARD block: too early is refused.
check("S2 blocked at 10h (before 20h)",  evaluateTiming(stepS2, mapS1, at(S1AT, 10)).ok, false);
check("S2 opens at 20h",                 evaluateTiming(stepS2, mapS1, at(S1AT, 20)).ok, true);
check("S2 at 24h on-schedule",           evaluateTiming(stepS2, mapS1, at(S1AT, 24)).offSchedule, false);
// Upper bound is ADVISORY: a missed day is allowed through, flagged.
check("S2 at 40h still allowed (missed day)", evaluateTiming(stepS2, mapS1, at(S1AT, 40)).ok, true);
check("S2 at 40h flagged off-schedule",  evaluateTiming(stepS2, mapS1, at(S1AT, 40)).offSchedule, true);
// Sequence prerequisite still blocks a blocking step (can't do S2 before S1).
check("S2 blocked when S1 missing (sequence)", evaluateTiming(stepS2, new Map(), at(S1AT, 24)).ok, false);
// The delayed test is fully advisory: neither its floor nor a missing prereq blocks.
check("delayed at 2 days allowed (advisory)",   evaluateTiming(stepDelayed, mapB4, at(B4AT, 48)).ok, true);
check("delayed at 2 days flagged off-schedule", evaluateTiming(stepDelayed, mapB4, at(B4AT, 48)).offSchedule, true);
check("delayed at 7 days on-schedule",   evaluateTiming(stepDelayed, mapB4, at(B4AT, 168)).offSchedule, false);
check("delayed ok at 7 days",            evaluateTiming(stepDelayed, mapB4, at(B4AT, 168)).ok, true);
check("delayed opens even if massed-B4 missing (advisory prereq)", evaluateTiming(stepDelayed, new Map(), at(B4AT, 168)).ok, true);
check("delayed flagged off-schedule when massed-B4 missing", evaluateTiming(stepDelayed, new Map(), at(B4AT, 168)).offSchedule, true);

console.log(`\nresult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
