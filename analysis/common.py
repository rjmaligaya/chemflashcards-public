"""
common.py  --  Shared loader, configuration, and helpers for the ChemFlashcards
               (v2, within-subjects) results analysis scripts.

WHY THIS FILE EXISTS
--------------------
Every 4.2.x analysis script needs the same three things:
  1. To READ a participant-data export (either the multi-sheet .xlsx workbook
     produced by /api/v2/export-all, OR a folder of the per-table CSVs).
  2. To LABEL each trial as spaced vs massed (schedule) and Q-full vs Q-blank
     (format), using the participant's counterbalance option.
  3. To apply the same pre-specified EXCLUSION / FLAGGING policy so every
     subsection reports on the same analysis sample.

Putting that shared logic here means the six numbered scripts stay short and
every one of them makes the *same* decisions. If a study rule changes (the ISI
window, the mastery soft-cap, which participants count), you change it ONCE,
here, in the CONFIG block below.

PRIVACY / LOCAL-ONLY
--------------------
These scripts only ever read the file path you hand them and write result
tables/plots next to it. Nothing is uploaded anywhere. They run entirely on
your machine with standard open-source Python packages (see requirements.txt).

INPUT SHAPES ACCEPTED
---------------------
  * A single .xlsx workbook with sheets:
        "Trials", "Ease ratings", "Predictions", "Forced choices"
    (this is exactly what the "export all" button produces).
  * A directory containing any of these CSV files (names matched loosely,
    case-insensitively):
        trials*.csv, familiarity*.csv (or ease*.csv),
        predictions*.csv, forced_choices*.csv
Both share the same column headers, so the analysis code downstream is identical.
"""

from __future__ import annotations

import os
import re
import sys
import glob
import unicodedata
import warnings
import pandas as pd
import numpy as np

# Console output includes a few non-ASCII characters (e.g. the minus sign in
# "spaced - massed"). On Windows the default console encoding (cp1252) raises
# UnicodeEncodeError on those, so switch stdout/stderr to UTF-8 up front. The
# guard keeps this harmless if the streams don't support reconfigure.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass

# ════════════════════════════════════════════════════════════════════════════
# CONFIG  --  every pre-specified study rule lives here. Edit these, not the
#            analysis scripts, if a design parameter changes.
# ════════════════════════════════════════════════════════════════════════════

# Inter-session interval gate for the SPACED sessions (routing-v2.js).
# Sessions unlock by completion, not calendar day; the next spaced session
# opens no sooner than MIN and the study treats beyond MAX as a late session.
MIN_ISI_HOURS = 20.0
MAX_ISI_HOURS = 28.0

# Mastery loop: an item is dropped ("soft-capped") after this many wrong
# attempts in one practice session (practice-engine.js decideTrialDisposition).
MAX_RETRIES = 5

# The 8 practice sub-sessions, in order. "Completed all practice" means a
# participant has a completed session row for every one of these labels.
SPACED_LABELS = ["spaced-S1", "spaced-S2", "spaced-S3", "spaced-S4"]
MASSED_LABELS = ["massed-B1", "massed-B2", "massed-B3", "massed-B4"]
PRACTICE_LABELS = SPACED_LABELS + MASSED_LABELS

# Session label / phase used for the ~1-week delayed posttest.
DELAYED_LABEL = "delayed"
DELAYED_PHASE = "delayed"

# Counterbalance: which practice group is the SPACED one for each option.
#   option1 -> C-1 spaced, C-2 massed
#   option2 -> C-2 spaced, C-1 massed
OPTION_TO_SPACED_GROUP = {"option1": "C-1", "option2": "C-2"}

# Forced-choice participant-facing labels are fixed so Set A == spaced group and
# Set B == massed group, regardless of whether spaced is C-1 or C-2 for that
# participant (schema_v2.sql, forced_choices_v2 comment).
FORCED_CHOICE_TO_SCHEDULE = {"set_a": "spaced", "set_b": "massed", "same": "same"}

# ---- Analysis-sample policy --------------------------------------------------
# Flags that decide which participants enter the analysis sample:
EXCLUDE_DEV_MODE       = True   # always drop dev/test IDs (dev_mode == 1)
KEEP_ONLY_COMPLETERS   = True   # keep only participants who did all 8 practice blocks
EXCLUDE_MISSING_DELAYED = False  # do NOT drop for a missing delayed test (assume completers did it)
FLAG_ISI_VIOLATIONS    = True   # flag out-of-window spaced ISIs, but KEEP the participant
# Baseline-ceiling exclusion is not applied.

# How to treat a trial whose `correct` value is missing (NULL). In the live app
# a timeout is still scored 1/0, so a NULL should be rare and means genuinely
# missing data. For the delayed TEST we score a non-response as incorrect (0);
# for practice metrics we drop it. Both are surfaced with a warning + count.
DELAYED_MISSING_CORRECT_AS_INCORRECT = True

# ---- Delayed-test PRIMARY scoring rule ---------------------------------------
# Selects the scoring rule applied to Q-full (full-name) delayed items.
# "strict" re-scores raw_answer against the exact IUPAC form, including hyphens
# and locants; "lenient" uses the stored instrument score. Q-blank items always
# use the stored lenient score and are unaffected by this flag.
QFULL_PRIMARY_RULE = "strict"

# ---- Baseline questionnaire (4.2.vi) ----------------------------------------
# Prior knowledge comes from the paper questionnaire, which is NOT in the app
# export, so 4.2.vi reads it from a CSV supplied with --baseline. The relevant
# items:
#   Q10 = "provide the IUPAC name of the chemical shown" -> could they name it?
#         This is the PRIMARY prior-knowledge item: 1 = named correctly, 0 = not.
#   Q9  = self-rated IUPAC familiarity, 5-point ordinal -> SECONDARY measure.
# The paper responses get transcribed into one row per participant. See
# analysis/baseline_template.csv (layout) and baseline_codebook.md (coding).
# Adjust these column names if your transcription uses different headers.
BASELINE_PID_COL         = "pid"                  # must match the app-export pids
BASELINE_SCORE_COL       = "q10_named_correct"    # primary: 1/0 could name the molecule
BASELINE_FAMILIARITY_COL = "q9_iupac_familiarity" # secondary ordinal (0-4 or label); "" to skip
# If instead you record Q10 as a per-participant yes/no flag under another name,
# point BASELINE_NAMED_COL at it and it will be coerced to 1/0.
BASELINE_NAMED_COL  = None
BASELINE_NAMED_TRUE = ("1", "yes", "y", "true", "correct")
# Demographic columns summarised for baseline characterisation (skipped if absent).
BASELINE_DEMOGRAPHIC_COLS = ["q1_language", "q3_age", "q4_affiliation",
                             "q7_last_chem_course"]


# ════════════════════════════════════════════════════════════════════════════
# LOADING
# ════════════════════════════════════════════════════════════════════════════

# Loose, case-insensitive matching so the loader tolerates small naming drift in
# future exports (e.g. "Trials" vs "trials", "Ease ratings" vs "Familiarity").
_SHEET_ALIASES = {
    "trials":         ["trial"],
    "familiarity":    ["ease", "familiar"],
    "predictions":    ["prediction", "predict"],
    "forced_choices": ["forced", "choice"],
}

# Columns we expect to be numeric in each table (everything else stays string).
_NUMERIC_COLS = {
    "trials": ["dev_mode", "session_id", "trial_id", "correct", "rt_ms",
               "review_ms", "trial_order", "timed_out", "retry_attempt",
               "soft_capped", "confidence"],
    "familiarity":    ["value"],
    "predictions":    ["value"],
    "forced_choices": ["confidence"],
}

# Columns we parse as datetimes where present.
_DATETIME_COLS = {
    "trials": ["enrollment_date", "session_started_at", "session_completed_at",
               "stim_on_ts", "stim_off_ts", "trial_created_at"],
    "familiarity":    ["created_at"],
    "predictions":    ["created_at"],
    "forced_choices": ["created_at"],
}


def _match_key(name: str) -> str | None:
    """Map a sheet/file name to one of the four canonical table keys."""
    low = name.lower()
    for key, aliases in _SHEET_ALIASES.items():
        if key in low or any(a in low for a in aliases):
            return key
    # The bulk trials export is named 'chemflashcards_all_<date>.csv' with no
    # table token (worker.mjs handleV2ExportAll), whereas the metacog bulk files
    # always carry their table name and are matched above. So an "all" file that
    # matched nothing else is the trials export.
    if "all" in low:
        return "trials"
    return None


def _coerce_types(df: pd.DataFrame, key: str) -> pd.DataFrame:
    """Make numeric columns numeric and datetime columns datetimes, leniently."""
    for col in _NUMERIC_COLS.get(key, []):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in _DATETIME_COLS.get(key, []):
        if col in df.columns:
            # Parses every timestamp as UTC and then drops the timezone, so
            # aware ("Z"-suffixed) and naive values arrive downstream as one
            # consistent naive-UTC dtype. Analyses use time differences (gaps,
            # recency, durations) only.
            ts = pd.to_datetime(df[col], errors="coerce", utc=True)
            df[col] = ts.dt.tz_localize(None)
    return df


def load_export(path: str) -> dict[str, pd.DataFrame]:
    """
    Load a participant-data export into a dict of DataFrames keyed by
    'trials', 'familiarity', 'predictions', 'forced_choices'.

    `path` may be an .xlsx workbook or a directory of per-table CSVs. Any table
    not present comes back as an empty DataFrame so callers can check .empty
    rather than handling KeyErrors.
    """
    tables: dict[str, pd.DataFrame] = {k: pd.DataFrame() for k in _SHEET_ALIASES}

    if os.path.isdir(path):
        for csv_path in glob.glob(os.path.join(path, "*.csv")):
            key = _match_key(os.path.basename(csv_path))
            if key is None:
                continue
            df = pd.read_csv(csv_path, dtype=str, keep_default_na=False,
                             na_values=[""])
            tables[key] = _coerce_types(df, key)
    elif path.lower().endswith((".xlsx", ".xlsm")):
        book = pd.read_excel(path, sheet_name=None, dtype=str)
        for sheet_name, df in book.items():
            key = _match_key(sheet_name)
            if key is None:
                continue
            # pandas may read blank cells as NaN already; normalise empties.
            df = df.where(df.notna(), None)
            tables[key] = _coerce_types(df, key)
    else:
        raise ValueError(
            f"Don't know how to read {path!r}. Pass either the export .xlsx "
            f"workbook or a directory containing the per-table .csv files."
        )

    if tables["trials"].empty:
        warnings.warn(
            "No 'Trials' data found in the export. The trial-level analyses "
            "(4.2.i / 4.2.ii / 4.2.iii) need it.")
    return tables


# ════════════════════════════════════════════════════════════════════════════
# LABELLING  --  schedule (spaced/massed) and format (blank/full)
# ════════════════════════════════════════════════════════════════════════════

def spaced_group_for(option_id: str) -> str | float:
    """Return 'C-1' or 'C-2' -- whichever group is the SPACED one for this option."""
    return OPTION_TO_SPACED_GROUP.get(str(option_id), np.nan)


def add_schedule_and_format(trials: pd.DataFrame) -> pd.DataFrame:
    """
    Add two analysis columns to a copy of `trials`:
      * schedule : 'spaced' | 'massed'  (from option_id x group_id)
      * fmt      : 'blank'  | 'full'    (from qtype: Q-blank / Q-full)
    Rows whose option_id/group_id can't be resolved get NaN schedule and a warning.
    """
    df = trials.copy()

    # schedule: spaced if the trial's group is this participant's spaced group.
    # Build as an object Series so we can mix string labels with NaN (numpy 2.x
    # refuses to put NaN into a string array via np.where).
    spaced_grp = df["option_id"].map(spaced_group_for)
    sched = pd.Series(np.where(df["group_id"] == spaced_grp, "spaced", "massed"),
                      index=df.index, dtype=object)
    unresolved_mask = df["group_id"].isna() | spaced_grp.isna()
    sched[unresolved_mask] = np.nan
    df["schedule"] = sched
    if unresolved_mask.any():
        warnings.warn(f"{int(unresolved_mask.sum())} trial(s) could not be "
                      f"labelled spaced/massed (missing option_id or group_id).")

    # fmt: 'blank' / 'full' from the qtype string (Q-blank / Q-full).
    qtype = df.get("qtype", pd.Series(index=df.index, dtype=object)).astype(str)
    fmt = pd.Series(np.nan, index=df.index, dtype=object)
    fmt[qtype.str.lower().str.contains("blank")] = "blank"
    fmt[qtype.str.lower().str.contains("full")] = "full"
    df["fmt"] = fmt

    return df


# ════════════════════════════════════════════════════════════════════════════
# COMPLETION, ISI, AND THE ANALYSIS-SAMPLE MANIFEST
# ════════════════════════════════════════════════════════════════════════════

def _completed_labels_by_pid(trials: pd.DataFrame) -> dict[str, set]:
    """For each pid, the set of session_labels that have a completion timestamp."""
    out: dict[str, set] = {}
    if "session_completed_at" in trials.columns:
        done = trials[trials["session_completed_at"].notna()]
    else:
        done = trials
    for pid, grp in done.groupby("pid"):
        out[pid] = set(grp["session_label"].dropna().unique())
    return out


def practice_completers(trials: pd.DataFrame) -> set:
    """pids that have a completed session for all 8 practice labels."""
    by_pid = _completed_labels_by_pid(trials)
    need = set(PRACTICE_LABELS)
    return {pid for pid, labels in by_pid.items() if need.issubset(labels)}


def isi_report(trials: pd.DataFrame) -> pd.DataFrame:
    """
    Per participant, the inter-session gaps between consecutive SPACED sessions
    and whether any fell outside [MIN_ISI_HOURS, MAX_ISI_HOURS].

    Gap = (start of next spaced session) - (completion of previous spaced session),
    which is exactly the interval the app's unlock gate governs.

    Returns one row per pid: pid, min_gap_h, max_gap_h, n_gaps,
    isi_violation (bool), detail (str).
    """
    rows = []
    for pid, grp in trials.groupby("pid"):
        # one representative start/complete time per spaced session label
        starts, completes = {}, {}
        for label in SPACED_LABELS:
            sub = grp[grp["session_label"] == label]
            if sub.empty:
                continue
            s = sub["session_started_at"].dropna()
            c = sub["session_completed_at"].dropna()
            if not s.empty:
                starts[label] = s.min()
            if not c.empty:
                completes[label] = c.max()

        gaps = []
        for prev, nxt in zip(SPACED_LABELS[:-1], SPACED_LABELS[1:]):
            if prev in completes and nxt in starts:
                hrs = (starts[nxt] - completes[prev]).total_seconds() / 3600.0
                gaps.append((f"{prev}->{nxt}", hrs))

        if not gaps:
            rows.append(dict(pid=pid, min_gap_h=np.nan, max_gap_h=np.nan,
                             n_gaps=0, isi_violation=False,
                             detail="no spaced-session timing available"))
            continue

        hrs_vals = [h for _, h in gaps]
        viol = [f"{name}={h:.1f}h" for name, h in gaps
                if h < MIN_ISI_HOURS or h > MAX_ISI_HOURS]
        rows.append(dict(
            pid=pid, min_gap_h=min(hrs_vals), max_gap_h=max(hrs_vals),
            n_gaps=len(gaps), isi_violation=bool(viol),
            detail="; ".join(viol) if viol else "within window"))
    return pd.DataFrame(rows)


def build_sample_manifest(trials: pd.DataFrame) -> pd.DataFrame:
    """
    One row per participant describing how the analysis-sample policy treats
    them: dev flag, practice completion, delayed-test presence, ISI violation
    flag, and the final `included` decision.
    """
    pids = sorted(trials["pid"].dropna().unique())
    dev = (trials.groupby("pid")["dev_mode"].max() if "dev_mode" in trials
           else pd.Series(dtype=float))
    completers = practice_completers(trials)
    has_delayed = set(
        trials.loc[trials["session_label"] == DELAYED_LABEL, "pid"].unique())
    isi = isi_report(trials).set_index("pid")

    rows = []
    for pid in pids:
        is_dev = bool(dev.get(pid, 0) == 1) if len(dev) else False
        completed = pid in completers
        delayed = pid in has_delayed
        isi_viol = bool(isi["isi_violation"].get(pid, False)) if not isi.empty else False

        included = True
        reasons = []
        if EXCLUDE_DEV_MODE and is_dev:
            included = False; reasons.append("dev_mode")
        if KEEP_ONLY_COMPLETERS and not completed:
            included = False; reasons.append("incomplete_practice")
        if EXCLUDE_MISSING_DELAYED and not delayed:
            included = False; reasons.append("missing_delayed")

        rows.append(dict(
            pid=pid, dev_mode=is_dev, completed_practice=completed,
            has_delayed=delayed, isi_violation=isi_viol,
            isi_detail=(isi["detail"].get(pid, "") if not isi.empty else ""),
            included=included,
            excluded_reason=("" if included else ",".join(reasons))))
    return pd.DataFrame(rows)


def analysis_pids(trials: pd.DataFrame) -> list[str]:
    """The list of pids that survive the pre-specified inclusion policy."""
    man = build_sample_manifest(trials)
    return man.loc[man["included"], "pid"].tolist()


def filter_to_analysis_sample(trials: pd.DataFrame,
                              extra_tables: dict[str, pd.DataFrame] | None = None
                              ) -> tuple[pd.DataFrame, dict, pd.DataFrame]:
    """
    Apply the inclusion policy and return
        (trials_kept, extra_tables_kept, manifest).
    ISI violators are KEPT (only flagged) per the current policy.
    """
    manifest = build_sample_manifest(trials)
    keep = set(manifest.loc[manifest["included"], "pid"])
    tk = trials[trials["pid"].isin(keep)].copy()
    ek = {}
    if extra_tables:
        for name, df in extra_tables.items():
            ek[name] = (df[df["pid"].isin(keep)].copy()
                        if not df.empty and "pid" in df.columns else df)
    return tk, ek, manifest


# ════════════════════════════════════════════════════════════════════════════
# DELAYED-TEST SCORING  (shared by 4.2.i and 4.2.iii)
# ════════════════════════════════════════════════════════════════════════════

def delayed_trials(trials: pd.DataFrame) -> pd.DataFrame:
    """Delayed-posttest trials only, with schedule + fmt labels and a clean
    numeric `correct` (0/1) applying the missing-value policy."""
    d = trials[(trials.get("phase") == DELAYED_PHASE) |
               (trials["session_label"] == DELAYED_LABEL)].copy()
    d = add_schedule_and_format(d)

    missing = d["correct"].isna().sum()
    if missing:
        if DELAYED_MISSING_CORRECT_AS_INCORRECT:
            warnings.warn(f"{missing} delayed trial(s) had missing `correct`; "
                          f"scored as incorrect (0).")
            d["correct"] = d["correct"].fillna(0)
        else:
            warnings.warn(f"{missing} delayed trial(s) had missing `correct`; "
                          f"dropped.")
            d = d[d["correct"].notna()]
    d["correct"] = d["correct"].astype(float)
    return d


def delayed_cell_means(trials: pd.DataFrame) -> pd.DataFrame:
    """
    Per-participant mean delayed accuracy in each schedule x format cell.
    Returns long form: pid, schedule, fmt, acc, n_items.
    """
    d = delayed_trials(trials)
    g = (d.groupby(["pid", "schedule", "fmt"])["correct"]
           .agg(acc="mean", n_items="size").reset_index())
    return g


def delayed_collapsed(trials: pd.DataFrame) -> pd.DataFrame:
    """
    Per-participant mean delayed accuracy by schedule, collapsed over format,
    plus the spaced-minus-massed advantage. Returns a wide frame:
    pid, spaced, massed, advantage.
    """
    d = delayed_trials(trials)
    by = (d.groupby(["pid", "schedule"])["correct"].mean()
            .unstack("schedule"))
    for col in ("spaced", "massed"):
        if col not in by.columns:
            by[col] = np.nan
    by = by.reset_index()
    by["advantage"] = by["spaced"] - by["massed"]
    return by[["pid", "spaced", "massed", "advantage"]]


# ── DELAYED-TEST REACTION TIME (H4 automaticity, behavioural half) ───────────

def delayed_rt_cells(trials: pd.DataFrame, retention_only: bool = True,
                     correct_only: bool = True,
                     fmt: str | None = None) -> pd.DataFrame:
    """
    Per-participant median retrieval latency (rt_ms) at the DELAYED test, by
    schedule. This is the response-time half of H4 -- spaced items answered
    faster than massed at the delayed test -- as distinct from the practice-phase
    RT curves (4.2.ii), which serve H2 acquisition.

    Timed-out trials are excluded (their rt_ms is censored at the 20 s ceiling).
    Defaults follow the automaticity convention: retention (Q-blank) items only,
    correct responses only (a fast wrong answer is not automaticity). `fmt`
    optionally restricts to one question format ('blank' or
    'full') when retention_only is False -- used for the Q-full RT companion.
    Returns wide: pid, spaced, massed, rt_diff (spaced - massed;
    negative = spaced faster, the H4 direction).
    """
    d = delayed_trials(trials)
    mask = d["rt_ms"].notna()
    if "timed_out" in d.columns:
        mask &= (d["timed_out"] != 1)
    if correct_only:
        mask &= (d["correct"] == 1)
    if retention_only:
        mask &= (d["fmt"] == "blank")
    if fmt is not None:
        mask &= (d["fmt"] == fmt)
    d = d[mask]
    by = d.groupby(["pid", "schedule"])["rt_ms"].median().unstack("schedule")
    for col in ("spaced", "massed"):
        if col not in by.columns:
            by[col] = np.nan
    by = by.reset_index()
    by["rt_diff"] = by["spaced"] - by["massed"]
    return by[["pid", "spaced", "massed", "rt_diff"]]


# ── STRICT vs LENIENT DELAYED-TEST SCORING ───────────────────────────────────

def _norm_strict(s) -> str:
    """Strict normalization for the delayed-test 'strict' scoring: lowercase,
    collapse internal whitespace, and trim -- but KEEP hyphens and locants, so a
    difference in hyphenation or number formatting counts as wrong. Contrast with
    the instrument's lenient rule (normalizeAnswer in practice-engine.js), which
    also strips hyphens and spaces."""
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    return re.sub(r"\s+", " ", str(s).strip().lower())


def norm_lenient(s) -> str:
    """The instrument's LENIENT normalization, replicated EXACTLY from
    normalizeAnswer in practice-engine.js: lowercase -> unicode NFKC ->
    hyphens/underscores become spaces -> collapse whitespace -> trim. An empty
    result means "no scorable answer" (scored wrong by the app). This is the
    single shared implementation; the timeout audit and any lenient re-scoring
    import it from here so the rule can never drift between scripts."""
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    s = unicodedata.normalize("NFKC", str(s).lower())
    s = re.sub(r"[-_]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def delayed_strict_cells(trials: pd.DataFrame) -> pd.DataFrame:
    """
    Per-participant delayed accuracy under a STRICT re-scoring of the stored
    raw_answer -- the exact IUPAC form is required (hyphenation, locants) -- by
    schedule x format. This is the companion to the instrument's lenient stored
    `correct`, so the delayed test can be reported under both scoring rules.
    Returns long: pid, schedule, fmt, acc_strict, n_items. Needs raw_answer,
    qtype, feature, full_name (all in the export).
    """
    d = delayed_trials(trials).copy()
    if "raw_answer" not in d.columns:
        warnings.warn("No raw_answer column; strict delayed scoring skipped.")
        return pd.DataFrame(columns=["pid", "schedule", "fmt", "acc_strict", "n_items"])
    is_full = d["qtype"].astype(str).str.contains("full", case=False)
    target = np.where(is_full, d.get("full_name"), d.get("feature"))
    raw = d["raw_answer"].tolist()
    d["correct_strict"] = [
        1.0 if (_norm_strict(r) != "" and _norm_strict(r) == _norm_strict(t)) else 0.0
        for r, t in zip(raw, target)]
    return (d.groupby(["pid", "schedule", "fmt"])["correct_strict"]
             .agg(acc_strict="mean", n_items="size").reset_index())


# ── PRIMARY (composite) DELAYED SCORING ──────────────────────────────────────

def delayed_primary_cells(trials: pd.DataFrame) -> pd.DataFrame:
    """
    Per-participant delayed accuracy by schedule x format under the PRIMARY
    composite scoring rule:
      * Q-blank rows ALWAYS use the stored lenient `correct`.
      * Q-full rows use the STRICT re-scoring from raw_answer iff
        QFULL_PRIMARY_RULE == "strict", else the stored lenient `correct`.
    Returns long form like delayed_cell_means: pid, schedule, fmt, acc, n_items.
    """
    d = delayed_trials(trials).copy()
    d["correct_primary"] = d["correct"]

    if QFULL_PRIMARY_RULE == "strict":
        if "raw_answer" not in d.columns:
            warnings.warn("QFULL_PRIMARY_RULE='strict' but no raw_answer column; "
                          "primary scoring falls back to the stored (lenient) "
                          "correct for Q-full items.")
        else:
            is_full = d["fmt"] == "full"
            target = d.get("full_name", pd.Series(index=d.index, dtype=object))
            strict = pd.Series(
                [1.0 if (_norm_strict(r) != "" and
                         _norm_strict(r) == _norm_strict(t)) else 0.0
                 for r, t in zip(d["raw_answer"], target)],
                index=d.index)
            d.loc[is_full, "correct_primary"] = strict[is_full]

    return (d.groupby(["pid", "schedule", "fmt"])["correct_primary"]
             .agg(acc="mean", n_items="size").reset_index())


def scoring_flip_counts(trials: pd.DataFrame) -> pd.DataFrame:
    """
    Per question type, how many DELAYED trials flip correctness between the
    lenient (stored) rule and the strict re-score from raw_answer. Strict can
    only be stricter (it demands the exact form), so flips should only appear in
    the lenient-only column -- but both directions are counted defensively so a
    strict-only flip would surface as a data-integrity red flag rather than
    vanish. Columns: qtype, n_trials, n_lenient_correct, n_strict_correct,
    n_flips_lenient_only, n_flips_strict_only.
    """
    d = delayed_trials(trials).copy()
    if "raw_answer" not in d.columns:
        warnings.warn("No raw_answer column; scoring flip counts skipped.")
        return pd.DataFrame(columns=["qtype", "n_trials", "n_lenient_correct",
                                     "n_strict_correct", "n_flips_lenient_only",
                                     "n_flips_strict_only"])
    is_full = d["qtype"].astype(str).str.contains("full", case=False)
    target = np.where(is_full, d.get("full_name"), d.get("feature"))
    d["strict"] = [
        1.0 if (_norm_strict(r) != "" and _norm_strict(r) == _norm_strict(t)) else 0.0
        for r, t in zip(d["raw_answer"], target)]
    d["lenient"] = d["correct"]  # the stored, policy-cleaned instrument score

    rows = []
    for qtype, g in d.groupby("qtype"):
        rows.append(dict(
            qtype=qtype, n_trials=len(g),
            n_lenient_correct=int((g["lenient"] == 1).sum()),
            n_strict_correct=int((g["strict"] == 1).sum()),
            n_flips_lenient_only=int(((g["lenient"] == 1) & (g["strict"] == 0)).sum()),
            n_flips_strict_only=int(((g["strict"] == 1) & (g["lenient"] == 0)).sum())))
    return pd.DataFrame(rows)


# ── LAST-PRACTICE RECENCY ────────────────────────────────────────────────────

def last_practice_recency(trials: pd.DataFrame
                          ) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    For each delayed trial: hours between that trial's stimulus onset and the
    participant's LAST practice occurrence of the same item.

    Delayed item_ids are the practice item_id plus a "-full"/"-blank" suffix
    (e.g. "C1-S2-amide-full" practises "C1-S2-amide"), so stripping the suffix
    links each test item back to its practice history. The last practice
    occurrence is the max stimulus-offset over that participant's practice
    trials with that item_id, ANY retry attempt. Timestamps are coalesced
    (stim_off_ts, then trial_created_at, then session_completed_at; the delayed
    side uses stim_on_ts, then trial_created_at, then session_started_at) so a
    missing per-trial timestamp degrades to the session-level one instead of
    crashing; rows with no usable timestamp at all get NaN plus a warning.

    Returns (per_trial, summary):
      per_trial: pid, item_id, schedule, fmt, recency_h
      summary:   schedule, fmt, mean_h, median_h, min_h, max_h, n
    """
    empty_trial = pd.DataFrame(columns=["pid", "item_id", "schedule", "fmt",
                                        "recency_h"])
    empty_summ = pd.DataFrame(columns=["schedule", "fmt", "mean_h", "median_h",
                                       "min_h", "max_h", "n"])

    d = delayed_trials(trials).copy()
    if d.empty:
        return empty_trial, empty_summ

    def _coalesce(df: pd.DataFrame, cols: list[str]) -> pd.Series:
        """First non-missing timestamp across `cols`, per row."""
        out = pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns]")
        for c in cols:
            if c in df.columns:
                out = out.fillna(pd.to_datetime(df[c], errors="coerce"))
        return out

    # delayed side: when this test trial was shown
    d["t_delayed"] = _coalesce(d, ["stim_on_ts", "trial_created_at",
                                   "session_started_at"])
    # link back to the practice item by stripping the -full/-blank suffix
    d["practice_item_id"] = (d["item_id"].astype(str)
                             .str.replace(r"-(full|blank)$", "", regex=True))

    # practice side: last time this participant saw this item (any retry)
    p = trials[trials["session_label"].isin(PRACTICE_LABELS)].copy()
    if p.empty:
        warnings.warn("No practice trials found; recency is NaN throughout.")
        last = pd.DataFrame(columns=["pid", "practice_item_id", "t_last"])
    else:
        p["t_prac"] = _coalesce(p, ["stim_off_ts", "trial_created_at",
                                    "session_completed_at"])
        last = (p.groupby(["pid", "item_id"])["t_prac"].max()
                 .rename("t_last").reset_index()
                 .rename(columns={"item_id": "practice_item_id"}))

    m = d.merge(last, on=["pid", "practice_item_id"], how="left")
    m["recency_h"] = (m["t_delayed"] - m["t_last"]).dt.total_seconds() / 3600.0

    n_missing = int(m["recency_h"].isna().sum())
    if n_missing:
        warnings.warn(f"{n_missing} delayed trial(s) have no computable "
                      f"last-practice recency (unmatched item_id or missing "
                      f"timestamps); left as NaN.")

    per_trial = m[["pid", "item_id", "schedule", "fmt", "recency_h"]].copy()
    summary = (m.groupby(["schedule", "fmt"])["recency_h"]
                .agg(mean_h="mean", median_h="median", min_h="min",
                     max_h="max", n="count").reset_index())
    return per_trial, summary


# ── HOLM-BONFERRONI STEP-DOWN  (familywise alpha control) ────────────────────

def holm_adjust(pdict: dict) -> dict:
    """
    Holm-Bonferroni step-down correction over a named family of p-values.
    Input {name: p_raw}; output {name: (p_raw, p_holm)}. NaN (or None) p-values
    are passed through with p_holm = NaN and do NOT count toward the family
    size, so an unavailable test can't inflate the correction on the others.
    Adjusted values are capped at 1 and forced monotone (a smaller raw p can
    never end up with a larger adjusted p than a bigger raw p), matching the
    standard step-down definition.
    """
    valid = [(name, float(p)) for name, p in pdict.items()
             if p is not None and not (isinstance(p, float) and np.isnan(p))]
    m = len(valid)
    adjusted: dict[str, float] = {}
    running_max = 0.0
    for rank, (name, p) in enumerate(sorted(valid, key=lambda kv: kv[1])):
        val = min(1.0, (m - rank) * p)
        running_max = max(running_max, val)  # enforce monotonicity
        adjusted[name] = running_max

    out = {}
    for name, p in pdict.items():
        out[name] = (p, adjusted.get(name, float("nan")))
    return out


# ════════════════════════════════════════════════════════════════════════════
# SMALL SHARED UTILITIES
# ════════════════════════════════════════════════════════════════════════════

# Creates the output directory if it does not exist and returns its path.
def ensure_outdir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def sem(x) -> float:
    """Standard error of the mean, NaN-safe, returns NaN for n<2."""
    x = pd.Series(x).dropna()
    n = len(x)
    return float(x.std(ddof=1) / np.sqrt(n)) if n > 1 else float("nan")


def get_matplotlib():
    """Import matplotlib with a non-interactive backend, or return None with a
    helpful message so a missing plotting library never crashes an analysis."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        return plt
    except Exception as exc:  # pragma: no cover
        warnings.warn(f"matplotlib unavailable ({exc}); skipping plots. "
                      f"Install it with:  pip install matplotlib")
        return None


# Prints a section title between two rules of equal-signs.
def banner(title: str) -> None:
    line = "=" * 78
    print(f"\n{line}\n{title}\n{line}")
