# Smart Study Planner — UI Specification
> Derived exclusively from `studyPlannerLogicSpecs.md`. Read that document first.

---

## Screens

1. Home
2. New Plan — Step 1: Topic Input
3. New Plan — Step 2: Topics Review Table
4. New Plan — Step 3: Schedule & Settings
5. New Plan — Step 4: Generated Plan View
6. Overflow Negotiation
7. Update Existing Plan
8. Settings

---

## 1. Home

Two top-level actions:
- **Start a new plan**
- **Update existing plan** (loads a previously saved JSON plan file)

---

## 2. New Plan — Step 1: Topic Input

### Topic input mode (choose one)
The user selects one of three modes:

| Mode                    | Description                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Exam name only**      | User enters the exam name (e.g., "SQE FLK1", "CFA Level 1"). AI generates the full granular topic list from its knowledge of the syllabus. |
| **High-level topics**   | User enters an exam name plus a list of broad topics. AI breaks each into granular sub-topics.                                             |
| **Granular topic list** | User types the list directly or uploads a plain-text file (one topic per line). AI only estimates topic sizing (Easy / Medium / Hard). |

### Free AI input field
A free-text area beneath the topic input. The user can enter anything they want the AI to take into account — for example:
- "I am really bad at Topic X"
- "Restrict to 30 topics maximum"
- "I have already learned the material — focus on practice and reviews"

The AI extracts structured planning-relevant information from this field (see `prompts.js`).

### Action
A **Generate Topics** button sends the input to the AI and moves to Step 2.

---

## 3. New Plan — Step 2: Topics Review Table

The AI-generated topic list is shown as an editable table. The user reviews and confirms before the plan is built.

### Table columns

| Column         | Description                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| #              | Topic number                                                                                                   |
| Topic title    | Editable topic name                                                                                            |
| Difficulty     | Easy / Medium / Hard (AI-assigned, user-editable)                                                              |
| Starting state | One of four options (see legend below); user-editable, AI may pre-fill based on free-text field |
| ↑ ↓            | Move topic up or down in order                                                                                 |
| 🗑              | Delete topic                                                                                                   |

### Starting state legend
Shown as a persistent legend beneath the table and as a tooltip on each state cell:

| State | What it means | Effect on scheduling |
|-------|--------------|----------------------|
| **Not Started** | Topic hasn't been touched | Full pipeline: Learn → Practice MCQs → Reviews |
| **Learned** | Content already studied; ready for practice | Skip learning sessions; begin at Practice MCQs (full PN remaining) |
| **Practicing** | One practice MCQ session already done | Skip learning; 1 MCQ session counted as done (PN − 1 remaining) |
| **Reviewing** | All practice MCQ sessions done | Skip learning and all practice MCQs; begin at first Review session (Day 0 of spaced repetition) |

### Additional controls
- **Add topic** button at the bottom of the table adds a blank row.
- Topics can also be **reordered by mouse drag**.

### Action
A **Confirm Topics** button moves to Step 3.

---

## 4. New Plan — Step 3: Schedule & Settings

### Study start date
A date picker. Defaults to today. Planning begins from this date.

### Exam date
A date picker for the target exam date.

### Weekly study schedule
The user defines how many sessions per day of the week.

- Input is provided for the **first week** and the **last week** separately.
- Layout: a table with rows = days of the week (Mon–Sun), columns = First Week | Last Week, cell value = number of sessions that day.

### Schedule ramp mode
Two radio options shown beneath the schedule table:

| Option | Description |
|--------|-------------|
| **Increase linearly** | Session count scales evenly week by week between first and last week values |
| **Cram at the end** | Slow increase at the beginning, then a significant step-up in the last few weeks |

### Spaced repetition intervals
Shown only in the advanced settings pane in settings as a configurable comma-separated list of day gaps. Not shown in this normal first generation flow
Default: `6, 16, 45, 131`
These are the gaps between consecutive review sessions. Day 0 is the date of the first Review session (scheduled as early as possible after all Practice MCQ sessions for that topic are complete).

### Number of mock exams 
Configurable integer. Default: **3**. Show that a minimum of 3 are recommended
The first mock is placed as early as possible (once eligibility conditions are met). Remaining mocks are spread evenly between that date and the exam date, preserving revision time between each mock and before the exam.

### Action
A **Generate Plan** button runs the scheduling algorithm and moves to Step 4 (or Overflow Negotiation if the plan cannot fit within the exam date).

---

## 5. New Plan — Step 4: Generated Plan View

Three output tabs/sections:

### 5a. Visual Trajectory

A timeline chart:
- **Horizontal axis**: dates from study start to exam day
- **Vertical axis**: topics, ordered by scheduled start date
- **Color bands per topic row**: one color per state at each point in time. Use distinct, color-blind friendly colors. For the practice revision, the color starts light with the first session and gets to it full saturation when all practiceMCQs sessions are done for that topic (i.e., its saturation depends on its n/PN percentage so users see progression), same with reviews, the more reviews done, the more saturated the color
  - States: Not Started, Learning, Practicing MCQs, Reviewing, Mock Exam, Post-Mock Revision
- **Mock exam markers**: vertical lines at mock exam dates
- **Legend**: displayed above and below the chart
- **Mouseover**: tooltip showing the state name for the hovered band

### 5b. Day-by-Day Plan

For each study day:
- List of sessions scheduled that day
- For each session block:
  - Topic name
  - Activity type
  - Where multiple consecutive blocks have identical topic + activity, they are combined into one entry showing the count (e.g., "Practice MCQs × 2")
  - A one-line reason (e.g., "Second round of Practice MCQs for Tort")

The plan is **regeneratable**: changing spaced repetition intervals, session schedule, or number of mocks rebuilds the plan from scratch.

**Download**: CSV with an added tick-box column (Completed ✓) for each session row.

### 5c. Topic-by-Topic Table

- One row per topic
- Columns: topic name, and a chronological description of every scheduled activity for that topic with its date and time estimate

**Download**: CSV with two additional tick-box columns per activity type so the user can track completion per activity.

### Plan save options
- **Download as CSV** (day-by-day plan and topic table separately)
- **Download as JSON** (full app data: all user inputs, topic list, schedule, settings — used for the Update Existing Plan flow)

### Post-generation prompt
After the plan is displayed the user is asked: *"Happy with this plan, or do you want to update it?"* Choosing Update enters the Overflow Negotiation flow (Section 6).

---

## 6. Overflow Negotiation

Triggered automatically if the algorithm cannot fit all required activities before the exam date, or manually if the user chooses to update the plan.
This should be in an expandable panel. It is open automatically if negotiation needed, and collapsed if not needed, but this means that users can always expand it, make changes and press 'regenaerate'

### Shortfall report
Displayed as a plain-language summary, e.g.:
> "With your current schedule, 8 of 14 topics will not complete all Practice MCQ sessions before the exam, and 5 topics will miss their scheduled review sessions. You need approximately 3 more sessions per week to complete the full plan."

### Options presented (in order of impact)
1. **Update study schedule** — Show the study schedule input and increase sessions per day/week
2. **Update topics table** — return to the topics review table to change difficulty or starting state (there should be a clear return button from there to current screen)
3. **Lower the number of mock exams** — reduce the default of 3

Each option shows its **projected impact** (e.g., "Adding 1 session on Wednesdays closes the gap for 4 topics") before the user confirms. Options can be **combined iteratively** until the plan is feasible.

---

## 7. Update Existing Plan

If the user just generated the plan it is still in memory and is used directly.

Otherwise the user uploads:
- The saved **JSON plan file** (contains all user data and configuration settings)

The replanning screen is identical to Overflow Negotiation (Section 6) but the algorithm additionally accounts for:
- The **current date** (activities before today are treated as past)
- The **user-updated state** for each topic (the user can mark how far they have actually progressed)-assume the previous plan has been followed  (i.e., all went according to plan between the earlier start date and current date) and update the initial state accordingly so user does not have to update everything, just the rows in which they deviated from the plan 

If there is overflow after accounting for current date and updated states, Section 6 negotiation is entered.

---

## 8. Settings Screen

### API configuration
- **OpenAI API key** input (stored locally only, never in the repository)
- **Model selector**: dropdown of the most recent OpenAI models

### Advanced settings (expandable panel)

#### Session duration
Default: **20 minutes**. Used for display only (e.g., showing estimated time in outputs). Does not affect scheduling. Exceptions: mock exam = 90 minutes; post-mock revision = full day.

#### Max new learning topics per day
Default: **2**. Used for the schedular to determine how many new learning topics can be scheduled in any one day.

#### Activity sessions table (editable)

see section 3 in studyPlannerLogicSpecs.md

#### Spaced repetition schedule (editable)
Comma-separated list of day gaps between consecutive review sessions.
Default: `6, 16, 45, 131`
