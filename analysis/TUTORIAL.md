# Tutorial — running the analysis from start to finish

This is the plain, step-by-step guide. No coding needed. If you can put a file in
a folder and double-click, you can run this.

---

## The 30-second version

1. Put your exported workbook (the `.xlsx` with the 4 sheets) in the
   **`participant-data\data`** folder.
2. Double-click **`RUN_ANALYSIS.bat`**.
3. Open the **`participant-data\results`** folder — your tables and plots are there.

*(First time only: double-click `INSTALL_FIRST_TIME.bat` once before step 2.)*

That's it. The rest of this file just explains each part in case you need it.

### Why everything lives under `participant-data`

The `participant-data` folder holds the real export and everything the analysis
generates from it. That whole folder is deliberately kept out of version
control, so participant-level files can never be published by accident. The
scripts and guides in the `analysis` folder itself are shared; anything with a
participant in it stays in `participant-data`. If you add new data or outputs,
put them there too.

---

## One-time setup (do this once per computer)

**1. Make sure Python is installed.**
Open the Start menu, type `cmd`, press Enter, then type:

```
py --version
```

- If you see something like `Python 3.14.6`, you're set — skip to step 2.
- If you see an error, install Python from <https://www.python.org/downloads/>.
  **On the first install screen, tick the box "Add python.exe to PATH"**, then
  finish the install and reopen `cmd` to check again.

**2. Install the packages the analysis needs.**
Double-click **`INSTALL_FIRST_TIME.bat`**. A window opens, installs everything,
and ends with "Setup finished." You only ever do this once.

---

## Running the analysis (every time you have new data)

**1. Export the data.** From the study's export, save the workbook — the file
named like `chemflashcards_all_YYYY-MM-DD.xlsx` with the four sheets
(`Trials`, `Ease ratings`, `Predictions`, `Forced choices`).

**2. (Optional) Add the questionnaire baseline.** If you have the transcribed
baseline questionnaire (for 4.2.vi), save it as a CSV whose name contains the
word "baseline" or "questionnaire". See `baseline_template.csv` and
`baseline_codebook.md` for how to fill it in.

**3. Drop the file(s) into the `participant-data\data` folder.** Put the `.xlsx`
(and the baseline CSV, if you have one) inside the folder called **`data`** that
sits inside **`participant-data`**, next to this tutorial.

**4. Run it.** Double-click **`RUN_ANALYSIS.bat`**. A black window opens and
shows progress. When it finishes it prints a summary like:

```
   [OK ]  4.2.i   Spacing effect at delay
   [OK ]  4.2.ii  Acquisition curves
   [OK ]  4.2.iii Calibration
   [OK ]  4.2.vi  Baseline & exclusions
   [OK ]  Audit   Timed-out trials (all phases)
```

**5. Read your results.** Everything is written to the
**`participant-data\results`** folder.

---

## What you get in the `participant-data\results` folder

| File type | What it is | Open it with |
|-----------|------------|--------------|
| `.csv`    | result tables (t-tests, ANOVA, summaries) | Excel (double-click) |
| `.png`    | the plots / figures | any image viewer (double-click) |
| `.sav`    | the same data as an **SPSS** file | SPSS (for your supervisor) |

Grouped by subsection:

- **4.2.i** — `42i_confirmatory_qblank.csv` (**the main result**: the
  pre-specified confirmatory test, spaced vs massed on the fill-in-the-blank
  retention items), `42i_group_comparison.csv` (spaced vs massed, secondary),
  the SPSS-style paired-samples and within-subjects tables, and
  `42i_per_participant_advantage.png`.
- **4.2.ii** — `42ii_curves_summary.csv` and `42ii_practice_curves.png`
  (first-pass accuracy, trials-to-mastery, retrieval speed over sessions).
- **4.2.iii** — the calibration tables and `42iii_calibration.png`.
- **4.2.vi** — `42vi_sample_summary.csv`, `42vi_exclusions_manifest.csv`
  (who's in/out and why), and the prior-knowledge / familiarity tables + plots.
- **Timeout audit** — `timeout_audit_rows.csv` / `timeout_audit_summary.csv`
  (every trial that hit the 20-second limit and what was typed).

Re-running overwrites the previous results, so each run gives you a fresh set.

### New tables added 2026-07-22 (plain-English guide)

| File | The question it answers |
|------|--------------------------|
| `42i_confirmatory_qblank.csv` | **The headline test.** Did spacing help on the fill-in-the-blank retention items? (This is the one pre-registered confirmatory test; everything else is supporting.) |
| `42i_primary_scoring.csv` + `42i_scoring_flips.csv` | What do the delayed scores look like under the primary scoring rule (full-name answers must be in exact IUPAC form), and how many answers change between the strict and lenient rules? |
| `42i_delayed_rt_by_format.csv` | Were spaced items answered faster at the delayed test, separately for each question format? |
| `42i_inverse_efficiency.csv` | Combining speed AND accuracy into one number, which schedule was more efficient at the delayed test? |
| `42i_recency_descriptives.csv` | How long before the delayed test had each kind of item last been practised? (Context for reading the schedule × format results.) |
| `42i_list_check.csv` | Is one of the two item lists (C-1 / C-2) simply easier? (Should be "no".) |
| `42ii_phase_schedule_interaction.csv` | Did massed practice look fine at the end of practice but lose at the delayed test — the crossover the study predicts? |
| `42ii_relearning_spaced.csv` | Within the spaced condition, did items get faster to re-learn each day? |
| `42iii_setpref_contingency.csv` | As a group, did participants judge the set they were actually better at — before and after taking the test? |
| `42iii_trajectory.csv` | Did confidence and predictions grow differently under the two schedules across the four sessions? (Exploratory.) |
| `42iii_timeout_audit_summary.csv` | What was excluded from the calibration because of timeouts, and why that's safe. |
| `42iii_holm_family.csv` | The metacognition p-values corrected for testing several things at once. |
| `timeout_audit_rows.csv` / `timeout_audit_summary.csv` | Every timed-out trial in the export: did anyone actually type a correct answer and just miss the submit button? (So far: never.) |

---

## If you'd rather type commands (optional)

Open a terminal in this folder (in File Explorer, click the address bar, type
`cmd`, press Enter) and run **one** of:

```
py run_all.py                          (auto-finds the file in participant-data\data)
py run_all.py C:\path\to\your_export.xlsx
```

To run a single subsection instead of all four:

```
py analysis_42i_spacing_effect.py --data C:\path\to\your_export.xlsx
```

---

## For your supervisor (SPSS)

Every run also writes `.sav` SPSS data files into `participant-data\results` (e.g.
`42i_data_2x2.sav`). Your supervisor can open one directly in SPSS and re-run the
test to confirm the Python numbers. For the 2×2 ANOVA, open `42i_data_2x2.sav`
and use **Analyze → General Linear Model → Repeated Measures** with two 2-level
factors (schedule × format). The result will match what the script reports.

---

## Troubleshooting

| Message | What to do |
|---------|-----------|
| `'py' is not recognized` | Python isn't installed or not on PATH. Reinstall from python.org and tick "Add python.exe to PATH". (Or try `python run_all.py`.) |
| `Missing required packages` | Double-click `INSTALL_FIRST_TIME.bat` and let it finish, then try again. |
| `No data file found` | Put your `.xlsx` export inside the `participant-data\data` folder, then run again. |
| `Found more than one possible data file` | Keep only the one you want in the `participant-data\data` folder (move the others out). |
| The window closes instantly | Run it from `cmd` instead so you can read the message: `py run_all.py`. |
| A subsection says `FAIL` | Scroll up in the window to the red/plain error line; it usually names a missing column or file. |

---

## If a run says [FAIL] with "PermissionError"

That is almost always Excel: Excel **locks** any CSV it has open, so the
pipeline cannot overwrite last run's table. Close the results files in Excel
(or close Excel) and run again. Nothing is wrong with the data or the scripts.

## The figures folder

After a run, look in `participant-data\results\figures\` — there is one picture per analysis
(18 in all), each readable on its own: the title says what it shows, both axes
are labelled with units, and the colors are always the same (blue = spaced,
orange = massed). The paired charts draw a thin line for every participant and
a bold line for the group average, so you can see both the overall effect and
who went the other way.

## Sharing with an AI assistant (plain-English version)

If you want an AI to help read the results, don't give it the raw export — give
it a **shareable copy**. Open a terminal in this folder and run:

```
python make_shareable_export.py --data data\your_export.xlsx
python run_all.py participant-data\data\your_export_SHAREABLE.xlsx
```

The first command makes a copy where every participant is renamed to a random
code (a fresh shuffle every time you run it) and every date is moved to a fake
year-2000 calendar. All the numbers the analysis needs (accuracy, timing gaps,
confidence, everything) are unchanged — only the things that could identify
*when* and *who* are gone. The second command runs the whole analysis on that
copy, so everything in `participant-data\results` uses the random codes too and is safe to
share. One rule: the file ending in `_PID_MAPPING_DO_NOT_SHARE.csv` is your
private decoder ring — never upload or paste that one.

## What is *not* included yet

Sections **4.2.iv (gaze)** and **4.2.v (recognition task)** come from the
eye-tracking pipeline, not this app export, and their measures aren't finalized
yet — so there are no scripts for them here. They'll be added once the
eye-tracking collaborators lock the measures.
