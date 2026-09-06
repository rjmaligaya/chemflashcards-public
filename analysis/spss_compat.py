"""
spss_compat.py  --  SPSS-parity statistics layer.

WHY THIS EXISTS
---------------
The analysis is done in Python, but the numbers need to match what SPSS would
report so results are trustworthy to an SPSS-using supervisor/reviewer. This
module wraps each inferential test so that it:

  1. Produces the SAME statistics SPSS produces (t, df, p, F, CI, effect sizes),
     using pingouin when available (its output mirrors SPSS) and falling back to
     scipy / statsmodels otherwise. The core t/F/p/CI are identical across all
     three engines; only convenience columns differ.
  2. Returns tables shaped like SPSS's own output tables (e.g. "Paired Samples
     Test", "Tests of Within-Subjects Effects"), so the printout/CSV looks
     familiar.
  3. Carries the exact SPSS menu path for the test (see SPSS_PROCEDURES).
  4. Can write a `.sav` SPSS data file (via pyreadstat) of the prepared analysis
     dataset, so the supervisor can open the SAME data in SPSS and reproduce the
     test by hand. This is the bridge between "I did it in Python" and "you can
     confirm it in SPSS."

A NOTE ON SPSS DEFAULTS WE MATCH DELIBERATELY
  * Paired Cohen's d: SPSS (v27+) standardizes by the SD of the DIFFERENCES
    (this is d_z). We compute d_z explicitly rather than using a library default,
    which may use a different standardizer.
  * ANOVA effect size: SPSS reports PARTIAL eta-squared. We compute it as
    SS_effect / (SS_effect + SS_error) = (F*df1)/(F*df1 + df2), which is exact.
  * Sphericity: with only two levels on a within factor, Mauchly's test is not
    applicable (epsilon = 1); the "sphericity assumed" row IS the corrected row.
    Our 2x2 design has two-level factors throughout, so no correction is needed.
"""

from __future__ import annotations
import warnings
import numpy as np
import pandas as pd

# Exact SPSS menu paths, so every result can say where it comes from in SPSS.
SPSS_PROCEDURES = {
    "paired_t":     "SPSS: Analyze > Compare Means > Paired-Samples T Test",
    "rm_anova":     "SPSS: Analyze > General Linear Model > Repeated Measures",
    "one_sample_t": "SPSS: Analyze > Compare Means > One-Sample T Test",
    "correlation":  "SPSS: Analyze > Correlate > Bivariate (Pearson)",
    "crosstab_chi2":"SPSS: Analyze > Descriptive Statistics > Crosstabs (Chi-square)",
    "descriptives": "SPSS: Analyze > Descriptive Statistics > Frequencies/Descriptives",
}


# Imports pingouin and returns the module, or None when it is not installed.
def _pingouin():
    try:
        import pingouin as pg
        return pg
    except Exception:
        return None


def _first(row, *names, default=np.nan):
    """First matching column value in a 1-row pingouin result (column names
    have drifted across pingouin versions, e.g. 'p-val' vs 'p_val')."""
    for n in names:
        if n in row.index:
            return row[n]
    return default


def engines_available() -> dict:
    """What SPSS-parity tooling is installed, for a startup banner."""
    # True when the named module imports successfully.
    def ok(mod):
        try:
            __import__(mod); return True
        except Exception:
            return False
    return {"pingouin": ok("pingouin"), "scipy": ok("scipy"),
            "statsmodels": ok("statsmodels"), "pyreadstat": ok("pyreadstat")}


# ── paired-samples t-test ────────────────────────────────────────────────────

def paired_ttest(a, b, name_a="cond_a", name_b="cond_b") -> dict:
    """
    Paired-samples t-test, returned as the fields SPSS shows across its
    "Paired Samples Statistics" and "Paired Samples Test" tables, plus d_z.
    """
    pair = pd.DataFrame({name_a: a, name_b: b}).dropna()
    n = len(pair)
    diff = pair[name_a] - pair[name_b]
    res = {
        "spss": SPSS_PROCEDURES["paired_t"], "n": n,
        f"mean_{name_a}": float(pair[name_a].mean()) if n else np.nan,
        f"sd_{name_a}": float(pair[name_a].std(ddof=1)) if n > 1 else np.nan,
        f"mean_{name_b}": float(pair[name_b].mean()) if n else np.nan,
        f"sd_{name_b}": float(pair[name_b].std(ddof=1)) if n > 1 else np.nan,
        "mean_diff": float(diff.mean()) if n else np.nan,
        "sd_diff": float(diff.std(ddof=1)) if n > 1 else np.nan,
        "sem_diff": np.nan, "t": np.nan, "df": max(n - 1, 0),
        "p_2tailed": np.nan, "ci95_low": np.nan, "ci95_high": np.nan,
        "cohen_d_dz": np.nan, "engine": "none", "note": "",
    }
    if n < 2:
        res["note"] = "need >=2 paired observations"
        return res

    sem = diff.std(ddof=1) / np.sqrt(n)
    res["sem_diff"] = float(sem)
    res["cohen_d_dz"] = float(diff.mean() / diff.std(ddof=1)) if diff.std(ddof=1) else np.nan

    pg = _pingouin()
    if pg is not None:
        row = pg.ttest(pair[name_a], pair[name_b], paired=True).iloc[0]
        res.update(t=float(row["T"]),
                   p_2tailed=float(_first(row, "p-val", "p_val")),
                   engine="pingouin")
        # power / BF10 are handy SPSS-adjacent extras when present
        for extra in ("power", "BF10"):
            if extra in row.index:
                res[extra] = row[extra]
    else:
        try:
            from scipy import stats
            t, p = stats.ttest_rel(pair[name_a], pair[name_b])
            res.update(t=float(t), p_2tailed=float(p), engine="scipy")
        except Exception as exc:
            res["note"] = f"scipy/pingouin unavailable ({exc})"
            return res

    # 95% CI of the mean difference (t-based) -- identical to SPSS
    try:
        from scipy import stats
        tcrit = stats.t.ppf(0.975, n - 1)
        res["ci95_low"] = float(diff.mean() - tcrit * sem)
        res["ci95_high"] = float(diff.mean() + tcrit * sem)
    except Exception:
        pass
    return res


def paired_ttest_tables(res: dict, name_a: str, name_b: str):
    """Render `paired_ttest` output as two SPSS-style tables (DataFrames)."""
    stats_tbl = pd.DataFrame([
        {"variable": name_a, "Mean": res.get(f"mean_{name_a}"),
         "N": res["n"], "Std. Deviation": res.get(f"sd_{name_a}")},
        {"variable": name_b, "Mean": res.get(f"mean_{name_b}"),
         "N": res["n"], "Std. Deviation": res.get(f"sd_{name_b}")},
    ])
    test_tbl = pd.DataFrame([{
        "pair": f"{name_a} - {name_b}",
        "Mean (difference)": res["mean_diff"], "Std. Deviation": res["sd_diff"],
        "Std. Error Mean": res["sem_diff"], "95% CI Lower": res["ci95_low"],
        "95% CI Upper": res["ci95_high"], "t": res["t"], "df": res["df"],
        "Sig. (2-tailed)": res["p_2tailed"], "Cohen's d (d_z)": res["cohen_d_dz"],
    }])
    return stats_tbl.round(4), test_tbl.round(4)


# ── one-sample t-test (used for prediction bias vs 0) ────────────────────────

# One-sample t-test of x against popmean, with df, two-tailed p, and a 95% CI
# on the mean difference.
def one_sample_ttest(x, popmean=0.0) -> dict:
    x = pd.Series(x).dropna()
    n = len(x)
    res = {"spss": SPSS_PROCEDURES["one_sample_t"], "test_value": popmean,
           "n": n, "mean": float(x.mean()) if n else np.nan,
           "sd": float(x.std(ddof=1)) if n > 1 else np.nan,
           "mean_diff": float(x.mean() - popmean) if n else np.nan,
           "t": np.nan, "df": max(n - 1, 0), "p_2tailed": np.nan,
           "ci95_low": np.nan, "ci95_high": np.nan, "engine": "none"}
    if n < 2:
        return res
    try:
        from scipy import stats
        t, p = stats.ttest_1samp(x, popmean)
        sem = x.std(ddof=1) / np.sqrt(n)
        tcrit = stats.t.ppf(0.975, n - 1)
        res.update(t=float(t), p_2tailed=float(p), engine="scipy",
                   ci95_low=float((x.mean() - popmean) - tcrit * sem),
                   ci95_high=float((x.mean() - popmean) + tcrit * sem))
    except Exception as exc:
        res["note"] = f"scipy unavailable ({exc})"
    return res


# ── 2x2 repeated-measures ANOVA ──────────────────────────────────────────────

def rm_anova(long_df: pd.DataFrame, dv: str, within: list, subject: str) -> pd.DataFrame:
    """
    Repeated-measures ANOVA shaped like SPSS "Tests of Within-Subjects Effects"
    (sphericity-assumed rows): Source, SS, df, MS, F, Sig., Partial Eta Squared.
    Uses pingouin if available, else statsmodels AnovaRM. Only subjects with all
    cells are used. Returns empty with a printed note if unavailable/underpowered.
    """
    # keep only subjects present in every cell
    cells_per_subject = long_df.groupby(subject).size()
    full = cells_per_subject.max() if len(cells_per_subject) else 0
    complete = cells_per_subject[cells_per_subject == full].index
    data = long_df[long_df[subject].isin(complete)].copy()
    n_sub = data[subject].nunique()
    if n_sub < 2:
        print(f"  [RM-ANOVA] skipped: only {n_sub} complete participant(s).")
        return pd.DataFrame()

    pg = _pingouin()
    rows = []
    if pg is not None:
        aov = pg.rm_anova(data=data, dv=dv, within=within, subject=subject,
                          detailed=True)
        for _, r in aov.iterrows():
            F, df1, df2 = r["F"], r["ddof1"], r["ddof2"]
            peta = (F * df1) / (F * df1 + df2) if pd.notna(F) else np.nan
            rows.append({
                "Source": r["Source"], "Type III SS": r.get("SS", np.nan),
                "df": df1, "Mean Square": r.get("MS", np.nan), "F": F,
                "Sig.": r.get("p-unc", r.get("p_unc", np.nan)),
                "Partial Eta Squared": peta,
                "Error df": df2, "engine": "pingouin"})
    else:
        try:
            from statsmodels.stats.anova import AnovaRM
        except Exception as exc:
            print(f"  [RM-ANOVA] skipped: no pingouin/statsmodels ({exc}).")
            return pd.DataFrame()
        res = AnovaRM(data, depvar=dv, subject=subject, within=within).fit()
        tbl = res.anova_table
        for src, r in tbl.iterrows():
            F, df1, df2 = r["F Value"], r["Num DF"], r["Den DF"]
            peta = (F * df1) / (F * df1 + df2)
            rows.append({"Source": src, "Type III SS": np.nan, "df": df1,
                         "Mean Square": np.nan, "F": F, "Sig.": r["Pr > F"],
                         "Partial Eta Squared": peta, "Error df": df2,
                         "engine": "statsmodels"})

    out = pd.DataFrame(rows)
    out.insert(0, "n_participants", n_sub)
    # sphericity note: every within factor here has 2 levels -> not applicable
    two_level = all(data.groupby(w)[w].nunique().shape[0] <= 2 or
                    data[w].nunique() == 2 for w in within)
    out.attrs["sphericity_note"] = (
        "Mauchly's test of sphericity is not applicable: every within-subjects "
        "factor has 2 levels (epsilon = 1), so the sphericity-assumed F is exact "
        "and no Greenhouse-Geisser/Huynh-Feldt correction is needed."
        if two_level else
        "One or more within factors has >2 levels; check sphericity if reporting.")
    return out.round(6)


# ── Pearson correlation ──────────────────────────────────────────────────────

# Pearson correlation of x with y: r, two-tailed p, and a 95% CI where available.
def pearson_corr(x, y) -> dict:
    d = pd.DataFrame({"x": x, "y": y}).dropna()
    n = len(d)
    res = {"spss": SPSS_PROCEDURES["correlation"], "n": n, "r": np.nan,
           "p_2tailed": np.nan, "ci95_low": np.nan, "ci95_high": np.nan}
    if n < 3 or d["x"].nunique() < 2 or d["y"].nunique() < 2:
        res["note"] = "need >=3 points with variation"
        return res
    pg = _pingouin()
    if pg is not None:
        row = pg.corr(d["x"], d["y"]).iloc[0]
        res.update(r=float(row["r"]),
                   p_2tailed=float(_first(row, "p-val", "p_val")))
        ci = _first(row, "CI95%", "CI95", default=None)
        if ci is not None and len(ci) == 2:
            res["ci95_low"], res["ci95_high"] = float(ci[0]), float(ci[1])
    else:
        from scipy import stats
        r, p = stats.pearsonr(d["x"], d["y"])
        res.update(r=float(r), p_2tailed=float(p))
    return res


# ── crosstab chi-square (categorical: forced choice vs actual better) ────────

# Pearson chi-square test of independence on the a-by-b contingency table.
def crosstab_chi2(a, b) -> dict:
    d = pd.DataFrame({"a": a, "b": b}).dropna()
    res = {"spss": SPSS_PROCEDURES["crosstab_chi2"], "n": len(d)}
    if d.empty:
        res["note"] = "no data"; return res
    table = pd.crosstab(d["a"], d["b"])
    res["table"] = table
    try:
        from scipy import stats
        chi2, p, dof, _ = stats.chi2_contingency(table)
        res.update(chi2=float(chi2), df=int(dof), p=float(p))
    except Exception as exc:
        res["note"] = f"scipy unavailable ({exc})"
    return res


# ── write an SPSS .sav data file (so the supervisor can reproduce in SPSS) ────

# Coerces a column name into a legal SPSS variable name, at most 64 characters.
def _sav_safe(name: str) -> str:
    out = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in str(name))
    if out and out[0].isdigit():
        out = "v_" + out
    return out[:64] or "var"


def write_sav(df: pd.DataFrame, path: str, labels: dict | None = None) -> str:
    """
    Write `df` to an SPSS `.sav` file so the supervisor can open the exact
    prepared dataset in SPSS. Falls back to CSV (same basename) if pyreadstat is
    not installed. Returns the path actually written.
    """
    safe = df.copy()
    rename = {c: _sav_safe(c) for c in safe.columns}
    safe.columns = [rename[c] for c in safe.columns]
    try:
        import pyreadstat
        col_labels = None
        if labels:
            col_labels = {rename.get(k, k): v for k, v in labels.items()}
        pyreadstat.write_sav(safe, path,
                             column_labels=col_labels)
        return path
    except Exception as exc:
        alt = path.rsplit(".", 1)[0] + ".csv"
        safe.to_csv(alt, index=False)
        warnings.warn(f"pyreadstat unavailable or failed ({exc}); wrote {alt} "
                      f"instead of {path}. Install pyreadstat for .sav output.")
        return alt
