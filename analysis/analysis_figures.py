"""
analysis_figures.py -- one standalone, fully-labelled figure per analysis.

WHY THIS EXISTS
---------------
The numbered scripts write result TABLES (plus two multi-panel compilation
figures). For reading, presenting, and thesis drafting it is easier to look at
one chart at a time, each self-contained: its own title, labelled axes with
units, a legend when there are two series, and consistent colors. This script
produces that set, into  <out>/figures/fig_*.png.

COLOR CONVENTION (fixed across every figure, chosen and validated for
color-vision deficiency and grayscale printing):
    SPACED = blue  (#2a78d6)     MASSED = orange (#eb6834)
    neutral gray for anything that is not a schedule (list check, timeout
    rate, the overall calibration curve).

Data rules mirror the numbered scripts exactly: analysis-sample filter
(dev excluded, 8-block completers), first-pass = retry_attempt 1, timeouts
excluded from every latency, lenient stored scoring unless a figure says
otherwise. Error bars are +/-1 standard error of the mean across participants.

RUN
    python analysis_figures.py --data path/to/export.xlsx [--out results]
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

C_SPACED, C_MASSED, C_NEUTRAL = "#2a78d6", "#eb6834", "#8a8984"
C_INK, C_GRID = "#0b0b0b", "#e4e3df"
SCHED_COLOR = {"spaced": C_SPACED, "massed": C_MASSED, "same": C_NEUTRAL}


# ── house style ──────────────────────────────────────────────────────────────

# Creates a figure and axis already carrying the house title, labels, and grid.
def new_fig(plt, title, xlabel, ylabel, subtitle=None, figsize=(6.5, 4.4)):
    fig, ax = plt.subplots(figsize=figsize)
    ax.set_title(title, fontsize=12, fontweight="bold", loc="left", pad=14 if subtitle else 8)
    if subtitle:
        ax.text(0, 1.02, subtitle, transform=ax.transAxes, fontsize=8.5,
                color="#52514e", va="bottom")
    ax.set_xlabel(xlabel, fontsize=10)
    ax.set_ylabel(ylabel, fontsize=10)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.grid(axis="y", color=C_GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.tick_params(labelsize=9)
    return fig, ax


# Writes a figure to outdir/name at 150 dpi and closes it.
def save(fig, outdir, name):
    path = os.path.join(outdir, name)
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor="white")
    print(f"  wrote {path}")
    import matplotlib.pyplot as plt
    plt.close(fig)


# Standard error of the mean, returning 0.0 for fewer than two values.
def sem(x):
    x = pd.Series(x).dropna()
    return float(x.std(ddof=1) / np.sqrt(len(x))) if len(x) > 1 else 0.0


# ── shared chart forms ───────────────────────────────────────────────────────

def slopegraph(plt, outdir, name, wide, title, ylabel, subtitle=None,
               percent=False, to_seconds=False):
    """Paired spaced-vs-massed chart: one thin line per participant, bold group
    means. `wide` needs columns pid, spaced, massed."""
    w = wide.dropna(subset=["spaced", "massed"]).copy()
    if to_seconds:
        w[["spaced", "massed"]] = w[["spaced", "massed"]] / 1000.0
    fig, ax = new_fig(plt, title, "Practice schedule", ylabel, subtitle)
    xs = [0, 1]
    for _, r in w.iterrows():
        ax.plot(xs, [r["spaced"], r["massed"]], color="#c9c8c2", linewidth=1, zorder=1)
        ax.scatter(xs, [r["spaced"], r["massed"]],
                   c=[C_SPACED, C_MASSED], s=18, zorder=2)
    means = [w["spaced"].mean(), w["massed"].mean()]
    errs = [sem(w["spaced"]), sem(w["massed"])]
    ax.errorbar(xs, means, yerr=errs, color=C_INK, linewidth=2.2,
                marker="o", markersize=8, capsize=4, zorder=3,
                markerfacecolor="white")
    for x, m in zip(xs, means):
        ax.annotate(f"{m*100:.1f}%" if percent else f"{m:.2f}",
                    (x, m), textcoords="offset points", xytext=(14, 0),
                    fontsize=9, color=C_INK, fontweight="bold")
    ax.set_xticks(xs, ["Spaced", "Massed"])
    ax.set_xlim(-0.35, 1.45)
    if percent:
        ax.set_ylim(0, 1.02)
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
    ax.text(1.0, -0.16, f"thin lines = participants (n={len(w)}); bold = mean ±1 SE",
            transform=ax.transAxes, ha="right", fontsize=8, color="#52514e")
    save(fig, outdir, name)


def curve(plt, outdir, name, per_pid, title, ylabel, xlabel,
          subtitle=None, percent=False, to_seconds=False):
    """Line chart over position 1-4, one line per schedule, mean ±1 SE.
    `per_pid` needs pid, schedule, idx, value."""
    d = per_pid.dropna(subset=["value"]).copy()
    if to_seconds:
        d["value"] = d["value"] / 1000.0
    fig, ax = new_fig(plt, title, xlabel, ylabel, subtitle)
    for sched in ("spaced", "massed"):
        g = d[d["schedule"] == sched].groupby("idx")["value"]
        m, e = g.mean(), g.apply(sem)
        ax.errorbar(m.index, m.values, yerr=e.values, label=sched.capitalize(),
                    color=SCHED_COLOR[sched], linewidth=2, marker="o",
                    markersize=6, capsize=3)
    ax.set_xticks([1, 2, 3, 4])
    if percent:
        ax.set_ylim(0, 1.02)
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
    ax.legend(frameon=False, fontsize=9)
    save(fig, outdir, name)


def interaction(plt, outdir, name, cells, title, xlabel, ylabel, xorder,
                xticklabels, subtitle=None, percent=False):
    """2-level interaction plot: x = factor levels, one line per schedule.
    `cells` needs pid, schedule, x, value."""
    fig, ax = new_fig(plt, title, xlabel, ylabel, subtitle)
    for sched in ("spaced", "massed"):
        g = cells[cells["schedule"] == sched]
        m = [g.loc[g["x"] == lv, "value"].mean() for lv in xorder]
        e = [sem(g.loc[g["x"] == lv, "value"]) for lv in xorder]
        ax.errorbar(range(len(xorder)), m, yerr=e, label=sched.capitalize(),
                    color=SCHED_COLOR[sched], linewidth=2, marker="o",
                    markersize=7, capsize=4)
    ax.set_xticks(range(len(xorder)), xticklabels)
    ax.set_xlim(-0.3, len(xorder) - 0.7)
    if percent:
        ax.set_ylim(0, 1.02)
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
    ax.legend(frameon=False, fontsize=9)
    save(fig, outdir, name)


# ── data assembly (mirrors the numbered scripts) ─────────────────────────────

# Returns all practice trials and the first-pass subset, both tagged with
# schedule and a 1-4 retrieval position.
def first_pass_practice(trials):
    p = trials[trials["session_label"].isin(common.PRACTICE_LABELS)].copy()
    p = common.add_schedule_and_format(p)
    label_idx = {**{l: i + 1 for i, l in enumerate(common.SPACED_LABELS)},
                 **{l: i + 1 for i, l in enumerate(common.MASSED_LABELS)}}
    p["idx"] = p["session_label"].map(label_idx)
    fp = p[p["retry_attempt"] == 1]
    return p, fp


def attempts_to_mastery(p):
    """Per (pid, session, item): attempts until the first correct response
    (censored at the observed max if never correct)."""
    rows = []
    for (pid, lab, item), grp in p.groupby(["pid", "session_label", "item_id"]):
        grp = grp.sort_values("retry_attempt")
        hit = grp.loc[grp["correct"] == 1, "retry_attempt"]
        rows.append(dict(pid=pid, session_label=lab, item_id=item,
                         schedule=grp["schedule"].iloc[0],
                         idx=grp["idx"].iloc[0],
                         attempts=float(hit.min() if len(hit) else
                                        grp["retry_attempt"].max())))
    return pd.DataFrame(rows)


# ── main ─────────────────────────────────────────────────────────────────────

# Builds every single-chart figure for 4.2.i, 4.2.ii, and 4.2.iii.
def main():
    ap = argparse.ArgumentParser(description="One labelled figure per analysis.")
    ap.add_argument("--data", required=True)
    # Default into the gitignored participant-data folder, so a standalone run
    # can't drop participant-derived figures somewhere committable.
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "participant-data", "results"))
    args = ap.parse_args()

    plt = common.get_matplotlib()
    if plt is None:
        sys.exit("matplotlib is required for figures:  pip install matplotlib")

    tables = common.load_export(args.data)
    trials, extra, _ = common.filter_to_analysis_sample(
        tables["trials"], {k: v for k, v in tables.items() if k != "trials"})
    outdir = common.ensure_outdir(os.path.join(args.out, "figures"))
    common.banner("Figures — one labelled chart per analysis")

    # ---- 4.2.i ----
    cells_len = common.delayed_cell_means(trials)

    qb = (cells_len[cells_len["fmt"] == "blank"]
          .pivot_table(index="pid", columns="schedule", values="acc").reset_index())
    slopegraph(plt, outdir, "fig_42i_confirmatory_qblank.png", qb,
               "Delayed accuracy — retention (Q-blank) items",
               "Accuracy (proportion correct)",
               subtitle="CONFIRMATORY PRIMARY (Version A) — 24 Session-4 fill-in items, lenient scoring",
               percent=True)

    slopegraph(plt, outdir, "fig_42i_collapsed_versionB.png",
               common.delayed_collapsed(trials),
               "Delayed accuracy — all 36 items, collapsed across format",
               "Accuracy (proportion correct)",
               subtitle="Version B / secondary — folds in the recency-confounded near-transfer items",
               percent=True)

    ix = cells_len.rename(columns={"fmt": "x", "acc": "value"})
    interaction(plt, outdir, "fig_42i_schedule_by_format.png", ix,
                "Delayed accuracy — schedule × test format", "Test format",
                "Accuracy (proportion correct)", ["blank", "full"],
                ["Retention (Q-blank)", "Near-transfer (Q-full)"],
                subtitle="Secondary; read beside the last-practice recency table (formats differ in recency)",
                percent=True)

    # scoring rules: mean accuracy by schedule under lenient / strict / primary
    frames = {"Lenient\n(instrument)": common.delayed_cell_means(trials).rename(columns={"acc": "v"}),
              "Strict\n(exact form)": common.delayed_strict_cells(trials).rename(columns={"acc_strict": "v"}),
              "Primary\n(strict Q-full only)": common.delayed_primary_cells(trials).rename(columns={"acc": "v"})}
    fig, ax = new_fig(plt, "Delayed accuracy under the three scoring rules",
                      "Scoring rule", "Accuracy (proportion correct)",
                      subtitle="Per-participant means; primary rule ⚑ pending AB sign-off")
    width, xs = 0.36, np.arange(len(frames))
    for k, sched in enumerate(("spaced", "massed")):
        means, errs = [], []
        for f in frames.values():
            per_pid = f[f["schedule"] == sched].groupby("pid")["v"].mean()
            means.append(per_pid.mean()); errs.append(sem(per_pid))
        ax.bar(xs + (k - 0.5) * width, means, width * 0.94, yerr=errs, capsize=3,
               color=SCHED_COLOR[sched], label=sched.capitalize(), edgecolor="white")
    ax.set_xticks(xs, list(frames.keys()))
    ax.set_ylim(0, 1.02)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
    ax.legend(frameon=False, fontsize=9)
    save(fig, outdir, "fig_42i_scoring_rules.png")

    slopegraph(plt, outdir, "fig_42i_delayed_rt.png",
               common.delayed_rt_cells(trials),
               "Delayed-test retrieval latency — retention items",
               "Median latency, correct responses (s)",
               subtitle="H4 behavioural half — correct-only, timeouts excluded; lower = faster",
               to_seconds=True)

    # inverse efficiency (retention items): median correct RT / accuracy
    d = common.delayed_trials(trials)
    ret = d[(d["fmt"] == "blank") & (d["timed_out"] != 1)]
    rt = (ret[ret["correct"] == 1].groupby(["pid", "schedule"])["rt_ms"].median()
          .unstack("schedule"))
    acc = (d[d["fmt"] == "blank"].groupby(["pid", "schedule"])["correct"].mean()
           .unstack("schedule"))
    ie = (rt / acc.replace(0, np.nan)).reset_index()
    slopegraph(plt, outdir, "fig_42i_inverse_efficiency.png", ie,
               "Inverse efficiency — retention items",
               "Median correct latency ÷ accuracy (s per correct answer)",
               subtitle="Speed–accuracy safeguard for H4; lower = more efficient",
               to_seconds=True)

    _, rec = common.last_practice_recency(trials)
    if not rec.empty:
        fig, ax = new_fig(plt, "Time since last practice at the delayed test",
                          "Test format", "Hours since that item was last practised",
                          subtitle="Why the schedule × format interaction is read with care")
        xs = np.arange(2)
        for k, sched in enumerate(("spaced", "massed")):
            m = [float(rec.query("schedule==@sched and fmt==@f")["mean_h"].iloc[0])
                 if len(rec.query("schedule==@sched and fmt==@f")) else np.nan
                 for f in ("blank", "full")]
            ax.bar(xs + (k - 0.5) * 0.36, m, 0.34, color=SCHED_COLOR[sched],
                   label=sched.capitalize(), edgecolor="white")
            for x, v in zip(xs + (k - 0.5) * 0.36, m):
                if not np.isnan(v):
                    ax.annotate(f"{v:.0f} h", (x, v), ha="center",
                                textcoords="offset points", xytext=(0, 3), fontsize=8.5)
        ax.set_xticks(xs, ["Retention (Q-blank)", "Near-transfer (Q-full)"])
        ax.legend(frameon=False, fontsize=9)
        save(fig, outdir, "fig_42i_recency.png")

    lists = common.add_schedule_and_format(trials)
    dl = common.delayed_trials(trials)
    per_list = dl.groupby(["pid", "group_id"])["correct"].mean().unstack("group_id")
    fig, ax = new_fig(plt, "List check — delayed accuracy by stimulus list",
                      "Stimulus list", "Accuracy (proportion correct)",
                      subtitle="Null-nuisance check: the counterbalanced lists should be equals")
    cols = [c for c in ("C-1", "C-2") if c in per_list.columns]
    ax.bar(range(len(cols)), [per_list[c].mean() for c in cols],
           0.5, yerr=[sem(per_list[c]) for c in cols], capsize=4,
           color=C_NEUTRAL, edgecolor="white")
    for i, c in enumerate(cols):
        ax.annotate(f"{per_list[c].mean()*100:.1f}%", (i, per_list[c].mean()),
                    ha="center", textcoords="offset points", xytext=(0, 4), fontsize=9)
    ax.set_xticks(range(len(cols)), cols)
    ax.set_ylim(0, 1.02)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
    save(fig, outdir, "fig_42i_list_check.png")

    # ---- 4.2.ii ----
    p, fp = first_pass_practice(trials)

    fpa = (fp.groupby(["pid", "schedule", "idx"])["correct"].mean()
           .rename("value").reset_index())
    curve(plt, outdir, "fig_42ii_first_pass_accuracy.png", fpa,
          "First-pass accuracy across practice",
          "First-pass accuracy (proportion correct)",
          "Retrieval position (session / block 1–4)", percent=True)

    atm = attempts_to_mastery(p)
    atm_pid = (atm.groupby(["pid", "schedule", "idx"])["attempts"].mean()
               .rename("value").reset_index())
    curve(plt, outdir, "fig_42ii_trials_to_mastery.png", atm_pid,
          "Attempts to first correct response across practice",
          "Mean attempts to mastery",
          "Retrieval position (session / block 1–4)",
          subtitle="Massed sits near its structural floor of 1 (no between-block forgetting)")

    rt_curve = (fp[fp["timed_out"] != 1]
                .groupby(["pid", "schedule", "idx"])["rt_ms"].median()
                .rename("value").reset_index())
    curve(plt, outdir, "fig_42ii_practice_rt.png", rt_curve,
          "Retrieval latency across practice (descriptive only)",
          "Median first-pass latency (s)",
          "Retrieval position (session / block 1–4)",
          subtitle="Not a test: seconds-apart re-retrieval is trivially faster than day-apart",
          to_seconds=True)

    endp = (fpa[fpa["idx"] == 4].assign(x="end")[["pid", "schedule", "x", "value"]])
    delq = (cells_len[cells_len["fmt"] == "blank"]
            .rename(columns={"acc": "value"}).assign(x="delayed")
            [["pid", "schedule", "x", "value"]])
    interaction(plt, outdir, "fig_42ii_phase_by_schedule.png",
                pd.concat([endp, delq], ignore_index=True),
                "H2 crossover — end of practice vs delayed test", "Phase",
                "Accuracy (proportion correct)", ["end", "delayed"],
                ["End of practice\n(Session/Block 4, first pass)", "Delayed test\n(~1 week, retention items)"],
                subtitle="The phase × schedule interaction is the dissociation test",
                percent=True)

    # ---- 4.2.iii ----
    fpc = fp[(fp["confidence"].notna())]
    if len(fpc):
        lab = {1: "Guess", 2: "Unsure", 3: "Fairly sure", 4: "Certain"}
        g = fpc.groupby("confidence")["correct"].agg(["mean", "size"])
        fig, ax = new_fig(plt, "Calibration — accuracy at each confidence level",
                          "Confidence rating (first-pass practice trials)",
                          "Accuracy (proportion correct)",
                          subtitle="Timeouts carry no rating and are excluded (audited separately)")
        xs = np.arange(len(g))
        ax.bar(xs, g["mean"], 0.55, color=C_NEUTRAL, edgecolor="white")
        for x, (m, n) in enumerate(zip(g["mean"], g["size"])):
            ax.annotate(f"{m*100:.0f}%\n(n={n})", (x, m), ha="center",
                        textcoords="offset points", xytext=(0, 4), fontsize=8.5)
        ax.set_xticks(xs, [lab.get(int(c), c) for c in g.index])
        ax.set_ylim(0, 1.1)
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
        save(fig, outdir, "fig_42iii_calibration_curve.png")

    preds = extra.get("predictions", pd.DataFrame())
    if not preds.empty:
        pr = preds.copy()
        lab_col = next((c for c in pr.columns
                        if pr[c].astype(str).isin(common.PRACTICE_LABELS).any()), None)
        if lab_col:
            label_idx = {**{l: i + 1 for i, l in enumerate(common.SPACED_LABELS)},
                         **{l: i + 1 for i, l in enumerate(common.MASSED_LABELS)}}
            pr["schedule"] = np.where(
                pr[lab_col].astype(str).isin(common.SPACED_LABELS), "spaced", "massed")
            pr["idx"] = pr[lab_col].map(label_idx)
            pr["pred_prop"] = pd.to_numeric(pr["value"], errors="coerce") / 12.0
            actual = fpa.rename(columns={"value": "actual"})
            m = pr.merge(actual, on=["pid", "schedule", "idx"], how="inner")
            fig, ax = new_fig(plt, "Pre-session predictions vs realized first-pass accuracy",
                              "Practice schedule", "Proportion of the block's 12 items",
                              subtitle="Hatched = predicted before the block; solid = what happened")
            xs = np.arange(2)
            for k, meas in enumerate(("pred_prop", "actual")):
                means = [m.loc[m["schedule"] == s, meas].mean() for s in ("spaced", "massed")]
                errs = [sem(m.loc[m["schedule"] == s, meas]) for s in ("spaced", "massed")]
                ax.bar(xs + (k - 0.5) * 0.36, means, 0.34, yerr=errs, capsize=3,
                       color=[SCHED_COLOR["spaced"], SCHED_COLOR["massed"]],
                       hatch="//" if meas == "pred_prop" else "",
                       alpha=0.55 if meas == "pred_prop" else 1.0, edgecolor="white",
                       label="Predicted" if meas == "pred_prop" else "Actual")
            ax.set_xticks(xs, ["Spaced", "Massed"])
            ax.set_ylim(0, 1.02)
            ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
            ax.legend(frameon=False, fontsize=9)
            save(fig, outdir, "fig_42iii_prediction_bias.png")

            traj_p = (pr.groupby(["pid", "schedule", "idx"])["pred_prop"].mean()
                      .rename("value").reset_index())
            curve(plt, outdir, "fig_42iii_prediction_trajectory.png", traj_p,
                  "Pre-session predictions across practice (exploratory)",
                  "Predicted proportion correct",
                  "Session / block position (1–4)", percent=True)

    traj_c = (fpc.groupby(["pid", "schedule", "idx"])["confidence"].mean()
              .rename("value").reset_index())
    curve(plt, outdir, "fig_42iii_confidence_trajectory.png", traj_c,
          "Per-item confidence across practice (exploratory)",
          "Mean confidence (1 = Guess … 4 = Certain)",
          "Session / block position (1–4)")

    fc = extra.get("forced_choices", pd.DataFrame())
    if not fc.empty:
        f = fc.copy()
        ch_col = next((c for c in f.columns
                       if f[c].astype(str).str.lower().isin(
                           common.FORCED_CHOICE_TO_SCHEDULE).any()), None)
        occ_col = next((c for c in f.columns if c != ch_col and
                        f[c].astype(str).str.contains(r"day_?4|delayed", case=False).any()), None)
        if ch_col and occ_col:
            f["judged"] = f[ch_col].astype(str).str.lower().map(common.FORCED_CHOICE_TO_SCHEDULE)
            # checkpoint values are day_4_immediate / day_14_delayed -- split on
            # "delayed", which is stable in both the schema and the fixture
            f["occ"] = np.where(f[occ_col].astype(str).str.contains("delayed", case=False),
                                "After delayed test (retrospective)", "Day 4 (prospective)")
            fig, ax = new_fig(plt, "Set-preference judgments at both occasions",
                              "Occasion", "Number of participants",
                              subtitle="Which set they believed better learned; H3's most direct measure")
            occs = ["Day 4 (prospective)", "After delayed test (retrospective)"]
            xs = np.arange(len(occs))
            for k, j in enumerate(("spaced", "massed", "same")):
                counts = [int(((f["occ"] == o) & (f["judged"] == j)).sum()) for o in occs]
                ax.bar(xs + (k - 1) * 0.27, counts, 0.25, color=SCHED_COLOR[j],
                       edgecolor="white",
                       label={"spaced": "Chose their spaced set", "massed": "Chose their massed set",
                              "same": "Said both the same"}[j])
            ax.set_xticks(xs, occs)
            ax.yaxis.get_major_locator().set_params(integer=True)
            ax.legend(frameon=False, fontsize=8.5)
            save(fig, outdir, "fig_42iii_setpref.png")

    to = common.add_schedule_and_format(trials)
    to["phase3"] = np.where(to["session_label"] == common.DELAYED_LABEL,
                            "Delayed test", np.where(to["schedule"] == "spaced",
                                                     "Spaced practice", "Massed practice"))
    rate = to.groupby("phase3")["timed_out"].mean() * 100
    order = [p for p in ("Spaced practice", "Massed practice", "Delayed test") if p in rate.index]
    fig, ax = new_fig(plt, "Timeout rate by study phase",
                      "Phase", "Trials hitting the 20 s limit (%)",
                      subtitle="Reported as its own outcome; also the Day-4 fatigue proxy")
    ax.bar(range(len(order)), [rate[p] for p in order], 0.5, color=C_NEUTRAL,
           edgecolor="white")
    for i, pph in enumerate(order):
        ax.annotate(f"{rate[pph]:.1f}%", (i, rate[pph]), ha="center",
                    textcoords="offset points", xytext=(0, 4), fontsize=9)
    ax.set_xticks(range(len(order)), order)
    save(fig, outdir, "fig_42iii_timeout_rate.png")

    print("\nAll single-chart figures are in", outdir)


if __name__ == "__main__":
    with warnings.catch_warnings():
        warnings.simplefilter("default")
        main()
