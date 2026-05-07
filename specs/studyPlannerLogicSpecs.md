# Smart Study Planner — Working Logic Specification v2

---

## 1. Overview

A standalone study planning tool. The user provides a topic list (or an exam name and the tool generates one), an exam date, and their weekly study availability. The tool generates an optimized, day-by-day study plan that sequences reading, reviewing, MCQ practice, mock exams and post-mock review sessions to achieve mastery across all topics by the exam date.

The plan is forward-looking: it predicts when each topic will be in each state based on a standard learning progression, without tracking actual performance. It produces both a visual trajectory and a granular daily schedule.

---

## 2. Inputs

| Input                       | Type                                         | Notes                                                                                                              |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Topic list                  | Three modes (see below)                      | Granular level; each assumed to have flashcards + MCQs                                                             |
| Study start date            | Date                                         | Defaults to today; planning begins from this date                                                                  |
| Exam date                   | Date                                         | Target date                                                                                                        |
| Study schedule              | Per-weekday: N sessions e.g., Mon: 1, Tue: 2 | User inputs sessions per day for first week and last week; extrapolated for weeks in between (see below)           |
| Schedule ramp mode          | Linear \| Cram at the end                    | Linear: even increase week by week. Cram: slow increase at first, significant increase in the last few weeks       |
| Spaced repetition intervals | Configurable                                 | Default: [6, 16, 45, 131] days — gaps **between consecutive review sessions** (review 0→1, 1→2, …). The first review is always scheduled the day after all PN sessions are complete (hardcoded 1-day gap not counted in this list). Only changeable in advanced settings. |


### Topic input modes

The user can provide topics at three levels of detail:

1. **Exam name only** (e.g., "SQE FLK1", "CFA Level 1") — the AI generates the full granular topic list from its knowledge of the exam syllabus
2. **High-level topics** (e.g., "Contract Law, Tort, Land Law") — the AI breaks each down into granular sub-topics
3. **Granular topic list** — user provides the full list directly (typed or uploaded as a plain-text file, one topic per line); AI only estimates topic sizing

#### Free text AI input field
Show the user a free text area for them to enter any information they want to share with AI to help the planning. E.g., I am really bad at topic X, or Restrict topic numbers to 30 topics, or I have already learned the material, focus on practice and reviews (which implies selecting the right starting state for all topics)
The AI prompt should ask the AI to extract any information that is relevant to the inputs and the planning (check the full specs to make explicit what this information may be, so it is returned in a structured json for the planner to make use of)

Generate a separate prompts.js file that I can review and edit at anytime

#### Topics review table
In all modes the user reviews and confirms the topic list, sizing and initial status (see section 5) before the plan is built.
This will be shown as a table with the following columns
Topic number | Topic tile | Topic difficulty (section 3) | Starting state (section 4) | Move up/down arrows | delete icon

And at the end there is an add topic button to add a new row
Also ideally it should be able to change topics order by mouse 

---

## 3. Topic Difficulty

On input, the LLM evaluates each topic name and assigns:

- **Easy (Short)**: single concept, few flashcards, few MCQs
- **Medium(Medium)**: moderate depth, typical topic
- **Hard (Long)**: broad topic, many sub-concepts, many cards/MCQs

The topic difficulty determines how many practice MCQs sessions needed (PN), and number of learning sessions needed (LN)

| Activity           | Easy | Medimum | Hard |
| ------------------ | ---- | ------- | ---- |
| Learning (LN)      | 1    | 2       | 3    |
| Practice MCQs (PM) | 3    | 4       | 5    |


---

## 4. Activity types

All activities are measured in **sessions** (not time). Session duration is a display-only setting (default 20 minutes, configurable in advanced settings) and does not affect scheduling calculations. Exceptions:

- **Mock exam**: always counted as 90 minutes regardless of session duration setting
- **Post-mock revision**: occupies a full dedicated day; may share that day with the mock exam but with no other activity types

| Activity           | Description                                                                        |
| ------------------ | ---------------------------------------------------------------------------------- |
| Learn              | Read text and/or do first pass of flashcards                                       |
| Practice MCQs      | Timed MCQ practice for a topic                                                     |
| Review             | Mix of flashcards and revision MCQs, scheduled via spaced repetition               |
| Mock exam          | Full simulated exam (90 min); see Section 8 for scheduling rules                   |
| Post-mock revision | Full-day deep review of mock results; shares day with mock or takes next study day |

## 5. Topic State Machine

States are **predicted** based on scheduled activities, not actual performance.

### Scheduler states (internal pipeline)
- **Not Started** — topic not yet touched
- **Learning** — LN sessions in progress (reading + first flashcard pass)
- **Ready to Practice** — all LN sessions done, waiting for first Practice MCQ session to be scheduled
- **Practicing MCQs** — PN sessions in progress (one per topic per day)
- **Practice Completed** — all PN sessions done; passive baseline state between review sessions
- **Reviewing** — a spaced-repetition review session is scheduled on this specific day
- **Mock Exam** (global event, see Section 8)
- **Post-Mock Revision** (follows every mock exam)

### Visual trajectory states
The trajectory chart uses all eight states above. Key distinctions:
- **Ready to Practice** appears between the last learning session and the first practice session; it shows that the topic is ready but hasn't yet been scheduled for practice.
- **Practice Completed** is the passive carry-forward colour shown on days *between* review sessions (once all PN are done). It makes it easy to see that practice is complete, even on non-review days.
- **Reviewing** overrides **Practice Completed** on the specific days when a review session is actually scheduled.
- The saturation of **Practicing** increases as more MCQ sessions are completed (lighter = early, richer = all done). Similarly, **Reviewing** becomes more saturated as more reviews are completed.

### Valid user-selectable starting states (topics review table)

| Starting state  | Meaning                                      | Scheduler behaviour                                                                                            |
| --------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Not Started** | Topic has not been touched                   | Full pipeline: LN learn → PN practice MCQs → reviews                                                           |
| **Learned**     | Topic content already studied; skip learning | Skip LN learn sessions; start at Practice MCQs (full PN remaining); shows as "Ready to Practice" initially      |
| **Practicing**  | One practice MCQ session already done        | Skip learning; 1 MCQ session counted as done (PN − 1 remaining)                                                |
| **Reviewing**   | All practice MCQ sessions done               | Skip learning and all practice MCQs; begin immediately at first Review session (first review = day after start) |

A tooltip / legend on the topics table explains each state to the user.

### State transitions
- Not Started → Learning (first learn session scheduled)
- Learning → Ready to Practice (all LN done, no practice session yet)
- Ready to Practice → Practicing MCQs (first practice session scheduled)
- Practicing MCQs → Practicing MCQs (repeat until PN complete; at most 1 session per topic per day)
- Practicing MCQs → Practice Completed (once all PN done)
- Practice Completed → Reviewing (on days when a review session is scheduled)
- Reviewing → Practice Completed (carry-forward baseline between review sessions)
- Mock Exam → Post-Mock Revision (mandatory; same day or next study day)
- Post-Mock Revision → Practicing MCQs if PN not yet complete, else → Practice Completed


---

## 6. Session Model

A session is a small unbreakable unit with one activity type

### Scheduler topic data model

Each topic carries the following runtime fields during scheduling:

| Field | Description |
|-------|-------------|
| `remainingLN` | Learning sessions still to be scheduled |
| `remainingPN` | Practice MCQ sessions still to be scheduled |
| `mcqSessionsDone` | Count of practice MCQ sessions completed so far |
| `reviewSessionsCompleted` | Count of spaced-repetition review sessions completed (useful for progress tracking and replanning) |
| `pnCompleteDate` | Date when `remainingPN` reaches 0 (set during scheduling) |
| `reviewDates[]` | List of scheduled review dates derived from spaced repetition intervals |

### Session composition priority

#### Learning rule
All LN learning sessions for a topic are scheduled **consecutively** (back-to-back across available slots) before the scheduler moves on to the next topic's learning. Topics are learned one at a time in topic-list order.

If a topic finishes its learning sessions mid-day with sessions remaining, a new topic's learning may begin on the same day. At most `maxNewTopicsPerDay` (default 4, configurable) distinct topics may start their first learning session on the same calendar day.

#### Day level priorities
For a specific day, fill available session slots in the following order:
1. **Learn** — continue the current topic's remaining LN sessions; if complete and slots remain, start the next topic (up to `maxNewTopicsPerDay` new topic starts per day, best-effort)
2. **Practice MCQs** — topics with `remainingLN = 0` and `remainingPN > 0`; at most 1 practice session per topic per day
3. **Review** — topics with due review sessions (target date ≤ today and all PN done)

Session count is the binding constraint (not time).

#### Overall priorities
1. Finish Learning of all unlearned topics
2. Start Practice MCQs sessions for all topics once they are read
3. Do first Mock session once all topics have started with 1 practice MCQs session
4. A Mock is always followed by a post-mock revision session
5. Reviewes for a topic start in the eariest possible opportunity once all its practice MCQs sessions are done, then follow the spaced repetition schedule

---

## 7. Per-Topic Timeline (the pipeline)

Each topic has an independent timeline from its Day 0 (when first read begins):

- LN learning sessions if it has not been learned before
- First practice MCQs session
- Possibley a Mock exam if all other topics are done
- Finish PN practice MCQs sessions
- Review sessions in earliest empty slot after finishing PN sessions, then follow a spaced repetition schedule

Topics enter the pipeline at different times. The scheduler assigns a Day 0 for each topic and fits all downstream activities into available session slots.

**Day 0 assignment strategy**: spread first reads as early as possible, constrained by session availability. Goal: get all topics to *Practice MCQs* as early as feasible, while spacing them to reduce review collisions downstream.

---

## 8. Mock Exams and Weakness Review

Default number of mock exams is 3, but the user can configure this number.
Priority is to get all mock exams done before the exam date. If this condition cannot be met, show a warning to the user and ask for updating the schedule to achieve this within the time period.

### Eligibility conditions (must be met before a mock can be scheduled)

| Mock                         | Condition                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| **1st (first) mock**         | All topics have had at least 1 Practice MCQ session                                    |
| **Middle mocks** (2nd … N−1) | No additional eligibility gate — placed by the scheduling strategy below               |
| **Last mock**                | All topics have finished all their Practice MCQ sessions (PN complete for every topic) |

### Scheduling strategy

- **First mock**: scheduled as early as possible — on the first available study day on or after the date its eligibility condition is met.
- **Last mock**: scheduled as early as possible after its eligibility condition is met (all PN complete), but no later than a point that leaves sufficient revision time before the exam.
- **Middle mocks**: spread evenly in the window between the first mock date and the last mock date.

Each mock exam must be followed by a post-mock revision session which takes one full day. The post-mock revision session is placed either on the same day as the mock (if sessions allow) or on the first scheduled study day after the mock.

---

## 9. Overflow Negotiation

If the algorithm cannot fit all required activities before the exam date, it reports a shortfall and enters a structured negotiation.

**Shortfall report format:**
> "With your current schedule, X of Y topics will not complete all Practice MCQ sessions before the exam, and Z topics will miss their scheduled review sessions. You need approximately N more sessions per week to complete the full plan."

**Options presented to user (in order of impact):**

1. Update study schedule to increase study time
2. Update topics table including difficulty and starting state
8. Lower the number of mock exams

Each option shows the projected impact before the user confirms. Negotiation is iterative — options can be combined until the plan is feasible.

---

## 10. Output

### 10a. Visual trajectory

A timeline view with:
- **Horizontal axis**: dates from today to exam day
- **Vertical axis**: topics (ordered by scheduled start date)
- **Color bands per topic**: state at each point in time — Not Started | Learning | Ready to Practice | Practicing MCQs | Practice Completed | Reviewing | Mock Exam | Post-Mock Revision
- **Mock exam markers**: vertical lines on the timeline

This gives the user a "regions changing in space" view of their full learning journey at a glance. Mouse over will tell what each colour mean in addition to providing a legend above and below the graph

### 10b. Day-by-day plan

For each day:
- List of sessions: 
- For each session: Activity details including: topic name, activity type (combine multiple sessions with exact same details into one and indicate number of sessions)
- One-line reason per block (e.g., "Second round of Practice MCQs for Tort")

The plan is **regeneratable**: if the user changes spaced repetition intervals, session schedule, target state, or mastery threshold, the plan rebuilds from scratch.

Plan can be downloaded as a CSV file, add a tickbox column that allow users to tick if the session has been completed or not

### 10C. Topic by topic table
- List of all topics
- Detailed timed description of what is done when on that topic
Can be downloaded as CSV with two additional tick box columns for each activity type so users can tick and monitor their progress
---

## 11. Saving and updating (Re-planing)
In addition to downloading as CSVs as above, the user can download the plan as app data (JSON) with all user data, settings, and session completion status associated with generating the plan. This allows the user to go to the replanning (update plan) screen.

The JSON includes the state of each topic from the topic table. This is the source of truth for replanning — the updater uses it to determine how far each topic has actually progressed.

The replanning screen is identical to the overflow negotiation screen, but the algorithm additionally accounts for:
- The current date (activities before today are treated as past)
- The user-updated state for each topic

The plan assumes all scheduled sessions were followed as planned between the original start date and the current date. The updater pre-fills each topic's current state accordingly. The user only needs to correct rows where they deviated from the plan.

If there is overflow after recalculation, Section 9 negotiation is entered.
---

## 12. Settings screen

### API configuration (locked to OpenAI)
- OpenAI API key input (stored locally, never in the repository)
- Model selector: dropdown of the most recent OpenAI models

### Advanced settings (expandable panel)

#### Session duration
Default: **20 minutes**. Display-only — does not affect scheduling calculations. Used to show estimated time alongside session counts in outputs.
Exception: mock exam = always 90 minutes; post-mock = full day.

#### Max new learning topics per day
Default: **4**. Used for the schedular to determine how many new learning topics can be scheduled in any one day.

#### Activity sessions table (editable)
Defaults from Section 3. Users can override per-difficulty session counts here.

| Activity                   | Easy | Medium | Hard |
| -------------------------- | ---- | ------ | ---- |
| Learning sessions (LN)     | 1    | 2      | 3    |
| Practice MCQ sessions (PM) | 3    | 4      | 5    |

#### Spaced repetition schedule (editable)
Comma-separated list of day gaps between consecutive review sessions.
Default: `6, 16, 45, 131`


