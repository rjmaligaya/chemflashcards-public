-- ═══════════════════════════════════════════════════════════
-- schema_v2.sql — the v2 ChemFlashcards schema.
--
-- Defines the tables that the /api/v2/* handlers in worker.mjs read and write,
-- in the D1 database `ssp-study-02`. The v1 tables are defined in schema.sql
-- and live in a separate database.
--
-- Deploy with:
--   wrangler d1 execute ssp-study-02 --file=schema_v2.sql --remote
--
-- For local dev, replace --remote with --local.
-- ═══════════════════════════════════════════════════════════

-- ── Participants ─────────────────────────────────────────
-- One row per enrolled participant. Enrollment happens when the
-- participant submits their PID at the landing page on Day 0.
-- The condition (option1/option2) is derived from PID parity by
-- routing-v2.js and verified server-side before insert.

CREATE TABLE IF NOT EXISTS participants_v2 (
  pid              TEXT    PRIMARY KEY,
  option_id        TEXT    NOT NULL,             -- 'option1' or 'option2'
  enrollment_date  TEXT    NOT NULL,             -- ISO 8601 datetime (UTC)
  dev_mode         INTEGER NOT NULL DEFAULT 0,   -- 1 if DEV PID (skips time gates)
  ua               TEXT,                         -- user agent at enrollment
  tz               TEXT,                         -- participant timezone at enrollment
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),

  CHECK (option_id IN ('option1','option2'))
);

CREATE INDEX IF NOT EXISTS idx_pv2_option ON participants_v2 (option_id);

-- ── Sessions ─────────────────────────────────────────────
-- One row per session attempt. A "session" is a self-contained block
-- the participant works through in one sitting.
--
-- session_label values (locked vocabulary):
--   'pretest'        — Day 0, in-lab, 24 Q-blank items
--   'spaced-S1'      — Day 1, at-home, 12 items from participant's spaced group
--   'spaced-S2'      — Day 2, at-home
--   'spaced-S3'      — Day 3, at-home
--   'spaced-S4'      — Day 4, at-home (first part of Day-4 composite)
--   'massed-B1'      — Day 4, at-home (first massed block)
--   'massed-B2'      — Day 4
--   'massed-B3'      — Day 4
--   'massed-B4'      — Day 4
--   'immediate'      — not written by the app; still accepted by the phase CHECK
--   'delayed'        — ~1 week after Day 4, in-lab, 36-item delayed posttest (eye-tracked)

CREATE TABLE IF NOT EXISTS sessions_v2 (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id   TEXT    NOT NULL,
  phase            TEXT    NOT NULL,             -- 'pretest'|'spaced'|'massed'|'immediate'|'delayed'
  session_label    TEXT    NOT NULL,             -- see vocabulary above
  group_practiced  TEXT,                         -- 'C-1' | 'C-2' for spaced/massed; NULL otherwise
  started_at       TEXT,
  completed_at     TEXT,
  ua               TEXT,
  device_w         INTEGER,
  device_h         INTEGER,
  tz               TEXT,
  session_context  TEXT    NOT NULL DEFAULT 'online',  -- 'online' | 'in_person'
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (participant_id) REFERENCES participants_v2 (pid),
  UNIQUE (participant_id, session_label),
  CHECK (phase IN ('pretest','spaced','massed','immediate','delayed'))
);

CREATE INDEX IF NOT EXISTS idx_sv2_pid   ON sessions_v2 (participant_id);
CREATE INDEX IF NOT EXISTS idx_sv2_phase ON sessions_v2 (phase);
CREATE INDEX IF NOT EXISTS idx_sv2_label ON sessions_v2 (session_label);

-- ── Trials ───────────────────────────────────────────────
-- One row per individual question attempt.
--
-- Stimulus timestamps:
--   stim_on_ts  — ms-precision ISO 8601, when the structure image was rendered
--   stim_off_ts — ms-precision ISO 8601, when the participant submitted (or timed out)
--
-- Scoring:
--   raw_answer is always stored. correct is the lenient automated flag:
--   case-insensitive, hyphen- and spacing-tolerant, matched against the item's
--   single accepted answer, and scored on whatever was typed, including on a
--   timeout.

CREATE TABLE IF NOT EXISTS trials_v2 (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL,
  participant_id   TEXT    NOT NULL,
  item_id          TEXT    NOT NULL,             -- e.g. 'C1-S2-amide' from items_v2.csv
  group_id         TEXT    NOT NULL,             -- 'C-1' | 'C-2'
  feature          TEXT    NOT NULL,             -- e.g. 'amide', 'eth', 'iso'
  full_name        TEXT    NOT NULL,             -- e.g. 'pentanamide'
  qtype            TEXT    NOT NULL,             -- 'Q-blank' | 'Q-full'
  raw_answer       TEXT,
  correct          INTEGER,                      -- 1 | 0, scored on the typed text even on a timeout; NULL only for a genuinely unanswered trial
  rt_ms            INTEGER,                      -- response time in ms
  review_ms        INTEGER,                      -- time on feedback screen (practice only)
  stim_on_ts       TEXT,
  stim_off_ts      TEXT,
  trial_order      INTEGER NOT NULL,             -- 1-based position within the session
  -- Mastery-loop bookkeeping (C3++):
  timed_out        INTEGER NOT NULL DEFAULT 0,   -- 1 if the trial auto-submitted at 0:00
  retry_attempt    INTEGER NOT NULL DEFAULT 1,   -- 1-based attempt count for this item this session
  soft_capped      INTEGER NOT NULL DEFAULT 0,   -- 1 on the trial that hit max_retries without mastery
  -- Metacognitive layer: the participant's self-rated confidence in the answer
  -- just submitted, captured after submit and before correctness is revealed.
  -- Values: 1=Guess, 2=Unsure, 3=Fairly sure, 4=Certain. NULL on the test
  -- trials (pretest and delayed posttest), where the prompt does not fire, and
  -- on rows written before the column was added.
  confidence       INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (session_id) REFERENCES sessions_v2 (id),
  FOREIGN KEY (participant_id) REFERENCES participants_v2 (pid),
  CHECK (qtype IN ('Q-blank','Q-full')),
  CHECK (group_id IN ('C-1','C-2')),
  CHECK (confidence IS NULL OR confidence BETWEEN 1 AND 4)
);

CREATE INDEX IF NOT EXISTS idx_tv2_session ON trials_v2 (session_id);
CREATE INDEX IF NOT EXISTS idx_tv2_pid     ON trials_v2 (participant_id);
CREATE INDEX IF NOT EXISTS idx_tv2_item    ON trials_v2 (item_id);
CREATE INDEX IF NOT EXISTS idx_tv2_qtype   ON trials_v2 (qtype);

-- ── Metacognitive layer ──────────────────────────────────
-- Four tables: the pre-session predictions, the end-of-Day-4 and
-- start-of-Day-14 forced choices, the Session 0 familiarity ratings, and the
-- editable copy strings shown by those prompts and by the Day-14 debrief.
--
-- Per-item confidence is not one of them. It lives in trials_v2.confidence, one
-- column above, so a trial row carries both the answer and the confidence in
-- it. The four tables below cover the measures that fire outside the trial loop.
--
-- All four store data in long format: one row per measurement, which is also
-- the shape of the CSV export.

-- pre_session_predictions_v2: "Of today's 12 items, how many do you think
-- you'll get right on your first try?" Fires once before the first item of
-- each spaced session and once before each Day-4 massed block. Does not fire
-- on the pretest or the delayed test. The massed-block distinction is carried
-- in session_label ('massed-B1' ... 'massed-B4'), so there is no separate
-- block_id column.

CREATE TABLE IF NOT EXISTS pre_session_predictions_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT    NOT NULL,
  session_label   TEXT    NOT NULL,              -- 'spaced-S1' ... 'massed-B4'
  value           INTEGER NOT NULL,              -- 0..12 items predicted correct
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (participant_id) REFERENCES participants_v2 (pid),
  UNIQUE (participant_id, session_label),
  CHECK (value BETWEEN 0 AND 12)
);

CREATE INDEX IF NOT EXISTS idx_pred_pid ON pre_session_predictions_v2 (participant_id);

-- forced_choices_v2: presented at the end of Day 4 and again at the start of
-- Day 14, after the session gate clears and before the delayed posttest items
-- begin. The participant picks which of the two sets they think they will
-- remember (Day 4) or did remember (Day 14) better, plus a 3-level confidence
-- in that judgement.
--
-- The participant-facing labels "Set A" and "Set B" are assigned at study
-- start: Set A is the spaced group and Set B is the massed group, whichever of
-- C-1 and C-2 those are for this participant. The mapping back to C-1 and C-2
-- follows from the participant's option_id in participants_v2.

CREATE TABLE IF NOT EXISTS forced_choices_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT    NOT NULL,
  checkpoint      TEXT    NOT NULL,              -- 'day_4_immediate' | 'day_14_delayed'
  choice          TEXT    NOT NULL,              -- 'set_a' | 'set_b' | 'same'
  confidence      INTEGER NOT NULL,              -- 1=Not very, 2=Somewhat, 3=Very
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (participant_id) REFERENCES participants_v2 (pid),
  UNIQUE (participant_id, checkpoint),
  CHECK (checkpoint IN ('day_4_immediate','day_14_delayed')),
  CHECK (choice IN ('set_a','set_b','same')),
  CHECK (confidence BETWEEN 1 AND 3)
);

CREATE INDEX IF NOT EXISTS idx_fc_pid ON forced_choices_v2 (participant_id);

-- familiarity_ratings_v2: baseline familiarity self-rating (1..7 bubble scale),
-- collected during Session 0, once per Session-1 stimulus of the list being
-- introduced. 'spaced_intro' fires before Session 1 (the spaced list);
-- 'massed_intro' fires on Day 4 after the break, before the massed blocks (the
-- massed list). One row per (participant, item); INSERT OR IGNORE keeps the
-- first (true-baseline) value if the screen is ever re-shown.

CREATE TABLE IF NOT EXISTS familiarity_ratings_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT    NOT NULL,
  checkpoint      TEXT    NOT NULL,              -- 'spaced_intro' | 'massed_intro'
  item_id         TEXT    NOT NULL,              -- e.g. 'C1-S1-al' from items_v2.csv
  group_id        TEXT    NOT NULL,              -- 'C-1' | 'C-2'
  feature         TEXT    NOT NULL,              -- e.g. 'al', 'eth', 'iso'
  full_name       TEXT    NOT NULL,              -- e.g. 'ethanal'
  value           INTEGER NOT NULL,              -- 1..7 (1=not at all, 7=very familiar)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (participant_id) REFERENCES participants_v2 (pid),
  UNIQUE (participant_id, item_id),
  CHECK (checkpoint IN ('spaced_intro','massed_intro')),
  CHECK (group_id IN ('C-1','C-2')),
  CHECK (value BETWEEN 1 AND 7)
);

CREATE INDEX IF NOT EXISTS idx_fam_pid ON familiarity_ratings_v2 (participant_id);

-- copy_strings_v2: key/value store for editable participant-facing copy.
-- The forced-choice prompts and the Day-14 debrief read their text from here at
-- render time, so wording changes need no frontend redeploy. A key is edited
-- with `wrangler d1 execute ... UPDATE copy_strings_v2 SET value=... WHERE
-- key=...` or through the admin.html UI (POST /api/v2/copy). The seed defaults
-- use INSERT OR IGNORE, so re-running this schema leaves existing values alone.

CREATE TABLE IF NOT EXISTS copy_strings_v2 (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO copy_strings_v2 (key, value) VALUES
  ('forced_choice_day4_prompt',
   'You practised two sets of chemical names. Set A included names such as {set_a_examples}. Set B included names such as {set_b_examples}. There are no right or wrong answers, and your choice won''t affect your results. Which set do you think you''ll remember better at your next visit?'),
  ('forced_choice_day14_prompt',
   'Earlier in the study you practised two sets of chemical names. Set A included names such as {set_a_examples}. Set B included names such as {set_b_examples}. Thinking about the test you just finished, which set do you feel you remembered better?'),
  ('forced_choice_option_set_a',         'Set A'),
  ('forced_choice_option_set_b',         'Set B'),
  ('forced_choice_option_same',          'About the same'),
  ('forced_choice_confidence_label',     'How confident are you in that answer?'),
  ('forced_choice_confidence_low',       'Not very confident'),
  ('forced_choice_confidence_mid',       'Somewhat confident'),
  ('forced_choice_confidence_high',      'Very confident'),
  ('forced_choice_submit',               'Submit'),
  ('prediction_prompt',
   'Of today''s 12 items, how many do you think you will get right on your first try?'),
  ('prediction_title',                   'Before you start'),
  ('prediction_cta',                     'Start the session'),
  ('summary_neutral_title',              'Thank you'),
  ('summary_neutral_body',               'Your responses have been saved.'),
  ('confidence_prompt',                  'How confident are you in that answer?'),
  ('confidence_option_guess',            'Guess'),
  ('confidence_option_unsure',           'Unsure'),
  ('confidence_option_fairly_sure',      'Fairly sure'),
  ('confidence_option_certain',          'Certain'),
  ('debrief_title',                      'Thank you for completing the study'),
  ('debrief_intro',
   'Below is a summary of your own results, followed by a short explanation of what we were measuring. You can stay on this page as long as you like, and you are welcome to take a screenshot if you want a record.'),
  ('debrief_spacing_effect',
   'This study compared two ways of practising chemistry nomenclature. With one set of words you practised a little each day over four days. With the other set you practised the same total amount, but all in one sitting on the last day. Decades of memory research show that spreading practice across days produces stronger long-term memory than cramming the same practice into one session. Your scores on the delayed test give one snapshot of how the two practice schedules compared for you.'),
  ('debrief_illusion_of_fluency',
   'Cramming feels easier in the moment. When you practise the same material several times in one sitting, each repetition feels smoother and more confident than the last. That feeling of ease is real, but it often does not predict how well you will remember the material later. The questions we asked you on Day 4 and at the delayed test, where you picked which set you thought you would remember better, were designed to see whether that feeling of ease shapes your judgments.'),
  ('debrief_what_we_measured',
   'You may have noticed that each question asked for your confidence rating, and that each session started with a guess about how many items you would get right. These were not part of your performance grade. They let us see how well you can judge your own learning, both for each individual question (your confidence rating) and across the whole study (which set you thought you would remember better). Comparing your judgments to your actual scores tells us how well a learner can tell what they know.'),
  -- Practice-session row labels for the debrief chart.
  ('practice_label_spaced_s1',           'Set A: Day 1'),
  ('practice_label_spaced_s2',           'Set A: Day 2'),
  ('practice_label_spaced_s3',           'Set A: Day 3'),
  ('practice_label_spaced_s4',           'Set A: Day 4'),
  ('practice_label_massed_b1',           'Set B: block 1'),
  ('practice_label_massed_b2',           'Set B: block 2'),
  ('practice_label_massed_b3',           'Set B: block 3'),
  ('practice_label_massed_b4',           'Set B: block 4'),
  -- Session 0 baseline familiarity scale (1..7 bubble).
  ('familiarity_title',                  'Before you start learning'),
  ('familiarity_intro',                  'Below are the molecules you are about to study. For each one, tell us how familiar its name and structure already are to you, before any practice. There are no right or wrong answers.'),
  ('familiarity_prompt',                 'How familiar are you with this molecule?'),
  ('familiarity_anchor_low',             'Not at all familiar'),
  ('familiarity_anchor_high',            'Very familiar'),
  ('familiarity_cta',                    'Next');

-- ── Tester edit requests (feedback) ──────────────────────
-- Backs the in-page "Request edit" tool used during end-to-end testing. The
-- table stands apart from the study-data tables above: no analysis path reads
-- it, it is append-only (no UNIQUE constraint), and it has no foreign key to
-- participants_v2. The stored `pid` is the DEV test id in use at submit time
-- and is kept as context only, so an insert never depends on enrollment state.
-- See schema_v2_feedback_migration.sql for adding this table to a live DB.

CREATE TABLE IF NOT EXISTS edit_requests_v2 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       TEXT    NOT NULL,            -- groups the pins submitted together from one page
  pid            TEXT,                        -- DEV test id in use (context only; NOT a foreign key)
  reporter       TEXT,                        -- optional tester name
  page           TEXT    NOT NULL,            -- page filename/path, e.g. 'study-session1.html'
  page_url       TEXT,                        -- full URL at submit time
  viewport       TEXT,                        -- e.g. '1280x800'
  ua             TEXT,                        -- user agent at submit time
  note           TEXT    NOT NULL,            -- the tester's requested change
  selector       TEXT,                        -- CSS-ish path to the pinned element
  element_text   TEXT,                        -- short snippet of the element's text / alt
  selected_text  TEXT,                        -- text the tester highlighted, if any
  pos            TEXT,                        -- normalized 'x,y' of the pin (0..1), for context
  resolved       INTEGER NOT NULL DEFAULT 0,  -- 0 = open, 1 = handled (toggled from admin.html)
  resolved_at    TEXT,                        -- when it was marked handled
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_er_batch    ON edit_requests_v2 (batch_id);
CREATE INDEX IF NOT EXISTS idx_er_resolved ON edit_requests_v2 (resolved);
CREATE INDEX IF NOT EXISTS idx_er_created  ON edit_requests_v2 (created_at);
