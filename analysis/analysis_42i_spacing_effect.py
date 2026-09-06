"""
4.2.i  --  Spacing effect at delay, collapsed and by format
===========================================================

WHAT THIS REPORTS
-----------------
The spaced-vs-massed difference in DELAYED-test accuracy.

CONFIRMATORY PRIMARY: the paired t-test on the Q-blank RETENTION items only,
under the primary scoring rule (Q-blank is lenient by definition, so this
equals the lenient Q-blank cell). Everything else in this script is SECONDARY
or descriptive:
  * the format-collapsed paired t-test, reported as "VERSION B", the
    alternative primary,
  * the 2x2 repeated-measures ANOVA crossing SCHEDULE with FORMAT,
  * delayed-test RT (H4), inverse efficiency, scoring sensitivity, the
    last-practice-recency descriptives, and the C-1/C-2 list null-check.

SPSS PARITY
-----------
All tests are computed through spss_compat.py, which produces SPSS-matching
numbers and SPSS-shaped tables:
  * paired t  -> SPSS: Analyze > Compare Means > Paired-Samples T Test
  * 2x2 RM    -> SPSS: Analyze > General Linear Model > Repeated Measures
It also writes `.sav` SPSS data files of the prepared datasets so the exact
same analysis can be reproduced/confirmed in SPSS.

OUTPUTS (written to the --out folder)
  * 42i_confirmatory_qblank.csv         THE confirmatory primary: per-participant
                                        Q-blank retention accuracy + paired t
  * 42i_group_comparison.csv            secondary table; difference row = paired t
  * 42i_spss_paired_samples.csv         SPSS-style "Paired Samples" tables
  * 42i_spss_within_subjects_effects.csv SPSS-style RM-ANOVA table (+ sphericity note)
  * 42i_data_collapsed.sav / .csv       per-participant spaced/massed (for SPSS paired t)
  * 42i_data_2x2.sav / .csv             per-participant 2x2 cells (for SPSS GLM RM)
  * 42i_delayed_rt.csv                  delayed RT on retention items (H4)
  * 42i_delayed_rt_by_format.csv        delayed RT split by format (Q-full companion)
  * 42i_inverse_efficiency.csv          median correct RT / accuracy, per schedule
  * 42i_scoring_sensitivity.csv         lenient vs strict delayed accuracy per cell
  * 42i_primary_scoring.csv             the PRIMARY composite rule vs pure lenient/strict
  * 42i_scoring_flips.csv               per-qtype lenient/strict flip counts
  * 42i_recency_descriptives.csv        last-practice recency by schedule x format
  * 42i_list_check.csv                  C-1 vs C-2 list-difficulty null-check
  * 42i_per_participant_advantage.png   per-participant spaced-minus-massed advantage
  * 42i_sample_manifest.csv             who was included/excluded and why

RUN
    python analysis_42i_spacing_effect.py --data path/to/export.xlsx
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


def plot_advantage(collapsed: pd.DataFrame, out_png: str) -> None:
    """Per-participant spaced-minus-massed advantage, sorted, with a mean line."""
    plt = common.get_matplotlib()
    if plt is None:
        return
    d = collapsed.dropna(subset=["advantage"]).sort_values("advantage")
    if d.empty:
        print("  [plot] no participants with both spaced and massed delayed "
              "accuracy; advantage plot skipped.")
        return
    fig, ax = plt.subplots(figsize=(max(6, 0.5 * len(d) + 2), 4.5))
    colors = ["#3a7ca5" if v >= 0 else "#c1666b" for v in d["advantage"]]
    ax.bar(range(len(d)), d["advantage"], color=colors)
    ax.axhline(0, color="#444", linewidth=1)
    m = d["advantage"].mean()
    ax.axhline(m, color="#e08e0b", linestyle="--", linewidth=1.5,
               label=f"mean = {m:+.3f}")
    ax.set_xticks(range(len(d)))
    ax.set_xticklabels(d["pid"], rotation=60, ha="right", fontsize=8)
    ax.set_ylabel("Delayed accuracy: spaced - massed")
    ax.set_xlabel("Participant")
    ax.set_title("Per-participant spacing advantage at the delayed test\n"
                 "(positive = spaced better)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_png, dpi=150)
    plt.close(fig)
    print(f"  wrote {out_png}")


# Runs the full 4.2.i analysis and writes every table, plot, and .sav file.
def main() -> None:
    ap = argparse.ArgumentParser(description="4.2.i spacing effect at delay")
    ap.add_argument("--data", required=True,
                    help="export .xlsx workbook OR folder of per-table CSVs")
    ap.add_argument("--out", default=None, help="output folder for tables/plots")
    args = ap.parse_args()

    out = common.ensure_outdir(
        args.out or os.path.join(
            args.data if os.path.isdir(args.data) else os.path.dirname(args.data)
            or ".", "results_4_2"))

    tables = common.load_export(args.data)
    trials, _, manifest = common.filter_to_analysis_sample(tables["trials"])

    common.banner("4.2.i  Spacing effect at the delayed test")
    print(f"SPSS-parity engines: {spss.engines_available()}")
    n_incl = int(manifest["included"].sum())
    print(f"Analysis sample: {n_incl} participant(s) "
          f"(of {len(manifest)} enrolled after policy).")
    if trials.empty:
        print("No trials in the analysis sample; nothing to test.")
        return

    # Per-participant delayed accuracy per schedule x format cell, under the
    # stored lenient instrument scoring (used by both the confirmatory test and
    # the secondary by-format / ANOVA blocks below).
    cells = common.delayed_cell_means(trials)

    # ── (0) CONFIRMATORY PRIMARY: Q-blank retention paired t ────────────────
    # Paired t-test of spaced versus massed mean delayed accuracy on the
    # Q-blank retention items, the sole confirmatory test for H1. It runs under
    # the primary composite scoring rule; because common.QFULL_PRIMARY_RULE
    # touches only Q-full, this cell equals the lenient Q-blank cell.
    common.banner("CONFIRMATORY PRIMARY (H1): Q-blank retention items")
    qb = (cells[cells["fmt"] == "blank"]
          .pivot_table(index="pid", columns="schedule", values="acc"))
    for col in ("spaced", "massed"):
        if col not in qb.columns:
            qb[col] = np.nan
    qb = qb.reset_index()
    qb["advantage"] = qb["spaced"] - qb["massed"]
    qtt = spss.paired_ttest(qb["spaced"], qb["massed"], "spaced", "massed")
    print(f"{qtt['spss']}")
    print("Q-blank retention items (mean delayed accuracy, primary rule):")
    print(f"  spaced = {qtt['mean_spaced']:.3f}   massed = {qtt['mean_massed']:.3f}")
    print(f"  mean difference (spaced - massed) = {qtt['mean_diff']:+.3f}")
    if not np.isnan(qtt["t"]):
        print(f"  t({qtt['df']}) = {qtt['t']:.3f}, Sig.(2-tailed) = {qtt['p_2tailed']:.4f}, "
              f"95% CI [{qtt['ci95_low']:+.3f}, {qtt['ci95_high']:+.3f}], "
              f"Cohen's d (d_z) = {qtt['cohen_d_dz']:.3f}")
    if qtt.get("note"):
        print(f"  note: {qtt['note']}")

    conf_path = os.path.join(out, "42i_confirmatory_qblank.csv")
    with open(conf_path, "w", newline="", encoding="utf-8") as fh:
        fh.write("CONFIRMATORY PRIMARY (H1): Q-blank retention items, delayed accuracy\n")
        fh.write("Sole confirmatory test (pre-specified 2026-07-22). Scoring = primary "
                 "rule; for Q-blank that is the stored lenient instrument score.\n")
        qb[["pid", "spaced", "massed", "advantage"]].round(4).to_csv(fh, index=False)
        fh.write("\nPaired Samples Test (spaced vs massed, Q-blank retention)\n")
        _, qtest_tbl = spss.paired_ttest_tables(qtt, "spaced", "massed")
        qtest_tbl.to_csv(fh, index=False)
    print(f"  wrote {conf_path}")

    # ── VERSION B: the format-collapsed alternative primary ──────────────────
    common.banner("VERSION B (supervisor choice pending)")
    print("The format-COLLAPSED paired t below remains the alternative primary\n"
          "until Dr. Bongers picks between Q-blank-only (above) and collapsed.\n"
          "Both are always computed and written; nothing has been removed.")

    # ── (1) SECONDARY: paired t-test, collapsed over format ──────────────────
    common.banner("SECONDARY: format-collapsed paired t-test")
    collapsed = common.delayed_collapsed(trials)
    tt = spss.paired_ttest(collapsed["spaced"], collapsed["massed"],
                           "spaced", "massed")

    print(f"{tt['spss']}")
    print("Collapsed over format (mean delayed accuracy):")
    print(f"  spaced = {tt['mean_spaced']:.3f}   massed = {tt['mean_massed']:.3f}")
    print(f"  mean difference (spaced - massed) = {tt['mean_diff']:+.3f}")
    if not np.isnan(tt["t"]):
        print(f"  t({tt['df']}) = {tt['t']:.3f}, Sig.(2-tailed) = {tt['p_2tailed']:.4f}, "
              f"95% CI [{tt['ci95_low']:+.3f}, {tt['ci95_high']:+.3f}], "
              f"Cohen's d (d_z) = {tt['cohen_d_dz']:.3f}")
    if tt.get("note"):
        print(f"  note: {tt['note']}")

    # SPSS-style Paired Samples tables (SECONDARY analysis)
    stats_tbl, test_tbl = spss.paired_ttest_tables(tt, "spaced", "massed")
    with open(os.path.join(out, "42i_spss_paired_samples.csv"), "w",
              newline="", encoding="utf-8") as fh:
        fh.write("SECONDARY analysis (the confirmatory primary is the Q-blank "
                 "retention t in 42i_confirmatory_qblank.csv)\n")
        fh.write("Paired Samples Statistics\n")
        stats_tbl.to_csv(fh, index=False)
        fh.write("\nPaired Samples Test (collapsed over format)\n")
        test_tbl.to_csv(fh, index=False)

    # ── by-format paired comparisons (for the group-comparison table) ────────
    byfmt = {}
    for fmt in ("blank", "full"):
        wide = (cells[cells["fmt"] == fmt]
                .pivot_table(index="pid", columns="schedule", values="acc"))
        for col in ("spaced", "massed"):
            if col not in wide.columns:
                wide[col] = np.nan
        byfmt[fmt] = spss.paired_ttest(wide["spaced"], wide["massed"],
                                       "spaced", "massed")

    # Flattens one paired t-test result into a row of the comparison table.
    def _row(fmt, r):
        return dict(
            comparison="spaced vs massed (difference)", format=fmt, n=r["n"],
            mean_spaced=round(r["mean_spaced"], 4),
            mean_massed=round(r["mean_massed"], 4),
            mean_diff=round(r["mean_diff"], 4),
            t=round(r["t"], 4) if not np.isnan(r["t"]) else "",
            df=r["df"],
            sig_2tailed=round(r["p_2tailed"], 5) if not np.isnan(r["p_2tailed"]) else "",
            ci95_low=round(r["ci95_low"], 4) if not np.isnan(r["ci95_low"]) else "",
            ci95_high=round(r["ci95_high"], 4) if not np.isnan(r["ci95_high"]) else "",
            cohen_d_dz=round(r["cohen_d_dz"], 4) if not np.isnan(r["cohen_d_dz"]) else "",
            engine=r["engine"])

    gc = pd.DataFrame([_row("collapsed", tt)] + [_row(f, byfmt[f]) for f in ("blank", "full")])
    gc.to_csv(os.path.join(out, "42i_group_comparison.csv"), index=False)
    print(f"\n  wrote {os.path.join(out, '42i_group_comparison.csv')}")
    print(f"  wrote {os.path.join(out, '42i_spss_paired_samples.csv')}")

    # ── (2) SECONDARY: 2x2 RM-ANOVA ──────────────────────────────────────────
    common.banner("SECONDARY: 2x2 RM-ANOVA (schedule x format)")
    anova = spss.rm_anova(cells, dv="acc", within=["schedule", "fmt"], subject="pid")
    if not anova.empty:
        note = anova.attrs.get("sphericity_note", "")
        anova_path = os.path.join(out, "42i_spss_within_subjects_effects.csv")
        with open(anova_path, "w", newline="", encoding="utf-8") as fh:
            fh.write("SECONDARY analysis (the confirmatory primary is the Q-blank "
                     "retention t in 42i_confirmatory_qblank.csv)\n")
            fh.write(f"{spss.SPSS_PROCEDURES['rm_anova']}\n")
            fh.write("Tests of Within-Subjects Effects (accuracy ~ schedule * format)\n")
            anova.drop(columns=["Error df"], errors="ignore").to_csv(fh, index=False)
            fh.write(f"\nSphericity note: {note}\n")
        print(f"  wrote {anova_path}")
        print(f"\n{spss.SPSS_PROCEDURES['rm_anova']}")
        print("Tests of Within-Subjects Effects:")
        for _, row in anova.iterrows():
            print(f"  {row['Source']:<14} F({int(row['df'])},{int(row['Error df'])}) = "
                  f"{row['F']:.3f}, Sig. = {row['Sig.']:.4f}, "
                  f"partial eta^2 = {row['Partial Eta Squared']:.3f}")
        print(f"  ({note})")

    # ── SPSS-ready data files (.sav) ─────────────────────────────────────────
    # collapsed: one row per participant, spaced & massed columns (for paired t)
    coll_path = spss.write_sav(collapsed[["pid", "spaced", "massed", "advantage"]],
                               os.path.join(out, "42i_data_collapsed.sav"),
                               labels={"spaced": "Delayed accuracy, spaced (collapsed)",
                                       "massed": "Delayed accuracy, massed (collapsed)",
                                       "advantage": "Spaced minus massed"})
    # 2x2: one row per participant, one column per schedule x format cell
    wide2x2 = cells.pivot_table(index="pid", columns=["schedule", "fmt"], values="acc")
    wide2x2.columns = [f"acc_{s}_{f}" for s, f in wide2x2.columns]
    wide2x2 = wide2x2.reset_index()
    x2_path = spss.write_sav(wide2x2, os.path.join(out, "42i_data_2x2.sav"))
    print(f"  wrote {coll_path}")
    print(f"  wrote {x2_path}   (open in SPSS: define 2 within factors, "
          f"schedule[2] x format[2])")

    # ── (3) delayed-test RT (H4 automaticity, behavioural half) ──────────────
    # Median retrieval latency on delayed RETENTION items, spaced vs massed
    # (correct-only, timeouts excluded). Tests H4's response-time claim AT THE
    # DELAYED TEST; the practice-phase RT curve (4.2.ii) serves H2, not H4.
    rt = common.delayed_rt_cells(trials, retention_only=True, correct_only=True)
    if not rt.dropna(subset=["spaced", "massed"]).empty:
        rtt = spss.paired_ttest(rt["spaced"], rt["massed"], "spaced", "massed")
        print("\nDelayed-test RT, retention items (median ms, correct-only, "
              "timeouts excluded):")
        print(f"  spaced = {rtt['mean_spaced']:.0f} ms   massed = {rtt['mean_massed']:.0f} ms")
        print(f"  mean difference (spaced - massed) = {rtt['mean_diff']:+.0f} ms "
              f"(negative = spaced faster, the H4 direction)")
        if not np.isnan(rtt["t"]):
            print(f"  t({rtt['df']}) = {rtt['t']:.3f}, Sig.(2-tailed) = "
                  f"{rtt['p_2tailed']:.4f}, Cohen's d (d_z) = {rtt['cohen_d_dz']:.3f}")
        rt.to_csv(os.path.join(out, "42i_delayed_rt.csv"), index=False)
        print(f"  wrote {os.path.join(out, '42i_delayed_rt.csv')}")
    else:
        print("\nDelayed-test RT: no participant yet has both a spaced and a "
              "massed correct-retention median; skipped.")

    # ── (3b) within-format delayed RT: the Q-full companion ──────────────────
    # Median delayed RT split by question format. Both formats filter on the
    # LENIENT correctness rule; the primary H4 RT test above uses Q-blank only.
    rt_blank = rt.copy()          # the retention (Q-blank) medians from above
    rt_blank.insert(1, "fmt", "blank")
    rt_full = common.delayed_rt_cells(trials, retention_only=False,
                                      correct_only=True, fmt="full")
    rt_full.insert(1, "fmt", "full")
    rt_byfmt = pd.concat([rt_blank, rt_full], ignore_index=True)
    rt_byfmt = rt_byfmt[["pid", "fmt", "spaced", "massed", "rt_diff"]]
    rt_byfmt.to_csv(os.path.join(out, "42i_delayed_rt_by_format.csv"), index=False)
    print("\nDelayed-test RT by format (median ms, lenient-correct-only, "
          "timeouts excluded):")
    full_ok = rt_full.dropna(subset=["spaced", "massed"])
    if not full_ok.empty:
        ftt = spss.paired_ttest(rt_full["spaced"], rt_full["massed"],
                                "spaced", "massed")
        print(f"  Q-full companion: spaced = {ftt['mean_spaced']:.0f} ms   "
              f"massed = {ftt['mean_massed']:.0f} ms   "
              f"diff = {ftt['mean_diff']:+.0f} ms")
        if not np.isnan(ftt["t"]):
            print(f"    t({ftt['df']}) = {ftt['t']:.3f}, Sig.(2-tailed) = "
                  f"{ftt['p_2tailed']:.4f}")
    else:
        print("  Q-full companion: no participant yet has both a spaced and a "
              "massed correct Q-full median; per-pid rows still written.")
    print(f"  wrote {os.path.join(out, '42i_delayed_rt_by_format.csv')}")

    # ── (3c) inverse efficiency on the retention (Q-blank) items ─────────────
    # IE = median correct RT (ms, timeouts excluded) / proportion correct
    # (lenient), per participant per schedule. IE folds speed and accuracy into
    # one number (lower = better); it guards against a speed-accuracy trade-off
    # masquerading as an RT effect. Accuracy 0 would divide by zero -> NaN,
    # with the count reported.
    d_all = common.delayed_trials(trials)
    qb_acc = (d_all[d_all["fmt"] == "blank"]
              .groupby(["pid", "schedule"])["correct"].mean().unstack("schedule"))
    ie = rt.set_index("pid")[["spaced", "massed"]].copy()
    n_zero_acc = 0
    for col in ("spaced", "massed"):
        acc = qb_acc[col] if col in qb_acc.columns else pd.Series(dtype=float)
        acc = acc.reindex(ie.index)
        n_zero_acc += int((acc == 0).sum())
        ie[col] = ie[col] / acc.where(acc > 0)   # acc 0 -> NaN, never divide by 0
    ie = ie.rename(columns={"spaced": "spaced_ie", "massed": "massed_ie"})
    ie["ie_diff"] = ie["spaced_ie"] - ie["massed_ie"]
    ie = ie.reset_index()
    itt = spss.paired_ttest(ie["spaced_ie"], ie["massed_ie"], "spaced", "massed")
    ie_path = os.path.join(out, "42i_inverse_efficiency.csv")
    with open(ie_path, "w", newline="", encoding="utf-8") as fh:
        fh.write("Inverse efficiency, delayed retention (Q-blank) items: "
                 "median correct RT (ms) / proportion correct (lenient). "
                 "Lower = better.\n")
        fh.write(f"Participants with accuracy 0 in a cell (IE undefined -> NaN): "
                 f"{n_zero_acc}\n")
        ie.round(1).to_csv(fh, index=False)
        fh.write("\nPaired Samples Test (spaced vs massed IE)\n")
        _, ie_tbl = spss.paired_ttest_tables(itt, "spaced", "massed")
        ie_tbl.to_csv(fh, index=False)
    print("\nInverse efficiency (retention items; lower = better):")
    print(f"  spaced = {itt['mean_spaced']:.0f}   massed = {itt['mean_massed']:.0f}   "
          f"diff = {itt['mean_diff']:+.0f}"
          + (f"   ({n_zero_acc} zero-accuracy cell(s) -> NaN)" if n_zero_acc else ""))
    if not np.isnan(itt["t"]):
        print(f"  t({itt['df']}) = {itt['t']:.3f}, Sig.(2-tailed) = {itt['p_2tailed']:.4f}")
    print(f"  wrote {ie_path}")

    # ── (4) scoring sensitivity: lenient (instrument) vs strict (exact form) ──
    # Re-scores the delayed test under a STRICT rule (exact IUPAC form incl.
    # hyphens/locants) alongside the lenient instrument scoring and reports the
    # mean of each cell plus the lenient-minus-strict difference.
    strict = common.delayed_strict_cells(trials)
    if not strict.empty:
        lenient = common.delayed_cell_means(trials)  # acc = lenient stored score
        merged = lenient.merge(strict, on=["pid", "schedule", "fmt"], how="outer")
        summ = (merged.groupby(["schedule", "fmt"])
                      .agg(acc_lenient=("acc", "mean"),
                           acc_strict=("acc_strict", "mean"),
                           n=("pid", "nunique")).reset_index())
        summ["lenient_minus_strict"] = summ["acc_lenient"] - summ["acc_strict"]
        summ.to_csv(os.path.join(out, "42i_scoring_sensitivity.csv"), index=False)
        print("\nScoring sensitivity (delayed accuracy, mean over participants):")
        for _, r in summ.iterrows():
            print(f"  {r['schedule']:<6} {r['fmt']:<5}  lenient={r['acc_lenient']:.3f}  "
                  f"strict={r['acc_strict']:.3f}  (delta={r['lenient_minus_strict']:+.3f})")
        print(f"  wrote {os.path.join(out, '42i_scoring_sensitivity.csv')}")

    # ── (5) PRIMARY-rule accuracy + per-qtype flip counts ────────────────────
    # The primary composite rule (set by common.QFULL_PRIMARY_RULE): Q-blank =
    # stored lenient, Q-full = strict re-score. Written next to the
    # pure-lenient and pure-strict cells so the three scorings sit in one table.
    primary = common.delayed_primary_cells(trials).rename(columns={"acc": "acc_primary"})
    lenient_cells = cells.rename(columns={"acc": "acc_lenient"})
    strict_cells = common.delayed_strict_cells(trials)
    merged_p = primary.merge(
        lenient_cells[["pid", "schedule", "fmt", "acc_lenient"]],
        on=["pid", "schedule", "fmt"], how="outer")
    if not strict_cells.empty:
        merged_p = merged_p.merge(
            strict_cells[["pid", "schedule", "fmt", "acc_strict"]],
            on=["pid", "schedule", "fmt"], how="outer")
    else:
        merged_p["acc_strict"] = np.nan
    psum = (merged_p.groupby(["schedule", "fmt"])
                    .agg(acc_primary=("acc_primary", "mean"),
                         acc_lenient=("acc_lenient", "mean"),
                         acc_strict=("acc_strict", "mean"),
                         n_participants=("pid", "nunique")).reset_index())
    prim_path = os.path.join(out, "42i_primary_scoring.csv")
    with open(prim_path, "w", newline="", encoding="utf-8") as fh:
        fh.write(f"PRIMARY composite scoring rule (QFULL_PRIMARY_RULE = "
                 f"'{common.QFULL_PRIMARY_RULE}', pending AB sign-off): "
                 f"Q-blank = stored lenient, Q-full = strict re-score.\n")
        fh.write("Per-participant cells (primary vs pure-lenient vs pure-strict)\n")
        merged_p.round(4).to_csv(fh, index=False)
        fh.write("\nCell means over participants\n")
        psum.round(4).to_csv(fh, index=False)
    print(f"\nPrimary-rule delayed accuracy (Q-full rule = "
          f"'{common.QFULL_PRIMARY_RULE}'):")
    for _, r in psum.iterrows():
        print(f"  {r['schedule']:<6} {r['fmt']:<5}  primary={r['acc_primary']:.3f}  "
              f"lenient={r['acc_lenient']:.3f}  strict={r['acc_strict']:.3f}")
    print(f"  wrote {prim_path}")

    flips = common.scoring_flip_counts(trials)
    if not flips.empty:
        flips.to_csv(os.path.join(out, "42i_scoring_flips.csv"), index=False)
        print("  Lenient/strict flip counts per question type:")
        for _, r in flips.iterrows():
            print(f"    {r['qtype']:<8} n={int(r['n_trials'])}  "
                  f"lenient-correct={int(r['n_lenient_correct'])}  "
                  f"strict-correct={int(r['n_strict_correct'])}  "
                  f"flips lenient-only={int(r['n_flips_lenient_only'])}  "
                  f"strict-only={int(r['n_flips_strict_only'])}")
        print(f"  wrote {os.path.join(out, '42i_scoring_flips.csv')}")

    # ── (6) last-practice recency, descriptive only ──────────────────────────
    _, recency_summ = common.last_practice_recency(trials)
    if not recency_summ.empty:
        recency_summ.round(1).to_csv(
            os.path.join(out, "42i_recency_descriptives.csv"), index=False)
        print("\nLast-practice recency at the delayed test (hours since the item "
              "was last practised):")
        for _, r in recency_summ.iterrows():
            print(f"  {r['schedule']:<6} {r['fmt']:<5}  mean={r['mean_h']:.0f}h  "
                  f"median={r['median_h']:.0f}h  range=[{r['min_h']:.0f}, "
                  f"{r['max_h']:.0f}]h  (n={int(r['n'])})")
        print("  NOTE: the schedule x format interaction is NOT interpretable as "
              "format sensitivity\n  without this recency picture in view -- "
              "spaced items (especially Q-full, drawn from\n  Sessions 1-3) were "
              "last practised much longer before the test than massed items.\n"
              "  Descriptive table only; no recency covariate model is fitted "
              "(pre-specified).")
        print(f"  wrote {os.path.join(out, '42i_recency_descriptives.csv')}")

    # ── (7) list null-check: C-1 vs C-2 (counterbalance nuisance test) ───────
    # Reports mean delayed accuracy per practice list (C-1, C-2) and fits a
    # mixed ANOVA on delayed accuracy with schedule as the within-subjects
    # factor and counterbalance option as the between-subjects factor. A list
    # difficulty difference would appear as the option main effect or the
    # schedule x option interaction.
    list_path = os.path.join(out, "42i_list_check.csv")
    d_lists = common.delayed_trials(trials)
    by_group = (d_lists.groupby(["pid", "group_id"])["correct"].mean()
                .rename("acc").reset_index()
                .groupby("group_id")["acc"]
                .agg(mean_acc="mean", sem=common.sem, n_participants="count")
                .reset_index())
    opt = trials.groupby("pid")["option_id"].first().rename("option_id")
    mixed_long = (common.delayed_collapsed(trials)
                  .melt(id_vars="pid", value_vars=["spaced", "massed"],
                        var_name="schedule", value_name="acc")
                  .merge(opt, on="pid", how="left"))
    with open(list_path, "w", newline="", encoding="utf-8") as fh:
        fh.write("List null-check: is one practice list (C-1 vs C-2) easier? "
                 "Expected null; a list-difficulty artifact would surface as the "
                 "schedule x option interaction below.\n")
        fh.write("Pooled delayed accuracy by list (participant means)\n")
        by_group.round(4).to_csv(fh, index=False)
        print("\nList null-check (delayed accuracy by list):")
        for _, r in by_group.iterrows():
            print(f"  {r['group_id']}: mean acc = {r['mean_acc']:.3f} "
                  f"(n={int(r['n_participants'])})")
        try:
            import pingouin as pg
            mixed = pg.mixed_anova(data=mixed_long.dropna(subset=["acc", "option_id"]),
                                   dv="acc", within="schedule",
                                   between="option_id", subject="pid")
            fh.write("\nMixed ANOVA: schedule (within) x counterbalance option "
                     "(between)  [pingouin.mixed_anova]\n")
            mixed.to_csv(fh, index=False)
            print("  Mixed ANOVA (schedule within x option between):")
            for _, r in mixed.iterrows():
                # pingouin's p column name drifted across versions (p-unc/p_unc)
                pval = r.get("p-unc", r.get("p_unc", np.nan))
                print(f"    {r['Source']:<12} F({int(r['DF1'])},{int(r['DF2'])}) = "
                      f"{r['F']:.3f}, p = {pval:.4f}")
            print("  (option main effect and schedule x option interaction are "
                  "the null-nuisance checks)")
        except ImportError:
            fh.write("\nMixed ANOVA skipped: pingouin is needed for "
                     "pingouin.mixed_anova. Install it with: pip install pingouin\n")
            print("  Mixed ANOVA skipped: pingouin is needed "
                  "(pip install pingouin).")
        except Exception as exc:
            fh.write(f"\nMixed ANOVA could not run: {exc}\n")
            print(f"  Mixed ANOVA could not run: {exc}")
    print(f"  wrote {list_path}")

    # ── plot + manifest ──────────────────────────────────────────────────────
    plot_advantage(collapsed, os.path.join(out, "42i_per_participant_advantage.png"))
    manifest.to_csv(os.path.join(out, "42i_sample_manifest.csv"), index=False)
    print("\nDone.")


if __name__ == "__main__":
    main()
