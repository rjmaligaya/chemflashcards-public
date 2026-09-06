"""
make_shareable_export.py -- produce an AI-shareable, de-identified copy of a
                            participant-data export.

WHY THIS EXISTS
---------------
The raw export is pseudonymous (PIDs, not names), but it is still LINKABLE:
the PID maps to a person through the lab's enrolment workbook, and -- less
obviously -- the timestamps do too. Enrolment dates are millisecond-unique,
practice happens at each person's own reminder hour, and the database row IDs
encode collection order. An assistant (or anyone) holding the lab's scheduling
records could re-link rows even with the PID column blanked; blanking the PID
column alone leaves participants reconstructible from enrollment_date and
option_id.

WHAT THIS SCRIPT DOES
---------------------
1. RANDOM CODES. Participants are shuffled into a fresh random order every run
   and renamed R01..Rn. The order is re-randomized on every invocation, so two
   shareable exports made on different days cannot be cross-linked to each
   other either. The real-PID <-> code mapping is written to a separate LOCAL
   file for your eyes only -- never share that file.
2. DATE-SHIFTING. Every timestamp is shifted per participant so that each
   person's earliest recorded moment lands on the same synthetic epoch
   (2000-01-01 00:00). Everything the analysis needs is RELATIVE time --
   inter-session gaps, retention intervals, last-practice recency, trial
   order -- and all of that survives the shift bit-for-bit. What is destroyed
   is exactly the linkable part: calendar dates, time of day, and enrolment
   order.
3. ROW-ID RENUMBERING + column drops. session_id / trial_id become dense
   per-participant counters (the originals are global counters that leak
   collection order); participant_tz is dropped.

Everything else (answers, correctness, confidence, RTs, labels, option_id,
dev_mode) is analytic content and is kept unchanged.

HOW TO USE (the safe workflow)
------------------------------
    python make_shareable_export.py --data path/to/export.xlsx
    python run_all.py path/to/export_SHAREABLE.xlsx

Run the analysis ON THE SHAREABLE FILE and every results table and plot
downstream carries only the random codes -- the whole results/ folder is then
safe to hand to an AI assistant. (If you previously ran the analysis on a raw
export, regenerate results/ from the shareable file before sharing it.)

Options:
    --out PATH       where to write the shareable .xlsx
                     (default: <input>_SHAREABLE.xlsx beside the input)
    --mapping PATH   where to write the local PID<->code mapping csv
                     (default: <input>_PID_MAPPING_DO_NOT_SHARE.csv)
    --seed N         fix the shuffle for a reproducible run (testing only;
                     leave unset for real use so every run re-randomizes)
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import random

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

# Every participant's timeline is re-anchored to this synthetic moment. The
# year 2000 is deliberately impossible to confuse with a real collection date.
SYNTH_EPOCH = pd.Timestamp("2000-01-01 00:00:00")

# Columns that never belong in a shareable file.
DROP_COLS = ["participant_tz"]

# Canonical sheet names the loader (common.load_export) recognises.
SHEET_NAMES = {
    "trials": "Trials",
    "familiarity": "Ease ratings",
    "predictions": "Predictions",
    "forced_choices": "Forced choices",
}


# Every distinct pid appearing in any table, sorted.
def collect_pids(tables: dict[str, pd.DataFrame]) -> list[str]:
    pids: set[str] = set()
    for df in tables.values():
        if not df.empty and "pid" in df.columns:
            pids.update(df["pid"].dropna().astype(str).unique())
    return sorted(pids)


def participant_anchors(tables: dict[str, pd.DataFrame]) -> dict[str, pd.Timestamp]:
    """Each participant's earliest timestamp across ALL tables and ALL datetime
    columns -- the moment that becomes the synthetic epoch for them."""
    anchors: dict[str, pd.Timestamp] = {}
    for key, df in tables.items():
        if df.empty or "pid" not in df.columns:
            continue
        for col in common._DATETIME_COLS.get(key, []):
            if col not in df.columns:
                continue
            ts = pd.to_datetime(df[col], errors="coerce")
            grouped = ts.groupby(df["pid"].astype(str)).min()
            for pid, t in grouped.items():
                if pd.isna(t):
                    continue
                if pid not in anchors or t < anchors[pid]:
                    anchors[pid] = t
    return anchors


def shift_datetimes(df: pd.DataFrame, key: str,
                    anchors: dict[str, pd.Timestamp]) -> pd.DataFrame:
    """Rewrite each datetime column as SYNTH_EPOCH + (t - participant anchor).
    Relative structure (gaps, ordering, durations between timestamps) is
    preserved exactly; absolute calendar time is destroyed."""
    out = df.copy()
    if out.empty or "pid" not in out.columns:
        return out
    pid = out["pid"].astype(str)
    for col in common._DATETIME_COLS.get(key, []):
        if col not in out.columns:
            continue
        ts = pd.to_datetime(out[col], errors="coerce")
        anchor = pid.map(anchors)
        shifted = SYNTH_EPOCH + (ts - anchor)
        # ISO strings so the shareable file round-trips through the loader the
        # same way a real export does; blanks stay blank.
        out[col] = shifted.dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        out.loc[shifted.isna(), col] = None
    return out


def renumber_ids(trials: pd.DataFrame) -> pd.DataFrame:
    """Replace global session_id / trial_id counters (they leak collection
    order) with dense per-participant counters. Neither is used analytically
    (the pipeline keys on session_label and trial_order), so this is safe."""
    out = trials.copy()
    if out.empty:
        return out
    if "session_id" in out.columns:
        new_sid = {}
        for pid, grp in out.groupby(out["pid"].astype(str)):
            for i, sid in enumerate(
                    grp.sort_values("session_label")["session_id"]
                       .dropna().unique(), start=1):
                new_sid[(pid, sid)] = i
        out["session_id"] = [
            new_sid.get((p, s), np.nan)
            for p, s in zip(out["pid"].astype(str), out["session_id"])]
    if "trial_id" in out.columns:
        out["trial_id"] = out.groupby(out["pid"].astype(str)).cumcount() + 1
    return out


# Writes the de-identified export plus the local pid-to-code mapping file.
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--data", required=True,
                    help="the raw export (.xlsx) or a folder of per-table CSVs")
    ap.add_argument("--out", default=None, help="shareable .xlsx to write")
    ap.add_argument("--mapping", default=None,
                    help="local PID<->code mapping csv (DO NOT SHARE)")
    ap.add_argument("--seed", type=int, default=None,
                    help="fix the shuffle (testing only)")
    args = ap.parse_args()

    stem = (args.data.rstrip("\\/") if os.path.isdir(args.data)
            else os.path.splitext(args.data)[0])
    out_path = args.out or stem + "_SHAREABLE.xlsx"
    map_path = args.mapping or stem + "_PID_MAPPING_DO_NOT_SHARE.csv"

    tables = common.load_export(args.data)
    pids = collect_pids(tables)
    if not pids:
        sys.exit("No pid values found in this export. This script needs the "
                 "RAW export (with PIDs) -- an already-ID-stripped file has "
                 "nothing to map, and its timestamps would still be linkable. "
                 "Point --data at the original export-all file.")

    # Fresh random order every run (unless --seed, which is for tests only).
    rng = random.Random(args.seed if args.seed is not None
                        else secrets.randbits(64))
    shuffled = pids[:]
    rng.shuffle(shuffled)
    width = max(2, len(str(len(shuffled))))
    code_of = {pid: f"R{i:0{width}d}" for i, pid in enumerate(shuffled, 1)}

    anchors = participant_anchors(tables)
    missing_anchor = [p for p in pids if p not in anchors]
    if missing_anchor:
        # No timestamp at all for these pids -- nothing to shift, still mapped.
        print(f"note: {len(missing_anchor)} participant(s) had no usable "
              f"timestamp; their rows are mapped but not date-shifted.")

    out_tables: dict[str, pd.DataFrame] = {}
    for key, df in tables.items():
        if df.empty:
            out_tables[key] = df
            continue
        d = shift_datetimes(df, key, anchors)
        if key == "trials":
            d = renumber_ids(d)
        d = d.drop(columns=[c for c in DROP_COLS if c in d.columns])
        if "pid" in d.columns:
            d["pid"] = d["pid"].astype(str).map(code_of).fillna(d["pid"])
        out_tables[key] = d

    with pd.ExcelWriter(out_path, engine="openpyxl") as xw:
        for key, sheet in SHEET_NAMES.items():
            out_tables.get(key, pd.DataFrame()).to_excel(
                xw, sheet_name=sheet, index=False)

    with open(map_path, "w", newline="", encoding="utf-8") as fh:
        fh.write("# LOCAL FILE - DO NOT SHARE. Maps real participant IDs to the\n")
        fh.write("# random codes in the shareable export written alongside it.\n")
        fh.write("# The codes are re-randomized on every run of the script.\n")
        fh.write("real_pid,share_code\n")
        for pid in pids:
            fh.write(f"{pid},{code_of[pid]}\n")

    n_rows = sum(len(df) for df in out_tables.values())
    print(f"\nShareable export : {out_path}")
    print(f"Local mapping    : {map_path}   <-- keep this to yourself")
    print(f"Participants     : {len(pids)} (codes shuffled fresh this run)")
    print(f"Rows written     : {n_rows}")
    print("\nNext step: run the analysis ON THE SHAREABLE FILE so every results")
    print(f"table inherits the codes:\n    python run_all.py \"{out_path}\"")


if __name__ == "__main__":
    main()
