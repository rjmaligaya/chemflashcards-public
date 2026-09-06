"""
run_all.py  --  One command to run every 4.2.x analysis.

WHAT IT DOES
------------
Finds your data export, runs all four analysis scripts, and puts every table and
plot in a single `results/` folder. You don't have to run the scripts one by one.

HOW IT FINDS YOUR DATA
----------------------
  * If you pass a path, it uses that:  python run_all.py my_export.xlsx
  * Otherwise it looks for a single .xlsx workbook in `participant-data/data/`,
    then in a legacy `data/` subfolder, then in this folder (ignoring the sample
    and template files).
  * It also auto-detects a questionnaire baseline CSV (any file whose name
    contains "baseline" or "questionnaire") sitting next to the data, and passes
    it to 4.2.vi. If none is found, 4.2.vi simply runs without it.

Results go to `participant-data/results/` (or pass --out yourfolder).

WHY `participant-data/`
-----------------------
Everything under `analysis/participant-data/` is real participant data or output
derived from it, so that whole folder is gitignored and never leaves this
machine. The scripts and docs in `analysis/` itself are safe to commit. Keep new
outputs inside `participant-data/` so that separation holds.

This is the file the RUN_ANALYSIS double-click launcher calls.
"""

from __future__ import annotations
import os
import sys
import glob
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

# Participant data and everything derived from it live here, and only here.
# This folder is gitignored (see the repo .gitignore) so no participant-level
# file can be committed by accident.
PRIVATE = os.path.join(HERE, "participant-data")

ANALYSES = [
    ("4.2.i   Spacing effect at delay",      "analysis_42i_spacing_effect.py"),
    ("4.2.ii  Acquisition curves",           "analysis_42ii_acquisition_curves.py"),
    ("4.2.iii Calibration",                  "analysis_42iii_calibration.py"),
    ("4.2.vi  Baseline & exclusions",        "analysis_42vi_baseline_exclusions.py"),
    ("Audit   Timed-out trials (all phases)", "analysis_timeout_audit.py"),
    ("Figures One labelled chart per analysis", "analysis_figures.py"),
]

# Packages that must be importable before anything can run.
REQUIRED = ["pandas", "numpy", "openpyxl", "scipy", "matplotlib"]


# Names of the REQUIRED packages that could not be imported.
def check_dependencies() -> list[str]:
    missing = []
    for mod in REQUIRED:
        try:
            __import__(mod)
        except Exception:
            missing.append(mod)
    return missing


def find_data(explicit: str | None) -> list[str]:
    """Return candidate data paths. If `explicit` given, just that."""
    if explicit:
        return [explicit]
    found = []
    for folder in (os.path.join(PRIVATE, "data"), os.path.join(HERE, "data"), HERE):
        if not os.path.isdir(folder):
            continue
        for f in sorted(glob.glob(os.path.join(folder, "*.xlsx"))):
            base = os.path.basename(f).lower()
            if any(skip in base for skip in ("sample", "template", "~$")):
                continue
            found.append(f)
        # a folder of per-table CSVs also counts, if placed under data/
    # de-duplicate while keeping order
    seen, out = set(), []
    for f in found:
        if f not in seen:
            seen.add(f); out.append(f)
    return out


# Finds a questionnaire baseline CSV beside the data, or None if there is none.
def find_baseline(data_path: str) -> str | None:
    folder = data_path if os.path.isdir(data_path) else (os.path.dirname(data_path) or HERE)
    for f in sorted(glob.glob(os.path.join(folder, "*.csv"))):
        base = os.path.basename(f).lower()
        if "template" in base:
            continue
        if "baseline" in base or "questionnaire" in base:
            return f
    # also look in the private data folder (and the legacy data/) as a fallback
    for alt in (os.path.join(PRIVATE, "data"), os.path.join(HERE, "data")):
        if not os.path.isdir(alt):
            continue
        for f in sorted(glob.glob(os.path.join(alt, "*.csv"))):
            base = os.path.basename(f).lower()
            if "template" in base:
                continue
            if "baseline" in base or "questionnaire" in base:
                return f
    return None


# Runs every analysis script in turn and returns 0 only if all of them succeed.
def main() -> int:
    # crude arg parse: first non --flag token is the data path
    args = sys.argv[1:]
    explicit_data = None
    explicit_baseline = None
    out = os.path.join(PRIVATE, "results")
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--baseline" and i + 1 < len(args):
            explicit_baseline = args[i + 1]; i += 2; continue
        if a == "--out" and i + 1 < len(args):
            out = args[i + 1]; i += 2; continue
        if not a.startswith("--"):
            explicit_data = a
        i += 1

    print("=" * 70)
    print(" ChemFlashcards  --  run all Section 4.2 analyses")
    print("=" * 70)

    missing = check_dependencies()
    if missing:
        print("\nMissing required packages: " + ", ".join(missing))
        print("Please run the one-time setup first:")
        print("   * double-click  INSTALL_FIRST_TIME.bat")
        print("   * or run:  py -m pip install -r requirements.txt")
        return 1

    candidates = find_data(explicit_data)
    if not candidates:
        print("\nNo data file found.")
        print("Put your exported workbook (the .xlsx with the 4 sheets) in this")
        print(f"folder:\n   {os.path.join(PRIVATE, 'data')}")
        print("then run this again. (Or: py run_all.py path\\to\\your_export.xlsx)")
        return 1
    if len(candidates) > 1:
        print("\nFound more than one possible data file:")
        for c in candidates:
            print("   " + c)
        print("Please keep only the one you want here, or name it explicitly:")
        print("   py run_all.py path\\to\\your_export.xlsx")
        return 1

    data = candidates[0]
    baseline = explicit_baseline or find_baseline(data)
    os.makedirs(out, exist_ok=True)

    print(f"\nData file : {data}")
    print(f"Baseline  : {baseline or '(none found -- 4.2.vi will run without it)'}")
    print(f"Results to: {out}\n")

    results = []
    for title, script in ANALYSES:
        print("\n" + "-" * 70)
        print(f" Running {title}")
        print("-" * 70)
        cmd = [sys.executable, os.path.join(HERE, script), "--data", data,
               "--out", out]
        if script.startswith("analysis_42vi") and baseline:
            cmd += ["--baseline", baseline]
        rc = subprocess.run(cmd).returncode
        results.append((title, rc == 0))

    print("\n" + "=" * 70)
    print(" SUMMARY")
    print("=" * 70)
    for title, ok in results:
        print(f"   [{'OK ' if ok else 'FAIL'}]  {title}")
    print(f"\nAll tables and plots are in:\n   {out}")
    if not all(ok for _, ok in results):
        print("\nSome analyses reported a problem above -- scroll up for the message.")
        return 1
    print("\nDone. You can open the CSV tables in Excel and the .png plots in any")
    print("image viewer. The .sav files can be opened directly in SPSS.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
