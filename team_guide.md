# Robot Use Tracker — Quick Guide

## Getting In
1. Open this link: **https://nate-ctr-lbm.github.io/robot-tracker/**
2. Enter the team passcode when asked
3. The first time on a device, you'll be asked **who's operating** — after that, it remembers you automatically. Wrong person showing? Fix it anytime from the **Operator on Duty** card, no need to log out.

---

## The Order You Do Things In

The app walks you through this in order — each step unlocks the next one.

### 1. Pick your name
You do this right after the passcode, in the **"Who's Operating?"** screen. You can change it anytime afterward from the **Operator on Duty** card.

### 2. Start — or join — a Booking
Under **Bookings**, check **"Active Bookings Right Now"** first:
- If someone's already running the thing you're about to do, tap **Join** on it instead of starting a duplicate
- Otherwise, pick a **Type** (Sim Data Collect, UC Data Collect, Targeted Data Collect, T1 Restocking/Sorting, Policy Training, Lunch, or Household Bridge Data Collection), fill in whatever number it asks for, and tap **Start Booking**

*Multiple bookings can run at the same time now* — one team on UC #2, another on UC #5, no conflict. You can't log anything until you're attached to a booking, one way or the other.

### 3. Log your actual work
Once you're attached to a booking, three things become available:

- **Run Time** *(optional)* — describe what you're doing, optionally set a target time, tap Start, tap Stop when done. The elapsed time now shows big and bold so it's easy to glance at from across the room.
- **Downtime** — pick a reason from the list first (**this is required**), tap Start, tap End when it's resolved
- **Lunch** — tap Start, tap End when you're back. Your booking stays open the whole time — see below for details.

### 4. End your Booking
Tap **"End This Booking."** If a Run Time, Downtime, or Lunch is still going, it'll tell you to stop that first — that's intentional, so nothing gets left half-logged.

---

## Two Ways to Handle Lunch

**Option 1 — Lunch button, booking stays open (most common).** If you're in the middle of an active booking like UC #2 and just need to step away for lunch, use the **Lunch button** right in the booking's controls. Tap Start, tap End when you're back — UC #2 never closes, it just has a lunch gap logged inside it. Starting Lunch automatically stops Run Time or Downtime if either was running, same as they already do for each other.

**Option 2 — Lunch as its own booking (for a clean break with nothing else running).** End your current booking, then start a new one and pick **Lunch** as the type. When you're back, end the Lunch booking and start your next real one.

Either way, lunch time is correctly kept separate from Total Active Time — see the note below.

---

## Household Bridge Data Collection

This one tracks progress toward a goal across multiple days, not just one sitting.

- Pick a **Task #** when you start it
- **First time that task number is ever used**, you'll be asked to set a target in hours — that's the goal
- **Every time after that**, starting the same Task # skips the prompt and just picks up where it left off, even if a different person starts it on a different day
- Progress shows live — both in your own booking status and in the shared Active Bookings list — like *"Task #3 — 0.4 of 1h collected"*

---

## T1 Restocking/Sorting

This is a CoRL task — a priority right now. Pick **T1 Restocking/Sorting** as the type when you start a booking for it; no number needed.

For the actual step-by-step (bin setup, button timing, the golden sample video), see the [T1 Operator Guide on Confluence](https://lbm-c.atlassian.net/wiki/spaces/RO/pages/1039728703/T1+Restocking+Sorting+Operator+Guide+Golden+Sample). This tracker guide only covers how to log the time — that page covers how to actually do the task.

---

## Keeping Your Hours Accurate for Debriefs

**Total Active Time** (shown on the dashboard) is what should get reported as on-robot hours. It only counts time the **Run Time** timer was actually running.

That means:
- **Stop Run Time before you step away** — lunch, downtime, end of day, whatever it is. This is the one that matters most.
- Log real interruptions as **Downtime**, don't just let Run Time keep going through them
- **Use the Lunch button** (or a Lunch booking) instead of leaving Run Time going through your break
- **End your booking** when you're actually done for the day

Do this consistently and whoever's writing the debrief can just read Total Active Time straight off the dashboard.

---

## After 6:30 PM

The tracker locks to view-only after 6:30 PM local time — any booking still open gets automatically closed, and you can't start a new one. If you genuinely need to keep logging past that (a supervisor-approved exception), there's an **override code field** right in the after-hours banner.

---

## Two Ways to View the Dashboard

There's a **KPI View / Grid View** toggle near the top.
- **KPI View** — the big numbers (Active Time, Downtime, etc.) front and center
- **Grid View** — everything as equal-sized tiles, better for scanning a lot at once

Your choice is remembered on your browser.

---

## Two Pages, One Team

- **Data Collection** page → Sim / UC / Targeted Data Collect, T1 Restocking/Sorting, Household Bridge
- **Policy Training** page → Policy Training runs
- **Lunch** is available on both

Two tabs at the top of the page switch between them. Everyone's data ends up in the same shared log either way.

---

## The Session Log

- Entries are grouped into **tabs by booking** — click one to see just that booking's rows, click **All** to see everything again
- Every row has an **Edit** and **Delete** button
- **Want a past day?** Use the arrows next to the date at the top — that day's log opens read-only
- **Need a report?** Scroll down and hit **"Generate Summary"** for whatever day you're viewing, or check specific sessions in **"Export Specific Sessions"** and hit **"Generate Summary for Selected"** instead

---

## A Few Things Worth Knowing

- **Everything syncs live.** No need to refresh — other people's entries show up automatically.
- **Downtime always needs a reason.** It'll stop you and ask if you skip this.
- **Made a mistake?** Every row has Edit and Delete.

---

Questions or something looks broken? Message Nate.
