"""
4.2.ii  --  Acquisition and automaticity curves
================================================

WHAT THIS REPORTS
-----------------
Three practice-time measures, tracked across the four SPACED sessions
(S1..S4) and the four MASSED blocks (B1..B4), as curves by schedule:
  * First-pass accuracy   -- proportion correct on the first attempt at each
                             item (retry_attempt == 1).
  * Trials to mastery     -- mean number of attempts before an item is answered
                             correctly (soft-capped items reported separately as
                             a soft-cap rate, since they never reached mastery).
  * Median retrieval latency -- median response time (rt_ms) of first-pass
                             CORRECT trials, i.e. how fast a correct retrieval is.

Each measure is computed per participant per session, then averaged across
participants (with standard error).

A note on the RT curve: during practice, a massed item was re-retrieved seconds
after its last appearance while a spaced item waited a day, so a massed RT
advantage during practice is TRIVIAL (near-term memory), not automaticity. The
practice-phase RT curve is therefore DESCRIPTIVE ONLY; the inferential RT test
lives at the delayed test (4.2.i / H4). The x-axis is retrieval position
(Session/Block 1-4), i.e. the n-th time the schedule's items were retrieved.

Also here:
  * the H2 crossover test -- a 2x2 RM ANOVA of PHASE (end-of-practice vs
    delayed) x SCHEDULE, whose interaction term is the massed-lead-then-reversal
    dissociation H2 predicts;
  * the within-spaced relearning curve (attempts-to-mastery by session
    position), with the massed values shown only as a structural-floor
    reference.

OUTPUTS (written to the --out folder)
  * 42ii_curves_summary.csv    long table: schedule, session_index, metric,
                               mean, sem, n_participants.
  * 42ii_per_participant.csv   the per-participant per-session values behind it.
  * 42ii_practice_curves.png   3-panel figure, one panel per measure.
  * 42ii_phase_schedule_interaction.csv  the H2 crossover test (per-pid cells
                               + the phase x schedule RM ANOVA).
  * 42ii_relearning_spaced.csv within-spaced attempts-to-mastery by session
                               position, massed floor + soft-cap counts.

RUN
    python analysis_42ii_acquisition_curves.py --data path/to/export.xlsx
"""

from __future__ import annotations
import argparse
import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import spss_compat as spss
import numpy as np
import pandas as pd


def _label_index(label: str) -> int | float:
    """spaced-S3 -> 3, massed-B2 -> 2."""
    try:
        return int(str(label).split("-")[1][1:])
    except Exception:
        return np.nan


def practice_frame(trials: pd.DataFrame) -> pd.DataFrame:
    """Practice trials only, tagged with schedule ('spaced'/'massed') and a
    1..4 session index, with rows lacking a scorable `correct` dropped."""
    p = trials[trials["session_label"].isin(common.PRACTICE_LABELS)].copy()
    p["schedule"] = np.where(p["session_label"].isin(common.SPACED_LABELS),
                             "spaced", "massed")
    p["idx"] = p["session_label"].map(_label_index)
    missing = p["correct"].isna().sum()
    if missing:
        warnings.warn(f"{missing} practice trial(s) had missing `correct`; "
                      f"dropped from accuracy/mastery measures.")
    return p


# ── the three per-participant, per-session measures ──────────────────────────

# Proportion correct on first attempts, per participant per schedule per session.
def first_pass_accuracy(p: pd.DataFrame) -> pd.DataFrame:
    fp = p[(p["retry_attempt"] == 1) & (p["correct"].notna())]
    return (fp.groupby(["pid", "schedule", "idx"])["correct"].mean()
              .rename("first_pass_accuracy").reset_index())


def trials_to_mastery(p: pd.DataFrame) -> pd.DataFrame:
    """
    Per (pid, session, item): the attempt number at which the item was first
    answered correctly. Items never answered correctly (soft-capped) are NaN.
    Aggregated to per (pid, session): mean attempts among mastered items, and
    the soft-cap rate (share of items that never reached mastery).
    """
    rows = []
    grp = p[p["correct"].notna()].groupby(["pid", "schedule", "idx", "item_id"])
    for (pid, sched, idx, _item), g in grp:
        correct_rows = g[g["correct"] == 1]
        attempt = (correct_rows["retry_attempt"].min()
                   if not correct_rows.empty else np.nan)
        rows.append((pid, sched, idx, attempt))
    per_item = pd.DataFrame(rows, columns=["pid", "schedule", "idx", "attempt"])
    if per_item.empty:
        return pd.DataFrame(columns=["pid", "schedule", "idx",
                                     "trials_to_mastery", "soft_cap_rate"])
    agg = (per_item.groupby(["pid", "schedule", "idx"])
                   .agg(trials_to_mastery=("attempt",
                                           lambda s: s.dropna().mean()),
                        soft_cap_rate=("attempt",
                                       lambda s: s.isna().mean()))
                   .reset_index())
    return agg


# Median rt_ms of first-pass correct trials, per participant per session.
def median_latency(p: pd.DataFrame) -> pd.DataFrame:
    # Exclude timed-out trials: their rt_ms is censored at the 20 s timeout, not a
    # measured latency (matches the chapter's reaction-time handling rule). A
    # correct-but-timed-out trial still counts for accuracy, just not for RT.
    fpc = p[(p["retry_attempt"] == 1) & (p["correct"] == 1)
            & (p["timed_out"] != 1) & p["rt_ms"].notna()]
    return (fpc.groupby(["pid", "schedule", "idx"])["rt_ms"].median()
               .rename("median_latency_ms").reset_index())


# ── aggregation across participants ──────────────────────────────────────────

# Mean, standard error, and n of one measure across participants, per cell.
def summarise(per_participant: pd.DataFrame, value_col: str) -> pd.DataFrame:
    return (per_participant.groupby(["schedule", "idx"])[value_col]
            .agg(mean="mean", sem=common.sem, n_participants="count")
            .reset_index().assign(metric=value_col))


# ── plotting ─────────────────────────────────────────────────────────────────

# Draws the three-panel practice-curve figure and saves it to out_png.
def plot_curves(summaries: dict[str, pd.DataFrame], out_png: str) -> None:
    plt = common.get_matplotlib()
    if plt is None:
        return
    titles = {
        "first_pass_accuracy": "First-pass accuracy",
        "trials_to_mastery":   "Trials to mastery",
        # RT during practice is descriptive only: massed items are re-retrieved
        # seconds apart, so a massed speed advantage here is trivial.
        "median_latency_ms":   "Median retrieval latency (ms)\n(descriptive only)",
    }
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.6))
    colors = {"spaced": "#3a7ca5", "massed": "#c1666b"}
    for ax, (metric, title) in zip(axes, titles.items()):
        s = summaries.get(metric)
        if s is None or s.empty:
            ax.set_title(f"{title}\n(no data)")
            continue
        for sched in ("spaced", "massed"):
            sub = s[s["schedule"] == sched].sort_values("idx")
            if sub.empty:
                continue
            ax.errorbar(sub["idx"], sub["mean"], yerr=sub["sem"], marker="o",
                        capsize=3, color=colors[sched],
                        label=f"{sched} (n={int(sub['n_participants'].max())})")
        ax.set_title(title)
        # "retrieval position": the n-th time this schedule's items were
        # retrieved, whether that took 4 days (spaced) or ~40 min (massed)
        ax.set_xlabel("Retrieval position (Session/Block 1-4)")
        ax.set_xticks([1, 2, 3, 4])
        ax.legend()
    axes[0].set_ylabel("value")
    fig.suptitle("4.2.ii  Acquisition & automaticity curves by schedule",
                 fontsize=13)
    fig.tight_layout(rect=[0, 0, 1, 0.95])
    fig.savefig(out_png, dpi=150)
    plt.close(fig)
    print(f"  wrote {out_png}")


# ── main ─────────────────────────────────────────────────────────────────────

# Runs the full 4.2.ii analysis and writes every table, figure, and .sav file.
def main() -> None:
    ap = argparse.ArgumentParser(description="4.2.ii acquisition curves")
    ap.add_argument("--data", required=True,
                    help="export .xlsx workbook OR folder of per-table CSVs")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = common.ensure_outdir(
        args.out or os.path.join(
            args.data if os.path.isdir(args.data) else os.path.dirname(args.data)
            or ".", "results_4_2"))

    tables = common.load_export(args.data)
    trials, _, manifest = common.filter_to_analysis_sample(tables["trials"])

    common.banner("4.2.ii  Acquisition & automaticity curves")
    print(f"Analysis sample: {int(manifest['included'].sum())} participant(s).")
    if trials.empty:
        print("No trials in the analysis sample; nothing to plot.")
        return

    p = practice_frame(trials)

    fpa = first_pass_accuracy(p)
    ttm = trials_to_mastery(p)
    lat = median_latency(p)

    # per-participant detail (merged wide) for transparency
    detail = fpa.merge(ttm, on=["pid", "schedule", "idx"], how="outer") \
                .merge(lat, on=["pid", "schedule", "idx"], how="outer") \
                .sort_values(["pid", "schedule", "idx"])
    detail.to_csv(os.path.join(out, "42ii_per_participant.csv"), index=False)
    # SPSS-ready long dataset (Analyze > GLM > Repeated Measures if you later
    # want to test session/schedule effects on these practice measures).
    spss.write_sav(detail, os.path.join(out, "42ii_data_curves.sav"))

    summaries = {
        "first_pass_accuracy": summarise(fpa, "first_pass_accuracy"),
        "trials_to_mastery":   summarise(ttm, "trials_to_mastery"),
        "median_latency_ms":   summarise(lat, "median_latency_ms"),
    }
    # soft-cap rate is a useful companion to trials-to-mastery; summarise too
    if not ttm.empty:
        summaries["soft_cap_rate"] = summarise(ttm, "soft_cap_rate")

    long = pd.concat(summaries.values(), ignore_index=True)
    long = long[["schedule", "idx", "metric", "mean", "sem", "n_participants"]]
    long.to_csv(os.path.join(out, "42ii_curves_summary.csv"), index=False)
    print(f"  wrote {os.path.join(out, '42ii_curves_summary.csv')}")
    print(f"  wrote {os.path.join(out, '42ii_per_participant.csv')}")

    # console preview
    for metric in ("first_pass_accuracy", "trials_to_mastery", "median_latency_ms"):
        s = summaries[metric]
        if s.empty:
            continue
        print(f"\n{metric}:")
        for sched in ("spaced", "massed"):
            vals = s[s["schedule"] == sched].sort_values("idx")
            pretty = ", ".join(f"{int(r.idx)}:{r['mean']:.2f}"
                               for _, r in vals.iterrows())
            if pretty:
                print(f"  {sched:<6} {pretty}")
    print("\nNOTE: the practice-phase RT curve is DESCRIPTIVE ONLY. Massed items "
          "are re-retrieved\nseconds apart, so a massed RT advantage during "
          "practice is trivial; the inferential\nRT contrast is at the delayed "
          "test (4.2.i, H4).")

    # ── H2 crossover test: phase x schedule interaction ──────────────────────
    # H2 predicts a dissociation: massed looks as good or better at the END of
    # practice (its items were just seen), but spaced wins at the DELAYED test.
    # That claim IS the interaction of phase (end-practice vs delayed) with
    # schedule -- so it is tested directly here, per participant:
    #   end-practice cell = first-pass accuracy on the 12 Session-4 / Block-4
    #                       practice items (the final practice pass);
    #   delayed cell      = accuracy on the 12 Q-blank retention items (the
    #                       same Session-4 instances), lenient scoring.
    common.banner("H2 crossover test (phase x schedule interaction)")
    end_prac = (fpa[fpa["idx"] == 4]
                .rename(columns={"first_pass_accuracy": "acc"})
                .assign(phase="end_practice")[["pid", "schedule", "phase", "acc"]])
    delayed_qb = (common.delayed_cell_means(trials)
                  .query("fmt == 'blank'")
                  .assign(phase="delayed")[["pid", "schedule", "phase", "acc"]])
    ps_long = pd.concat([end_prac, delayed_qb], ignore_index=True)

    if ps_long.empty or ps_long["pid"].nunique() < 2:
        print("Not enough data for the phase x schedule test; skipped.")
    else:
        ps_anova = spss.rm_anova(ps_long, dv="acc",
                                 within=["phase", "schedule"], subject="pid")
        ps_wide = (ps_long.pivot_table(index="pid",
                                       columns=["phase", "schedule"],
                                       values="acc"))
        ps_wide.columns = [f"acc_{ph}_{sc}" for ph, sc in ps_wide.columns]
        ps_wide = ps_wide.reset_index()
        ps_path = os.path.join(out, "42ii_phase_schedule_interaction.csv")
        with open(ps_path, "w", newline="", encoding="utf-8") as fh:
            fh.write("H2 crossover test: phase (end-of-practice vs delayed) x "
                     "schedule. The INTERACTION row is the dissociation test.\n")
            fh.write("Per-participant cells (end-practice = first-pass accuracy "
                     "on Session-4/Block-4 items; delayed = Q-blank retention "
                     "accuracy, lenient)\n")
            ps_wide.round(4).to_csv(fh, index=False)
            if not ps_anova.empty:
                fh.write("\nTests of Within-Subjects Effects (accuracy ~ phase * schedule)\n")
                ps_anova.drop(columns=["Error df"], errors="ignore").to_csv(fh, index=False)
                fh.write(f"\nSphericity note: {ps_anova.attrs.get('sphericity_note','')}\n")
        if not ps_anova.empty:
            for _, row in ps_anova.iterrows():
                print(f"  {row['Source']:<18} F({int(row['df'])},{int(row['Error df'])}) = "
                      f"{row['F']:.3f}, Sig. = {row['Sig.']:.4f}, "
                      f"partial eta^2 = {row['Partial Eta Squared']:.3f}")
            print("  (the phase * schedule row is H2's crossover)")
        print(f"  wrote {ps_path}")

    # ── within-spaced relearning curve + massed floor ────────────────────────
    # In the SPACED condition, session-to-session attempts-to-mastery is a real
    # relearning-acceleration curve: each session starts after ~a day of
    # forgetting, so falling attempts mean faster relearning. In the MASSED
    # condition the blocks are minutes apart -- there is no between-block
    # forgetting to recover from -- so near-1 attempt counts there are a
    # STRUCTURAL FLOOR, not evidence of efficient learning; they are reported
    # only as a descriptive reference.
    if not ttm.empty:
        sp_wide = (ttm[ttm["schedule"] == "spaced"]
                   .pivot_table(index="pid", columns="idx",
                                values="trials_to_mastery"))
        sp_wide.columns = [f"attempts_S{int(c)}" for c in sp_wide.columns]
        sp_wide = sp_wide.reset_index()
        ma_floor = (ttm[ttm["schedule"] == "massed"]
                    .groupby("idx")["trials_to_mastery"]
                    .agg(mean="mean", sem=common.sem, n_participants="count")
                    .reset_index())
        # soft-cap counts: rows with soft_capped == 1 mark items dropped after
        # MAX_RETRIES wrong attempts (one row per capped item per session)
        cap_counts = (p[p["soft_capped"] == 1]
                      .groupby("schedule").size().rename("n_soft_capped_items")
                      .reindex(["spaced", "massed"]).fillna(0).astype(int)
                      .reset_index())
        rl_path = os.path.join(out, "42ii_relearning_spaced.csv")
        with open(rl_path, "w", newline="", encoding="utf-8") as fh:
            fh.write("Within-SPACED relearning curve: mean attempts-to-mastery "
                     "per session position per participant.\n")
            sp_wide.round(3).to_csv(fh, index=False)
            fh.write("\nMassed reference (descriptive ONLY): near-1 values are a "
                     "structural floor -- blocks are minutes apart, so there is "
                     "no between-block forgetting to relearn from.\n")
            ma_floor.round(3).to_csv(fh, index=False)
            fh.write("\nSoft-capped items per schedule (soft_capped == 1; item "
                     "dropped after max retries)\n")
            cap_counts.to_csv(fh, index=False)
        print("\nRelearning (spaced attempts-to-mastery by session position):")
        means = (ttm[ttm["schedule"] == "spaced"]
                 .groupby("idx")["trials_to_mastery"].mean())
        print("  spaced " + ", ".join(f"S{int(i)}:{v:.2f}" for i, v in means.items()))
        print("  massed floor " + ", ".join(f"B{int(r['idx'])}:{r['mean']:.2f}"
                                            for _, r in ma_floor.iterrows())
              + "   (structural floor; descriptive only)")
        print("  soft-capped items: " +
              ", ".join(f"{r['schedule']}={int(r['n_soft_capped_items'])}"
                        for _, r in cap_counts.iterrows()))
        print(f"  wrote {rl_path}")

    plot_curves(summaries, os.path.join(out, "42ii_practice_curves.png"))
    print("\nDone.")


if __name__ == "__main__":
    main()
