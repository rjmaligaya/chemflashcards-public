/**
 * copy-strings.js — fetch + cache the editable participant-facing copy.
 *
 * The metacognitive layer prompts (per-item confidence, pre-session
 * predictions, forced-choice, debrief) read their wording from copy_strings_v2
 * in D1 via GET /api/v2/copy, so the wording can change without a frontend
 * redeploy.
 *
 * This module wraps the fetch in a per-session cache and a sync getter with
 * a fallback. Pages that need any string call `preloadCopyStrings()` once
 * (e.g. just before starting the trial loop), then read with `getCopy(key,
 * fallback)` anywhere.
 *
 * The fallback strings live here too, so a failed fetch still renders English
 * copy matching the seed defaults.
 */

import { workerUrl, API } from "./config-v2.js";

// Resolved copy keys after a successful preload. Empty until preloadCopyStrings.
let _strings = null;
let _inflight = null;

// Mirrors the seed defaults in schema_v2_metacog_migration.sql. Used as the
// fallback when getCopy is called before preload, or when the fetch failed.
// Keep in sync with the migration script.
export const COPY_FALLBACK = Object.freeze({
  forced_choice_day4_prompt:
    "You practised two sets of chemical names. Set A included names such as {set_a_examples}. Set B included names such as {set_b_examples}. There are no right or wrong answers, and your choice won't affect your results. Which set do you think you'll remember better at your next visit?",
  forced_choice_day14_prompt:
    "Earlier in the study you practised two sets of chemical names. Set A included names such as {set_a_examples}. Set B included names such as {set_b_examples}. Thinking about the test you just finished, which set do you feel you remembered better?",
  forced_choice_option_set_a:        "Set A",
  forced_choice_option_set_b:        "Set B",
  forced_choice_option_same:         "About the same",
  forced_choice_confidence_label:    "How confident are you in that answer?",
  forced_choice_confidence_low:      "Not very confident",
  forced_choice_confidence_mid:      "Somewhat confident",
  forced_choice_confidence_high:     "Very confident",
  forced_choice_submit:              "Submit",
  prediction_prompt:                 "Of today's 12 items, how many do you think you will get right on your first try?",
  prediction_title:                  "Before you start",
  prediction_cta:                    "Start the session",
  summary_neutral_title:             "Thank you",
  summary_neutral_body:              "Your responses have been saved.",
  confidence_prompt:                 "How confident are you in that answer?",
  confidence_option_guess:           "Guess",
  confidence_option_unsure:          "Unsure",
  confidence_option_fairly_sure:     "Fairly sure",
  confidence_option_certain:         "Certain",
  debrief_title:                     "Thank you for completing the study",
  debrief_intro:
    "Below is a summary of your own results, followed by a short explanation of what we were measuring. You can stay on this page as long as you like, and you are welcome to take a screenshot if you want a record.",
  debrief_spacing_effect:
    "This study compared two ways of practising chemistry nomenclature. With one set of words you practised a little each day over four days. With the other set you practised the same total amount, but all in one sitting on the last day. Decades of memory research show that spreading practice across days produces stronger long-term memory than cramming the same practice into one session. Your scores on the delayed test give one snapshot of how the two practice schedules compared for you.",
  debrief_illusion_of_fluency:
    "Cramming feels easier in the moment. When you practise the same material several times in one sitting, each repetition feels smoother and more confident than the last. That feeling of ease is real, but it often does not predict how well you will remember the material later. The questions we asked you on Day 4 and at the delayed test, where you picked which set you thought you would remember better, were designed to see whether that feeling of ease shapes your judgments.",
  debrief_what_we_measured:
    "You may have noticed that each question asked for your confidence rating, and that each session started with a guess about how many items you would get right. These were not part of your performance grade. They let us see how well you can judge your own learning, both for each individual question (your confidence rating) and across the whole study (which set you thought you would remember better). Comparing your judgments to your actual scores tells us how well a learner can tell what they know.",
  // Practice-session row labels for the debrief chart.
  practice_label_spaced_s1:          "Set A: Day 1",
  practice_label_spaced_s2:          "Set A: Day 2",
  practice_label_spaced_s3:          "Set A: Day 3",
  practice_label_spaced_s4:          "Set A: Day 4",
  practice_label_massed_b1:          "Set B: block 1",
  practice_label_massed_b2:          "Set B: block 2",
  practice_label_massed_b3:          "Set B: block 3",
  practice_label_massed_b4:          "Set B: block 4",
  // Session 0 per-molecule baseline familiarity scale. The current tutorial
  // flow does not use these keys.
  familiarity_title:                 "Before you start learning",
  familiarity_intro:                 "Below are the molecules you are about to study. For each one, tell us how familiar its name and structure already are to you, before any practice. There are no right or wrong answers.",
  familiarity_prompt:                "How familiar are you with this molecule?",
  familiarity_anchor_low:            "Not at all familiar",
  familiarity_anchor_high:           "Very familiar",
  familiarity_cta:                   "Next",
  // Session 0 per-topic "easy to learn" rating, used by the current tutorial
  // flow. {family} is interpolated per topic. These keys are not seeded in D1,
  // so these defaults render until a copy_strings_v2 override is added.
  // Draft wording. Not yet reviewed for participant-facing use.
  ease_prompt:                       "Was the name for {family} easy to learn?",
  ease_anchor_low:                   "Very hard to learn",
  ease_anchor_high:                  "Very easy to learn",
  ease_cta:                          "Next",
});

/**
 * Fetch /api/v2/copy and cache the result. Idempotent — repeated calls
 * resolve to the same in-flight Promise (so multiple modules can preload
 * without firing duplicate requests).
 *
 * On network failure, leaves _strings null so getCopy falls back to
 * COPY_FALLBACK. Warns to the console and does not throw.
 */
export function preloadCopyStrings() {
  if (_strings) return Promise.resolve(_strings);
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const res = await fetch(workerUrl(API.COPY), { cache: "no-store" });
      if (!res.ok) throw new Error(`copy fetch http_${res.status}`);
      const body = await res.json();
      _strings = (body && typeof body.strings === "object") ? body.strings : {};
      return _strings;
    } catch (e) {
      console.warn("[copy-strings] preload failed, using fallback:", e?.message || e);
      _strings = null;
      return COPY_FALLBACK;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * Sync getter. Returns the cached value if preloaded, otherwise the
 * caller-supplied fallback, otherwise the matching key from COPY_FALLBACK,
 * otherwise an empty string. Never throws.
 */
export function getCopy(key, fallback) {
  if (_strings && typeof _strings[key] === "string") return _strings[key];
  if (typeof fallback === "string")                  return fallback;
  if (typeof COPY_FALLBACK[key] === "string")        return COPY_FALLBACK[key];
  return "";
}

/** Test hook — reset module cache. Not used in production. */
export function _resetCopyStringsForTest() {
  _strings = null;
  _inflight = null;
}
