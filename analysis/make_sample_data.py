"""
make_sample_data.py  --  Generate a SYNTHETIC ChemFlashcards export for testing.
================================================================================

This writes fake-but-realistically-shaped data that matches the real export
schema, so you (or the scripts' author) can run the 4.2.x analyses end-to-end
WITHOUT using any real participant data. Every value here is randomly generated;
no real person is represented.

It produces both input shapes the analysis scripts accept:
  * sample_data/sample_export.xlsx        (4-sheet workbook)
  * sample_data/csv/{trials,familiarity,predictions,forced_choices}.csv
  * sample_data/questionnaire_baseline.csv  (for 4.2.vi --baseline)

The synthetic sample is built to exercise the code paths:
  * a real spacing effect (spaced > massed at delay),
  * practice curves that improve over sessions,
  * a dev/test id (excluded), an incomplete participant (excluded),
  * and one ISI-timing violator (kept but flagged).

Realism details the newer analyses depend on:
  * item_ids follow the real instrument convention -- practice items look like
    "C1-S2-f5" and each delayed item is a practice item_id plus a "-blank" /
    "-full" suffix (Q-blank items are the 12 Session-4 instances per group;
    Q-full items come from Sessions 1-3) -- so the last-practice-recency and
    phase x schedule analyses can link test items back to practice.
  * raw_answer really is the typed answer: correct rows carry the target
    (sometimes with hyphens turned to spaces on Q-full, so the LENIENT and
    STRICT scoring rules genuinely disagree on some trials), wrong rows carry a
    non-matching string. Stored `correct` always equals the instrument's
    lenient re-score of raw_answer, like the real app.
  * a small number of trials time out (timed_out=1, rt_ms capped at 20000,
    empty or fragment answer, no confidence prompt), so the timeout audit has
    something to sweep.
  * stim_on_ts / stim_off_ts advance trial by trial through each session
    instead of all sharing the session timestamps.

RUN
    python make_sample_data.py
"""

from __future__ import annotations
import os
import datetime as dt
import numpy as np
import pandas as pd

RNG = np.random.default_rng(20260721)
HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(HERE, "sample_data")
MAX_RETRIES = 5
TIMEOUT_MS = 20000  # the app's 20-second answer window

# participant specs: (pid, option_id, dev_mode, complete, isi_bad)
# These ids are FABRICATED. They deliberately sit in a 9xxxx block that real
# enrolment never uses, so nothing here can be mistaken for a real participant
# and a repo-wide search for live ids stays free of false positives.
PARTICIPANTS = [
    ("01-90001", "option1", 0, True,  False),
    ("02-90001", "option2", 0, True,  False),
    ("03-90002", "option1", 0, True,  False),
    ("04-90002", "option2", 0, True,  False),
    ("01-90003", "option1", 0, True,  False),
    ("02-90003", "option2", 0, True,  False),
    ("05-90009", "option1", 0, True,  True),   # ISI violator (kept, flagged)
    ("02-90099", "option2", 0, False, False),  # incomplete (excluded)
    ("01-DEV0",  "option1", 1, True,  False),  # dev/test id (excluded)
]

SPACED_LABELS = ["spaced-S1", "spaced-S2", "spaced-S3", "spaced-S4"]
MASSED_LABELS = ["massed-B1", "massed-B2", "massed-B3", "massed-B4"]


# Formats a datetime as the export's "YYYY-MM-DD HH:MM:SS" string.
def ts(d: dt.datetime) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S")


# Returns the group practised on the spaced schedule under a counterbalance option.
def spaced_group(option_id: str) -> str:
    return "C-1" if option_id == "option1" else "C-2"


def compact(grp: str) -> str:
    """'C-1' -> 'C1' -- the group prefix used inside real item_ids."""
    return grp.replace("-", "")


def full_name_for(grp: str, session: int, item_n: int) -> str:
    """A hyphenated fake IUPAC name, so lenient (hyphens->spaces) and strict
    (exact form) scoring can genuinely disagree on typed answers."""
    return f"mol-{compact(grp).lower()}-{session}-{item_n}"


def sim_attempts(p_first: float):
    """Simulate one item's mastery-loop attempts. Returns list of
    (retry_attempt, correct, soft_capped)."""
    out = []
    for a in range(1, MAX_RETRIES + 1):
        p = min(0.95, p_first + 0.12 * (a - 1))
        if RNG.random() < p:
            out.append((a, 1, 0)); return out
        out.append((a, 0, 1 if a == MAX_RETRIES else 0))
    return out


def conf_for(correct: int) -> int:
    """Confidence that tracks correctness (so calibration has signal)."""
    if correct:
        return int(RNG.choice([2, 3, 4, 4], p=[0.1, 0.3, 0.3, 0.3]))
    return int(RNG.choice([1, 1, 2, 3], p=[0.4, 0.2, 0.3, 0.1]))


def answer_for(correct: int, target: str, qtype: str,
               p_timeout_if_wrong: float):
    """
    Build (raw_answer, timed_out) for one trial the way the instrument would
    record it. Correct answers reproduce the target (Q-full sometimes with
    hyphens as spaces -- lenient-correct but strict-wrong); wrong answers are a
    non-matching string; a fraction of WRONG answers become timeouts with an
    empty or fragment answer, so no generated timeout is ever correct.
    """
    if correct:
        raw = target
        if qtype == "Q-full" and RNG.random() < 0.35:
            raw = target.replace("-", " ")  # lenient yes, strict no
        return raw, 0
    if RNG.random() < p_timeout_if_wrong:
        # timeout: mostly a true non-response, sometimes mid-typing fragment
        raw = "" if RNG.random() < 0.6 else target[: max(1, len(target) // 3)]
        return raw, 1
    return "wrong-answer", 0


# Generates every synthetic table: trials, familiarity, predictions, forced
# choices, and the questionnaire baseline.
def build():
    trials, predictions, forced, familiarity, baseline = [], [], [], [], []
    trial_id = 0
    session_id = 0
    enroll0 = dt.datetime(2026, 6, 22, 15, 0, 0)

    for pi, (pid, option, dev, complete, isi_bad) in enumerate(PARTICIPANTS):
        enroll = enroll0 + dt.timedelta(days=pi)
        sp_grp = spaced_group(option)
        ma_grp = "C-2" if sp_grp == "C-1" else "C-1"
        skill = RNG.uniform(-0.08, 0.08)  # participant random effect

        def emit_practice(label, phase, grp, sess_start, sess_done, p_first):
            """One 12-item practice session incl. mastery-loop retries.
            Returns the first-pass-correct count (for the prediction rows)."""
            nonlocal trial_id
            fp_correct = 0
            order = 0
            cursor = sess_start  # per-trial stimulus clock inside the session
            snum = int(label.split("-")[1][1:])  # spaced-S3 -> 3, massed-B2 -> 2
            for item_n in range(1, 13):
                feat = f"f{item_n}"
                item_id = f"{compact(grp)}-S{snum}-{feat}"
                full = full_name_for(grp, snum, item_n)
                for (att, correct, cap) in sim_attempts(p_first):
                    order += 1; trial_id += 1
                    if att == 1 and correct:
                        fp_correct += 1
                    # practice is all Q-blank; target = feature
                    raw, timed_out = answer_for(correct, feat, "Q-blank",
                                                p_timeout_if_wrong=0.08)
                    rt = (TIMEOUT_MS if timed_out else
                          max(600, int(RNG.normal(4200 - 180 * snum, 900))))
                    review = int(RNG.uniform(1200, 3800))
                    stim_on = cursor
                    stim_off = stim_on + dt.timedelta(milliseconds=rt + review)
                    cursor = stim_off + dt.timedelta(seconds=1)
                    trials.append(dict(
                        pid=pid, option_id=option, enrollment_date=ts(enroll),
                        dev_mode=dev, participant_tz="America/Toronto",
                        session_id=session_id, session_label=label, phase=phase,
                        group_practiced=grp, session_started_at=ts(sess_start),
                        session_completed_at=ts(sess_done),
                        session_context="online",
                        trial_id=trial_id, item_id=item_id, group_id=grp,
                        feature=feat, full_name=full, qtype="Q-blank",
                        raw_answer=raw, correct=correct, rt_ms=rt,
                        review_ms=review, stim_on_ts=ts(stim_on),
                        stim_off_ts=ts(stim_off), trial_order=order,
                        timed_out=timed_out, retry_attempt=att,
                        soft_capped=cap,
                        # the app skips the confidence prompt on a timeout
                        confidence=(None if timed_out else conf_for(correct)),
                        trial_created_at=ts(stim_off)))
            return fp_correct

        # ---- spaced practice: S1..S4, ~24h apart (one violator gets a 10h gap)
        sess_start = enroll + dt.timedelta(hours=2)
        for si, label in enumerate(SPACED_LABELS):
            if si > 0:
                gap = 10 if (isi_bad and si == 1) else RNG.uniform(22, 26)
                sess_start = sess_start + dt.timedelta(hours=gap)
            session_id += 1
            sess_done = sess_start + dt.timedelta(minutes=12)
            p_first = min(0.9, 0.45 + 0.1 * si + skill)  # improves over sessions
            fp_correct = emit_practice(label, "spaced", sp_grp,
                                       sess_start, sess_done, p_first)
            predictions.append(dict(pid=pid, session_label=label,
                                    value=int(np.clip(fp_correct + RNG.integers(-1, 3),
                                                      0, 12)),
                                    created_at=ts(sess_start)))

        # ---- massed practice on day 4: B1..B4 back-to-back --------------------
        n_blocks = 4 if complete else 3   # incomplete participant misses B4
        massed_day = sess_start + dt.timedelta(hours=RNG.uniform(23, 26))
        block_start = massed_day
        for bi in range(n_blocks):
            label = MASSED_LABELS[bi]
            session_id += 1
            block_done = block_start + dt.timedelta(minutes=10)
            p_first = min(0.9, 0.5 + 0.06 * bi + skill)
            fp_correct = emit_practice(label, "massed", ma_grp,
                                       block_start, block_done, p_first)
            predictions.append(dict(pid=pid, session_label=label,
                                    value=int(np.clip(fp_correct + RNG.integers(-1, 3),
                                                      0, 12)),
                                    created_at=ts(block_start)))
            block_start = block_done + dt.timedelta(minutes=2)

        # ---- familiarity ("Ease ratings") for both intro checkpoints ---------
        for chk, grp in (("spaced_intro", sp_grp), ("massed_intro", ma_grp)):
            for item_n in range(1, 13):
                familiarity.append(dict(
                    pid=pid, checkpoint=chk,
                    item_id=f"{compact(grp)}-S1-f{item_n}",
                    group_id=grp, feature=f"f{item_n}",
                    full_name=full_name_for(grp, 1, item_n),
                    value=int(RNG.integers(1, 8)),
                    created_at=ts(enroll + dt.timedelta(hours=1))))

        # ---- questionnaire baseline (external file, matches baseline_template) -
        named = int(RNG.random() < 0.4)
        baseline.append(dict(
            pid=pid,
            q1_language=str(RNG.choice(["English", "French", "Other"],
                                       p=[0.8, 0.1, 0.1])),
            q3_age=int(RNG.integers(18, 30)),
            q4_affiliation=str(RNG.choice(
                ["Undergraduate student", "Graduate student", "Faculty"],
                p=[0.7, 0.25, 0.05])),
            q7_last_chem_course=str(RNG.choice(
                ["Secondary School (Highschool)", "Undergraduate-level",
                 "Graduate-level", "Never"], p=[0.2, 0.6, 0.15, 0.05])),
            q9_iupac_familiarity=int(RNG.integers(0, 5)),
            q10_answer=str(RNG.choice(["iodoethane", "ethyl iodide", "(blank)",
                                       "1-iodoethane"])),
            q10_named_correct=named))

        # ---- delayed test ~7 days after day 4 (only if completer) ------------
        if not complete:
            continue
        delayed_start = massed_day + dt.timedelta(days=7, hours=RNG.uniform(-2, 2))
        delayed_done = delayed_start + dt.timedelta(minutes=15)
        session_id += 1
        order = 0
        cursor = delayed_start
        # Delayed item plan mirrors delayed_posttest_v2.csv: per group, the 12
        # Q-blank RETENTION items are the Session-4 practice instances and the
        # 6 Q-full items are drawn from Sessions 1-3 (2 per session). Each
        # delayed item_id = the practice item_id + "-blank"/"-full".
        adv = RNG.uniform(0.10, 0.24)  # spaced advantage for this participant
        for grp in (sp_grp, ma_grp):
            is_spaced = (grp == sp_grp)
            base_p = 0.62 + skill + (adv / 2 if is_spaced else -adv / 2)
            plan = [("Q-blank", 4, n) for n in range(1, 13)] + \
                   [("Q-full", s, n) for s in (1, 2, 3) for n in (1, 2)]
            for qtype, snum, item_n in plan:
                order += 1; trial_id += 1
                feat = f"f{item_n}"
                full = full_name_for(grp, snum, item_n)
                practice_item = f"{compact(grp)}-S{snum}-{feat}"
                suffix = "blank" if qtype == "Q-blank" else "full"
                target = feat if qtype == "Q-blank" else full
                p = float(np.clip(base_p + (0.05 if qtype == "Q-full" else 0),
                                  0.05, 0.95))
                correct = int(RNG.random() < p)
                raw, timed_out = answer_for(correct, target, qtype,
                                            p_timeout_if_wrong=0.15)
                rt = (TIMEOUT_MS if timed_out else
                      max(800, int(RNG.normal(5200, 1400))))
                stim_on = cursor
                stim_off = stim_on + dt.timedelta(milliseconds=rt + 800)
                cursor = stim_off + dt.timedelta(seconds=1)
                trials.append(dict(
                    pid=pid, option_id=option, enrollment_date=ts(enroll),
                    dev_mode=dev, participant_tz="America/Toronto",
                    session_id=session_id, session_label="delayed",
                    phase="delayed", group_practiced=None,
                    session_started_at=ts(delayed_start),
                    session_completed_at=ts(delayed_done),
                    session_context="in_person",
                    trial_id=trial_id,
                    item_id=f"{practice_item}-{suffix}", group_id=grp,
                    feature=feat, full_name=full,
                    qtype=qtype, raw_answer=raw,
                    correct=correct, rt_ms=rt,
                    review_ms=None, stim_on_ts=ts(stim_on),
                    stim_off_ts=ts(stim_off), trial_order=order,
                    timed_out=timed_out, retry_attempt=1, soft_capped=0,
                    confidence=None,   # test trials carry no confidence prompt
                    trial_created_at=ts(stim_off)))

        # ---- forced choices at day 4 and day 14 ------------------------------
        # bias the choice toward "spaced" (set_a) since spaced really is better
        for chk in ("day_4_immediate", "day_14_delayed"):
            choice = str(RNG.choice(["set_a", "set_b", "same"], p=[0.5, 0.25, 0.25]))
            forced.append(dict(pid=pid, checkpoint=chk, choice=choice,
                               confidence=int(RNG.integers(1, 4)),
                               created_at=ts(delayed_start if "14" in chk else massed_day)))

    return (pd.DataFrame(trials), pd.DataFrame(familiarity),
            pd.DataFrame(predictions), pd.DataFrame(forced), pd.DataFrame(baseline))


# Builds the synthetic tables and writes them as one workbook and per-table CSVs.
def main():
    os.makedirs(OUTDIR, exist_ok=True)
    csvdir = os.path.join(OUTDIR, "csv"); os.makedirs(csvdir, exist_ok=True)
    trials, familiarity, predictions, forced, baseline = build()

    # xlsx workbook (sheet names match the real export)
    xlsx = os.path.join(OUTDIR, "sample_export.xlsx")
    with pd.ExcelWriter(xlsx) as xw:
        trials.to_excel(xw, sheet_name="Trials", index=False)
        familiarity.to_excel(xw, sheet_name="Ease ratings", index=False)
        predictions.to_excel(xw, sheet_name="Predictions", index=False)
        forced.to_excel(xw, sheet_name="Forced choices", index=False)

    # per-table CSVs
    trials.to_csv(os.path.join(csvdir, "trials.csv"), index=False)
    familiarity.to_csv(os.path.join(csvdir, "familiarity.csv"), index=False)
    predictions.to_csv(os.path.join(csvdir, "predictions.csv"), index=False)
    forced.to_csv(os.path.join(csvdir, "forced_choices.csv"), index=False)
    baseline.to_csv(os.path.join(OUTDIR, "questionnaire_baseline.csv"), index=False)

    print(f"Wrote synthetic data to {OUTDIR}")
    print(f"  {xlsx}")
    print(f"  {csvdir}/*.csv")
    print(f"  {os.path.join(OUTDIR, 'questionnaire_baseline.csv')}")
    print(f"  trials rows: {len(trials)}, participants: {trials['pid'].nunique()}, "
          f"timeouts: {int((trials['timed_out'] == 1).sum())}")


if __name__ == "__main__":
    main()
