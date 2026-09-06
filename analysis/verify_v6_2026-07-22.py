"""
verify_v6.py -- INDEPENDENT recomputation of every statistic entering Chapter 4 v6.

Reads the de-identified shareable export directly (own loader, own scoring
normalizers, own stats via scipy -- deliberately NOT importing analysis/common.py
or spss_compat.py) and compares against the results/ folder produced by run_all.py.

Every check prints  [PASS]/[FAIL]  mine vs pipeline.
Extra chapter-only numbers (dz CIs, d_av, retention intervals, fatigue proxies,
ceiling check, R04 descriptives) are printed at the end.
"""
import re
import numpy as np
import pandas as pd
from scipy import stats

XLSX = r"C:\Users\RJ\Desktop\THESIS RESULTS BACKUPS\backups\your_export_SHAREABLE.xlsx"
RES = r"C:\Users\RJ\Desktop\chemflashcards\analysis\participant-data\results"

SPACED = ["spaced-S1", "spaced-S2", "spaced-S3", "spaced-S4"]
MASSED = ["massed-B1", "massed-B2", "massed-B3", "massed-B4"]
PRACTICE = SPACED + MASSED

results = []  # (status, label, detail)


# Records a PASS or FAIL for one recomputed value against the pipeline value.
def check(label, mine, theirs, tol=6e-4):
    try:
        if isinstance(mine, str) or isinstance(theirs, str):
            ok = str(mine) == str(theirs)
        else:
            m, t = float(mine), float(theirs)
            if np.isnan(m) and np.isnan(t):
                ok = True
            else:
                ok = abs(m - t) <= tol
    except Exception:
        ok = False
    results.append(("PASS" if ok else "FAIL", label, f"mine={mine}  pipeline={theirs}"))
    return ok


# Records a value for the report without comparing it to anything.
def note(label, value):
    results.append(("NOTE", label, str(value)))


# ---------- own normalizers (re-implemented from the documented specs) ----------
import unicodedata


def norm_lenient(s):
    """Instrument rule: lowercase -> NFKC -> hyphens/underscores->spaces ->
    collapse whitespace -> trim."""
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    s = unicodedata.normalize("NFKC", str(s).lower())
    s = re.sub(r"[-_]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_strict(s):
    """Strict rule: lowercase, collapse whitespace, trim; KEEP hyphens/locants."""
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    return re.sub(r"\s+", " ", str(s).strip().lower())


def norm_sepfree(s):
    """Separator-free: drop hyphens/underscores/spaces entirely (mechanical
    'taught-conventions' candidate detector: credits extra/missing separators)."""
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    s = unicodedata.normalize("NFKC", str(s).lower())
    return re.sub(r"[-_\s]", "", s)


# ---------- own stats helpers ----------

def paired_t(a, b):
    """Paired t with mean-diff CI, dz, dz noncentral-t CI, and d_av."""
    d = pd.DataFrame({"a": a, "b": b}).dropna()
    n = len(d)
    if n < 2:
        return dict(n=n)
    diff = d["a"] - d["b"]
    md, sd = diff.mean(), diff.std(ddof=1)
    se = sd / np.sqrt(n)
    t = md / se
    df = n - 1
    p = 2 * stats.t.sf(abs(t), df)
    tc = stats.t.ppf(0.975, df)
    dz = md / sd
    # noncentral-t CI for dz
    lo = hi = np.nan
    try:
        from scipy.optimize import brentq
        # Root at the noncentrality parameter putting t at the 97.5th percentile.
        def f_lo(nc):
            return stats.nct.cdf(t, df, nc) - 0.975
        # Root at the noncentrality parameter putting t at the 2.5th percentile.
        def f_hi(nc):
            return stats.nct.cdf(t, df, nc) - 0.025
        span = max(10.0, abs(t) * 5 + 10)
        lo = brentq(f_lo, -span, span) / np.sqrt(n)
        hi = brentq(f_hi, -span, span) / np.sqrt(n)
    except Exception:
        pass
    d_av = md / ((d["a"].std(ddof=1) + d["b"].std(ddof=1)) / 2)
    return dict(n=n, mean_a=d["a"].mean(), mean_b=d["b"].mean(), mean_diff=md,
                sd_diff=sd, se=se, t=t, df=df, p=p,
                ci_lo=md - tc * se, ci_hi=md + tc * se,
                dz=dz, dz_lo=lo, dz_hi=hi, d_av=d_av)


# One-sample t-test of x against mu, returning n, mean, t, df, and p.
def one_sample_t(x, mu=0.0):
    x = pd.Series(x).dropna()
    n = len(x)
    if n < 2:
        return dict(n=n)
    t, p = stats.ttest_1samp(x, mu)
    return dict(n=n, mean=x.mean(), t=float(t), df=n - 1, p=float(p))


# Goodman-Kruskal gamma between ordinal confidence and binary correctness.
def gk_gamma(conf, corr):
    conf = np.asarray(conf, float); corr = np.asarray(corr, float)
    C = D = 0
    for i in range(len(conf)):
        for j in range(i + 1, len(conf)):
            dc, do = conf[i] - conf[j], corr[i] - corr[j]
            if dc == 0 or do == 0:
                continue
            if (dc > 0) == (do > 0):
                C += 1
            else:
                D += 1
    return (C - D) / (C + D) if (C + D) else np.nan


# Holm-Bonferroni step-down adjustment across a named family of p-values.
def holm(pdict):
    valid = [(k, v) for k, v in pdict.items() if v is not None and not np.isnan(v)]
    m = len(valid)
    out, run = {}, 0.0
    for r, (k, v) in enumerate(sorted(valid, key=lambda kv: kv[1])):
        adj = min(1.0, (m - r) * v)
        run = max(run, adj)
        out[k] = run
    return out


# ---------- load the shareable export ----------
book = pd.read_excel(XLSX, sheet_name=None, dtype=str)
note("sheets in shareable export", list(book.keys()))

# PID-leak scan over every cell of every sheet
pid_pat = re.compile(r"\d{2}-\d{5}")
leaks = []
for sheet, df in book.items():
    for col in df.columns:
        s = df[col].dropna().astype(str)
        bad = s[s.str.contains(pid_pat)]
        if len(bad):
            leaks.append((sheet, col, bad.iloc[0]))
if leaks:
    results.append(("FAIL", "PID scan of shareable xlsx", str(leaks)))
else:
    results.append(("PASS", "PID scan of shareable xlsx", "0 hits for \\d{2}-\\d{5} in any cell"))

# pid inventory per sheet
for sheet, df in book.items():
    pid_col = "pid" if "pid" in df.columns else None
    if pid_col:
        note(f"pids in sheet '{sheet}'", sorted(df[pid_col].dropna().unique()))


# Returns the first workbook sheet whose name contains name_part.
def pick(name_part):
    for sheet, df in book.items():
        if name_part in sheet.lower():
            return df.copy()
    return pd.DataFrame()


tr = pick("trial")
fam = pick("ease") if not pick("ease").empty else pick("familiar")
pred = pick("prediction")
fc = pick("forced")

# coerce
for c in ["dev_mode", "correct", "rt_ms", "review_ms", "trial_order", "timed_out",
          "retry_attempt", "soft_capped", "confidence", "session_id", "trial_id"]:
    if c in tr.columns:
        tr[c] = pd.to_numeric(tr[c], errors="coerce")
for c in ["enrollment_date", "session_started_at", "session_completed_at",
          "stim_on_ts", "stim_off_ts", "trial_created_at"]:
    if c in tr.columns:
        tr[c] = pd.to_datetime(tr[c], errors="coerce", utc=True).dt.tz_localize(None)
for df_, vc in ((fam, "value"), (pred, "value"), (fc, "confidence")):
    if not df_.empty and vc in df_.columns:
        df_[vc] = pd.to_numeric(df_[vc], errors="coerce")

note("total trial rows in export", len(tr))
note("distinct pids in trials", sorted(tr["pid"].dropna().unique()))

# ---------- manifest ----------
done = tr[tr["session_completed_at"].notna()]
labels_by_pid = {p: set(g["session_label"].dropna().unique()) for p, g in done.groupby("pid")}
completers = {p for p, ls in labels_by_pid.items() if set(PRACTICE).issubset(ls)}
devmax = tr.groupby("pid")["dev_mode"].max()
included = sorted(p for p in completers if devmax.get(p, 0) != 1)
note("completers (all 8 practice blocks, non-dev)", included)
check("N included", len(included), 6)
check("N enrolled ids in trials", tr["pid"].nunique(), 10)
check("N dev ids", int((devmax == 1).sum()), 1)

# ISI gaps
isi_rows = {}
for p, g in tr.groupby("pid"):
    starts, comps = {}, {}
    for lab in SPACED:
        sub = g[g["session_label"] == lab]
        if sub.empty:
            continue
        s = sub["session_started_at"].dropna()
        c = sub["session_completed_at"].dropna()
        if len(s):
            starts[lab] = s.min()
        if len(c):
            comps[lab] = c.max()
    gaps = []
    for a, b in zip(SPACED[:-1], SPACED[1:]):
        if a in comps and b in starts:
            gaps.append((f"{a}->{b}", (starts[b] - comps[a]).total_seconds() / 3600))
    isi_rows[p] = gaps
viol = {p: [f"{n}={h:.1f}h" for n, h in gaps if h < 20 or h > 28]
        for p, gaps in isi_rows.items()}
flagged = sorted(p for p in included if viol.get(p))
note("ISI-flagged completers", {p: viol[p] for p in flagged})
check("N ISI-flagged included", len(flagged), 3)
exp_viol = {"R01": "spaced-S1->spaced-S2=47.7h", "R03": "spaced-S2->spaced-S3=44.1h; spaced-S3->spaced-S4=122.4h",
            "R07": "spaced-S1->spaced-S2=31.3h"}
for p, s in exp_viol.items():
    check(f"ISI detail {p}", "; ".join(viol.get(p, [])), s)

# ---------- schedule / fmt labels ----------
sp_group = tr["option_id"].map({"option1": "C-1", "option2": "C-2"})
tr["schedule"] = np.where(tr["group_id"] == sp_group, "spaced", "massed")
q = tr["qtype"].astype(str).str.lower()
tr["fmt"] = np.select([q.str.contains("blank"), q.str.contains("full")],
                      ["blank", "full"], default=None)

ta = tr[tr["pid"].isin(included)].copy()  # analysis sample
dl = ta[(ta["phase"] == "delayed") | (ta["session_label"] == "delayed")].copy()
n_missing_correct = int(dl["correct"].isna().sum())
check("delayed trials with NULL correct", n_missing_correct, 0)
dl["correct"] = dl["correct"].fillna(0).astype(float)
check("delayed trials in analysis sample", len(dl), 216)

# ---------- 4.2.i confirmatory Q-blank ----------
qb = (dl[dl["fmt"] == "blank"].groupby(["pid", "schedule"])["correct"].mean()
      .unstack("schedule").reset_index())
qb["advantage"] = qb["spaced"] - qb["massed"]
exp_qb = {"R01": (0.5833, 0.4167), "R02": (0.9167, 0.75), "R03": (0.6667, 0.4167),
          "R07": (0.25, 0.4167), "R08": (0.9167, 0.9167), "R09": (0.9167, 1.0)}
for p, (s, m) in exp_qb.items():
    row = qb[qb["pid"] == p].iloc[0]
    check(f"Qblank {p} spaced", row["spaced"], s)
    check(f"Qblank {p} massed", row["massed"], m)
tt_qb = paired_t(qb["spaced"], qb["massed"])
check("Qblank mean spaced", tt_qb["mean_a"], 0.7083)
check("Qblank mean massed", tt_qb["mean_b"], 0.6528)
check("Qblank mean diff", tt_qb["mean_diff"], 0.0556)
check("Qblank t", tt_qb["t"], 0.8305)
check("Qblank p", tt_qb["p"], 0.4441, tol=5e-4)
check("Qblank CI lo", tt_qb["ci_lo"], -0.1164)
check("Qblank CI hi", tt_qb["ci_hi"], 0.2275)
check("Qblank dz", tt_qb["dz"], 0.339)
note("Qblank dz 95% CI (noncentral t)", f"[{tt_qb['dz_lo']:.3f}, {tt_qb['dz_hi']:.3f}]")
note("Qblank d_av (literature-comparable)", f"{tt_qb['d_av']:.3f}")
note("Qblank direction split", f"pos={int((qb['advantage']>0).sum())}, "
     f"neg={int((qb['advantage']<0).sum())}, tie={int((qb['advantage']==0).sum())}")

# ---------- collapsed (Version B) ----------
coll = (dl.groupby(["pid", "schedule"])["correct"].mean().unstack("schedule").reset_index())
coll["advantage"] = coll["spaced"] - coll["massed"]
tt_c = paired_t(coll["spaced"], coll["massed"])
check("collapsed mean spaced", tt_c["mean_a"], 0.537)
check("collapsed mean massed", tt_c["mean_b"], 0.4907)
check("collapsed t", tt_c["t"], 0.667)
check("collapsed p", tt_c["p"], 0.5343)
check("collapsed dz", tt_c["dz"], 0.2723)
check("collapsed CI lo", tt_c["ci_lo"], -0.1321)
check("collapsed CI hi", tt_c["ci_hi"], 0.2247)
note("collapsed dz 95% CI", f"[{tt_c['dz_lo']:.3f}, {tt_c['dz_hi']:.3f}]")
note("collapsed d_av", f"{tt_c['d_av']:.3f}")
note("collapsed direction split", f"pos={int((coll['advantage']>0).sum())}, "
     f"neg={int((coll['advantage']<0).sum())}, tie={int((coll['advantage']==0).sum())}")

# ---------- by-format Q-full ----------
qf = (dl[dl["fmt"] == "full"].groupby(["pid", "schedule"])["correct"].mean()
      .unstack("schedule").reset_index())
tt_f = paired_t(qf["spaced"], qf["massed"])
check("Qfull mean spaced", tt_f["mean_a"], 0.1944)
check("Qfull mean massed", tt_f["mean_b"], 0.1667)
check("Qfull t", tt_f["t"], 0.2104)
check("Qfull p", tt_f["p"], 0.8417)
check("Qfull dz", tt_f["dz"], 0.0859)
note("Qfull dz 95% CI", f"[{tt_f['dz_lo']:.3f}, {tt_f['dz_hi']:.3f}]")

# ---------- 2x2 RM ANOVA via 1-df contrast identities ----------
cells = (dl.groupby(["pid", "schedule", "fmt"])["correct"].mean().reset_index()
         .pivot_table(index="pid", columns=["schedule", "fmt"], values="correct"))
cells.columns = [f"{s}_{f}" for s, f in cells.columns]
sched_contrast = (cells["spaced_blank"] + cells["spaced_full"]) / 2 - \
                 (cells["massed_blank"] + cells["massed_full"]) / 2
fmt_contrast = (cells["spaced_blank"] + cells["massed_blank"]) / 2 - \
               (cells["spaced_full"] + cells["massed_full"]) / 2
inter_contrast = (cells["spaced_blank"] - cells["massed_blank"]) - \
                 (cells["spaced_full"] - cells["massed_full"])
for name, con, expF, expP, expEta in [
        ("schedule", sched_contrast, 0.267857, 0.626848, 0.050847),
        ("format", fmt_contrast, 93.913043, 0.000199, 0.949451),
        ("schedule x format", inter_contrast, 0.043103, 0.843722, 0.008547)]:
    r = one_sample_t(con, 0.0)
    F = r["t"] ** 2
    eta = F / (F + r["df"])
    check(f"2x2 ANOVA {name} F", F, expF, tol=5e-4)
    check(f"2x2 ANOVA {name} p", r["p"], expP, tol=5e-5)
    check(f"2x2 ANOVA {name} partial eta2", eta, expEta, tol=5e-4)

# ---------- delayed RT (retention, correct-only lenient, timeouts excluded) ----------
rt_mask = dl["rt_ms"].notna() & (dl["timed_out"] != 1) & (dl["correct"] == 1)
rt_qb = (dl[rt_mask & (dl["fmt"] == "blank")]
         .groupby(["pid", "schedule"])["rt_ms"].median().unstack("schedule").reset_index())
exp_rt = {"R01": (3780.0, 5004.0), "R02": (4894.0, 4558.0), "R03": (6748.5, 4854.0),
          "R07": (4954.0, 3585.0), "R08": (4155.0, 5134.0), "R09": (3403.0, 3790.5)}
for p, (s, m) in exp_rt.items():
    row = rt_qb[rt_qb["pid"] == p].iloc[0]
    check(f"RT {p} spaced", row["spaced"], s)
    check(f"RT {p} massed", row["massed"], m)
tt_rt = paired_t(rt_qb["spaced"], rt_qb["massed"])
note("delayed RT retention: spaced mean of medians",
     f"{tt_rt['mean_a']:.0f} ms; massed {tt_rt['mean_b']:.0f} ms; diff {tt_rt['mean_diff']:+.0f} ms")
note("delayed RT paired t", f"t({tt_rt['df']})={tt_rt['t']:.3f}, p={tt_rt['p']:.4f}, "
     f"dz={tt_rt['dz']:.3f} CI [{tt_rt['dz_lo']:.3f},{tt_rt['dz_hi']:.3f}], d_av={tt_rt['d_av']:.3f}")

# Q-full RT companion (lenient-correct filter)
rt_qf = (dl[rt_mask & (dl["fmt"] == "full")]
         .groupby(["pid", "schedule"])["rt_ms"].median().unstack("schedule")
         .reindex(columns=["spaced", "massed"]).reset_index())
note("Qfull RT rows (pid: spaced, massed)",
     {r["pid"]: (r["spaced"], r["massed"]) for _, r in rt_qf.iterrows()})
both = rt_qf.dropna(subset=["spaced", "massed"])
note("Qfull RT paired n (both cells present)", len(both))
check("Qfull RT R02 spaced", rt_qf.loc[rt_qf["pid"] == "R02", "spaced"].iloc[0], 11636.0)
check("Qfull RT R09 massed", rt_qf.loc[rt_qf["pid"] == "R09", "massed"].iloc[0], 13360.0)

# ---------- inverse efficiency ----------
acc_qb = (dl[dl["fmt"] == "blank"].groupby(["pid", "schedule"])["correct"].mean()
          .unstack("schedule"))
ie = rt_qb.set_index("pid")[["spaced", "massed"]] / acc_qb
ie = ie.reset_index()
exp_ie = {"R01": (6480.0, 12009.6), "R02": (5338.9, 6077.3), "R03": (10122.8, 11649.6),
          "R07": (19816.0, 8604.0), "R08": (4532.7, 5600.7), "R09": (3712.4, 3790.5)}
for p, (s, m) in exp_ie.items():
    row = ie[ie["pid"] == p].iloc[0]
    check(f"IE {p} spaced", row["spaced"], s, tol=0.06)
    check(f"IE {p} massed", row["massed"], m, tol=0.06)
tt_ie = paired_t(ie["spaced"], ie["massed"])
check("IE mean diff", tt_ie["mean_diff"], 378.4982, tol=0.05)
check("IE t", tt_ie["t"], 0.1642)
check("IE p", tt_ie["p"], 0.876, tol=5e-4)
note("IE means", f"spaced {tt_ie['mean_a']:.0f}, massed {tt_ie['mean_b']:.0f}; "
     f"dz={tt_ie['dz']:.3f} CI [{tt_ie['dz_lo']:.3f},{tt_ie['dz_hi']:.3f}]")

# ---------- scoring: strict rescore, flips, scenario-T candidates ----------
is_full = dl["fmt"] == "full"
target = np.where(is_full, dl["full_name"], dl["feature"])
dl["strict"] = [1.0 if (norm_strict(r) != "" and norm_strict(r) == norm_strict(t)) else 0.0
                for r, t in zip(dl["raw_answer"], target)]
dl["releni"] = [1.0 if (norm_lenient(r) != "" and norm_lenient(r) == norm_lenient(t)) else 0.0
                for r, t in zip(dl["raw_answer"], target)]
check("delayed: stored correct == my lenient rescore (mismatches)",
      int((dl["correct"] != dl["releni"]).sum()), 0)
flips_l = int(((dl["correct"] == 1) & (dl["strict"] == 0)).sum())
flips_s = int(((dl["strict"] == 1) & (dl["correct"] == 0)).sum())
check("flips lenient-only (all delayed)", flips_l, 0)
check("flips strict-only (all delayed)", flips_s, 0)
check("Q-blank n lenient correct", int(dl.loc[dl["fmt"] == "blank", "correct"].sum()), 98)
check("Q-full n lenient correct", int(dl.loc[dl["fmt"] == "full", "correct"].sum()), 13)
# separator-free candidates: wrong under BOTH rules but identical once separators dropped
cand = dl[(dl["correct"] == 0) &
          (dl["raw_answer"].map(norm_sepfree) != "") &
          (dl["raw_answer"].map(norm_sepfree) == pd.Series(target, index=dl.index).map(norm_sepfree))]
note("scenario-T mechanical candidates (separator-only misses, scored wrong)",
     f"{len(cand)} rows: " + "; ".join(
         f"{r['pid']}/{r['item_id']}: '{r['raw_answer']}' vs '{t}'"
         for (_, r), t in zip(cand.iterrows(), pd.Series(target, index=dl.index).loc[cand.index])))

# ---------- recency ----------
# First non-missing timestamp across cols, per row.
def coalesce(df, cols):
    out = pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns]")
    for c in cols:
        if c in df.columns:
            out = out.fillna(pd.to_datetime(df[c], errors="coerce"))
    return out

dlr = dl.copy()
dlr["t_del"] = coalesce(dlr, ["stim_on_ts", "trial_created_at", "session_started_at"])
dlr["pitem"] = dlr["item_id"].astype(str).str.replace(r"-(full|blank)$", "", regex=True)
pr_ = ta[ta["session_label"].isin(PRACTICE)].copy()
pr_["t_prac"] = coalesce(pr_, ["stim_off_ts", "trial_created_at", "session_completed_at"])
last = (pr_.groupby(["pid", "item_id"])["t_prac"].max().rename("t_last").reset_index()
        .rename(columns={"item_id": "pitem"}))
mr = dlr.merge(last, on=["pid", "pitem"], how="left")
mr["recency_h"] = (mr["t_del"] - mr["t_last"]).dt.total_seconds() / 3600
rec = (mr.groupby(["schedule", "fmt"])["recency_h"]
       .agg(mean_h="mean", median_h="median", min_h="min", max_h="max", n="count").reset_index())
exp_rec = {("massed", "blank"): (164.5, 163.0, 141.7, 188.9, 72),
           ("massed", "full"): (164.6, 163.1, 141.7, 188.9, 36),
           ("spaced", "blank"): (165.1, 163.8, 142.3, 189.1, 72),
           ("spaced", "full"): (225.8, 210.7, 166.1, 358.4, 36)}
for (s, f), (mh, mdh, mnh, mxh, n) in exp_rec.items():
    row = rec[(rec["schedule"] == s) & (rec["fmt"] == f)].iloc[0]
    check(f"recency {s}/{f} mean_h", row["mean_h"], mh, tol=0.06)
    check(f"recency {s}/{f} median_h", row["median_h"], mdh, tol=0.06)
    check(f"recency {s}/{f} n", row["n"], n)

# ---------- list check ----------
bygrp = (dl.groupby(["pid", "group_id"])["correct"].mean().rename("acc").reset_index()
         .groupby("group_id")["acc"].agg(mean="mean", n="count").reset_index())
check("list C-1 mean", bygrp.loc[bygrp["group_id"] == "C-1", "mean"].iloc[0], 0.5278)
check("list C-2 mean", bygrp.loc[bygrp["group_id"] == "C-2", "mean"].iloc[0], 0.5)
opt = ta.groupby("pid")["option_id"].first()
adv_by_opt = coll.set_index("pid")["advantage"]
mean_by_opt = coll.set_index("pid")[["spaced", "massed"]].mean(axis=1)
g1 = [p for p in included if opt[p] == "option1"]
g2 = [p for p in included if opt[p] == "option2"]
note("counterbalance split", f"option1 (C-1 spaced): {g1}; option2 (C-2 spaced): {g2}")
# mixed-ANOVA identities for 2x2 (balanced 3/3): interaction F = indep-t^2 on advantage
t_int, p_int = stats.ttest_ind(adv_by_opt[g1], adv_by_opt[g2], equal_var=True)
check("mixed ANOVA interaction F", t_int ** 2, 0.1323529, tol=5e-4)
check("mixed ANOVA interaction p", p_int, 0.7344185, tol=5e-4)
t_opt, p_opt = stats.ttest_ind(mean_by_opt[g1], mean_by_opt[g2], equal_var=True)
check("mixed ANOVA option F", t_opt ** 2, 0.0017668, tol=5e-5)
check("mixed ANOVA option p", p_opt, 0.9684867, tol=5e-4)
# schedule (within) main effect in balanced mixed = one-way RM F of advantage vs 0
# with error term = subj-within-groups: F = (grand advantage mean)^2 * N / MS_err,
# MS_err from deviations of each subject's advantage from its group mean:
grand = adv_by_opt[included].mean()
ss_sched = len(included) * (grand ** 2) / 2 * 2  # N * mean^2 (per-cell coding halves)
dev = pd.concat([adv_by_opt[g1] - adv_by_opt[g1].mean(),
                 adv_by_opt[g2] - adv_by_opt[g2].mean()])
ms_err = (dev ** 2).sum() / (len(included) - 2) / 2
F_sched = (len(included) * grand ** 2 / 2) / ms_err
check("mixed ANOVA schedule F", F_sched, 0.3676471, tol=5e-4)

# ---------- 4.2.ii curves ----------
p_ = ta[ta["session_label"].isin(PRACTICE)].copy()
p_["sched"] = np.where(p_["session_label"].isin(SPACED), "spaced", "massed")
p_["idx"] = p_["session_label"].str[-1].astype(int)
fp = p_[(p_["retry_attempt"] == 1) & p_["correct"].notna()]
check("first-pass practice rows per completer (should be 96 x 6)", len(fp), 576)
fpa = fp.groupby(["pid", "sched", "idx"])["correct"].mean().rename("fpa").reset_index()
fpa_g = fpa.groupby(["sched", "idx"])["fpa"].mean()
exp_fpa = {("massed", 1): 0.569444, ("massed", 2): 0.819444, ("massed", 3): 0.875,
           ("massed", 4): 0.875, ("spaced", 1): 0.527778, ("spaced", 2): 0.722222,
           ("spaced", 3): 0.847222, ("spaced", 4): 0.847222}
for k, v in exp_fpa.items():
    check(f"first-pass accuracy {k}", fpa_g[k], v, tol=5e-5)
# trials to mastery
rows = []
for (pid, sched, idx, item), g in p_[p_["correct"].notna()].groupby(["pid", "sched", "idx", "item_id"]):
    cr = g[g["correct"] == 1]
    rows.append((pid, sched, idx, cr["retry_attempt"].min() if len(cr) else np.nan))
ttm = pd.DataFrame(rows, columns=["pid", "sched", "idx", "att"])
ttm_pid = ttm.groupby(["pid", "sched", "idx"])["att"].mean().rename("ttm").reset_index()
ttm_g = ttm_pid.groupby(["sched", "idx"])["ttm"].mean()
for k, v in {("spaced", 1): 1.527778, ("spaced", 2): 1.291667, ("spaced", 3): 1.208333,
             ("spaced", 4): 1.152778, ("massed", 1): 1.527778, ("massed", 2): 1.236111,
             ("massed", 3): 1.152778, ("massed", 4): 1.125}.items():
    check(f"trials-to-mastery {k}", ttm_g[k], v, tol=5e-5)
check("items never mastered (NaN attempts)", int(ttm["att"].isna().sum()), 0)
check("soft-capped items", int((p_["soft_capped"] == 1).sum()), 0)
# median first-pass-correct latency
lat = (p_[(p_["retry_attempt"] == 1) & (p_["correct"] == 1) & (p_["timed_out"] != 1)
          & p_["rt_ms"].notna()]
       .groupby(["pid", "sched", "idx"])["rt_ms"].median().rename("lat").reset_index())
lat_g = lat.groupby(["sched", "idx"])["lat"].mean()
for k, v in {("massed", 1): 4838.583, ("massed", 4): 3526.0,
             ("spaced", 1): 7099.167, ("spaced", 4): 5098.0}.items():
    check(f"median latency {k}", lat_g[k], v, tol=0.05)

# ---------- H2 phase x schedule ----------
endp = fpa[fpa["idx"] == 4].rename(columns={"fpa": "acc", "sched": "schedule"})
endp = endp[["pid", "schedule", "acc"]].assign(phase="end")
dqb = qb.melt(id_vars="pid", value_vars=["spaced", "massed"],
              var_name="schedule", value_name="acc").assign(phase="delayed")
ps = pd.concat([endp, dqb], ignore_index=True)
wide = ps.pivot_table(index="pid", columns=["phase", "schedule"], values="acc")
wide.columns = [f"{a}_{b}" for a, b in wide.columns]
exp_cells = {"R01": (0.4167, 0.5833, 0.8333, 0.75), "R02": (0.75, 0.9167, 1.0, 1.0),
             "R03": (0.4167, 0.6667, 0.75, 0.8333), "R07": (0.4167, 0.25, 0.6667, 0.5833),
             "R08": (0.9167, 0.9167, 1.0, 0.9167), "R09": (1.0, 0.9167, 1.0, 1.0)}
for pid_, (dm, ds, em, es) in exp_cells.items():
    check(f"H2 cells {pid_} delayed massed", wide.loc[pid_, "delayed_massed"], dm)
    check(f"H2 cells {pid_} end massed", wide.loc[pid_, "end_massed"], em)
ph_con = (wide["end_massed"] + wide["end_spaced"]) / 2 - \
         (wide["delayed_massed"] + wide["delayed_spaced"]) / 2
sc_con = (wide["end_spaced"] + wide["delayed_spaced"]) / 2 - \
         (wide["end_massed"] + wide["delayed_massed"]) / 2
ix_con = (wide["delayed_spaced"] - wide["delayed_massed"]) - \
         (wide["end_spaced"] - wide["end_massed"])
for name, con, expF, expP, expEta in [
        ("phase", ph_con, 14.322034, 0.012831, 0.741228),
        ("schedule", sc_con, 0.106383, 0.757509, 0.020833),
        ("phase x schedule", ix_con, 2.142857, 0.203111, 0.3)]:
    r = one_sample_t(con, 0.0)
    F = r["t"] ** 2
    check(f"H2 ANOVA {name} F", F, expF, tol=5e-4)
    check(f"H2 ANOVA {name} p", r["p"], expP, tol=5e-5)
    check(f"H2 ANOVA {name} partial eta2", F / (F + r["df"]), expEta, tol=5e-4)
note("H2 cell means", f"end-practice: spaced {wide['end_spaced'].mean():.4f} massed "
     f"{wide['end_massed'].mean():.4f}; delayed: spaced {wide['delayed_spaced'].mean():.4f} "
     f"massed {wide['delayed_massed'].mean():.4f}")

# ---------- 4.2.iii calibration ----------
fp3 = ta[ta["session_label"].isin(PRACTICE) & (ta["retry_attempt"] == 1)].copy()
crated = fp3[fp3["confidence"].notna() & fp3["correct"].notna()]
check("rated first-pass practice trials", len(crated), 571)
lvl = crated.groupby("confidence")["correct"].agg(n="size", acc="mean")
for lv, (n_exp, a_exp) in {1: (86, 0.534884), 2: (90, 0.4),
                           3: (222, 0.878378), 4: (173, 0.930636)}.items():
    check(f"confidence level {lv} n", lvl.loc[lv, "n"], n_exp)
    check(f"confidence level {lv} accuracy", lvl.loc[lv, "acc"], a_exp, tol=5e-5)
gam_rows = []
for pid_, g in crated.groupby("pid"):
    gam = gk_gamma(g["confidence"], g["correct"]) if g["confidence"].nunique() >= 2 else np.nan
    bias = float(((g["confidence"] - 1) / 3).mean() - g["correct"].mean())
    gam_rows.append((pid_, gam, bias, len(g)))
gpp = pd.DataFrame(gam_rows, columns=["pid", "gamma", "bias", "n"])
note("per-participant gamma", {r['pid']: round(r['gamma'], 3) for _, r in gpp.iterrows()})
note("mean gamma (resolution)", f"{gpp['gamma'].mean():.3f} (SE {gpp['gamma'].std(ddof=1)/np.sqrt(6):.3f}; "
     f"undefined for {int(gpp['gamma'].isna().sum())})")
bias_t = one_sample_t(gpp["bias"], 0.0)
check("confidence bias t-test p (vs Holm family raw)", bias_t["p"], 0.1358272, tol=5e-6)
note("confidence bias mean", f"{gpp['bias'].mean():+.4f} (SE {gpp['bias'].std(ddof=1)/np.sqrt(6):.4f}), "
     f"t({bias_t['df']})={bias_t['t']:.3f}, p={bias_t['p']:.4f}")

# predictions
pred_a = pred[pred["pid"].isin(included)].copy()
fpr = fp3[fp3["correct"].notna()]
realized = (fpr.groupby(["pid", "session_label"])["correct"]
            .agg(realized="sum", n_items="size").reset_index())
pm = pred_a.rename(columns={"value": "predicted"}).merge(realized, on=["pid", "session_label"])
pm["bias"] = pm["predicted"] - pm["realized"]
check("prediction rows", len(pm), 48)
check("prediction R03 spaced-S4 predicted", pm.loc[(pm["pid"] == "R03") &
      (pm["session_label"] == "spaced-S4"), "predicted"].iloc[0], 1)
pb_t = one_sample_t(pm["bias"], 0.0)
check("prediction bias p", pb_t["p"], 2.4292232e-08, tol=1e-9)
r_pr, p_pr = stats.pearsonr(pm["predicted"], pm["realized"])
check("prediction corr p", p_pr, 6.4284722e-06, tol=1e-7)
note("prediction summary", f"mean predicted {pm['predicted'].mean():.2f}, mean realized "
     f"{pm['realized'].mean():.2f}, mean bias {pm['bias'].mean():+.2f} (SE "
     f"{pm['bias'].std(ddof=1)/np.sqrt(len(pm)):.2f}); t({pb_t['df']})={pb_t['t']:.3f}; "
     f"r={r_pr:.3f}")
note("prediction bias by schedule",
     pm.assign(sched=np.where(pm["session_label"].isin(SPACED), "spaced", "massed"))
       .groupby("sched")["bias"].mean().to_dict())

# forced choices
fca = fc[fc["pid"].isin(included)].copy()
fca["predicted_better"] = fca["choice"].map({"set_a": "spaced", "set_b": "massed", "same": "same"})
fca = fca.merge(coll[["pid", "advantage"]], on="pid", how="left")
fca["actual_better"] = np.select([fca["advantage"] > 0, fca["advantage"] < 0],
                                 ["spaced", "massed"], default="same")
check("forced-choice rows", len(fca), 12)
for cp in ["day_4_immediate", "day_14_delayed"]:
    sub = fca[fca["checkpoint"] == cp]
    agree = (sub["predicted_better"] == sub["actual_better"]).mean()
    note(f"set-preference {cp}", f"choices: " +
         str(sub["predicted_better"].value_counts().to_dict()) +
         f"; agreement {agree:.2f} (n={len(sub)})")
    tab = pd.crosstab(sub["predicted_better"], sub["actual_better"])
    chi2, pchi, dfchi, _ = stats.chi2_contingency(tab, correction=False)
    check(f"setpref {cp} chi2", chi2, 0.750, tol=5e-4)
    check(f"setpref {cp} chi2 p", pchi, 0.6873, tol=5e-4)
check("actually-better split (collapsed)",
      str(dict(fca[fca["checkpoint"] == "day_14_delayed"]["actual_better"].value_counts())),
      str({'spaced': 4, 'massed': 2}))
piv = fca.pivot_table(index="pid", columns="checkpoint", values="predicted_better", aggfunc="first")
changed = int((piv["day_4_immediate"] != piv["day_14_delayed"]).sum())
check("set-preference shift: changed choices", changed, 2)
note("shift detail", {p: (piv.loc[p, 'day_4_immediate'], piv.loc[p, 'day_14_delayed'])
                      for p in piv.index if piv.loc[p, 'day_4_immediate'] != piv.loc[p, 'day_14_delayed']})

# trajectories
fp3["idx"] = fp3["session_label"].str[-1].astype(float)
fp3["sched"] = np.where(fp3["session_label"].isin(SPACED), "spaced", "massed")
conf_traj = (fp3[fp3["confidence"].notna()]
             .groupby(["pid", "sched", "idx"])["confidence"].mean().rename("v").reset_index())
# OLS slope of the measure on retrieval position, NaN with fewer than 2 points.
def slope(g):
    if g["idx"].nunique() < 2:
        return np.nan
    return float(np.polyfit(g["idx"], g["v"], 1)[0])
csl = (conf_traj.groupby(["pid", "sched"])[["idx", "v"]].apply(slope).rename("slope")
       .reset_index().pivot_table(index="pid", columns="sched", values="slope"))
tt_cs = paired_t(csl["spaced"], csl["massed"])
check("confidence slope t", tt_cs["t"], -2.5545, tol=5e-4)
check("confidence slope p", tt_cs["p"], 0.051, tol=5e-4)
note("confidence slopes", f"spaced {tt_cs['mean_a']:+.4f}/position, massed {tt_cs['mean_b']:+.4f}; "
     f"dz={tt_cs['dz']:.3f} CI [{tt_cs['dz_lo']:.3f},{tt_cs['dz_hi']:.3f}]")
pred_a["idx"] = pred_a["session_label"].str[-1].astype(float)
pred_a["sched"] = np.where(pred_a["session_label"].isin(SPACED), "spaced", "massed")
ptraj = pred_a.rename(columns={"value": "v"})
psl = (ptraj.groupby(["pid", "sched"])[["idx", "v"]].apply(slope).rename("slope")
       .reset_index().pivot_table(index="pid", columns="sched", values="slope"))
tt_ps = paired_t(psl["spaced"], psl["massed"])
check("prediction slope t", tt_ps["t"], -2.4212, tol=5e-4)
check("prediction slope p", tt_ps["p"], 0.06, tol=5e-4)
note("prediction slopes", f"spaced {tt_ps['mean_a']:+.3f}/block, massed {tt_ps['mean_b']:+.3f}; "
     f"dz={tt_ps['dz']:.3f} CI [{tt_ps['dz_lo']:.3f},{tt_ps['dz_hi']:.3f}]")
# trajectory group means spot-checks
cm = conf_traj.groupby(["sched", "idx"])["v"].mean()
check("confidence massed pos1", cm[("massed", 1.0)], 2.3472, tol=5e-4)
check("confidence massed pos4", cm[("massed", 4.0)], 2.9028, tol=5e-4)
check("confidence spaced pos1", cm[("spaced", 1.0)], 2.8889, tol=5e-4)
pmn = ptraj.groupby(["sched", "idx"])["v"].mean()
check("prediction massed pos1", pmn[("massed", 1.0)], 4.6667, tol=5e-4)
check("prediction massed pos4", pmn[("massed", 4.0)], 8.6667, tol=5e-4)
check("prediction spaced pos1", pmn[("spaced", 1.0)], 7.3333, tol=5e-4)

# Holm family recompute
fam_p = {"calibration_bias_vs_0": bias_t["p"], "prediction_bias_vs_0": pb_t["p"],
         "prediction_vs_realized_corr": p_pr,
         "setpref_prospective_chi2": 0.6872892787909721,
         "setpref_retrospective_chi2": 0.6872892787909721,
         "trajectory_confidence_slope": tt_cs["p"], "trajectory_prediction_slope": tt_ps["p"]}
adj = holm(fam_p)
for k, v in {"calibration_bias_vs_0": 0.4074816, "prediction_bias_vs_0": 1.70046e-07,
             "prediction_vs_realized_corr": 3.857083e-05, "setpref_prospective_chi2": 1.0,
             "trajectory_confidence_slope": 0.2549387,
             "trajectory_prediction_slope": 0.2549387}.items():
    check(f"Holm-adjusted {k}", adj[k], v, tol=5e-5)

# ---------- timeout audit ----------
t_all = tr.copy()
is_full_a = t_all["qtype"].astype(str).str.contains("full", case=False)
t_all["target"] = np.where(is_full_a, t_all["full_name"], t_all["feature"])
t_all["releni"] = [1 if (norm_lenient(r) != "" and norm_lenient(r) == norm_lenient(x)) else 0
                   for r, x in zip(t_all["raw_answer"], t_all["target"])]
t_all["restrict"] = [1 if (norm_strict(r) != "" and norm_strict(r) == norm_strict(x)) else 0
                     for r, x in zip(t_all["raw_answer"], t_all["target"])]
has_c = t_all["correct"].notna()
mism = int((t_all.loc[has_c, "correct"].astype(int) != t_all.loc[has_c, "releni"]).sum())
check("integrity: stored correct reproduces from raw_answer (mismatches)", mism, 0)
check("integrity: NULL correct rows", int((~has_c).sum()), 0)
check("total trials", len(t_all), 1155)
to = t_all[t_all["timed_out"] == 1].copy()
to["empty"] = to["raw_answer"].map(norm_lenient) == ""
check("timeouts overall", len(to), 32)
check("timeouts empty", int(to["empty"].sum()), 20)
check("timeouts lenient-correct", int(to["releni"].sum()), 0)
check("timeouts strict-correct", int(to["restrict"].sum()), 0)
tos = to[to["pid"].isin(included)]
check("analysis-sample timeouts", len(tos), 16)
check("analysis-sample timeouts empty", int(tos["empty"].sum()), 11)
by_phase = tos.groupby("phase").size()
check("timeouts delayed", by_phase.get("delayed", 0), 9)
check("timeouts massed practice", by_phase.get("massed", 0), 3)
check("timeouts spaced practice", by_phase.get("spaced", 0), 4)
tsc = ta.groupby("phase").size()
check("analysis-sample trials delayed", tsc.get("delayed", 0), 216)
check("analysis-sample trials massed", tsc.get("massed", 0), 363)
check("analysis-sample trials spaced", tsc.get("spaced", 0), 373)
note("timeout rates (analysis sample)",
     f"delayed {9/216*100:.2f}%, massed practice {3/363*100:.2f}%, spaced practice {4/373*100:.2f}%")
fp_to_confnull = fp3[(fp3["timed_out"] == 1) & (fp3["confidence"].isna())]
check("confidence-null first-pass practice timeouts (calibration exclusions)",
      len(fp_to_confnull), 5)

# ---------- 4.2.vi ----------
fam_a = fam[fam["pid"].isin(included)].copy()
fam_a["set"] = fam_a["checkpoint"].map({"spaced_intro": "spaced", "massed_intro": "massed"})
fs = fam_a.groupby("set")["value"].agg(n="size", mean="mean", sd="std")
check("ease rating spaced mean", fs.loc["spaced", "mean"], 5.622222, tol=5e-5)
check("ease rating massed mean", fs.loc["massed", "mean"], 4.977778, tol=5e-5)
check("ease rating n per set", fs.loc["spaced", "n"], 45)
ease_t = paired_t(fam_a[fam_a["set"] == "spaced"].groupby("pid")["value"].mean(),
                  fam_a[fam_a["set"] == "massed"].groupby("pid")["value"].mean())
note("ease rating paired t (per-pid means; confounded with list content/occasion)",
     f"t({ease_t['df']})={ease_t['t']:.3f}, p={ease_t['p']:.4f}")

# ---------- chapter-only extras ----------
# achieved retention interval: massed-B4 completion -> delayed start, per completer
ri = {}
for p in included:
    g = tr[tr["pid"] == p]
    b4 = g.loc[g["session_label"] == "massed-B4", "session_completed_at"].dropna().max()
    dstart = g.loc[g["session_label"] == "delayed", "session_started_at"].dropna().min()
    if pd.notna(b4) and pd.notna(dstart):
        ri[p] = (dstart - b4).total_seconds() / 86400
note("achieved retention interval (days, massed-B4 completion -> delayed start)",
     {k: round(v, 1) for k, v in ri.items()})
note("RI summary", f"min {min(ri.values()):.1f}, median {np.median(list(ri.values())):.1f}, "
     f"max {max(ri.values()):.1f} days")
# ceiling check
note("delayed collapsed per-participant (spaced, massed)",
     {r['pid']: (round(r['spaced'], 3), round(r['massed'], 3)) for _, r in coll.iterrows()})
note("cells at 1.0 (ceiling)", int((cells == 1.0).to_numpy().sum()))
note("Q-blank cells >= 11/12", int((qb[["spaced", "massed"]] >= 11 / 12 - 1e-9).to_numpy().sum()))
# fatigue proxies across massed blocks B1..B4
mb = ta[ta["session_label"].isin(MASSED)]
to_mb = mb[mb["timed_out"] == 1].groupby("session_label").size().reindex(MASSED).fillna(0).astype(int)
note("massed-block timeouts B1..B4", to_mb.to_dict())
lat_mb = lat[lat["sched"] == "massed"].groupby("idx")["lat"].mean()
note("massed-block mean median-RT B1..B4 (ms)", {int(k): round(v) for k, v in lat_mb.items()})
fpa_mb = fpa[fpa["sched"] == "massed"].groupby("idx")["fpa"].mean()
note("massed-block first-pass accuracy B1..B4", {int(k): round(v, 3) for k, v in fpa_mb.items()})
sp4_to = int(ta[(ta["session_label"] == "spaced-S4") & (ta["timed_out"] == 1)].shape[0])
note("spaced-S4 timeouts (same sitting, before massed)", sp4_to)
# R04 half-completer descriptives
r04 = tr[(tr["pid"] == "R04")].copy()
r04d = r04[(r04["session_label"] == "delayed")].copy()
if len(r04d):
    r04d["correct"] = pd.to_numeric(r04d["correct"], errors="coerce").fillna(0)
    sp_grp = {"option1": "C-1", "option2": "C-2"}[r04["option_id"].iloc[0]]
    r04d["half"] = np.where(r04d["group_id"] == sp_grp, "practised(spaced)", "untrained(massed-never)")
    qmask = r04d["qtype"].astype(str).str.lower().str.contains("blank")
    summ04 = r04d.groupby(["half"])["correct"].agg(n="size", acc="mean")
    summ04b = r04d[qmask].groupby(["half"])["correct"].agg(n="size", acc="mean")
    note("R04 (half-completer) delayed, all items", summ04.round(3).to_dict())
    note("R04 delayed, Q-blank only", summ04b.round(3).to_dict())
    note("R04 practice labels completed",
         sorted(r04.loc[r04["session_completed_at"].notna(), "session_label"].dropna().unique()))
# session labels present for R11
r11 = tr[tr["pid"] == "R11"]
note("R11 sessions (delayed-only, matches pending 01-12345 deletion)",
     sorted(r11["session_label"].dropna().unique()))
# accuracy-by-confidence non-monotonicity detail (levels 1 vs 2)
note("guess-vs-unsure detail", f"level1 n=86 acc={lvl.loc[1,'acc']:.3f}, level2 n=90 acc={lvl.loc[2,'acc']:.3f}")

# ---------- print ----------
n_pass = sum(1 for s, _, _ in results if s == "PASS")
n_fail = sum(1 for s, _, _ in results if s == "FAIL")
print(f"\n{'='*88}\nVERIFICATION REPORT  --  {n_pass} PASS / {n_fail} FAIL\n{'='*88}")
for s, label, detail in results:
    if s == "FAIL":
        print(f"[{s}] {label}\n        {detail}")
print("-" * 88)
for s, label, detail in results:
    if s == "PASS":
        print(f"[{s}] {label}: {detail}")
print("-" * 88)
for s, label, detail in results:
    if s == "NOTE":
        print(f"[NOTE] {label}:\n        {detail}")
