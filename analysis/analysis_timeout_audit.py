"""
Timeout audit  --  a standalone sweep of EVERY timed-out trial in an export
===========================================================================

WHAT THIS ANSWERS
-----------------
Of all trials that hit the 20-second answer window (timed_out == 1), in ANY
phase (practice or delayed test): what had the participant actually typed?
Three cases matter:
  * empty            -- a true non-response (nothing scorable typed);
  * non-empty CORRECT -- they knew it but didn't press submit in time;
  * non-empty wrong  -- a fragment or a wrong-track start.

The pre-specified calibration handling EXCLUDES timeouts, so this sweep counts
how many timed-out trials carried a correct answer. It runs on any export,
under BOTH scoring rules (the instrument's lenient rule and the strict
exact-form rule), because an answer can be lenient-correct but strict-wrong.

Scoring replicates the instrument exactly: common.norm_lenient is the same
lowercase -> NFKC -> hyphens/underscores-to-spaces -> collapse-whitespace ->
trim pipeline as normalizeAnswer in practice-engine.js; the target is `feature`
for Q-blank items and `full_name` for Q-full items; an empty answer is wrong.

As a free integrity check it also verifies that the STORED `correct` matches an
instrument-exact re-score of `raw_answer` on every scorable trial, and prints
every mismatch it finds.

ID-REMOVED EXPORTS: if the export has no pid column values at all (identifiers
stripped for privacy), participants are reconstructed as pseudo-ids from
enrollment_date + option_id, with sanity checks that the grouping is stable.
When real pids are present they are used as-is.

OUTPUTS (written to the --out folder)
  * timeout_audit_rows.csv     one row per timed-out trial: who/where/what was
                               typed, lenient + strict re-scores, case labels.
  * timeout_audit_summary.csv  counts by case (all / non-dev / analysis
                               sample), by phase, by schedule, + timeout rates.

RUN
    python analysis_timeout_audit.py --data path/to/export.xlsx
"""

from __future__ import annotations
import argparse
import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import numpy as np
import pandas as pd

ROW_COLS = ["pid", "dev_mode", "session_label", "phase", "schedule", "qtype",
            "retry_attempt", "item_id", "target", "raw_answer", "correct",
            "releni", "restrict", "case", "case_strict", "subcase", "rt_ms"]


def dl_distance(a: str, b: str) -> int:
    """Damerau-Levenshtein (optimal string alignment) distance -- how many
    single-character edits (or adjacent swaps) separate two strings. Used only
    to label near-miss timeouts descriptively."""
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    d = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(la + 1):
        d[i][0] = i
    for j in range(lb + 1):
        d[0][j] = j
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                          d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[la][lb]


def ensure_pids(t: pd.DataFrame) -> pd.DataFrame:
    """
    Use the real pid column when it carries values. Only when pid is ENTIRELY
    missing (an ID-removed export) rebuild pseudo-participants from
    enrollment_date + option_id -- enrollment_date is per-participant, and
    option_id double-checks the grouping. Sanity checks run BEFORE the
    grouping is trusted; a failure raises with a plain message rather than
    silently merging two people into one pseudo-id.
    """
    t = t.copy()
    if "pid" in t.columns and t["pid"].notna().any():
        n_missing = int(t["pid"].isna().sum())
        if n_missing:
            warnings.warn(f"{n_missing} trial row(s) have a blank pid; they are "
                          f"kept but cannot be attributed to a participant.")
        return t

    print("No pid values in this export (ID-removed); reconstructing "
          "pseudo-participants from enrollment_date + option_id.")
    if "enrollment_date" not in t.columns or t["enrollment_date"].isna().any():
        raise ValueError(
            "Cannot build pseudo-participants: enrollment_date is missing or "
            "has blank values, so rows can't be grouped reliably. Re-export "
            "with pids or with complete enrollment dates.")
    key = (t["enrollment_date"].astype(str) + "|" + t["option_id"].astype(str))
    codes, _uniques = pd.factorize(key, sort=True)
    t["pid"] = ["P%02d" % (c + 1) for c in codes]

    # each pseudo-participant must have exactly one option_id and dev_mode
    chk = t.groupby("pid").agg(n_opt=("option_id", "nunique"),
                               n_dev=("dev_mode", "nunique"))
    if not ((chk["n_opt"] == 1).all() and (chk["n_dev"] == 1).all()):
        raise ValueError("Pseudo-participant grouping is unstable (a pseudo-id "
                         "spans multiple option_id/dev_mode values).")
    # and one session_id per (pid, session_label) -- two real people who share
    # an enrollment_date + option would collide here and be caught
    if "session_id" in t.columns:
        n_sess = t.groupby(["pid", "session_label"])["session_id"].nunique()
        if (n_sess > 1).any():
            raise ValueError(
                "Pseudo-participant grouping merged two people: some "
                "(pid, session_label) maps to more than one session_id. "
                "Re-export with pids to run this audit.")
    print(f"  {t['pid'].nunique()} pseudo-participant(s) reconstructed; "
          f"grouping sanity checks passed.")
    return t


# Runs the timeout sweep over an export and writes the row listing and summary.
def main() -> None:
    ap = argparse.ArgumentParser(description="timeout audit (all phases)")
    ap.add_argument("--data", required=True,
                    help="export .xlsx workbook OR folder of per-table CSVs")
    ap.add_argument("--out", default=None, help="output folder for tables")
    args = ap.parse_args()

    out = common.ensure_outdir(
        args.out or os.path.join(
            args.data if os.path.isdir(args.data) else os.path.dirname(args.data)
            or ".", "results_4_2"))

    tables = common.load_export(args.data)
    t = tables["trials"].copy()

    common.banner("Timeout audit -- every timed-out trial, any phase")
    if t.empty:
        print("No trials in the export; nothing to audit.")
        return

    t = ensure_pids(t)
    t = common.add_schedule_and_format(t)

    # ── re-score every trial under both rules ────────────────────────────────
    is_full = t["qtype"].astype(str).str.contains("full", case=False)
    t["target"] = np.where(is_full, t.get("full_name"), t.get("feature"))
    t["releni"] = [1 if (common.norm_lenient(r) != "" and
                         common.norm_lenient(r) == common.norm_lenient(x)) else 0
                   for r, x in zip(t["raw_answer"], t["target"])]
    t["restrict"] = [1 if (common._norm_strict(r) != "" and
                           common._norm_strict(r) == common._norm_strict(x)) else 0
                     for r, x in zip(t["raw_answer"], t["target"])]

    # integrity check: stored `correct` vs the instrument-exact re-score.
    # NULL `correct` rows are masked out BEFORE the int comparison, because
    # .astype(int) on a NaN raises.
    has_corr = t["correct"].notna()
    stored = t.loc[has_corr, "correct"].astype(int)
    mism = t.loc[has_corr][stored != t.loc[has_corr, "releni"]]
    print(f"\nStored-vs-recomputed lenient check over all {len(t)} trial(s): "
          f"{len(mism)} mismatch(es), {int((~has_corr).sum())} NULL correct.")
    if len(mism):
        print("  MISMATCHES (investigate -- stored score does not reproduce "
              "from raw_answer):")
        print(mism[["pid", "session_label", "item_id", "qtype", "raw_answer",
                    "target", "correct", "releni", "timed_out"]]
              .to_string(index=False))

    # ── the sweep ────────────────────────────────────────────────────────────
    to = t[t["timed_out"] == 1].copy()
    rows_path = os.path.join(out, "timeout_audit_rows.csv")
    if to.empty:
        # zero-timeout export: still leave an (empty) listing so downstream
        # steps that expect the file don't break, then stop cleanly.
        pd.DataFrame(columns=ROW_COLS).to_csv(rows_path, index=False)
        print("\nNo timed-out trials in this export -- nothing to sweep.")
        print(f"  wrote {rows_path} (empty listing)")
        return

    to["nonempty"] = to["raw_answer"].map(lambda r: common.norm_lenient(r) != "")
    to["case"] = np.select(
        [~to["nonempty"], to["releni"] == 1],
        ["empty (true non-response)", "non-empty CORRECT (lenient)"],
        default="non-empty wrong")
    to["case_strict"] = np.select(
        [~to["nonempty"], to["restrict"] == 1],
        ["empty (true non-response)", "non-empty CORRECT (strict)"],
        default="non-empty wrong")

    def subcat(row):
        """Among non-empty wrong answers: mid-typing (prefix of the target) or
        a near-miss (edit distance 1)? Descriptive labels only."""
        if row["case"] != "non-empty wrong":
            return ""
        a = common.norm_lenient(row["raw_answer"])
        x = common.norm_lenient(row["target"])
        if x.startswith(a) and len(a) >= 3:
            return "prefix of target (mid-typing)"
        if dl_distance(a, x) <= 1:
            return "near-miss (edit distance 1)"
        return "other wrong"
    to["subcase"] = to.apply(subcat, axis=1)

    # three nested views: everything, dev excluded, the analysis sample
    manifest = common.build_sample_manifest(t)
    keep = set(manifest.loc[manifest["included"], "pid"])
    views = [("ALL trials (incl. dev)", to),
             ("non-dev only", to[to["dev_mode"] != 1]),
             ("analysis sample (policy-included pids)", to[to["pid"].isin(keep)])]

    summary_sections = []
    print(f"\n══ TIMEOUT SWEEP — {len(to)} timed-out trial(s) ══")
    for label, sub in views:
        print(f"\n── {label} (n={len(sub)}) ──")
        if sub.empty:
            print("  (none)")
            continue
        counts = sub["case"].value_counts()
        print(counts.to_string())
        n_lenient_ok = int((sub["case"] == "non-empty CORRECT (lenient)").sum())
        n_strict_ok = int((sub["case_strict"] == "non-empty CORRECT (strict)").sum())
        print(f"  correct under lenient rule: {n_lenient_ok}   "
              f"under strict rule: {n_strict_ok}")
        w = sub[sub["subcase"] != ""]
        if len(w):
            print("  breakdown of non-empty wrong:")
            print("  " + w["subcase"].value_counts().to_string()
                  .replace("\n", "\n  "))
        sec = counts.rename("n").reset_index().rename(columns={"index": "case"})
        sec.insert(0, "view", label)
        summary_sections.append(sec)

    # summaries by phase and by schedule (analysis sample; falls back to all
    # timeouts if the policy leaves none, so the tables are never silently empty)
    samp = to[to["pid"].isin(keep)]
    scope_label = "analysis sample"
    if samp.empty:
        samp = to
        scope_label = "ALL trials (no analysis-sample timeouts)"
    print(f"\n── timeouts by phase x case ({scope_label}) ──")
    by_phase = pd.crosstab(samp["phase"], samp["case"], margins=True)
    print(by_phase.to_string())
    prac = samp[samp["phase"] != common.DELAYED_PHASE]
    by_sched = None
    if len(prac):
        print(f"\n── practice timeouts by schedule x case ({scope_label}) ──")
        by_sched = pd.crosstab(prac["schedule"], prac["case"], margins=True)
        print(by_sched.to_string())

    # the confidence prompt is skipped on a timeout by design -> expect 0
    n_conf = int(to["confidence"].notna().sum())
    print(f"\nTimeouts with a non-null confidence: {n_conf} "
          f"(engine skips the prompt on timeout -> expect 0)")
    rt_vals = to["rt_ms"].dropna()
    if len(rt_vals):
        print(f"rt_ms on timeouts: min {int(rt_vals.min())} "
              f"max {int(rt_vals.max())} (censored at the 20 s window)")

    # timeout RATE context: how big is this cell at all?
    ts_scope = t[t["pid"].isin(keep)] if keep else t
    rate_frames = {}
    if not ts_scope.empty:
        rate = (ts_scope.assign(is_to=ts_scope["timed_out"] == 1)
                .groupby("phase")["is_to"].agg(timeouts="sum", trials="size",
                                               pct="mean"))
        rate["pct"] = (rate["pct"] * 100).round(2)
        rate_frames["by phase"] = rate.reset_index()
        print("\n── timeout rate by phase (analysis sample) ──")
        print(rate.to_string())
        pr = ts_scope[ts_scope["phase"] != common.DELAYED_PHASE]
        if not pr.empty:
            prate = (pr.assign(is_to=pr["timed_out"] == 1)
                     .groupby("schedule")["is_to"]
                     .agg(timeouts="sum", trials="size", pct="mean"))
            prate["pct"] = (prate["pct"] * 100).round(2)
            rate_frames["practice, by schedule"] = prate.reset_index()
            print(prate.to_string())

    # ── write the outputs ────────────────────────────────────────────────────
    listing = to.sort_values(["pid", "session_label", "trial_order"])[ROW_COLS]
    listing.to_csv(rows_path, index=False)
    print(f"\n  wrote {rows_path}")

    summ_path = os.path.join(out, "timeout_audit_summary.csv")
    with open(summ_path, "w", newline="", encoding="utf-8") as fh:
        fh.write("Timeout audit summary (see timeout_audit_rows.csv for every "
                 "trial). Cases use the instrument-exact lenient rule; the "
                 "strict-rule correct count is shown per view in the console "
                 "output and per row in the listing.\n")
        fh.write("Counts by case per view\n")
        if summary_sections:
            pd.concat(summary_sections, ignore_index=True).to_csv(fh, index=False)
        fh.write(f"\nBy phase x case ({scope_label})\n")
        by_phase.to_csv(fh)
        if by_sched is not None:
            fh.write(f"\nPractice timeouts by schedule x case ({scope_label})\n")
            by_sched.to_csv(fh)
        for name, frame in rate_frames.items():
            fh.write(f"\nTimeout rate {name} (analysis sample)\n")
            frame.to_csv(fh, index=False)
    print(f"  wrote {summ_path}")
    print("\nDone.")


if __name__ == "__main__":
    main()
