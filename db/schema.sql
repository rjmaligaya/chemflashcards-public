-- ═══════════════════════════════════════════════════════════
-- schema.sql — the v1 ChemFlashcards schema.
--
-- Defines the `sessions` and `trials` tables that the /api/status and
-- /api/ingest handlers in worker.mjs read and write, together with the
-- analysis views over them. The v2 study uses schema_v2.sql and a separate
-- database.
--
-- Deploy with:
--   wrangler d1 execute ssp-study-01 --file=schema.sql --remote
--
-- For local dev, replace --remote with --local.
-- ═══════════════════════════════════════════════════════════

-- ── Sessions ─────────────────────────────────────────────
-- One row per participant per session (first attempt only).
-- Reattempts are stored in the trials table (reattempt = 1).

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT    NOT NULL,
  study_id        TEXT    NOT NULL DEFAULT '',
  condition       TEXT    NOT NULL DEFAULT '',  -- 'spaced' | 'massed'
  session_id      INTEGER NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  ua              TEXT,
  device_w        INTEGER,
  device_h        INTEGER,
  tz              TEXT,
  pretest_lag_days INTEGER,                     -- days between pre-test completion and Session 0 start (set on Session 0 only)
  session_context TEXT    NOT NULL DEFAULT 'online',  -- 'online' | 'in_person' (pretest -1 and posttest 6 are in_person)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  UNIQUE (participant_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_pid       ON sessions (participant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_study     ON sessions (study_id);
CREATE INDEX IF NOT EXISTS idx_sessions_condition ON sessions (condition);

-- ── Trials ───────────────────────────────────────────────
-- One row per trial event.
-- Key metrics:
--   rt_ms      — time from question display to submit press (ms)
--   review_ms  — time spent on feedback screen before pressing Next (ms)
--   correct    — 1 | 0
--   phase      — "first_pass" | "mastery"
--   skill      — skill number (1–20), links to anchor concept
--   anchor     — the concept being tested (e.g. "acetone", "one")

CREATE TABLE IF NOT EXISTS trials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  TEXT    NOT NULL,
  study_id        TEXT    NOT NULL DEFAULT '',
  condition       TEXT    NOT NULL DEFAULT '',  -- 'spaced' | 'massed'
  session_id      INTEGER NOT NULL,
  reattempt       INTEGER NOT NULL DEFAULT 0,   -- 0 = first attempt, 1 = reattempt

  trial_index     INTEGER,
  item_id         TEXT,                         -- e.g. 'Q01'
  skill           INTEGER,                      -- skill number 1–20
  anchor          TEXT,                         -- anchor concept label
  phase           TEXT,                         -- first_pass | mastery
  attempt_num     INTEGER,                      -- attempt number within topic
  task_type       TEXT    NOT NULL DEFAULT 'retrieval',  -- retrieval | recognition | error_detection | matching | bidirectional | feature_id | suffix_recognition | fatigue

  rt_ms           INTEGER,   -- response time: question shown → submit pressed
  review_ms       INTEGER,   -- review time: feedback shown → Next pressed
  answer_raw      TEXT,      -- raw typed answer
  answer_norm     TEXT,      -- normalised answer
  correct         INTEGER,   -- 1 | 0
  timed_out       INTEGER NOT NULL DEFAULT 0,  -- 1 if auto-submitted by 20s timer; 0 otherwise

  trial_ts        TEXT,      -- ISO timestamp when answer was submitted
  started_at      TEXT,      -- session start timestamp
  completed_at    TEXT,      -- session completion timestamp

  ua              TEXT,
  device_w        INTEGER,
  device_h        INTEGER,
  tz              TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trials_pid       ON trials (participant_id);
CREATE INDEX IF NOT EXISTS idx_trials_session   ON trials (participant_id, session_id);
CREATE INDEX IF NOT EXISTS idx_trials_item      ON trials (item_id);
CREATE INDEX IF NOT EXISTS idx_trials_skill     ON trials (skill);
CREATE INDEX IF NOT EXISTS idx_trials_study     ON trials (study_id);
CREATE INDEX IF NOT EXISTS idx_trials_condition ON trials (condition);
CREATE INDEX IF NOT EXISTS idx_trials_task_type ON trials (task_type);

-- ── Analysis views ────────────────────────────────────────

-- Per-participant per-skill accuracy and timing summary
-- Primary view for spacing effect analysis
CREATE VIEW IF NOT EXISTS v_skill_accuracy AS
SELECT
  participant_id,
  study_id,
  condition,
  session_id,
  skill,
  anchor,
  phase,
  COUNT(*)                                                          AS n_trials,
  SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END)                     AS n_correct,
  ROUND(100.0 * SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END)
        / COUNT(*), 1)                                             AS pct_correct,
  SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END)                   AS n_timed_out,
  ROUND(AVG(rt_ms), 0)                                             AS avg_rt_ms,
  ROUND(AVG(CASE WHEN timed_out = 0 THEN rt_ms END), 0)            AS avg_rt_ms_excl_timeout,
  ROUND(AVG(review_ms), 0)                                         AS avg_review_ms,
  MIN(rt_ms)                                                        AS min_rt_ms,
  MAX(rt_ms)                                                        AS max_rt_ms
FROM trials
WHERE correct IS NOT NULL
  AND reattempt = 0
GROUP BY participant_id, study_id, condition, session_id, skill, anchor, phase;

-- Session-level summary (useful for detecting spacing vs massed effect)
CREATE VIEW IF NOT EXISTS v_session_summary AS
SELECT
  participant_id,
  study_id,
  condition,
  session_id,
  COUNT(*)                                                          AS n_trials,
  SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END)                     AS n_correct,
  ROUND(100.0 * SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END)
        / COUNT(*), 1)                                             AS pct_correct,
  SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END)                   AS n_timed_out,
  ROUND(100.0 * SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END)
        / COUNT(*), 1)                                             AS pct_timed_out,
  ROUND(AVG(rt_ms), 0)                                             AS avg_rt_ms,
  ROUND(AVG(review_ms), 0)                                         AS avg_review_ms,
  MIN(started_at)                                                   AS started_at,
  MAX(completed_at)                                                 AS completed_at
FROM trials
WHERE correct IS NOT NULL
  AND reattempt = 0
GROUP BY participant_id, study_id, condition, session_id;

-- Cross-session learning curve per anchor (key measure for spacing effect)
CREATE VIEW IF NOT EXISTS v_anchor_learning_curve AS
SELECT
  participant_id,
  condition,
  anchor,
  skill,
  session_id,
  SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS n_correct,
  COUNT(*)                                       AS n_trials,
  SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END) AS n_timed_out,
  ROUND(AVG(rt_ms), 0)                           AS avg_rt_ms,
  ROUND(AVG(CASE WHEN timed_out = 0 THEN rt_ms END), 0) AS avg_rt_ms_excl_timeout
FROM trials
WHERE phase = 'first_pass'
  AND reattempt = 0
GROUP BY participant_id, condition, anchor, skill, session_id
ORDER BY participant_id, skill, session_id;

-- Sensitivity view: accuracy and RT with and without timed-out trials,
-- alongside the timed-out count and rate
CREATE VIEW IF NOT EXISTS v_timed_out_sensitivity AS
SELECT
  participant_id,
  condition,
  session_id,
  -- All trials
  COUNT(*)                                                          AS n_all,
  ROUND(100.0 * SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END)
        / COUNT(*), 1)                                             AS pct_correct_all,
  ROUND(AVG(rt_ms), 0)                                             AS avg_rt_all,
  -- Excluding timed-out
  SUM(CASE WHEN timed_out = 0 THEN 1 ELSE 0 END)                   AS n_excl_timeout,
  ROUND(100.0 * SUM(CASE WHEN timed_out = 0 AND correct = 1 THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN timed_out = 0 THEN 1 ELSE 0 END), 0), 1) AS pct_correct_excl,
  ROUND(AVG(CASE WHEN timed_out = 0 THEN rt_ms END), 0)            AS avg_rt_excl,
  -- Timed-out count and rate
  SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END)                   AS n_timed_out,
  ROUND(100.0 * SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END)
        / COUNT(*), 1)                                             AS pct_timed_out
FROM trials
WHERE reattempt = 0
  AND phase = 'first_pass'
GROUP BY participant_id, condition, session_id
ORDER BY participant_id, session_id;

-- ── Posttest analysis views ───────────────────────────────

-- Per-participant per-task_type accuracy/timing for the two posttests.
-- session_id 5 = online T1 posttest, session_id 6 = in-person T2 posttest.
-- session_context comes from the sessions table (online vs in_person).
CREATE VIEW IF NOT EXISTS v_posttest_accuracy AS
SELECT
  t.participant_id,
  t.condition,
  s.session_context,
  t.session_id,
  t.task_type,
  COUNT(*)                                                          AS n_trials,
  SUM(CASE WHEN t.correct = 1 THEN 1 ELSE 0 END)                   AS n_correct,
  ROUND(100.0 * SUM(CASE WHEN t.correct = 1 THEN 1 ELSE 0 END)
        / COUNT(*), 1)                                             AS pct_correct,
  ROUND(AVG(t.rt_ms), 0)                                            AS avg_rt_ms,
  ROUND(AVG(CASE WHEN t.timed_out = 0 THEN t.rt_ms END), 0)         AS avg_rt_ms_excl_timeout
FROM trials t
LEFT JOIN sessions s
  ON s.participant_id = t.participant_id
 AND s.session_id     = t.session_id
WHERE t.session_id IN (5, 6)
  AND t.reattempt = 0
  AND t.correct IS NOT NULL
GROUP BY t.participant_id, t.condition, s.session_context, t.session_id, t.task_type;

-- Transfer gain per participant per task_type.
-- pretest (-1) is the baseline; gain_t1/gain_t2 are signed point differences vs pretest.
-- Participants missing any of the three sessions get NULLs in the corresponding columns.
CREATE VIEW IF NOT EXISTS v_transfer_gain AS
WITH agg AS (
  SELECT
    participant_id,
    condition,
    task_type,
    ROUND(100.0 * SUM(CASE WHEN session_id = -1 AND correct = 1 THEN 1 ELSE 0 END)
          / NULLIF(SUM(CASE WHEN session_id = -1 THEN 1 ELSE 0 END), 0), 1) AS pretest_accuracy,
    ROUND(100.0 * SUM(CASE WHEN session_id =  5 AND correct = 1 THEN 1 ELSE 0 END)
          / NULLIF(SUM(CASE WHEN session_id =  5 THEN 1 ELSE 0 END), 0), 1) AS posttest_t1_accuracy,
    ROUND(100.0 * SUM(CASE WHEN session_id =  6 AND correct = 1 THEN 1 ELSE 0 END)
          / NULLIF(SUM(CASE WHEN session_id =  6 THEN 1 ELSE 0 END), 0), 1) AS posttest_t2_accuracy
  FROM trials
  WHERE session_id IN (-1, 5, 6)
    AND reattempt = 0
    AND correct IS NOT NULL
  GROUP BY participant_id, condition, task_type
)
SELECT
  participant_id,
  condition,
  task_type,
  pretest_accuracy,
  posttest_t1_accuracy,
  posttest_t2_accuracy,
  ROUND(posttest_t1_accuracy - pretest_accuracy, 1) AS gain_t1,
  ROUND(posttest_t2_accuracy - pretest_accuracy, 1) AS gain_t2
FROM agg;

-- Coefficient of variation for RT during the in-person T2 retrieval trials.
-- Higher CV = more variable response times (a fatigue / engagement proxy).
-- stddev uses the population variance formula: sqrt(E[X^2] - E[X]^2).
CREATE VIEW IF NOT EXISTS v_cv_rt AS
SELECT
  participant_id,
  condition,
  COUNT(*)                                                          AS n_trials,
  ROUND(AVG(rt_ms), 0)                                              AS avg_rt_ms,
  ROUND(SQRT(AVG(rt_ms * rt_ms) - AVG(rt_ms) * AVG(rt_ms)), 1)      AS stddev_rt_ms,
  ROUND(SQRT(AVG(rt_ms * rt_ms) - AVG(rt_ms) * AVG(rt_ms))
        / NULLIF(AVG(rt_ms), 0), 3)                                  AS cv_rt
FROM trials
WHERE session_id = 6
  AND task_type  = 'retrieval'
  AND reattempt  = 0
  AND rt_ms IS NOT NULL
GROUP BY participant_id, condition;
