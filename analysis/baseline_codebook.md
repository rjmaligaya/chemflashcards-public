# Baseline questionnaire codebook (for 4.2.vi)

How to transcribe the paper questionnaire (`Questionnaire-2026-06-04`) into
`baseline_template.csv`. One row per participant. `4.2.vi` reads this file with
`--baseline`. The **primary prior-knowledge measure is Q10** ("could you name
the molecule"); Q9 and the demographics characterize the sample.

| Column | Questionnaire item | How to code |
|--------|--------------------|-------------|
| `pid` | (assigned) | Exact participant id as used in the app export, in the form `01-XXXXX` / `02-XXXXX`. Must match, or the participant won't merge. |
| `q1_language` | Q1 first language | `English`, `French`, or the text they wrote for "Other". |
| `q3_age` | Q3 age | Whole number of years. Leave blank if declined. |
| `q4_affiliation` | Q4 which best describes you | One of: `Not affiliated`, `Undergraduate student`, `Graduate student`, `Postdoctoral fellow`, `Faculty`, or their "Other" text. |
| `q7_last_chem_course` | Q7 last chemistry course | One of: `Primary or Middle School`, `Secondary School (Highschool)`, `Undergraduate-level`, `Graduate-level`, `Never`, or "Other" text. |
| `q9_iupac_familiarity` | Q9 IUPAC familiarity (5-point) | Code **0–4**: 0 = Not at all (never heard of it), 1 = Heard of it, 2 = Know a little, 3 = Know a fair amount, 4 = Know it very well. |
| `q10_answer` | Q10 free-text IUPAC name written | Copy what they wrote verbatim (for the record). Blank if they left it blank. |
| `q10_named_correct` | Q10 scored | **1** if the name they gave is correct, **0** if incorrect or blank. This is the primary prior-knowledge score. |

## Notes
- `q10_named_correct` is the number the analysis treats as "prior knowledge."
  Because it is 1/0, its mean is simply the **proportion of participants who
  could name the molecule** before practice.
- If you'd rather score Q10 as free text only and let the script derive the
  yes/no flag from a differently-named column, set `BASELINE_NAMED_COL` in
  `common.py` to that column's name.
- Column names are all configurable in `common.py` (the `BASELINE_*` settings) —
  change them there if your transcription uses different headers.
- Only participants who are **included** in the analysis (completers, non-dev)
  are summarized; the rest are ignored automatically.
