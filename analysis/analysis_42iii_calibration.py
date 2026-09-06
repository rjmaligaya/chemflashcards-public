"""
4.2.iii  --  Calibration and the forced-choice illusion
=======================================================

WHAT THIS REPORTS  (three related pieces of metacognition)
----------------------------------------------------------
(a) Per-item confidence vs correctness
    On each practice trial the participant rated confidence 1-4 (Guess, Unsure,
    Fairly sure, Certain). We report accuracy at each confidence level and the
    within-participant Goodman-Kruskal gamma between confidence and correctness
    (the standard "resolution" measure: does higher confidence track being right?).

(b) Pre-session predictions vs realized accuracy
    Before each practice session the participant predicted how many of the 12
    items they'd get right on the first try. We compare that prediction to the
    realized first-pass-correct count (bias = predicted - actual).

(c) Forced-choice set preference vs each participant's own delayed advantage
    At Day 4 and Day 14 the participant chose which set (A = spaced, B = massed,
    or "same") they thought they'd remember / did remember better. We line that
    choice up against their actual spaced-minus-massed advantage on the delayed
    test, and report how often the stated preference matched reality -- both as
    the per-participant agreement (CAVEATED SECONDARY) and as the group-level
    Kornell-style contingency of judged-better vs actually-better set.

SCOPE RULE (pre-specified): every per-item calibration metric uses FIRST-PASS
PRACTICE trials only (retry_attempt == 1, practice sessions, never the delayed
test). Retries would double-count items the participant just saw, and delayed
trials carry no confidence prompt by design.

Also here: the timeout-transparency table, the bias-vs-resolution split, the
confidence/prediction trajectory by schedule (EXPLORATORY), and the
Holm-corrected p-value family for the metacognitive tests.

OUTPUTS (written to the --out folder)
  * 42iii_confidence_calibration.csv
  * 42iii_prediction_calibration.csv
  * 42iii_forced_choice_vs_advantage.csv
  * 42iii_setpref_contingency.csv      group-level judged vs actual + the
                                       prospective->retrospective shift table
  * 42iii_timeout_audit_summary.csv    timeout taxonomy + calibration exclusions
  * 42iii_trajectory.csv               confidence/prediction by session position
  * 42iii_holm_family.csv              raw + Holm-adjusted metacognitive p-values
  * 42iii_calibration.png   (3-panel figure)
  * 42iii_trajectory.png    (2-panel figure)

RUN
    python analysis_42iii_calibration.py --data path/to/export.xlsx
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


# ── the pre-specified base for per-item calibration: first-pass practice ─────

def first_pass_practice(trials: pd.DataFrame) -> pd.DataFrame:
    """
    FIRST-PASS PRACTICE trials only: retry_attempt == 1 and a practice session
    label (never the delayed test). This is the pre-specified base for every
    per-item calibration metric -- retries would let one item contribute several
    ratings made seconds apart, and delayed-test trials carry no confidence
    prompt by design.
    """
    fp = trials[trials["session_label"].isin(common.PRACTICE_LABELS)
                & (trials["retry_attempt"] == 1)].copy()
    if "phase" in fp.columns:
        fp = fp[fp["phase"] != common.DELAYED_PHASE]
    # belt and braces: fail loudly if the restriction is ever broken
    assert (fp["retry_attempt"] == 1).all(), "non-first-pass trial slipped in"
    assert fp["session_label"].isin(common.PRACTICE_LABELS).all(), \
        "non-practice trial slipped in"
    return fp


# ── (a) confidence vs correctness ────────────────────────────────────────────

def gk_gamma(conf, correct) -> float:
    """Goodman-Kruskal gamma between ordinal confidence and binary correctness."""
    conf = np.asarray(conf, dtype=float)
    correct = np.asarray(correct, dtype=float)
    C = D = 0
    n = len(conf)
    for i in range(n):
        for j in range(i + 1, n):
            dc = conf[i] - conf[j]
            do = correct[i] - correct[j]
            if dc == 0 or do == 0:
                continue
            if (dc > 0) == (do > 0):
                C += 1
            else:
                D += 1
    return (C - D) / (C + D) if (C + D) else float("nan")


def confidence_calibration(fp: pd.DataFrame):
    """
    Per-item confidence vs correctness over FIRST-PASS PRACTICE trials (the
    caller passes first_pass_practice(trials)).

    Splits calibration into its two standard components:
      * BIAS       -- mean scaled confidence minus accuracy, per participant.
                      Confidence 1-4 is scaled to 0-1 as (c - 1) / 3; that is a
                      REPORTING CONVENTION (mapping the endpoints "Guess" and
                      "Certain" onto 0 and 1), not a measured probability.
                      Positive = overconfident.
      * RESOLUTION -- Goodman-Kruskal gamma: does higher confidence track being
                      right, regardless of the overall level?
    A participant can be biased with perfect resolution, or the reverse, so the
    two components are reported separately.

    Returns (per_level_table, summary_dict, per_participant_frame) where the
    per-participant frame has pid, gamma, bias, n_rated.
    """
    assert (fp["retry_attempt"] == 1).all(), \
        "calibration must run on first-pass practice trials only"
    c = fp[fp["confidence"].notna() & fp["correct"].notna()].copy()
    if c.empty:
        return pd.DataFrame(), {}, pd.DataFrame()

    labels = {1: "1 Guess", 2: "2 Unsure", 3: "3 Fairly sure", 4: "4 Certain"}
    per_level = (c.groupby("confidence")["correct"]
                   .agg(n="size", accuracy="mean").reset_index())
    per_level["confidence_label"] = per_level["confidence"].map(labels)

    rows = []
    for pid, g in c.groupby("pid"):
        # gamma needs variation in confidence; otherwise it is undefined (NaN)
        gamma = (gk_gamma(g["confidence"], g["correct"])
                 if g["confidence"].nunique() >= 2 else float("nan"))
        bias = float(((g["confidence"] - 1) / 3.0).mean() - g["correct"].mean())
        rows.append((pid, gamma, bias, len(g)))
    per_pp = pd.DataFrame(rows, columns=["pid", "gamma", "bias", "n_rated"])

    defined = per_pp["gamma"].dropna()
    summary = dict(
        n_participants=int(per_pp["pid"].nunique()),
        mean_gamma=float(defined.mean()) if len(defined) else float("nan"),
        sem_gamma=common.sem(defined),
        n_gamma_undefined=int(per_pp["gamma"].isna().sum()),
        mean_bias=float(per_pp["bias"].mean()),
        sem_bias=common.sem(per_pp["bias"]),
        # one-sample t: is the group over- or under-confident (bias != 0)?
        bias_ttest=spss.one_sample_ttest(per_pp["bias"], popmean=0.0))
    return per_level, summary, per_pp


# ── (b) predictions vs realized ──────────────────────────────────────────────

def prediction_calibration(trials: pd.DataFrame, predictions: pd.DataFrame):
    """Merge each pre-session prediction with the realized first-pass-correct
    count for that session. Returns (per_session_table, summary)."""
    if predictions.empty:
        return pd.DataFrame(), {}

    p = trials[trials["session_label"].isin(common.PRACTICE_LABELS)]
    fp = p[(p["retry_attempt"] == 1) & (p["correct"].notna())]
    realized = (fp.groupby(["pid", "session_label"])["correct"]
                  .agg(realized_correct="sum", n_items="size").reset_index())

    merged = predictions.rename(columns={"value": "predicted_correct"}) \
        .merge(realized, on=["pid", "session_label"], how="inner")
    if merged.empty:
        return merged, {}
    merged["bias"] = merged["predicted_correct"] - merged["realized_correct"]

    summary = dict(
        n_obs=len(merged),
        mean_predicted=float(merged["predicted_correct"].mean()),
        mean_realized=float(merged["realized_correct"].mean()),
        mean_bias=float(merged["bias"].mean()),
        sem_bias=common.sem(merged["bias"]))
    # SPSS one-sample t: is the prediction bias different from 0 (over/under)?
    summary["bias_ttest"] = spss.one_sample_ttest(merged["bias"], popmean=0.0)
    # SPSS bivariate Pearson correlation: predicted vs realized
    summary["corr"] = spss.pearson_corr(merged["predicted_correct"],
                                        merged["realized_correct"])
    return merged.sort_values(["pid", "session_label"]), summary


# ── (c) forced-choice preference vs actual advantage ─────────────────────────

def forced_choice_vs_advantage(trials: pd.DataFrame, forced: pd.DataFrame):
    """Line up each forced choice against the participant's actual delayed
    spaced-minus-massed advantage. Returns (table, agreement_summary)."""
    if forced.empty:
        return pd.DataFrame(), {}

    adv = common.delayed_collapsed(trials)[["pid", "advantage"]]
    fc = forced.copy()
    fc["predicted_better"] = fc["choice"].map(common.FORCED_CHOICE_TO_SCHEDULE)
    merged = fc.merge(adv, on="pid", how="left")

    # Maps a signed delayed advantage onto the schedule that actually did better.
    def actual_better(a):
        if pd.isna(a):
            return "unknown"
        if a > 0:
            return "spaced"
        if a < 0:
            return "massed"
        return "same"

    merged["actual_better"] = merged["advantage"].map(actual_better)
    # a choice "matches" if the participant named the schedule that was in fact
    # better; "same" choices match only when the advantage is exactly zero.
    merged["match"] = merged["predicted_better"] == merged["actual_better"]

    summary = {}
    for cp, g in merged.groupby("checkpoint"):
        scorable = g[g["actual_better"] != "unknown"]
        entry = dict(
            n=len(scorable),
            agreement_rate=float(scorable["match"].mean()) if len(scorable) else float("nan"))
        # SPSS crosstab chi-square: stated preference x which schedule was better
        if len(scorable) and scorable["predicted_better"].nunique() > 1 \
                and scorable["actual_better"].nunique() > 1:
            entry["chi2"] = spss.crosstab_chi2(scorable["predicted_better"],
                                               scorable["actual_better"])
        summary[cp] = entry
    return merged.sort_values(["checkpoint", "pid"]), summary


# ── (d) Kornell-style group contingency + prospective->retrospective shift ───

def _checkpoint_kind(cp: str) -> str:
    """Classify a forced-choice checkpoint label as the Day-4 (prospective)
    or delayed (retrospective) occasion. Matches on words, not digits, because
    'day_14_delayed' also contains a '4'."""
    low = str(cp).lower()
    if "immediate" in low or "day_4" in low.replace("day_14", ""):
        return "prospective"
    if "delayed" in low or "14" in low:
        return "retrospective"
    return "unknown"


def setpref_contingency(fc_table: pd.DataFrame):
    """
    Group-level (Kornell-style) view of the set preference: a contingency table
    of judged-better-set vs actually-better-set at each occasion (Day-4
    prospective, delayed retrospective), plus the shift table showing who
    changed their choice after actually taking the test. Built on the merged
    per-choice table from forced_choice_vs_advantage. Returns
    (contingencies_by_kind, chi2_by_kind, shift_table_or_None).
    """
    if fc_table.empty:
        return {}, {}, None
    fc = fc_table.copy()
    fc["kind"] = fc["checkpoint"].map(_checkpoint_kind)

    contingencies, chi2s = {}, {}
    for kind in ("prospective", "retrospective"):
        g = fc[(fc["kind"] == kind) & (fc["actual_better"] != "unknown")]
        if g.empty:
            continue
        contingencies[kind] = pd.crosstab(
            g["predicted_better"].rename("judged_better"),
            g["actual_better"].rename("actually_better"), margins=True)
        if g["predicted_better"].nunique() > 1 and g["actual_better"].nunique() > 1:
            chi2s[kind] = spss.crosstab_chi2(g["predicted_better"],
                                             g["actual_better"])

    # shift: one row per participant with both occasions; did the choice change
    # after experiencing the delayed test?
    both = (fc[fc["kind"].isin(["prospective", "retrospective"])]
            .pivot_table(index="pid", columns="kind", values="predicted_better",
                         aggfunc="first"))
    shift = None
    if {"prospective", "retrospective"}.issubset(both.columns):
        both = both.dropna(subset=["prospective", "retrospective"])
        if not both.empty:
            shift = pd.crosstab(both["prospective"].rename("day4_choice"),
                                both["retrospective"].rename("delayed_choice"),
                                margins=True)
    return contingencies, chi2s, shift


# ── (e) confidence / prediction trajectory by schedule (EXPLORATORY) ─────────

def _label_index(label: str) -> float:
    """spaced-S3 -> 3, massed-B2 -> 2 (session/block position)."""
    try:
        return float(str(label).split("-")[1][1:])
    except Exception:
        return float("nan")


def _slope(x, y) -> float:
    """OLS slope of y on x; NaN when there are fewer than 2 points."""
    d = pd.DataFrame({"x": x, "y": y}).dropna()
    if len(d) < 2 or d["x"].nunique() < 2:
        return float("nan")
    return float(np.polyfit(d["x"], d["y"], 1)[0])


def trajectory_by_schedule(fp: pd.DataFrame, predictions: pd.DataFrame):
    """
    Does confidence grow differently across the four retrieval positions under
    the two schedules? EXPLORATORY. Two data streams:
      * per-item confidence: mean first-pass confidence per session position;
      * pre-session predictions: the predicted first-pass-correct count.
    Returns (group_means, slopes_wide, tests) where group_means is a long frame
    (measure, schedule, idx, mean, sem, n), slopes_wide has one row per pid per
    measure with spaced/massed slopes, and tests maps measure -> paired-t dict.
    """
    fp = fp.copy()
    fp["idx"] = fp["session_label"].map(_label_index)
    fp["schedule"] = np.where(fp["session_label"].isin(common.SPACED_LABELS),
                              "spaced", "massed")

    streams = {}
    conf = fp[fp["confidence"].notna()]
    if not conf.empty:
        streams["confidence"] = (conf.groupby(["pid", "schedule", "idx"])
                                 ["confidence"].mean().rename("value")
                                 .reset_index())
    if not predictions.empty:
        pr = predictions.copy()
        pr["idx"] = pr["session_label"].map(_label_index)
        pr["schedule"] = np.where(pr["session_label"].isin(common.SPACED_LABELS),
                                  "spaced", "massed")
        pr = pr[pr["session_label"].isin(common.PRACTICE_LABELS)]
        streams["prediction"] = (pr.rename(columns={"value": "value"})
                                 [["pid", "schedule", "idx", "value"]])

    means_rows, slope_frames, tests = [], [], {}
    for measure, df in streams.items():
        gm = (df.groupby(["schedule", "idx"])["value"]
              .agg(mean="mean", sem=common.sem, n="count").reset_index()
              .assign(measure=measure))
        means_rows.append(gm)
        # select the two columns first so this works on any pandas 2.x
        sl = (df.groupby(["pid", "schedule"])[["idx", "value"]]
              .apply(lambda g: _slope(g["idx"], g["value"]))
              .rename("slope").reset_index()
              .pivot_table(index="pid", columns="schedule", values="slope"))
        for col in ("spaced", "massed"):
            if col not in sl.columns:
                sl[col] = np.nan
        sl = sl.reset_index().assign(measure=measure)
        slope_frames.append(sl[["pid", "measure", "spaced", "massed"]])
        tests[measure] = spss.paired_ttest(sl["spaced"], sl["massed"],
                                           "spaced", "massed")

    group_means = (pd.concat(means_rows, ignore_index=True)
                   [["measure", "schedule", "idx", "mean", "sem", "n"]]
                   if means_rows else pd.DataFrame())
    slopes = (pd.concat(slope_frames, ignore_index=True)
              if slope_frames else pd.DataFrame())
    return group_means, slopes, tests


def plot_trajectory(group_means: pd.DataFrame, out_png: str) -> None:
    """2-panel line figure matching the house plot style."""
    plt = common.get_matplotlib()
    if plt is None or group_means.empty:
        return
    colors = {"spaced": "#3a7ca5", "massed": "#c1666b"}
    titles = {"confidence": "Mean per-item confidence (1-4)",
              "prediction": "Mean pre-session prediction (0-12)"}
    measures = [m for m in ("confidence", "prediction")
                if m in set(group_means["measure"])]
    fig, axes = plt.subplots(1, max(len(measures), 1), figsize=(10, 4.4))
    if len(measures) <= 1:
        axes = [axes]
    for ax, measure in zip(axes, measures):
        s = group_means[group_means["measure"] == measure]
        for sched in ("spaced", "massed"):
            sub = s[s["schedule"] == sched].sort_values("idx")
            if sub.empty:
                continue
            ax.errorbar(sub["idx"], sub["mean"], yerr=sub["sem"], marker="o",
                        capsize=3, color=colors[sched], label=sched)
        ax.set_title(titles.get(measure, measure))
        ax.set_xlabel("Retrieval position (Session/Block 1-4)")
        ax.set_xticks([1, 2, 3, 4])
        ax.legend()
    fig.suptitle("4.2.iii  Metacognitive trajectory by schedule (EXPLORATORY)",
                 fontsize=12)
    fig.tight_layout(rect=[0, 0, 1, 0.93])
    fig.savefig(out_png, dpi=150)
    plt.close(fig)
    print(f"  wrote {out_png}")


# ── timeout transparency ─────────────────────────────────────────────────────

def timeout_transparency(trials: pd.DataFrame, fp: pd.DataFrame):
    """
    The three-case timeout taxonomy (empty / correct / wrong) over the analysis
    sample, plus the count of confidence-null timeouts the calibration excludes.
    Each timed-out trial is classified as empty (a lenient-normalized blank
    answer), correct (stored score of 1), or wrong (non-empty and scored 0). The
    counts are re-derived from whichever export is passed in, so the exclusion
    is auditable on every dataset rather than fixed at one.
    Returns (summary_frame, n_confnull_excluded).
    """
    to = trials[trials.get("timed_out") == 1].copy()
    rows = []
    if to.empty:
        rows.append(dict(scope="all analysis-sample trials",
                         case="(no timeouts in this export)", n=0))
        n_confnull = 0
    else:
        empty_ans = to["raw_answer"].map(common.norm_lenient) == "" \
            if "raw_answer" in to.columns else pd.Series(False, index=to.index)
        case = np.select(
            [empty_ans, to["correct"] == 1],
            ["empty (true non-response)", "correct (stored score)"],
            default="wrong (non-empty)")
        to["case"] = case
        for c, n in to["case"].value_counts().items():
            rows.append(dict(scope="all analysis-sample trials", case=c, n=int(n)))
        # the calibration base is first-pass practice; count what it excludes
        fp_to = fp[(fp.get("timed_out") == 1) & fp["confidence"].isna()]
        n_confnull = int(len(fp_to))
    rows.append(dict(scope="calibration exclusions",
                     case="confidence-null timeouts (first-pass practice)",
                     n=n_confnull))
    return pd.DataFrame(rows), n_confnull


# ── plotting ─────────────────────────────────────────────────────────────────

# Draws the three-panel calibration figure and saves it to out_png.
def plot_all(per_level, pred_table, fc_table, out_png):
    plt = common.get_matplotlib()
    if plt is None:
        return
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.6))

    # panel (a): accuracy by confidence level
    ax = axes[0]
    if not per_level.empty:
        ax.bar(per_level["confidence"], per_level["accuracy"], color="#3a7ca5")
        for _, r in per_level.iterrows():
            ax.text(r["confidence"], r["accuracy"] + 0.02, f"n={int(r['n'])}",
                    ha="center", fontsize=8)
        ax.set_ylim(0, 1.05)
        ax.set_xticks([1, 2, 3, 4])
        ax.set_xlabel("Confidence (1 Guess … 4 Certain)")
        ax.set_ylabel("Accuracy")
    ax.set_title("(a) Accuracy by confidence")

    # panel (b): predicted vs realized first-pass correct
    ax = axes[1]
    if not pred_table.empty:
        ax.scatter(pred_table["predicted_correct"], pred_table["realized_correct"],
                   alpha=0.6, color="#3a7ca5")
        lim = [0, max(12, pred_table[["predicted_correct", "realized_correct"]]
                      .max().max() + 1)]
        ax.plot(lim, lim, "--", color="#888", label="perfect calibration")
        ax.set_xlim(lim); ax.set_ylim(lim)
        ax.set_xlabel("Predicted first-pass correct")
        ax.set_ylabel("Realized first-pass correct")
        ax.legend()
    ax.set_title("(b) Prediction vs reality")

    # panel (c): delayed advantage colored by Day-14 forced choice
    ax = axes[2]
    if not fc_table.empty:
        d14 = fc_table[fc_table["checkpoint"] == "day_14_delayed"] \
            .dropna(subset=["advantage"]).sort_values("advantage")
        cmap = {"spaced": "#3a7ca5", "massed": "#c1666b", "same": "#999999"}
        if not d14.empty:
            colors = [cmap.get(pb, "#999999") for pb in d14["predicted_better"]]
            ax.bar(range(len(d14)), d14["advantage"], color=colors)
            ax.axhline(0, color="#444", linewidth=1)
            ax.set_xticks(range(len(d14)))
            ax.set_xticklabels(d14["pid"], rotation=60, ha="right", fontsize=7)
            ax.set_ylabel("Delayed advantage (spaced − massed)")
            handles = [plt.Rectangle((0, 0), 1, 1, color=cmap[k])
                       for k in ("spaced", "massed", "same")]
            ax.legend(handles, ["chose spaced (Set A)", "chose massed (Set B)",
                                "chose same"], fontsize=8)
    ax.set_title("(c) Day-14 choice vs actual advantage")

    fig.suptitle("4.2.iii  Calibration & the forced-choice illusion", fontsize=13)
    fig.tight_layout(rect=[0, 0, 1, 0.95])
    fig.savefig(out_png, dpi=150)
    plt.close(fig)
    print(f"  wrote {out_png}")


# ── main ─────────────────────────────────────────────────────────────────────

# Runs the full 4.2.iii analysis and writes every table, figure, and .sav file.
def main() -> None:
    ap = argparse.ArgumentParser(description="4.2.iii calibration")
    ap.add_argument("--data", required=True,
                    help="export .xlsx workbook OR folder of per-table CSVs")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = common.ensure_outdir(
        args.out or os.path.join(
            args.data if os.path.isdir(args.data) else os.path.dirname(args.data)
            or ".", "results_4_2"))

    tables = common.load_export(args.data)
    trials, extra, manifest = common.filter_to_analysis_sample(
        tables["trials"],
        {"predictions": tables["predictions"], "forced_choices": tables["forced_choices"]})
    predictions = extra["predictions"]
    forced = extra["forced_choices"]

    common.banner("4.2.iii  Calibration & the forced-choice illusion")
    print(f"Analysis sample: {int(manifest['included'].sum())} participant(s).")
    if trials.empty:
        print("No trials in the analysis sample; nothing to calibrate.")
        return

    # All per-item calibration metrics run on FIRST-PASS PRACTICE trials only
    # (pre-specified; see first_pass_practice above).
    fp = first_pass_practice(trials)
    print(f"Calibration base: {len(fp)} first-pass practice trial(s) "
          f"(retries and the delayed test excluded by rule).")

    # collect the metacognitive p-values as we go, for the Holm family at the end
    family: dict[str, float] = {}

    # (a) confidence vs correctness -- bias and resolution, separately
    per_level, gsum, per_pp = confidence_calibration(fp)
    if not per_level.empty:
        per_level.to_csv(os.path.join(out, "42iii_confidence_calibration.csv"),
                         index=False)
        print("\n(a) Accuracy by confidence level (first-pass practice):")
        for _, r in per_level.iterrows():
            print(f"    {r['confidence_label']:<15} acc={r['accuracy']:.3f} "
                  f"(n={int(r['n'])})")
        if gsum.get("n_participants"):
            print(f"    RESOLUTION: within-participant gamma = "
                  f"{gsum['mean_gamma']:+.3f} (SE {gsum['sem_gamma']:.3f}, "
                  f"n={gsum['n_participants']}, "
                  f"undefined for {gsum['n_gamma_undefined']})")
            # bias: scaled confidence (c-1)/3 minus accuracy; positive = overconfident
            print(f"    BIAS: mean scaled-confidence minus accuracy = "
                  f"{gsum['mean_bias']:+.3f} (SE {gsum['sem_bias']:.3f}; "
                  f"positive = overconfident)")
            bt = gsum["bias_ttest"]
            if not np.isnan(bt.get("t", np.nan)):
                print(f"      bias vs 0: t({bt['df']}) = {bt['t']:.3f}, "
                      f"Sig.(2-tailed) = {bt['p_2tailed']:.4f}")
            family["calibration_bias_vs_0"] = bt.get("p_2tailed", np.nan)
    else:
        print("\n(a) No confidence ratings present; skipped.")

    # (b) predictions vs realized
    pred_table, psum = prediction_calibration(trials, predictions)
    if not pred_table.empty:
        pred_table.to_csv(os.path.join(out, "42iii_prediction_calibration.csv"),
                          index=False)
        print("\n(b) Pre-session prediction vs realized first-pass correct:")
        print(f"    mean predicted = {psum['mean_predicted']:.2f}, "
              f"mean realized = {psum['mean_realized']:.2f}, "
              f"mean bias = {psum['mean_bias']:+.2f} (SE {psum['sem_bias']:.2f})")
        bt = psum["bias_ttest"]
        if not np.isnan(bt.get("t", np.nan)):
            print(f"    {bt['spss']}")
            print(f"      bias vs 0: t({bt['df']}) = {bt['t']:.3f}, "
                  f"Sig.(2-tailed) = {bt['p_2tailed']:.4f}")
        cr = psum["corr"]
        if not np.isnan(cr.get("r", np.nan)):
            print(f"    {cr['spss']}")
            print(f"      predicted-vs-realized r = {cr['r']:.3f}, "
                  f"Sig.(2-tailed) = {cr['p_2tailed']:.4f} (n={cr['n']})")
        family["prediction_bias_vs_0"] = psum["bias_ttest"].get("p_2tailed", np.nan)
        family["prediction_vs_realized_corr"] = psum["corr"].get("p_2tailed", np.nan)
    else:
        print("\n(b) No prediction data present; skipped.")

    # (c) forced choice vs advantage -- per-participant view
    fc_table, fsum = forced_choice_vs_advantage(trials, forced)
    if not fc_table.empty:
        fc_table.to_csv(os.path.join(out, "42iii_forced_choice_vs_advantage.csv"),
                        index=False)
        # Per-checkpoint agreement rate: the proportion of forced choices whose
        # named schedule matches the sign of that participant's own delayed
        # advantage. Block (d) reports the group contingency of the same data.
        print("\n(c) CAVEATED SECONDARY: per-participant forced choice vs own "
              "delayed advantage:")
        for cp, s in fsum.items():
            rate = (f"{s['agreement_rate']:.2f}" if not np.isnan(s['agreement_rate'])
                    else "n/a")
            line = f"    {cp}: agreement rate = {rate} (n={s['n']})"
            chi = s.get("chi2")
            if chi and "chi2" in chi:
                line += (f"; {spss.SPSS_PROCEDURES['crosstab_chi2'].split(': ')[1]} "
                         f"chi2({chi['df']}) = {chi['chi2']:.2f}, p = {chi['p']:.4f}")
            print(line)
    else:
        print("\n(c) No forced-choice data present; skipped.")

    # (d) Kornell-style group contingency + prospective->retrospective shift
    contingencies, chi2s, shift = setpref_contingency(fc_table)
    if contingencies or shift is not None:
        sp_path = os.path.join(out, "42iii_setpref_contingency.csv")
        with open(sp_path, "w", newline="", encoding="utf-8") as fh:
            fh.write("Group-level set-preference contingency (Kornell-style): "
                     "judged-better set vs actually-better set, per occasion.\n")
            print("\n(d) Group contingency: judged-better vs actually-better set:")
            for kind in ("prospective", "retrospective"):
                tab = contingencies.get(kind)
                if tab is None:
                    continue
                occasion = ("Day-4 (prospective)" if kind == "prospective"
                            else "Delayed (retrospective)")
                fh.write(f"\n{occasion}: judged (rows) x actual (columns)\n")
                tab.to_csv(fh)
                print(f"    {occasion}:")
                print("      " + tab.to_string().replace("\n", "\n      "))
                chi = chi2s.get(kind)
                if chi and "chi2" in chi:
                    fh.write(f"chi2({chi['df']}) = {chi['chi2']:.3f}  "
                             f"p = {chi['p']:.4f}  n = {chi['n']}\n")
                    print(f"      chi2({chi['df']}) = {chi['chi2']:.2f}, "
                          f"p = {chi['p']:.4f}")
                    family[f"setpref_{kind}_chi2"] = chi.get("p", np.nan)
            if shift is not None:
                fh.write("\nProspective -> retrospective shift (who changed "
                         "their choice after taking the delayed test): Day-4 "
                         "choice (rows) x delayed choice (columns)\n")
                shift.to_csv(fh)
                # off-diagonal cells (ignoring the margins) = changed choices
                core = shift.drop(index="All", columns="All", errors="ignore")
                stayed = sum(core.loc[r, c] for r in core.index
                             for c in core.columns if r == c)
                total = int(core.to_numpy().sum())
                print(f"    Shift after the test: {total - stayed} of {total} "
                      f"changed their choice between Day 4 and the delayed test.")
        print(f"  wrote {sp_path}")

    # (e) EXPLORATORY: confidence / prediction trajectory by schedule
    traj_means, traj_slopes, traj_tests = trajectory_by_schedule(fp, predictions)
    if not traj_means.empty:
        print("\n(e) EXPLORATORY: metacognitive trajectory by schedule "
              "(retrieval position 1-4):")
        tr_path = os.path.join(out, "42iii_trajectory.csv")
        with open(tr_path, "w", newline="", encoding="utf-8") as fh:
            fh.write("EXPLORATORY: confidence / prediction by retrieval "
                     "position (Session/Block 1-4) and schedule.\n")
            fh.write("Group means\n")
            traj_means.round(4).to_csv(fh, index=False)
            fh.write("\nPer-participant OLS slopes (value ~ position), by schedule\n")
            traj_slopes.round(4).to_csv(fh, index=False)
            fh.write("\nPaired t on slopes (spaced vs massed)\n")
            for measure, res in traj_tests.items():
                _, tbl = spss.paired_ttest_tables(res, "spaced", "massed")
                fh.write(f"{measure}\n")
                tbl.to_csv(fh, index=False)
        for measure, res in traj_tests.items():
            if not np.isnan(res.get("t", np.nan)):
                print(f"    {measure} slope: spaced = {res['mean_spaced']:+.3f}, "
                      f"massed = {res['mean_massed']:+.3f}; "
                      f"t({res['df']}) = {res['t']:.3f}, "
                      f"Sig.(2-tailed) = {res['p_2tailed']:.4f}")
            family[f"trajectory_{measure}_slope"] = res.get("p_2tailed", np.nan)
        print(f"  wrote {tr_path}")
        plot_trajectory(traj_means, os.path.join(out, "42iii_trajectory.png"))

    # Timeout taxonomy over the analysis sample, plus the count of
    # confidence-null timeouts excluded from the calibration metrics.
    to_summary, n_confnull = timeout_transparency(trials, fp)
    to_summary.to_csv(os.path.join(out, "42iii_timeout_audit_summary.csv"),
                      index=False)
    print("\nTimeout transparency (analysis sample):")
    for _, r in to_summary.iterrows():
        print(f"    [{r['scope']}] {r['case']}: {int(r['n'])}")
    print("    (exclusion of confidence-null timeouts is the pre-specified "
          "primary handling;\n     the 2026-07-22 sweep found 0/32 timeouts "
          "correct, so exclusion cannot hide\n     miscalibration. Run "
          "analysis_timeout_audit.py for the full per-trial sweep.)")
    print(f"  wrote {os.path.join(out, '42iii_timeout_audit_summary.csv')}")

    # ── the Holm-corrected metacognitive family (pre-specified) ──────────────
    common.banner("Metacognitive family, Holm-corrected (pre-specified)")
    if family:
        adj = common.holm_adjust(family)
        fam_tbl = pd.DataFrame(
            [dict(test=name, p_raw=p_raw, p_holm=p_holm)
             for name, (p_raw, p_holm) in adj.items()])
        fam_tbl.to_csv(os.path.join(out, "42iii_holm_family.csv"), index=False)
        for _, r in fam_tbl.iterrows():
            raw = f"{r['p_raw']:.4f}" if not pd.isna(r['p_raw']) else "n/a"
            hol = f"{r['p_holm']:.4f}" if not pd.isna(r['p_holm']) else "n/a"
            print(f"    {r['test']:<34} p_raw = {raw}   p_holm = {hol}")
        print("    (Holm-Bonferroni step-down within the metacognitive DV "
              "family, decision 2026-07-22 #7)")
        print(f"  wrote {os.path.join(out, '42iii_holm_family.csv')}")
    else:
        print("    No metacognitive p-values were produced on this export; "
              "no family to correct.")

    # SPSS-ready data files so the calibration analyses can be reproduced in SPSS
    if not per_pp.empty:
        spss.write_sav(per_pp, os.path.join(out, "42iii_data_confidence_gamma.sav"),
                       labels={"gamma": "Goodman-Kruskal gamma (confidence vs correct)",
                               "bias": "Calibration bias: mean (conf-1)/3 minus accuracy"})
    if not pred_table.empty:
        spss.write_sav(pred_table[["pid", "session_label", "predicted_correct",
                                   "realized_correct", "bias"]],
                       os.path.join(out, "42iii_data_predictions.sav"))
    if not fc_table.empty:
        spss.write_sav(fc_table[["pid", "checkpoint", "choice", "confidence",
                                 "predicted_better", "advantage", "actual_better",
                                 "match"]],
                       os.path.join(out, "42iii_data_forced_choice.sav"))

    plot_all(per_level, pred_table, fc_table,
             os.path.join(out, "42iii_calibration.png"))
    print("\nDone.")


if __name__ == "__main__":
    main()
