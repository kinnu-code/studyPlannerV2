# Scheduling Logic Reference

**Source of truth:** `js/planner.js`  
**Last updated:** 2026-05-07

---

## Overview

The scheduler converts a topic list + availability calendar into a day-by-day study plan. It runs in two phases: a clean pass to find accurate mock eligibility, then an iterative pass that places mocks and fills in the full schedule.

---

## Key Concepts

### Topics and Sessions

Each topic has:
- **LN** (learning sessions) — from `lnTable[difficulty]`. Default: easy=1, medium=2, hard=3.
- **PN** (practice MCQ sessions) — from `pnTable[difficulty]`. Default: easy=3, medium=4, hard=5.
- **Reviews** — spaced repetition sessions after all PN are done. Count = `srIntervals.length`.

### Starting States

| State | LN remaining | PN remaining | MCQ done | Notes |
|---|---|---|---|---|
| Not Started | full LN | full PN | 0 | Default |
| Learned | 0 | full PN | 0 | Skips learning |
| Practicing | 0 | PN − 1 | 1 | One MCQ already counted |
| Reviewing | 0 | 0 | PN | Enters SR immediately |

### Calendar

Built from `startDate` to `examDate` (exclusive). Each day has a `totalSessions` budget interpolated linearly (or via cram-mode cubic ramp) between `firstWeek` and `lastWeek` values for each day-of-week.

---

## Phase 1 — Clean Run (Mock Eligibility)

`runPass2` is called once with no days blocked. This gives accurate dates for:
- `firstMockEligibleDate` — day when every topic has ≥ 1 MCQ done
- `lastMockEligibleDate` — day when every topic has all PN done

These dates are used to place mocks. Using a full clean pass (rather than a simplified simulation) ensures blocked mock days don't distort the eligibility estimate.

---

## Phase 2 — Mock Placement + Full Schedule (up to 3 iterations)

### Mock Placement (`placeMocks`)

- **Mock 1** lands on the first study day strictly after `firstMockEligibleDate`
- **Last mock** lands on the first study day strictly after `lastMockEligibleDate`
- **Middle mocks** are evenly interpolated between first and last
- Collisions are resolved by bumping to the next available study day
- Each mock day is blocked (`blockedBy = 'mock'`)
- Post-mock day is either the same day (`postMockSameDay = true`) or the next study day (blocked as `'postMock'`)

### Convergence

After placing mocks, the full schedule runs again. If the blocked days push learning/practice later such that mocks are now too early, eligibility is recomputed and mocks repositioned. Repeats up to 3 times (converges in ≤ 2 for normal inputs).

---

## Daily Scheduling — Priority Order

For each unblocked study day with `totalSessions > 0`, slots are filled in this order:

### Step 0 — Due Reviews (highest priority)

All topics whose `nextReviewTargetDate ≤ today` are scheduled before anything else.

**Sort within this tier:**
1. First-ever reviews (`nextReviewIndex === 0`) before subsequent reviews
2. Within each tier: most-overdue first

Reviews always take slots first so the SR schedule is never disrupted.

### Step 1 — Learning

Topics are learned sequentially (all sessions for topic A before topic B begins). Within a day:
- At most `maxNewTopicsPerDay` distinct topics may start learning (default: 4)
- Slots are filled after reviews

**Learning always comes before practice.** Practice can only start once all of a topic's learning sessions are complete, and it never displaces learning from an earlier-scheduled topic.

When a topic's last learning session is placed, its `practiceDeadline` is set to `learnEndDate + maxDaysBetweenPractice`.

### Step 2 — Practice MCQs

Remaining slots go to eligible topics: `remainingLN === 0 && remainingPN > 0`, one session per topic per day.

**Within this step, urgent topics are scheduled first.**  
A topic is urgent when its `practiceDeadline ≤ today`. Urgency does not preempt learning — it only determines ordering within the practice step.

- **Deadline origin:** `learnEndDate + maxDaysBetweenPractice` when learning finishes
- **Deadline reset:** `lastPracticeDate + maxDaysBetweenPractice` after each practice session
- **Pre-learned topics** (Learned / Practicing starting state): deadline set to `startDate + maxDaysBetweenPractice`
- Default `maxDaysBetweenPractice` = 7 days (configurable in Advanced Settings)

---

## Spaced Repetition Clock

**Trigger:** when a topic's last PN session is scheduled, `nextReviewIndex` is set to 0 and `nextReviewTargetDate` is set to `pnCompleteDate + 1 day` (hardcoded — first review is always the next study day).

**Intervals:** `srIntervals` = `[6, 16, 45, 131]` (days). These govern the gaps **between consecutive review sessions** (not from PN to first review):

| Gap | From → To | Days |
|---|---|---|
| hardcoded 1 | PN complete → Review 1 | 1 |
| `srIntervals[0]` | Review 1 → Review 2 | 6 |
| `srIntervals[1]` | Review 2 → Review 3 | 16 |
| `srIntervals[2]` | Review 3 → Review 4 | 45 |
| `srIntervals[3]` | Review 4 → Review 5 | 131 |

With 4 intervals there are 5 review sessions per topic. When the last review is done, `nextReviewTargetDate` becomes `null`.

**For topics starting in Reviewing state:** first review is due at `startDate + 1 day` (we don't know their actual last review date, so we schedule it immediately).

---

## Visual States (chart.js)

| State | Condition |
|---|---|
| Not Started | Learning not yet begun |
| Learning | `learn` session on this day |
| Ready to Practice | Learning done, some or no practice done, no practice session today |
| Practicing | `practice` session on this day |
| Practice Completed | All PN done, no practice or review session today |
| Reviewing | `review` session on this day |
| Mock | This day is blocked as a mock exam |
| PostMock | This day is blocked as post-mock revision |

**Key distinction:** "Ready to Practice" is the carry-forward state between practice sessions. "Practicing" only appears on days with an actual practice session — not as a passive state.

---

## Settings Reference

| Setting | Default | Effect |
|---|---|---|
| `lnTable` | easy=1, medium=2, hard=3 | Learning sessions per topic |
| `pnTable` | easy=3, medium=4, hard=5 | Practice sessions per topic |
| `maxNewTopicsPerDay` | 4 | Max new topics starting learning on one day |
| `maxDaysBetweenPractice` | 7 | Max gap (days) between learn→practice and practice→practice |
| `srIntervals` | [6, 16, 45, 131] | Spaced repetition gaps in days |
| `postMockSameDay` | true | Whether post-mock review shares the mock day |
| `sessionDuration` | 20 min | Display only — does not affect scheduling |

---

## Data Flow

```
generatePlan(config)
  ├── buildCalendar()           → days[] with totalSessions budgets
  ├── initTopics()              → topicStates[] (immutable source)
  ├── runPass2() [clean]        → no mocks, fills calendar, returns states
  ├── computeEligibility()      → firstMockEligibleDate, lastMockEligibleDate
  └── for iter in [0..2]:
        reset calendar
        placeMocks()            → blocks mock/postMock days
        runPass2() [with mocks] → fills schedule around blocked days
        computeEligibility()    → check if mocks are still valid
        if valid: break

runPass2(calendar, topicStates, srIntervals, settings, startDate)
  init: clone states, set practiceDeadline for pre-learned topics, prime SR for Reviewing topics
  for each unblocked study day:
    step 0:  schedule due reviews (sorted: first-reviews first, then most-overdue)
    step 1:  schedule learning (sequential, capped by maxNewTopicsPerDay)
             → set practiceDeadline when topic finishes learning
    step 2:  schedule practice (urgent first, then normal; one per topic per day)
    post:    prime SR clock for topics that finished all PN today (first review = next day)
```
