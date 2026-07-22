# User Manual — Spaced Repetition Review Tracker

A simple guide to using the app. No technical background needed.

## What this app does

You save short notes about things you've learned. The app tells you exactly
which ones to review each day, using a schedule called **2-7-30**:

- You add something you learned today → your first review is due **2 days**
  from now.
- You complete that review → your next one is due **7 days** later.
- You complete that one → your last review is due **30 days** later.
- Complete that third review and the item is **archived** — you're done with it.

If you miss a day, nothing is lost. An overdue item just waits for you in the
queue until you get to it — there's no penalty, and no early reviews either
(you can't review something before its due date, even if you want to).

## Creating an account

1. Open the app and click **"Need an account? Register"**.
2. Enter an email and a password (at least 8 characters, with at least one
   letter and one number).
3. You're logged in immediately after registering.

Your session stays logged in until you click **Log out** — there's no
"remember me" checkbox because there's only one mode.

## Adding something you learned

On the **Due today** tab, type what you learned into the box at the top and
click **Add item**. That's it — the app automatically schedules its first
review for 2 days from now.

## The "Due today" tab

This is your daily to-do list: everything due for review *today or earlier*.
It's normal to see items at different stages mixed together (some on their
2-day review, some on their 7-day, some on their 30-day) — the label under
each item tells you which review that item is currently on, not "how many
days until it's due." If it's showing up in this list, it's due *now*.

Each item shows:
- The full text of what you wrote
- Which review stage it's on (2-day / 7-day / 30-day)
- **Review** and **Skip** buttons

Click anywhere on an item's text (not the buttons) to open its detail view —
you'll see the exact dates and its full review history there.

### Review vs. Skip

- **Review** — click this once you've actually reviewed/recalled the item.
  It records the review and schedules the *next* one according to the
  2-7-30 rule.
- **Skip** — click this if you're not reviewing it today but don't want it
  gone either. It pushes the due date to tomorrow and tries again then.

## The "All items" tab

Browse everything you've ever added, with a filter:
- **Active** — items still going through the schedule
- **Archived** — items that finished all three reviews
- **All** — both

Click any item to open its detail view, where you can:
- **Edit** the text (this does *not* reset or change its schedule — only the
  words change)
- **Delete** it (this is a *soft* delete — it disappears from your lists but
  isn't destroyed; see Export below)

### Downloading your data

At the top of "All items," check **Include deleted** if you want deleted
items included, then click **Download my items**. This saves a `.json` file
with your account info and every item (including its full review history) —
useful as a backup, or just to see everything in one place.

## Admin features (admin accounts only)

If you're logged in as an admin, you'll see an extra **Admin** tab: a list of
every user, with a button to **Suspend** or **Unsuspend** each one. A
suspended user can't log in — even a token they already had stops working
immediately. You can't suspend yourself (the button is hidden on your own
row).

## Frequently asked

**I reviewed something by mistake — can I undo it?**
No. Review and Skip are both immediate — there's no undo. If you accidentally
advance an item's schedule, just keep going; nothing is permanently broken.

**I deleted an item — is it really gone?**
No — it's a *soft* delete. It disappears from every list, but the data still
exists and shows up if you export with "Include deleted" checked. There's
currently no "restore" button in the UI, though.

**Why can't I review something before its due date?**
That's deliberate — the whole point of the 2-7-30 method is spacing reviews
out over time. Reviewing early would defeat that.

**I don't see the Admin tab — why?**
Only accounts with the admin role see it. Regular accounts don't have access
to user management, by design.
