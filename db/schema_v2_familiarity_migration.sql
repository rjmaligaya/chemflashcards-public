-- ═══════════════════════════════════════════════════════════
-- schema_v2_familiarity_migration.sql
--
-- Incremental migration: adds the Session 0 baseline familiarity layer to an
-- existing ssp-study-02 database. Safe and idempotent: IF NOT EXISTS on the
-- table and index, INSERT OR IGNORE on the seeds. Touches no existing table
-- (trials_v2, participants_v2, sessions_v2, or any metacognitive table).
--
-- Use this file rather than re-running schema_v2_metacog_migration.sql on a
-- database that already has the metacognitive layer. That file begins with
-- `ALTER TABLE trials_v2 ADD COLUMN confidence`, which fails with a duplicate
-- column error once the column is present.
--
-- Deploy with:
--   wrangler d1 execute ssp-study-02 --file=schema_v2_familiarity_migration.sql --remote
-- (replace --remote with --local for local dev)
-- ═══════════════════════════════════════════════════════════

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

-- Session 0 baseline familiarity scale copy.
INSERT OR IGNORE INTO copy_strings_v2 (key, value) VALUES
  ('familiarity_title',                  'Before you start learning'),
  ('familiarity_intro',                  'Below are the molecules you are about to study. For each one, tell us how familiar its name and structure already are to you, before any practice. There are no right or wrong answers.'),
  ('familiarity_prompt',                 'How familiar are you with this molecule?'),
  ('familiarity_anchor_low',             'Not at all familiar'),
  ('familiarity_anchor_high',            'Very familiar'),
  ('familiarity_cta',                    'Next');
