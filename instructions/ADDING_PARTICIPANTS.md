# Adding a participant to the reminder spreadsheet

Plain-language steps for enrolling a participant so their daily reminder emails go out.
(For how the study itself runs, see `LAB_HANDOFF.md` or the app code.)

After a participant finishes Visit 1 and has a **study ID** and a **start date**, add them
to the spreadsheet:

1. Open **`ChemFlashcards_participants.xlsx`** from the lab's shared Queen's OneDrive — the
   shared online copy, not a downloaded one.
2. In the **`Participants`** table, click into the last row and add a **new row**
   (don't leave any blank rows).
3. Fill in the columns:
   - **first_name** — their first name (used to greet them in the email).
   - **email** — their email. Double-check it; a typo means they get no reminders.
   - **participant_id** — copy it **exactly** from the assignment sheet, e.g. `03-12345`.
     Keep the leading zero. Don't make one up.
   - **day1_date** — their start date typed as **year-month-day**: `2026-06-20`.
     Not `06/20/2026`, not `June 20`.
   - **reminder_time** — the time of day to send their emails, as a whole hour in 24-hour
     form (`09:00`, `15:00`, `18:00`…), from the dropdown. **Leave it blank for the default
     of 3:00 PM.**
   - **status** — type **`active`** to start the reminders. (Use anything else, e.g.
     `hold`, to keep someone in the sheet without sending — for example before their date is set.)
   - (`visit2_date` and `RI_days` fill in by themselves — don't type in those.)
4. **Save.**

That's it. The system then emails them automatically at their reminder time (or 3 PM if you
left it blank): Day 1 on their start date, Days 2–4 the next three days, and a nudge about
their second lab visit a couple of days before it.

## The two things that must be right

- **The start date** must be plain text as year-month-day (`2026-06-20`). If Excel turns it
  into a regular date or a different format, the reminder timing breaks.
- **The participant ID** must keep its leading zero (`03-12345`, not `312345`).

If either cell looks like a **right-aligned number** instead of **left-aligned text**, set
the cell format to Text (Home → Number format → Text) and retype it before saving.

## To pause or withdraw someone

Change their **status** from `active` to `withdrawn`. The reminders stop and their data is untouched.
