# REMINDERS_SETUP.md

How the participant daily-reminder emails are sent. **As-built and tested
2026-06-15** (updated 2026-06-15: per-participant send time, hourly run, Visit-2 nudge
at +8). The system lives in **Microsoft Power Automate** (a scheduled cloud
flow) that reads a OneDrive Excel table and sends via Outlook. It is operated by
the lab and is independent of the webapp at runtime.

> **Why Power Automate and not Qualtrics (researched 2026-06-15).** Qualtrics has
> no clean way to send "N days after each participant's own start date": workflow
> delays cap at 7 days with no re-evaluation; Distribution Automations are
> calendar-only; and contact filters only do date *ranges*, not "equals today / N
> days ago." The fully-Microsoft path (Excel + Outlook, both **standard**
> connectors) is included with Queen's M365 and does exactly what we need. See
> DESIGN_RATIONALE.md (2026-06-15) for the full comparison and rejected alternatives.

> **The webapp half is already live.** Reminder links point to
> `chemflashcards.com/study?pid=<id>`. `public/landing-v2.js` reads `?pid=`,
> prefills the ID, runs an idempotent routing check, and stops on a "Continue"
> button — no trial starts and no data is written from the link alone (commit
> `09bb0e3`, live on master).

---

## Participant flow

1. **Visit 1 (in person).** Consent + paper questionnaire. The lab assigns the
   participant ID and records the participant's chosen **Day-1 start date**.
2. **Enrolment.** The participant's row (first name, email, ID, Day-1 date,
   `status = active`) goes into the Excel table (Part 1).
3. **Days 1-4 (at home).** The flow emails a reminder each day at the participant's
   chosen time (a whole hour in `reminder_time`; **blank = 3 PM Eastern**) with the link
   `chemflashcards.com/study?pid=<their ID>`.
4. **Visit-2 nudge (~2 days before).** The flow emails a reminder to check their calendar
   for the in-lab Visit 2. (Calendly, run by AB/Ebun, books Visits 1 and 2 and sends its
   own 24-hour reminder; this is a belt-and-suspenders nudge, now sent a couple of days
   ahead rather than the day of.)

Reminder offsets from `day1_date`: **Day 1 = +0, Day 2 = +1, Day 3 = +2,
Day 4 = +3, Visit-2 nudge = +8**. (Was +10 / "Day 11"; moved to +8 on 2026-06-15 so the
nudge arrives before the visit, not the day of.)

---

## Part 1 — the data source (Excel table)

Workbook `ChemFlashcards_participants.xlsx` in the lab's **Queen's (work) OneDrive**,
containing a formatted Table named **`Participants`**:

| Column | Notes |
|---|---|
| `first_name` | Used in the greeting. |
| `email` | Where the reminder is sent. |
| `participant_id` | Assigned ID, e.g. `03-12345`. **Text** (preserves leading zero; the first digit's parity sets the study condition — copy it from the assignment sheet, never invent it). |
| `day1_date` | The at-home Day-1 start date. **MUST be Text, `yyyy-mm-dd`** (e.g. `2026-06-20`) or the flow's date math breaks. |
| `reminder_time` | Whole hour to send, 24-hour **Text** (e.g. `09:00`, `15:00`, `18:00`). **Blank = the 3 PM default.** Has a dropdown from `07:00` to `21:00`; the flow matches on the hour only. |
| `status` | `active` = send. Anything else (`withdrawn`, `example`) = skipped. |

Two further columns are **auto-calculated scheduling aids** (the flow ignores them):

| Column | Notes |
|---|---|
| `visit2_date` | `day1_date + 10` (= 7 days after Day 4), shifted off weekends: **Sat to the Fri before (6-day RI), Sun to the Mon after (8-day RI)**. **Highlighted yellow when the interval is not 7 days**, a flag to keep the RI at 7 where possible. |
| `RI_days` | The retention interval the row works out to: 6, 7, or 8. |

`participant_id`, `day1_date`, and `reminder_time` are pre-formatted as Text. Three harmless
EXAMPLE rows (`status = example`) ship in the file showing the 7- / 6- / 8-day cases; they
never send. Delete them before enrolling real participants.
**Set `status = active` only once `day1_date` is filled** (a blank date errors the
offset). Add/remove whole rows; don't leave `active` rows with a blank date.

*Open choice:* how the table is populated — the researcher types each row at Visit 1
(current assumption; the table doubles as the enrolment/tracking sheet), or a
Microsoft Form auto-adds rows (would need a step to reformat its date to yyyy-mm-dd).

---

## Part 2 — the flow (`ChemFlashcards daily reminders`)

A scheduled cloud flow at make.powerautomate.com (signed in with the Queen's
account; Excel + Outlook are standard connectors, no premium licence):

1. **Recurrence** — Frequency `Day`, Interval `1`, Time zone **(UTC-05:00) Eastern
   Time (US & Canada)**, **At these hours `7,8,9,10,11,12,13,14,15,16,17,18,19,20,21`**
   (7 AM to 9 PM), At these minutes **0**. The flow wakes at the top of each of those
   hours and emails only the people whose `reminder_time` is that hour.
2. **Compose `TodayEastern`** —
   ```
   convertTimeZone(utcNow(),'UTC','Eastern Standard Time','yyyy-MM-dd')
   ```
   Today's Eastern date as text. `Eastern Standard Time` auto-handles daylight saving.
3. **Compose `HourEastern`** —
   ```
   convertTimeZone(utcNow(),'UTC','Eastern Standard Time','HH')
   ```
   The current Eastern hour, `00` to `23`.
4. **List rows present in a table** (Excel Online (Business)) — the workbook + table
   `Participants`; **Filter Query** `status eq 'active'`.
5. **Filter array** — keep only rows whose send-hour equals the current hour.
   **From** = the `value` from List rows; **Filter Query** (advanced mode):
   ```
   @equals(if(empty(trim(coalesce(item()?['reminder_time'],''))),15,int(first(split(trim(item()?['reminder_time']),':')))),int(outputs('HourEastern')))
   ```
   (the row's hour, or `15` if `reminder_time` is blank, equals the current hour).
6. **Apply to each** row of the **Filter array output** (`body('Filter_array')`):
   - **Compose `DayOffset`** —
     ```
     div(sub(ticks(outputs('TodayEastern')), ticks(items('Apply_to_each')?['day1_date'])), 864000000000)
     ```
   - **Compose `LinkURL`** —
     ```
     concat('https://chemflashcards.com/study?pid=', items('Apply_to_each')?['participant_id'])
     ```
   - **Switch** on `outputs('DayOffset')`: case `0` → Day 1, `1` → Day 2, `2` → Day 3,
     `3` → Day 4, `8` → Visit-2 nudge, **Default** → nothing. (Case `10` was removed on
     2026-06-15; the nudge now goes out at +8, a couple of days before the visit.)
   - In each case, **Send an email (V2)** (Office 365 Outlook; sends from the
     signed-in Queen's account): **To** = the row's `email`; **Subject** + **Body** per
     Part 3.

---

## Part 3 — the five email bodies (code view / HTML)

Paste each into its Switch case's **Send an email (V2) → Body** in **code view
(`</>`)**, then **Save from code view** — do not switch back to the visual editor,
which mangles the link. The link is the single token `@{outputs('LinkURL')}`; the
name is wrapped in `trim(...)` to avoid stray spaces.

**Day 1** (case `0`) — Subject: `Your ChemFlashcards study starts today`
```html
<p class="editor-paragraph">Hi @{trim(items('Apply_to_each')?['first_name'])},<br><br>Today is your first at-home practice day. When you have about 25 minutes, open your session:<br><br><a href="@{outputs('LinkURL')}" class="editor-link">Open today's session</a><br><br>Your ID is already filled in, so just click Continue when the page loads.<br><br>Thanks,<br>The QCER Lab, Queen's University</p>
```

**Day 2** (case `1`) — Subject: `ChemFlashcards: day 2`
```html
<p class="editor-paragraph">Hi @{trim(items('Apply_to_each')?['first_name'])},<br><br>This is your reminder to do today's practice session (about 6 to 8 minutes):<br><br><a href="@{outputs('LinkURL')}" class="editor-link">Open today's session</a><br><br>Thanks for keeping your daily schedule going,<br>The QCER Lab</p>
```

**Day 3** (case `2`) — Subject: `ChemFlashcards: day 3` (body identical to Day 2)
```html
<p class="editor-paragraph">Hi @{trim(items('Apply_to_each')?['first_name'])},<br><br>This is your reminder to do today's practice session (about 6 to 8 minutes):<br><br><a href="@{outputs('LinkURL')}" class="editor-link">Open today's session</a><br><br>Thanks for keeping your daily schedule going,<br>The QCER Lab</p>
```

**Day 4** (case `3`) — Subject: `ChemFlashcards: day 4, your last at-home day`
```html
<p class="editor-paragraph">Hi @{trim(items('Apply_to_each')?['first_name'])},<br><br>Today is your final at-home day. It runs a bit longer, around 45 to 60 minutes, so please set aside the time:<br><br><a href="@{outputs('LinkURL')}" class="editor-link">Open today's session</a><br><br>After today, your only remaining step is your in-person visit.<br><br>Thanks,<br>The QCER Lab</p>
```

**Visit-2 nudge** (case `8`) — Subject: `ChemFlashcards: your in-person Visit 2 is coming up` (no link)
```html
<p class="editor-paragraph">Hi @{trim(items('Apply_to_each')?['first_name'])},<br><br>Your in-person Visit 2 is coming up in a couple of days. Please check your calendar for the date and time you booked, and make sure you can attend. If you need to reschedule, reply to this email or contact the lab.<br><br>There is nothing to do at home for this step; Visit 2 happens in the lab.<br><br>Thanks,<br>The QCER Lab</p>
```

---

## Part 4 — testing

Use **Test → Run manually** (the schedule is irrelevant to testing). Keep one test
row with your own email, `status = active`, and change its `day1_date` relative to
**today's real date**, re-running each time:

| `day1_date` | Expected email |
|---|---|
| today | Day 1 |
| today − 1 | Day 2 |
| today − 2 | Day 3 |
| today − 3 | Day 4 |
| today − 8 | Visit-2 nudge |
| today − 10 | nothing (the old day-of email was removed) |

Click the link in Days 1-4 and confirm it lands on `chemflashcards.com/study?pid=…`.
Set the test row's `reminder_time` to the **current whole hour** (else it won't pass the
Filter array). If a run sends the wrong email (or nothing), open **run history** and read `TodayEastern`, `HourEastern`, and
`DayOffset` outputs — the offset is just (today − day1_date) in days.

---

## Part 5 — running it day to day

- **Enrol:** add the participant's row at Visit 1; set `status = active` once
  `day1_date` is filled.
- **Pause/withdraw:** set `status` to anything other than `active` (reminders stop;
  data untouched).
- **Safeguards:** keep the flow **On**; name a **backup operator**; do a weekly
  check that reminders fired (Power Automate run history). A run that errors emails
  the flow owner by default.

---

## Rejected / fallback (historical)

- **Qualtrics-native date-anchored sending** — not possible (delays cap at 7 days;
  automations are calendar-only; filters do ranges only). See DESIGN_RATIONALE.md.
- **Qualtrics manual daily send** — the lab would each morning send a date-filtered
  distribution per cohort. Reliable but a daily chore + single point of failure.
  Was the fallback before Power Automate was chosen.
- **Qualtrics → Power Automate hybrid** — needs a *premium* connector; the
  all-Microsoft path is free, so this was avoided.
