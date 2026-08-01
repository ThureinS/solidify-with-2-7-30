# User Manual — 2-7-30

A simple guide to using the app. No technical background needed.

The app is named after the schedule it runs on. That's the whole idea, so it
seemed like the honest thing to call it.

## What this app does

You save short notes about things you've learned. The app tells you exactly
which ones to review each day, using a schedule called **2-7-30**:

- You add something you learned today → your first review is due **2 days**
  from now.
- You complete that review → your next one is due **7 days** later.
- You complete that one → your last review is due **30 days** later.
- Complete that third review and the item is **archived** — you're done with it.

Each interval is counted from the day you *actually did* the review, not from
the day it was originally due. Review something three days late and the next
one is 7 days from *that* day.

If you miss a day, nothing is lost. An overdue item just waits for you in the
queue until you get to it — there's no penalty, and no early reviews either
(you can't review something before its due date, even if you want to).

## Creating an account

1. Open the app and switch the **Log in / Register** toggle to **Register**.
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
  gone either. It pushes the due date to tomorrow and tries again then. Your
  progress through 2-7-30 doesn't move — a skipped 7-day review is still a
  7-day review tomorrow.

Skipping is a normal, intended move, not a failure. It does get recorded
though, and you'll see it on the History page — see below.

### The numbers along the top

Under the "Due today" heading is a line of statistics. They're worth reading
carefully, because each one answers a *different* question:

- **"4 left today"** — how many items are still waiting. Reviewing or
  skipping something removes it from this list, so this number goes *down* as
  you work. It is not the size of today's original workload; the History page
  shows that.
- **"79% reviewed rather than skipped this year"** — out of every button you
  pressed this year, this share were **Review** rather than **Skip**. Hover
  it for the same explanation. **It is not a completion rate.** It has no way
  of knowing about items you never opened, because nothing is recorded for
  those. Review one item all year and skip nothing, and this reads 100%.
- **"14 days streak"** — how many days in a row you've handled *something*.
  A skip keeps your streak alive; the streak asks "did you turn up?", not
  "did you finish?". If you haven't done anything yet today, your streak
  isn't broken — it just counts back from yesterday until the day is over.
- **"6 handled this week, down from 11 by this point last week"** — this week
  compared against the *same stretch* of last week. If today is Thursday, it
  compares Monday–Thursday against last Monday–Thursday, so the comparison
  is fair rather than a part-week losing to a whole one.

Note that a skip counts *towards* your streak and *against* your
reviewed-rather-than-skipped share. That's deliberate: they're two honest
answers to two different questions.

### Daily goal

Next to the stats is a small **Daily goal** box. Type a number and a progress
bar appears showing how many items you've handled today against that target.
Leave it blank (or set it to 0) to turn it off.

It's a personal nudge, nothing more — it's stored in your own browser, not in
your account, so it won't follow you to another device, and nothing happens
if you miss it.

## The "History" tab

A calendar of everything you've done, drawn as moon phases.

**Today's moon** sits at the top with a count like "1 of 5 handled". This is
today's *whole* workload — everything due, including anything overdue — so it
won't match the "left today" number on the other tab, which is only what
remains. The moon fills up as you work: an empty circle at the start of the
day, a full gold one when you've handled everything.

This is the only true percentage in the app. It works for today because today
is the only day where the app can still see what was due.

**The grid below** shows one row per month, one circle per day:

- **Full moon** — you reviewed that day and skipped nothing.
- **Half moon** — a skip was involved that day, on its own or alongside
  reviews.
- **Empty outline** — no activity recorded.

Hover any day to see its date and exact review and skip counts.

One honest limitation, worth understanding: a full moon means *everything you
logged that day was a review*. It does **not** mean you got through everything
that was due. If four items were due and you reviewed one and ignored the rest,
that day still shows a full moon, because ignoring an item records nothing at
all. The app can't reconstruct what was due on a past day.

Use the **arrows** beside the year to look at previous years. The "today"
card at the top doesn't change when you do — it's always about today.

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

## Light and dark

The **☀ / ☾** button in the top bar switches between light and dark. Until you
press it, the app follows whatever your operating system is set to.

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

**Why does "left today" not match "of 5 handled" on the History page?**
They're counting different things. "Left today" is what's still waiting;
History's number is the day's whole workload, including what you've already
done. Handle everything and the first goes to 0 while the second stays put.

**My streak is 14 days but my reviewed-rather-than-skipped share is only 79%
— which one is right?**
Both. The streak counts a skip as showing up; the percentage counts it as not
reviewing. Turning up every day and skipping often produces exactly this.

**Does skipping hurt me?**
Only in the sense that a skip is recorded as a skip: it shows as a half moon
for that day and counts against your reviewed-rather-than-skipped share. It
does not lose your progress, break your streak, or change which review stage
an item is on.

**I don't see the Admin tab — why?**
Only accounts with the admin role see it. Regular accounts don't have access
to user management, by design.
