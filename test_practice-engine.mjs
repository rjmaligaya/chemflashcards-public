/**
 * Self-test for practice-engine.js and features-v2.js.
 * Run with: node test_practice-engine.mjs
 */
import {
  makePrompt, normalizeAnswer, scoreAnswer, parseCSV,
  pickSessionItems, shuffle, imagePathFor,
  decideTrialDisposition, simulateMasteryLoop,
  installBeforeUnloadGuard, removeBeforeUnloadGuard, _getBeforeUnloadRefCount,
} from "./public/practice-engine.js";
import { FEATURES_V2, getFeatureCopy } from "./public/features-v2.js";

let pass = 0, fail = 0;
// Compares an actual value with an expected one and records a pass or a fail.
function check(name, actual, expected) {
  const ok = (typeof expected === "object")
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  if (ok) { console.log(`  pass: ${name}`); pass++; }
  else    { console.error(`  FAIL: ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); fail++; }
}

// makePrompt: where the blank falls in a molecule name for suffix, prefix,
// chain-root and whole-word features, and the fallback for unknown input.
console.log("\n== makePrompt ==");
// Suffix features: blank goes at the end
check("ethanal/al   -> ethan_______",      makePrompt("ethanal", "al"),         "ethan_______");
check("hexanal/al   -> hexan_______",      makePrompt("hexanal", "al"),         "hexan_______");
check("octan-4-one/one",                   makePrompt("octan-4-one", "one"),    "octan-4-_______");
check("ethanamide/amide -> ethan_______",  makePrompt("ethanamide", "amide"),   "ethan_______");
// Prefix features: blank goes at the start
check("1-fluoropropane/fluoro",            makePrompt("1-fluoropropane", "fluoro"), "1-_______propane");
check("iso-butyl chloride/iso",            makePrompt("iso-butyl chloride", "iso"), "_______-butyl chloride");
// Chain-root features: blank goes in the middle
check("3-methylbutane/but",                makePrompt("3-methylbutane", "but"), "3-methyl_______ane");
check("iodoethane/eth",                    makePrompt("iodoethane", "eth"),     "iodo_______ane");
check("hex-3-ene/hex",                     makePrompt("hex-3-ene", "hex"),      "_______-3-ene");
// Whole-word cases
check("benzene/benzene -> whole word",     makePrompt("benzene", "benzene"),    "_______");
check("pyridine/pyridine -> whole word",   makePrompt("pyridine", "pyridine"),  "_______");
// Fallbacks
check("missing feature -> whole word",     makePrompt("ethanal", "xyz"),        "_______");
check("empty inputs -> whole word",        makePrompt("", ""),                  "_______");

// normalizeAnswer: trimming, case folding, and hyphen, underscore and whitespace
// handling on a typed answer.
console.log("\n== normalizeAnswer ==");
check("trim + lowercase",                  normalizeAnswer("  Methyl  "),       "methyl");
check("hyphen -> space",                   normalizeAnswer("sec-butyl"),        "sec butyl");
check("multiple spaces collapsed",         normalizeAnswer("sec    butyl"),     "sec butyl");
check("underscores treated as spaces",     normalizeAnswer("sec_butyl"),        "sec butyl");
check("null safe",                         normalizeAnswer(null),               "");
check("empty safe",                        normalizeAnswer(""),                 "");

// scoreAnswer: matching a typed answer against a target or a list of accepted
// variants.
console.log("\n== scoreAnswer ==");
check("exact match",                       scoreAnswer("methyl", "methyl"),     true);
check("case-insensitive",                  scoreAnswer("METHYL", "methyl"),     true);
check("hyphen-tolerant",                   scoreAnswer("sec-butyl", "sec butyl"), true);
check("variants list match",               scoreAnswer("propan-2-one", ["acetone", "propan-2-one"]), true);
check("non-match",                         scoreAnswer("ethyl", "methyl"),      false);
check("empty answer non-match",            scoreAnswer("", "methyl"),           false);

// parseCSV: turning item CSV text into row objects keyed by column name.
console.log("\n== parseCSV ==");
const csv = `item_id,group,feature,session\nA1,C-1,al,1\nA2,C-1,amide,2`;
const parsed = parseCSV(csv);
check("parseCSV row count",                parsed.length,                       2);
check("parseCSV row 0 feature",            parsed[0].feature,                   "al");
check("parseCSV row 1 session",            parsed[1].session,                   "2");

// pickSessionItems: which item group a session draws from for each counterbalance
// option and phase.
console.log("\n== pickSessionItems ==");
const items = [
  {item_id:"a", group:"C-1", session:"1"}, {item_id:"b", group:"C-1", session:"2"},
  {item_id:"c", group:"C-2", session:"1"}, {item_id:"d", group:"C-2", session:"2"},
];
check("option1 spaced S1 -> 1 C-1 item",
      pickSessionItems({items, optionId:"option1", sessionId:1, phase:"spaced"}).map(x => x.item_id),
      ["a"]);
check("option1 massed S2 -> 1 C-2 item",
      pickSessionItems({items, optionId:"option1", sessionId:2, phase:"massed"}).map(x => x.item_id),
      ["d"]);
check("option2 spaced S1 -> 1 C-2 item",
      pickSessionItems({items, optionId:"option2", sessionId:1, phase:"spaced"}).map(x => x.item_id),
      ["c"]);
check("option2 massed S2 -> 1 C-1 item",
      pickSessionItems({items, optionId:"option2", sessionId:2, phase:"massed"}).map(x => x.item_id),
      ["b"]);

// shuffle: element and length preservation, and a fixed order under a seeded
// random source.
console.log("\n== shuffle ==");
const orig = [1,2,3,4,5,6,7,8,9,10];
const shuffled = shuffle([...orig]);
check("shuffle preserves length",          shuffled.length,                     orig.length);
check("shuffle preserves elements (sorted)", shuffled.slice().sort((a,b)=>a-b), orig);
// Determinism check: a seeded random source produces one fixed shuffle order.
const seedRng = (() => { let s = 1; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; })();
const seededShuf = shuffle([...orig], seedRng);
check("shuffle with seeded rng is deterministic", seededShuf.join(","), "6,2,8,4,1,9,7,10,5,3");

// FEATURES_V2: every feature in both lists has display copy and a rule string,
// and an unknown key returns null.
console.log("\n== FEATURES_V2 coverage ==");
const v2Features = [
  "al","amide","ene","eth","fluoro","hex","iodo","ol","pent","prop","pyridine","pyrrole",  // C-1
  "benzene","bromo","but","chloro","hept","iso","methyl","oate","oct","one","tert","toluene", // C-2
];
for (const f of v2Features) {
  const copy = getFeatureCopy(f);
  check(`${f} has displayName + rule`,
        copy && typeof copy.displayName === "string" && typeof copy.rule === "string",
        true);
}
check("unknown feature -> null",           getFeatureCopy("xyz"),               null);
check("empty feature -> null",             getFeatureCopy(""),                  null);

// imagePathFor: the structure image path built from a molecule name.
console.log("\n== imagePathFor ==");
check("simple name",                       imagePathFor({full_name:"hexane"}),             "images/structures/hexane.svg");
check("hyphenated name preserved",         imagePathFor({full_name:"1-fluoropropane"}),    "images/structures/1-fluoropropane.svg");
check("space -> underscore",               imagePathFor({full_name:"iso-butyl chloride"}), "images/structures/iso-butyl_chloride.svg");
check("uppercase folded",                  imagePathFor({full_name:"Octan-4-one"}),        "images/structures/octan-4-one.svg");
check("empty",                             imagePathFor({}),                                "");

// Every item in items_v2.csv produces a well-formed prompt, and the whole-word
// blanks are counted against the expected total.
console.log("\n== Real-data smoke test: makePrompt across all 96 items in items_v2.csv ==");
const fs   = await import("node:fs");
const csvText = fs.readFileSync("public/items_v2.csv", "utf8");
const allItems = parseCSV(csvText);
let wholeWordFallbacks = 0;
let validPrompts = 0;
const fallbackList = [];
for (const it of allItems) {
  const p = makePrompt(it.full_name, it.feature);
  if (p === "_______") {
    wholeWordFallbacks++;
    fallbackList.push(`${it.group} S${it.session} ${it.feature} = "${it.full_name}"`);
  } else if (p.includes("_______") && p.length > 7) {
    validPrompts++;
  } else {
    fail++;
    console.error(`  FAIL: malformed prompt for ${it.item_id}: "${p}"`);
  }
}
console.log(`  ${validPrompts} items got a valid embedded blank.`);
console.log(`  ${wholeWordFallbacks} items got a whole-word blank (feature is the full name):`);
for (const f of fallbackList) console.log(`    - ${f}`);
// Expected whole-word fallbacks: cases where the full molecule name exactly
// equals the feature. From items_v2.csv: 4 pyridine + 4 pyrrole + 4 toluene
// + 2 benzene (S1, S2; S3 and S4 use "bromobenzene" so they get an embedded
// blank "bromo_______"). Total = 14.
check("real-data: 14 expected whole-word blanks", wholeWordFallbacks, 14);
check("real-data: 82 items got embedded blanks",  validPrompts,        82);

// decideTrialDisposition: whether an answered item is mastered, requeued at a
// capped depth, or soft-capped once the retry limit is reached.
console.log("\n== decideTrialDisposition ==");
check("correct -> master",
  decideTrialDisposition({correct:true, attempt:1, maxRetries:5, requeueDepth:3, deckLength:10}),
  { action: "master", reinsertAt: null, softCapped: false });
check("wrong + attempt < max -> requeue at depth 3",
  decideTrialDisposition({correct:false, attempt:2, maxRetries:5, requeueDepth:3, deckLength:10}),
  { action: "requeue", reinsertAt: 3, softCapped: false });
check("wrong + small deck -> requeue capped at deck length",
  decideTrialDisposition({correct:false, attempt:2, maxRetries:5, requeueDepth:3, deckLength:1}),
  { action: "requeue", reinsertAt: 1, softCapped: false });
check("wrong + empty deck -> requeue at 0 (back-to-back)",
  decideTrialDisposition({correct:false, attempt:2, maxRetries:5, requeueDepth:3, deckLength:0}),
  { action: "requeue", reinsertAt: 0, softCapped: false });
check("wrong + attempt == max -> soft cap",
  decideTrialDisposition({correct:false, attempt:5, maxRetries:5, requeueDepth:3, deckLength:10}),
  { action: "soft_cap", reinsertAt: null, softCapped: true });
check("wrong + attempt > max -> soft cap (defensive)",
  decideTrialDisposition({correct:false, attempt:6, maxRetries:5, requeueDepth:3, deckLength:10}),
  { action: "soft_cap", reinsertAt: null, softCapped: true });

// simulateMasteryLoop: the trial sequence, mastered items and soft-capped items
// the mastery loop produces for a set of scripted outcomes.
console.log("\n== simulateMasteryLoop ==");
// Scenario 1: 3 items, A fails twice then succeeds, B and C succeed first try.
{
  const items = [{item_id:"A"},{item_id:"B"},{item_id:"C"}];
  const outcomes = new Map([
    ["A", [false, false, true]],
    ["B", [true]],
    ["C", [true]],
  ]);
  const r = simulateMasteryLoop(items, outcomes, {maxRetries:5, requeueDepth:3});
  check("Scenario 1: trial count = 5", r.sequence.length, 5);
  check("Scenario 1: 3 mastered",      r.mastered.sort(),   ["A","B","C"]);
  check("Scenario 1: 0 soft-capped",   r.softCapped,        []);
  check("Scenario 1: first trial is A1 wrong",
        { id: r.sequence[0].item_id, a: r.sequence[0].attempt, c: r.sequence[0].correct },
        { id: "A", a: 1, c: false });
  check("Scenario 1: A reappears after B and C",
        r.sequence.slice(3).map(t => t.item_id),
        ["A","A"]);
}
// Scenario 2: A fails 5 times, hits soft cap. B succeeds.
{
  const items = [{item_id:"A"},{item_id:"B"}];
  const outcomes = new Map([
    ["A", [false, false, false, false, false]],
    ["B", [true]],
  ]);
  const r = simulateMasteryLoop(items, outcomes, {maxRetries:5, requeueDepth:3});
  check("Scenario 2: trial count = 6", r.sequence.length, 6);
  check("Scenario 2: B mastered",      r.mastered,          ["B"]);
  check("Scenario 2: A soft-capped",   r.softCapped,        ["A"]);
  check("Scenario 2: A's 5th attempt is the soft cap",
        r.sequence[r.sequence.length - 1],
        { item_id: "A", attempt: 5, correct: false });
}
// Scenario 3: all correct first try (happy path).
{
  const items = [{item_id:"A"},{item_id:"B"},{item_id:"C"}];
  const outcomes = new Map([["A",[true]],["B",[true]],["C",[true]]]);
  const r = simulateMasteryLoop(items, outcomes);
  check("Scenario 3: trial count = items count", r.sequence.length, 3);
  check("Scenario 3: all mastered, none capped",
        { m: r.mastered.sort(), c: r.softCapped },
        { m: ["A","B","C"], c: [] });
}

// beforeunload guard: nested installs and removals are reference counted, clamp
// at zero, and survive the Day 4 install pattern.
console.log("\n== beforeunload guard ref counting ==");
// Reset to a known zero state (Node start state).
while (_getBeforeUnloadRefCount() > 0) removeBeforeUnloadGuard();
check("starts at 0",              _getBeforeUnloadRefCount(), 0);
installBeforeUnloadGuard();
check("install -> 1",             _getBeforeUnloadRefCount(), 1);
installBeforeUnloadGuard();
check("nested install -> 2",      _getBeforeUnloadRefCount(), 2);
removeBeforeUnloadGuard();
check("first remove -> 1 (still guarded)", _getBeforeUnloadRefCount(), 1);
removeBeforeUnloadGuard();
check("second remove -> 0 (released)",     _getBeforeUnloadRefCount(), 0);
// Defensive: extra remove beyond zero should not go negative.
removeBeforeUnloadGuard();
removeBeforeUnloadGuard();
check("extra removes clamp at 0",          _getBeforeUnloadRefCount(), 0);
// Day-4 simulation: composite install + per-phase install/remove cycles.
installBeforeUnloadGuard();                                    // runDay4Page install
installBeforeUnloadGuard(); removeBeforeUnloadGuard();         // phase 1 install/remove
check("after phase 1, still 1",            _getBeforeUnloadRefCount(), 1);
installBeforeUnloadGuard(); removeBeforeUnloadGuard();         // phase 2 install/remove
check("after phase 2, still 1",            _getBeforeUnloadRefCount(), 1);
removeBeforeUnloadGuard();                                     // runDay4Page final remove
check("composite removed, 0 at the end",   _getBeforeUnloadRefCount(), 0);

console.log(`\nresult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
