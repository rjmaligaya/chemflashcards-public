"""
4.2.vi  --  Baseline characterization and exclusions
====================================================

WHAT THIS REPORTS
-----------------
  * The achieved sample: how many enrolled, how many completed all practice,
    how many have a delayed test, how many are flagged for ISI-timing issues.
  * The distribution of PRIOR KNOWLEDGE from the questionnaire item
    ("could you name this molecule?"), read from a separate CSV you supply.
  * The participants removed by the pre-specified exclusion screen, itemised
    with the reason for each.
  * (Secondary) the baseline familiarity self-ratings ("Ease ratings", 1-7)
    from the app export, summarised by set.

CURRENT EXCLUSION POLICY  (see the CONFIG block in common.py)
  * dev_mode test IDs        -> always excluded
  * did NOT complete all 8 practice blocks (S1-4, B1-4) -> excluded
  * missing delayed test     -> NOT excluded (completers assumed to have done it)
  * ISI-timing violations    -> FLAGGED but kept
  * baseline ceiling         -> not applied yet

THE BASELINE (QUESTIONNAIRE) CSV
--------------------------------
Supply it with --baseline. By default the loader expects columns:
    pid              (matches the app-export participant ids)
    baseline_score   (a number, e.g. how many molecules the participant could name)
If instead your questionnaire is one row per molecule with a yes/no "named"
column, set BASELINE_NAMED_COL (and BASELINE_PID_COL) in common.py and the
loader will count the "yes" responses per participant automatically.
If you don't pass --baseline, that section is skipped and everything else runs.

OUTPUTS (written to the --out folder)
  * 42vi_sample_summary.csv
  * 42vi_exclusions_manifest.csv
  * 42vi_prior_knowledge.csv          (only if --baseline supplied)
  * 42vi_prior_knowledge.png          (only if --baseline supplied)
  * 42vi_familiarity_summary.csv
  * 42vi_familiarity.png

RUN
    python analysis_42vi_baseline_exclusions.py --data export.xlsx --baseline questionnaire.csv
    python analysis_42vi_baseline_exclusions.py --data export.xlsx     # baseline skipped
"""

from __future__ import annotations
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import spss_compat as spss
import numpy as np
import pandas as pd


# ── baseline questionnaire loader ────────────────────────────────────────────

def _coerce_binary(series: pd.Series) -> pd.Series:
    """Turn a yes/no or 1/0 column into numeric 1/0 (NaN if blank/unrecognised)."""
    s = series.astype(str).str.strip().str.lower()
    num = pd.to_numeric(s, errors="coerce")
    truthy = s.isin(common.BASELINE_NAMED_TRUE)
    return num.where(num.notna(), truthy.astype(float).where(s != "", np.nan))


def load_baseline(path: str) -> pd.DataFrame:
    """
    Read the transcribed questionnaire into a per-participant frame. Returns all
    columns present, plus a numeric `baseline_score` derived from the Q10
    "could you name the molecule" item (1 = named correctly, 0 = not). Q9
    familiarity and demographics are passed through for characterisation.
    """
    df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""],
                     comment="#")
    pid_col = common.BASELINE_PID_COL
    if pid_col not in df.columns:
        raise ValueError(
            f"Baseline file {path!r} has no '{pid_col}' column. "
            f"Columns present: {list(df.columns)}. "
            f"Adjust BASELINE_PID_COL in common.py to match your file.")
    df = df.rename(columns={pid_col: "pid"})

    if common.BASELINE_NAMED_COL and common.BASELINE_NAMED_COL in df.columns:
        df["baseline_score"] = _coerce_binary(df[common.BASELINE_NAMED_COL])
    elif common.BASELINE_SCORE_COL in df.columns:
        df["baseline_score"] = _coerce_binary(df[common.BASELINE_SCORE_COL])
    else:
        raise ValueError(
            f"Baseline file {path!r} has neither a '{common.BASELINE_SCORE_COL}' "
            f"nor a '{common.BASELINE_NAMED_COL}' column for the Q10 naming item. "
            f"Set BASELINE_SCORE_COL or BASELINE_NAMED_COL in common.py.")
    return df


# ── familiarity ("Ease ratings") summary ─────────────────────────────────────

def familiarity_summary(familiarity: pd.DataFrame, include_pids: list[str]):
    """Per-set mean baseline familiarity (1-7) over the included sample."""
    if familiarity.empty:
        return pd.DataFrame(), pd.DataFrame()
    f = familiarity[familiarity["pid"].isin(include_pids)].copy()
    if f.empty:
        return pd.DataFrame(), pd.DataFrame()
    # spaced_intro == spaced list, massed_intro == massed list
    f["set"] = f["checkpoint"].map({"spaced_intro": "spaced (Set A)",
                                    "massed_intro": "massed (Set B)"})
    by_set = (f.groupby("set")["value"]
                .agg(n="size", mean="mean", sd="std").reset_index())
    per_pp = (f.groupby(["pid", "set"])["value"].mean()
                .rename("mean_familiarity").reset_index())
    return by_set, per_pp


# ── plotting ─────────────────────────────────────────────────────────────────

# Draws a histogram of baseline prior-knowledge scores with a mean line.
def plot_prior_knowledge(scores: pd.Series, out_png: str) -> None:
    plt = common.get_matplotlib()
    if plt is None:
        return
    s = pd.Series(scores).dropna()
    if s.empty:
        return
    fig, ax = plt.subplots(figsize=(6, 4))
    bins = min(10, max(3, s.nunique()))
    ax.hist(s, bins=bins, color="#3a7ca5", edgecolor="white")
    ax.axvline(s.mean(), color="#e08e0b", linestyle="--",
               label=f"mean = {s.mean():.2f}")
    ax.set_xlabel("Baseline prior-knowledge score")
    ax.set_ylabel("Participants")
    ax.set_title("4.2.vi  Distribution of prior knowledge (questionnaire)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_png, dpi=150)
    plt.close(fig)
    print(f"  wrote {out_png}")


# Draws a box plot of per-participant mean baseline familiarity, one box per set.
def plot_familiarity(per_pp: pd.DataFrame, out_png: str) -> None:
    plt = common.get_matplotlib()
    if plt is None or per_pp.empty:
        return
    fig, ax = plt.subplots(figsize=(6, 4))
    sets = sorted(per_pp["set"].dropna().unique())
    data = [per_pp.loc[per_pp["set"] == s, "mean_familiarity"].values for s in sets]
    # matplotlib renamed boxplot's label kwarg across versions; set ticks after
    # the fact so this works on both old ('labels') and new ('tick_labels').
    ax.boxplot(data, showmeans=True)
    ax.set_xticks(range(1, len(sets) + 1))
    ax.set_xticklabels(sets)
    ax.set_ylabel("Mean baseline familiarity (1-7)")
    ax.set_title("4.2.vi  Baseline familiarity by set")
    fig.tight_layout()
    fig.savefig(out_png, dpi=150)
    plt.close(fig)
    print(f"  wrote {out_png}")


# ── main ─────────────────────────────────────────────────────────────────────

# Runs the full 4.2.vi analysis and writes every table, figure, and .sav file.
def main() -> None:
    ap = argparse.ArgumentParser(description="4.2.vi baseline & exclusions")
    ap.add_argument("--data", required=True,
                    help="export .xlsx workbook OR folder of per-table CSVs")
    ap.add_argument("--baseline", default=None,
                    help="questionnaire baseline CSV (optional)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = common.ensure_outdir(
        args.out or os.path.join(
            args.data if os.path.isdir(args.data) else os.path.dirname(args.data)
            or ".", "results_4_2"))

    tables = common.load_export(args.data)
    trials_all = tables["trials"]

    common.banner("4.2.vi  Baseline characterization & exclusions")
    if trials_all.empty:
        print("No trials in the export; cannot characterise the sample.")
        return

    # ---- exclusions manifest over ALL enrolled participants ------------------
    manifest = common.build_sample_manifest(trials_all)
    manifest.to_csv(os.path.join(out, "42vi_exclusions_manifest.csv"), index=False)
    included = manifest.loc[manifest["included"], "pid"].tolist()

    n_all = len(manifest)
    n_dev = int(manifest["dev_mode"].sum())
    n_completers = int((manifest["completed_practice"] & ~manifest["dev_mode"]).sum())
    n_incl = len(included)
    n_delayed = int(manifest.loc[manifest["included"], "has_delayed"].sum())
    n_isi = int(manifest.loc[manifest["included"], "isi_violation"].sum())

    summary = pd.DataFrame([
        ("enrolled (all ids in export)", n_all),
        ("dev/test ids (excluded)", n_dev),
        ("non-dev enrolled", n_all - n_dev),
        ("completed all practice (non-dev)", n_completers),
        ("INCLUDED in analysis", n_incl),
        ("  ...of those, have delayed test", n_delayed),
        ("  ...of those, ISI-flagged (kept)", n_isi),
    ], columns=["group", "n"])
    summary.to_csv(os.path.join(out, "42vi_sample_summary.csv"), index=False)

    print("\nAchieved sample:")
    for _, r in summary.iterrows():
        print(f"  {r['group']:<38} {r['n']}")

    excluded = manifest[~manifest["included"]]
    if not excluded.empty:
        print("\nExcluded participants:")
        for _, r in excluded.iterrows():
            print(f"  {r['pid']:<12} reason: {r['excluded_reason']}")
    if n_isi:
        print("\nISI-flagged (kept, but note timing):")
        for _, r in manifest[manifest["included"] & manifest["isi_violation"]].iterrows():
            print(f"  {r['pid']:<12} {r['isi_detail']}")

    # ---- prior knowledge from the questionnaire ------------------------------
    if args.baseline:
        try:
            base = load_baseline(args.baseline)
        except Exception as exc:
            print(f"\n[baseline] could not read {args.baseline}: {exc}")
            base = pd.DataFrame()
        if not base.empty:
            base_incl = base[base["pid"].isin(included)].copy()
            base_incl.to_csv(os.path.join(out, "42vi_prior_knowledge.csv"),
                             index=False)
            spss.write_sav(base_incl, os.path.join(out, "42vi_data_baseline.sav"))

            # Q10: could name the molecule (primary prior-knowledge item, 1/0)
            s = base_incl["baseline_score"].dropna()
            print("\nPrior knowledge (Q10 'could you name the molecule'), "
                  "included sample:")
            if not s.empty:
                named = int(s.sum()); n = len(s)
                print(f"  {named}/{n} named it correctly "
                      f"({100 * named / n:.0f}%); mean={s.mean():.2f}, "
                      f"sd={s.std(ddof=1):.2f}")
                missing = set(included) - set(base["pid"])
                if missing:
                    print(f"  note: {len(missing)} included participant(s) have no "
                          f"baseline row: {sorted(missing)}")
            plot_prior_knowledge(base_incl["baseline_score"],
                                 os.path.join(out, "42vi_prior_knowledge.png"))

            # Q9: self-rated IUPAC familiarity (secondary ordinal)
            fam_col = common.BASELINE_FAMILIARITY_COL
            if fam_col and fam_col in base_incl.columns:
                freq = base_incl[fam_col].value_counts(dropna=True)
                if not freq.empty:
                    print(f"\nSelf-rated IUPAC familiarity (Q9), included sample:")
                    for level, cnt in freq.items():
                        print(f"  {str(level):<22} {int(cnt)}")

            # Demographics for baseline characterisation
            demo_cols = [c for c in common.BASELINE_DEMOGRAPHIC_COLS
                         if c in base_incl.columns]
            if demo_cols:
                print("\nSample characterisation (questionnaire demographics):")
                for c in demo_cols:
                    vals = base_incl[c].dropna()
                    num = pd.to_numeric(vals, errors="coerce")
                    if num.notna().all() and not vals.empty:  # numeric (e.g. age)
                        print(f"  {c}: mean={num.mean():.1f}, sd={num.std(ddof=1):.1f}, "
                              f"range {num.min():.0f}-{num.max():.0f} (n={len(num)})")
                    else:
                        counts = vals.value_counts()
                        pretty = ", ".join(f"{k}={v}" for k, v in counts.items())
                        print(f"  {c}: {pretty}")
    else:
        print("\nPrior knowledge: no --baseline file supplied; section skipped. "
              "(Pass the questionnaire CSV; see baseline_template.csv for the layout.)")

    # ---- familiarity ("Ease ratings") secondary characterization -------------
    by_set, per_pp = familiarity_summary(tables["familiarity"], included)
    if not by_set.empty:
        by_set.to_csv(os.path.join(out, "42vi_familiarity_summary.csv"), index=False)
        spss.write_sav(per_pp, os.path.join(out, "42vi_data_familiarity.sav"))
        print("\nBaseline familiarity (Ease ratings, 1-7), included sample:")
        for _, r in by_set.iterrows():
            print(f"  {r['set']:<16} mean={r['mean']:.2f} (sd {r['sd']:.2f}, "
                  f"n={int(r['n'])})")
        plot_familiarity(per_pp, os.path.join(out, "42vi_familiarity.png"))
    else:
        print("\nBaseline familiarity: no 'Ease ratings' in export; skipped.")

    print("\nDone.")


if __name__ == "__main__":
    main()
