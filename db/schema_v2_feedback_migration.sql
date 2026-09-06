-- ═══════════════════════════════════════════════════════════
-- schema_v2_feedback_migration.sql
--
-- Adds the tester edit-request ("feedback") table to an existing ssp-study-02
-- database. The table backs the in-page "Request edit" tool used during
-- end-to-end testing.
--
-- The table stands apart from the study-data tables (participants_v2,
-- sessions_v2, trials_v2) and the metacognitive tables. Nothing reads it, joins
-- it, or feeds it into an analysis path. It is:
--   - append-only, with no UNIQUE constraint, so every submission is a new row,
--     and
--   - free of any foreign key to participants_v2. The stored `pid` is the DEV
--     test id in use at submit time and is kept as context only, so an insert
--     never depends on enrollment state.
--
-- Safe to run on a live DB: no destructive statements, IF NOT EXISTS on
-- every CREATE.
--
-- Deploy with:
--   wrangler d1 execute ssp-study-02 --file=schema_v2_feedback_migration.sql --remote
--
-- For local dev, replace --remote with --local.
-- ═══════════════════════════════════════════════════════════

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
