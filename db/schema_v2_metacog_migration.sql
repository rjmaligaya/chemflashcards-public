-- ═══════════════════════════════════════════════════════════
-- schema_v2_metacog_migration.sql
--
-- Adds the metacognitive measurement layer to an existing ssp-study-02
-- database: per-item confidence, pre-session predictions, forced choices,
-- familiarity ratings, and editable copy. Safe to run on a live DB, with no
-- destructive statements, IF NOT EXISTS on every CREATE, and INSERT OR IGNORE
-- on the seeds.
--
-- schema_v2.sql already contains everything below, so a fresh database does not
-- need this file. Use it to upgrade a database created without the
-- metacognitive layer.
--
-- Deploy with:
--   wrangler d1 execute ssp-study-02 --file=schema_v2_metacog_migration.sql --remote
--
-- For local dev, replace --remote with --local.
-- ═══════════════════════════════════════════════════════════

-- ── Additive column on trials_v2 ─────────────────────────
-- ALTER TABLE ... ADD COLUMN does not support IF NOT EXISTS in SQLite.
-- If you have already run this migration once, the next line will error
-- with "duplicate column name: confidence". That is harmless — wrangler
-- exits non-zero but the subsequent CREATE TABLE / INSERT statements are
-- idempotent. If you want a clean re-run, split this file: run the
-- ALTER once, then re-run just the CREATE TABLE + INSERT block below.

ALTER TABLE trials_v2 ADD COLUMN confidence INTEGER;

-- ── New tables ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pre_session_predictions_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT    NOT NULL,
  session_label   TEXT    NOT NULL,
  value           INTEGER NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (participant_id) REFERENCES participants_v2 (pid),
  UNIQUE (participant_id, session_label),
  CHECK (value BETWEEN 0 AND 12)
);

CREATE INDEX IF NOT EXISTS idx_pred_pid ON pre_session_predictions_v2 (participant_id);

-- Removes the postdictions table and its index if an earlier run of this
-- migration created them.
DROP TABLE IF EXISTS post_session_postdictions_v2;
DROP INDEX  IF EXISTS idx_postd_pid;

CREATE TABLE IF NOT EXISTS forced_choices_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT    NOT NULL,
  checkpoint      TEXT    NOT NULL,
  choice          TEXT    NOT NULL,
  confidence      INTEGER NOT NULL,
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
-- introduced. 'spaced_intro' fires before Session 1; 'massed_intro' fires on
-- Day 4 after the break. One row per (participant, item); INSERT OR IGNORE keeps
-- the first (true-baseline) value if the screen is ever re-shown. Safe to run on
-- a live ssp-study-02 database (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS familiarity_ratings_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT    NOT NULL,
  checkpoint      TEXT    NOT NULL,
  item_id         TEXT    NOT NULL,
  group_id        TEXT    NOT NULL,
  feature         TEXT    NOT NULL,
  full_name       TEXT    NOT NULL,
  value           INTEGER NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (participant_id) REFERENCES participants_v2 (pid),
  UNIQUE (participant_id, item_id),
  CHECK (checkpoint IN ('spaced_intro','massed_intro')),
  CHECK (group_id IN ('C-1','C-2')),
  CHECK (value BETWEEN 1 AND 7)
);

CREATE INDEX IF NOT EXISTS idx_fam_pid ON familiarity_ratings_v2 (participant_id);

CREATE TABLE IF NOT EXISTS copy_strings_v2 (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed defaults. INSERT OR IGNORE so re-running the migration does NOT
-- overwrite admin edits to any of the strings below.
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
