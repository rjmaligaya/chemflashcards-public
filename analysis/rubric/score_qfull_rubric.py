#!/usr/bin/env python3
"""
score_qfull_rubric.py  --  segment-level scoring of the Study 2 delayed-test
whole-name (Q-full) responses.

Three jobs, in this order:

  1. MECHANICAL SWEEP.  Decide deterministically, from the raw string alone,
     every case that does not need a human: exact match, separator-only
     near-miss, blank, and timeout-with-no-text.  These need no coder and no
     reliability statistic, because the rule is a function of the string.

  2. COD ER-BLIND EXPORT.  Write the residual (human-judgement) responses to a
     sheet with the schedule label stripped and the participant identifier
     hashed, so that a coder cannot know whether a response came from the
     spaced or the massed list.  This matters more here than anywhere else in
     the thesis: the rubric is applied to a within-subject contrast, so coder
     expectancy would map straight onto the effect.

  3. SCORE AND SUMMARIZE.  Merge a completed coding sheet back in, compute the
     feature score, the form score, the ordinal tier distribution and the error
     tag distribution, and run the participant-level paired contrasts.

Usage
-----
    python score_qfull_rubric.py --export your_export.xlsx --stage sweep
    python score_qfull_rubric.py --export your_export.xlsx --stage blind
    python score_qfull_rubric.py --export your_export.xlsx --stage score \
        --coding coding_qfull_v1.csv --slotmap slot_map_qfull_v1.csv

The export is read through common.py so that the analysis-sample policy, the
schedule labelling and the delayed-trial selection are exactly the ones the
rest of the pipeline uses.  Nothing here re-implements them.

Author: J. Maligaya.  Slot map version v1.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import unicodedata
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import common  # the existing Study 2 analysis helpers
except ImportError:  # pragma: no cover
    sys.exit("common.py must be importable (run from the analysis directory).")

SALT = "qfull-rubric-v1"  # fixed so hashes are stable across runs


# ─────────────────────────────────────────────────────────────────────────────
# 1. MECHANICAL SWEEP
# ─────────────────────────────────────────────────────────────────────────────

def norm_exact(s) -> str:
    """Lower-case, collapse internal whitespace, trim.  Keeps hyphens and
    locants.  This is the strict rule already used in common._norm_strict."""
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    return re.sub(r"\s+", " ", str(s).strip().lower())


def norm_no_separators(s) -> str:
    """Strip every hyphen, space and underscore after unicode folding, so that
    a response differing from the target only in separator placement collapses
    onto it.  This is strictly more permissive than the instrument's lenient
    rule, which maps separators to spaces and therefore still fails on an
    INSERTED separator (iodo-ethane against iodoethane)."""
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    s = unicodedata.normalize("NFKC", str(s).lower())
    return re.sub(r"[-_\s]+", "", s)


def mechanical_tier(raw, target, timed_out) -> tuple[str, str]:
    """Return (disposition, reason).  Disposition is one of:
        'exact'          -- tier 4, no coder needed
        'separator-only' -- tier 2, no coder needed
        'blank'          -- tier 0, no coder needed
        'code'           -- needs a human
    """
    r, t = norm_exact(raw), norm_exact(target)
    if r == "" and t != "":
        return "blank", ("timeout-no-text" if timed_out else "blank")
    if r == t:
        return "exact", "string identical after case and whitespace folding"
    if norm_no_separators(r) == norm_no_separators(t):
        return "separator-only", "identical once every separator is removed"
    return "code", "requires slot-level judgement"


# Applies mechanical_tier to every Q-full response and records the disposition.
def run_sweep(qfull: pd.DataFrame) -> pd.DataFrame:
    out = qfull.copy()
    disp, reason = [], []
    for _, row in out.iterrows():
        d, why = mechanical_tier(row["raw_answer"], row["full_name"],
                                 bool(row.get("timed_out", 0)))
        disp.append(d)
        reason.append(why)
    out["disposition"] = disp
    out["disposition_reason"] = reason
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 2. CODER-BLIND EXPORT
# ─────────────────────────────────────────────────────────────────────────────

# Eight-character salted SHA-256 digest standing in for a participant id.
def blind_id(pid: str) -> str:
    return hashlib.sha256(f"{SALT}:{pid}".encode()).hexdigest()[:8]


def write_blind_sheet(swept: pd.DataFrame, slotmap: pd.DataFrame,
                      path: Path) -> pd.DataFrame:
    """Condition-stripped coding sheet, shuffled by a deterministic key so the
    order carries no schedule information either."""
    todo = swept[swept["disposition"] == "code"].copy()
    todo["coder_key"] = [blind_id(p) for p in todo["pid"]]
    todo = todo.merge(
        slotmap[["item_id", "root", "suffix", "suffix_locant",
                 "subst_id", "subst_locant", "n_feature_slots"]],
        on="item_id", how="left", suffixes=("", "_slot"))
    todo["sort_key"] = [
        hashlib.sha256(f"{SALT}:{k}:{i}".encode()).hexdigest()
        for k, i in zip(todo["coder_key"], todo["item_id"])]
    todo = todo.sort_values("sort_key")
    cols = ["coder_key", "item_id", "full_name", "raw_answer",
            "root", "suffix", "suffix_locant", "subst_id", "subst_locant",
            "n_feature_slots"]
    blank_cols = ["c_root", "c_suffix", "c_suffix_locant", "c_subst_id",
                  "c_subst_locant", "c_assembly", "c_ortho", "c_sep",
                  "tier", "tags", "adjudicate", "coder_note"]
    sheet = todo[cols].rename(columns={"full_name": "target"})
    for c in blank_cols:
        sheet[c] = ""
    sheet.to_csv(path, index=False)
    return sheet


# ─────────────────────────────────────────────────────────────────────────────
# 3. SCORE
# ─────────────────────────────────────────────────────────────────────────────

FEATURE_SLOTS = ["root", "suffix", "suffix_locant", "subst_id", "subst_locant"]
FORM_SLOTS = ["assembly", "ortho", "sep"]

TAG_VOCAB = [
    # feature-knowledge failures
    "wrong-root", "wrong-suffix-class", "wrong-substituent",
    "missing-substituent", "missing-locant", "wrong-locant-value",
    "missing-ring", "numeral-form-error",
    # production-form failures
    "ordering", "ester-inversion", "elision", "word-boundary",
    "separator-count", "orthographic",
    # accepted or tolerable variants
    "legacy-locant-style", "redundant-locant", "alternative-nomenclature",
    # non-responses
    "truncated", "blank", "timeout",
]


# Mean of the applicable slot scores in one row, and how many applied.
def _prop(row, slots):
    vals = [row[s] for s in slots if pd.notna(row.get(s))]
    vals = [v for v in vals if str(v).strip() not in ("", "NA")]
    if not vals:
        return np.nan, 0
    vals = [float(v) for v in vals]
    return float(np.mean(vals)), len(vals)


# Derives the feature score, form score, and the tier indicators per response.
def score_coding(coding: pd.DataFrame) -> pd.DataFrame:
    d = coding.copy()
    for c in FEATURE_SLOTS + FORM_SLOTS:
        d[c] = pd.to_numeric(d[c], errors="coerce")
    feat = d.apply(lambda r: _prop(r, FEATURE_SLOTS), axis=1)
    form = d.apply(lambda r: _prop(r, FORM_SLOTS), axis=1)
    d["feature_score"] = [f[0] for f in feat]
    d["n_feature_applicable"] = [f[1] for f in feat]
    d["n_feature_correct"] = d["feature_score"] * d["n_feature_applicable"]
    d["form_score"] = [f[0] for f in form]
    d["n_form_applicable"] = [f[1] for f in form]
    d["strict_correct"] = (d["tier"] == 4).astype(float)
    d["tier_ge2"] = (d["tier"] >= 2).astype(float)
    d["tier_ge3"] = (d["tier"] >= 3).astype(float)
    return d


# Lists every coded tag that is not in TAG_VOCAB.
def check_tags(coding: pd.DataFrame) -> list[str]:
    bad = []
    for _, r in coding.iterrows():
        for t in str(r.get("tags", "") or "").split(";"):
            t = t.strip()
            if t and t not in TAG_VOCAB:
                bad.append(f"{r['pid']} {r['item_id']}: unknown tag {t!r}")
    return bad


def participant_cells(scored: pd.DataFrame) -> pd.DataFrame:
    """Item-mean-of-proportions per participant per schedule.  Item-mean, not
    slot-pooled, because slot counts differ by item (2 to 4) and by list (16
    for C-1 against 20 for C-2), so pooling would weight the longer names more
    heavily and would not be comparable with the binary rule it sits beside."""
    g = scored.groupby(["pid", "schedule"])
    out = g.agg(feature_score=("feature_score", "mean"),
                form_score=("form_score", "mean"),
                strict=("strict_correct", "mean"),
                tier_ge2=("tier_ge2", "mean"),
                tier_ge3=("tier_ge3", "mean"),
                n_items=("item_id", "size")).reset_index()
    pooled = (scored.groupby(["pid", "schedule"])
                    .apply(lambda x: x["n_feature_correct"].sum()
                                     / x["n_feature_applicable"].sum(),
                           include_groups=False)
                    .rename("feature_score_pooled").reset_index())
    return out.merge(pooled, on=["pid", "schedule"])


# Paired t-test of spaced against massed on one measure, with the mean
# difference, its 95% CI, Cohen's d_z, and the count favouring spaced.
def paired(cells: pd.DataFrame, col: str) -> dict:
    from scipy import stats
    w = cells.pivot(index="pid", columns="schedule", values=col).dropna()
    diff = w["spaced"] - w["massed"]
    t, p = stats.ttest_rel(w["spaced"], w["massed"])
    sd = diff.std(ddof=1)
    dz = diff.mean() / sd if sd > 0 else np.nan
    n = len(diff)
    se = sd / np.sqrt(n)
    crit = stats.t.ppf(0.975, n - 1)
    return dict(measure=col, n=n,
                spaced=w["spaced"].mean(), massed=w["massed"].mean(),
                diff=diff.mean(), sd_diff=sd,
                ci_lo=diff.mean() - crit * se, ci_hi=diff.mean() + crit * se,
                t=t, df=n - 1, p=p, dz=dz,
                n_favouring_spaced=int((diff > 0).sum()),
                n_ties=int((diff == 0).sum()))


# ─────────────────────────────────────────────────────────────────────────────

# Reads an export and returns its delayed Q-full trials plus the sample manifest.
def load_qfull(export: str) -> pd.DataFrame:
    warnings.simplefilter("ignore")
    book = common.load_export(export)
    kept, _, manifest = common.filter_to_analysis_sample(book["trials"])
    d = common.delayed_trials(kept)
    q = d[d["fmt"] == "full"].copy()
    return q, manifest


# Runs one of the three stages: sweep, blind, or score.
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True)
    ap.add_argument("--stage", choices=["sweep", "blind", "score"],
                    required=True)
    ap.add_argument("--coding")
    # The slot map ships with this script, so resolve it next to the script
    # rather than relative to wherever the command was run from.
    ap.add_argument("--slotmap",
                    default=str(Path(__file__).resolve().parent / "slot_map_qfull_v1.csv"))
    # Everything this script writes carries participant ids and raw answers, so
    # it defaults into the gitignored participant-data folder.
    ap.add_argument("--outdir",
                    default=str(Path(__file__).resolve().parent.parent
                                / "participant-data" / "rubric-output"))
    a = ap.parse_args()
    out = Path(a.outdir)
    out.mkdir(parents=True, exist_ok=True)

    qfull, manifest = load_qfull(a.export)
    slotmap = pd.read_csv(a.slotmap)
    swept = run_sweep(qfull)

    if a.stage == "sweep":
        tab = (swept.groupby("disposition").size()
                    .rename("n").reset_index()
                    .sort_values("n", ascending=False))
        print(f"Q-full responses in the analysis sample: {len(swept)}")
        print(tab.to_string(index=False))
        swept.to_csv(out / "qfull_sweep.csv", index=False)
        return

    if a.stage == "blind":
        sheet = write_blind_sheet(swept, slotmap, out / "qfull_blind_sheet.csv")
        print(f"Wrote {len(sheet)} responses for hand coding, "
              f"condition stripped and participant identifier hashed.")
        return

    # stage == score
    coding = pd.read_csv(a.coding, keep_default_na=False, na_values=["NA"])
    key = ["pid", "item_id"]
    merged = swept.merge(coding, on=key, how="left",
                         suffixes=("", "_coded"), validate="one_to_one")
    missing = merged["tier"].isna().sum()
    if missing:
        sys.exit(f"{missing} response(s) in the export have no coding row.")

    # integrity: the coded raw answer must be the stored raw answer
    lhs = merged["raw_answer"].fillna("").astype(str).str.strip()
    rhs = merged["raw_answer_coded"].fillna("").astype(str).str.strip()
    drift = merged[lhs.str.lower() != rhs.str.lower()]
    if len(drift):
        print("RAW-ANSWER DRIFT between coding sheet and export:")
        print(drift[["pid", "item_id", "raw_answer", "raw_answer_coded"]]
              .to_string(index=False))
        sys.exit(1)

    # integrity: mechanical dispositions must agree with the hand tiers
    conflicts = merged[
        ((merged["disposition"] == "exact") & (merged["tier"] != 4)) |
        ((merged["disposition"] == "blank") & (merged["tier"] != 0)) |
        ((merged["disposition"] == "separator-only") & (merged["tier"] != 2))]
    if len(conflicts):
        print("MECHANICAL / HAND TIER CONFLICTS:")
        print(conflicts[["pid", "item_id", "raw_answer", "disposition",
                         "tier"]].to_string(index=False))

    bad = check_tags(merged)
    if bad:
        print("TAGS OUTSIDE THE CONTROLLED VOCABULARY:")
        print("\n".join(bad))

    scored = score_coding(merged)
    scored.to_csv(out / "qfull_scored.csv", index=False)

    cells = participant_cells(scored)
    cells.to_csv(out / "qfull_participant_cells.csv", index=False)

    rows = [paired(cells, c) for c in
            ["strict", "feature_score", "feature_score_pooled",
             "form_score", "tier_ge2", "tier_ge3"]]
    contrasts = pd.DataFrame(rows)
    contrasts.to_csv(out / "qfull_contrasts.csv", index=False)

    tiers = (scored.groupby(["schedule", "tier"]).size()
                   .rename("n").reset_index()
                   .pivot(index="tier", columns="schedule", values="n")
                   .fillna(0).astype(int))
    tiers.to_csv(out / "qfull_tier_distribution.csv")

    tagrows = []
    for _, r in scored.iterrows():
        for t in str(r.get("tags", "") or "").split(";"):
            t = t.strip()
            if t:
                tagrows.append(dict(schedule=r["schedule"], tag=t))
    tags = pd.DataFrame(tagrows)
    if len(tags):
        tt = (tags.groupby(["tag", "schedule"]).size().rename("n").reset_index()
                  .pivot(index="tag", columns="schedule", values="n")
                  .fillna(0).astype(int))
        tt["total"] = tt.sum(axis=1)
        tt = tt.sort_values("total", ascending=False)
        tt.to_csv(out / "qfull_tag_distribution.csv")

    pd.set_option("display.width", 200)
    print("\n=== Mechanical sweep ===")
    print(swept.groupby("disposition").size().to_string())
    print("\n=== Participant-level contrasts (six completers) ===")
    print(contrasts.round(4).to_string(index=False))
    print("\n=== Tier distribution ===")
    print(tiers.to_string())
    if len(tags):
        print("\n=== Error tags ===")
        print(tt.to_string())
    n_adj = int(pd.to_numeric(scored["adjudicate"], errors="coerce").fillna(0).sum())
    print(f"\nResponses flagged for adjudication: {n_adj} of {len(scored)}")


if __name__ == "__main__":
    main()
