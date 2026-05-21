/**
 * Study Planner — core scheduling engine.
 * Pure functions only; no DOM, no API, no storage.
 * Works in both browser (window.StudyPlanner) and Node.js (module.exports).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.StudyPlanner = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DOW_KEYS   = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  // ─── Date helpers ──────────────────────────────────────────────────────────

  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
  }

  function addDays(date, n) {
    return new Date(date.getTime() + n * MS_PER_DAY);
  }

  function dateKey(date) {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD UTC, avoids DST shifts
  }

  function cloneDate(date) {
    return new Date(date.getTime());
  }

  // ─── interpolateSessions ───────────────────────────────────────────────────

  function interpolateSessions(first, last, weekIdx, totalWeeks, rampMode) {
    if (totalWeeks <= 1) return first;
    const t      = weekIdx / (totalWeeks - 1);
    const factor = rampMode === 'cram' ? Math.pow(t, 3) : t;
    return Math.round(first + (last - first) * factor);
  }

  // ─── Session-length helpers ────────────────────────────────────────────────

  function countCalendarMinutes(startDate, examDate, firstWeekMins, lastWeekMins, rampMode, blockedDays = []) {
    const blockedSet = new Set(blockedDays);
    const totalDays  = daysBetween(startDate, examDate);
    const totalWeeks = Math.max(2, Math.ceil(totalDays / 7));
    let   totalMins  = 0;
    let   cur = cloneDate(startDate);
    while (cur.getTime() < examDate.getTime()) {
      if (!blockedSet.has(dateKey(cur))) {
        const weekIdx = Math.floor(daysBetween(startDate, cur) / 7);
        const dow     = DOW_KEYS[cur.getUTCDay()];
        totalMins += interpolateSessions(firstWeekMins[dow] || 0, lastWeekMins[dow] || 0, weekIdx, totalWeeks, rampMode);
      }
      cur = addDays(cur, 1);
    }
    return totalMins;
  }

  function computeTotalWorkUnits(topics, settings) {
    const { lnTable, pnTable } = settings;
    let units = 0;
    for (const t of topics) {
      units += (lnTable[t.difficulty] || 1) + (pnTable[t.difficulty] || 3);
    }
    return units;
  }

  // Returns session length in minutes, clamped to [minLen, maxLen], floored to integer minutes.
  function computeOptimalSessionLength(totalMinutes, totalUnits, overheadFactor, minLen, maxLen) {
    if (totalUnits === 0 || totalMinutes === 0) return maxLen;
    const raw = totalMinutes / (totalUnits * overheadFactor);
    return Math.min(maxLen, Math.max(minLen, Math.floor(raw)));
  }

  function countSessionTypes(calendar) {
    let learn = 0, practice = 0, review = 0;
    for (const day of calendar) {
      for (const s of (day.sessions || [])) {
        if      (s.activityType === 'learn')    learn++;
        else if (s.activityType === 'practice') practice++;
        else if (s.activityType === 'review')   review++;
      }
    }
    return { learn, practice, review, total: learn + practice + review };
  }

  // ─── buildCalendar ─────────────────────────────────────────────────────────

  // firstWeekMins / lastWeekMins: minutes per day-of-week.
  // sessionLength: computed session duration in minutes; sessions/day = floor(mins/T).
  function buildCalendar(startDate, examDate, firstWeekMins, lastWeekMins, rampMode, sessionLength, blockedDays = []) {
    const blockedSet = new Set(blockedDays);
    const days       = [];
    const totalDays  = daysBetween(startDate, examDate);
    const totalWeeks = Math.max(2, Math.ceil(totalDays / 7));
    const T          = Math.max(1, sessionLength); // guard against 0

    let cur = cloneDate(startDate);
    while (cur.getTime() < examDate.getTime()) {
      const weekIdx   = Math.floor(daysBetween(startDate, cur) / 7);
      const dow       = DOW_KEYS[cur.getUTCDay()];
      const dk        = dateKey(cur);
      const isBlocked = blockedSet.has(dk);
      const dailyMins = isBlocked ? 0 : interpolateSessions(firstWeekMins[dow] || 0, lastWeekMins[dow] || 0, weekIdx, totalWeeks, rampMode);
      const n         = Math.floor(dailyMins / T);

      days.push({
        date:          cloneDate(cur),
        totalSessions: n,
        dailyMinutes:  dailyMins,
        sessions:      [],
        blockedBy:     isBlocked ? 'user' : null,
      });
      cur = addDays(cur, 1);
    }
    return days;
  }

  // ─── initTopics ────────────────────────────────────────────────────────────

  function initTopics(topics, settings) {
    const { lnTable, pnTable } = settings;

    return topics.map(topic => {
      const LN = lnTable[topic.difficulty] || 1;
      const PN = pnTable[topic.difficulty] || 3;

      let remainingLN, remainingPN, mcqSessionsDone;

      switch (topic.startingState) {
        case 'Learned':
          remainingLN = 0;  remainingPN = PN;             mcqSessionsDone = 0;  break;
        case 'Practicing':
          remainingLN = 0;  remainingPN = Math.max(0, PN - 1); mcqSessionsDone = 1;  break;
        case 'Reviewing':
          remainingLN = 0;  remainingPN = 0;               mcqSessionsDone = PN; break;
        default: // 'Not Started'
          remainingLN = LN; remainingPN = PN;               mcqSessionsDone = 0;
      }

      return {
        id:                      topic.id,
        name:                    topic.name,
        difficulty:              topic.difficulty,
        startingState:           topic.startingState,
        remainingLN,
        remainingPN,
        totalLN:                 LN,
        totalPN:                 PN,
        mcqSessionsDone,
        reviewSessionsCompleted: 0,
        pnCompleteDate:          null,
        practiceDeadline:        null,
        reviewDates:             [],
        nextReviewIndex:         -1,
        nextReviewTargetDate:    null,
        learningStarted:         topic.startingState !== 'Not Started',
      };
    });
  }

  // ─── scheduleLearningForDay ───────────────────────────────────────────────
  // Mutates day.sessions and topic state in-place.
  // Returns the updated currentLearner reference.

  function scheduleLearningForDay(day, learningQueue, currentLearner, maxNewTopicsPerDay) {
    let slotsLeft             = day.totalSessions - day.sessions.length;
    let newTopicsStartedToday = 0;

    while (slotsLeft > 0) {
      // Need a new topic from the queue
      if (!currentLearner) {
        if (learningQueue.length === 0) break;
        // Only start a new (unstarted) topic if under the daily cap
        if (!learningQueue[0].learningStarted && newTopicsStartedToday >= maxNewTopicsPerDay) break;
        currentLearner = learningQueue.shift();
      }

      // Mark first session
      const isFirstSession = !currentLearner.learningStarted;
      if (isFirstSession) {
        currentLearner.learningStarted = true;
        newTopicsStartedToday++;
      }

      day.sessions.push({ topicId: currentLearner.id, activityType: 'learn', isFirstSession });
      currentLearner.remainingLN--;
      slotsLeft--;

      if (currentLearner.remainingLN === 0) {
        currentLearner = null; // finished; next loop iteration dequeues next topic
      }
    }

    return currentLearner;
  }

  // ─── schedulePractice ─────────────────────────────────────────────────────
  // Schedules one practice session and advances the freshness deadline.

  function schedulePractice(day, topic, maxDaysBetweenPractice) {
    day.sessions.push({ topicId: topic.id, activityType: 'practice' });
    topic.remainingPN--;
    topic.mcqSessionsDone++;
    topic.practiceDeadline = addDays(day.date, maxDaysBetweenPractice);
    if (topic.remainingPN === 0 && !topic.pnCompleteDate) {
      topic.pnCompleteDate = cloneDate(day.date);
    }
  }

  // ─── scheduleMCQsForDay ───────────────────────────────────────────────────

  function scheduleMCQsForDay(day, states, maxDaysBetweenPractice) {
    let slotsLeft = day.totalSessions - day.sessions.length;
    if (slotsLeft <= 0) return;

    const practicedToday = new Set(
      day.sessions.filter(s => s.activityType === 'practice').map(s => s.topicId)
    );

    const eligible = states.filter(t =>
      t.remainingLN === 0 && t.remainingPN > 0 && !practicedToday.has(t.id)
    );

    // Urgent topics (deadline reached or passed) get slots before non-urgent ones.
    const dayMs = day.date.getTime();
    const urgent = eligible.filter(t => t.practiceDeadline !== null && t.practiceDeadline.getTime() <= dayMs);
    const normal = eligible.filter(t => t.practiceDeadline === null  || t.practiceDeadline.getTime() >  dayMs);

    for (const topic of [...urgent, ...normal]) {
      if (slotsLeft <= 0) break;
      schedulePractice(day, topic, maxDaysBetweenPractice);
      slotsLeft--;
    }
  }

  // ─── computeEligibility ───────────────────────────────────────────────────
  // Reads actual eligibility dates from a Pass-2 calendar.

  function computeEligibility(calendar, states) {
    const mcqDone = {};
    let firstMockEligibleDate = null;
    let lastMockEligibleDate  = null;

    for (const day of calendar) {
      if (day.blockedBy || day.totalSessions === 0) continue;
      for (const s of day.sessions) {
        if (s.activityType !== 'practice') continue;
        mcqDone[s.topicId] = (mcqDone[s.topicId] || 0) + 1;
      }
      if (!firstMockEligibleDate && states.every(t => (mcqDone[t.id] || 0) >= 1)) {
        firstMockEligibleDate = cloneDate(day.date);
      }
      if (!lastMockEligibleDate && states.every(t => (mcqDone[t.id] || 0) >= t.totalPN)) {
        lastMockEligibleDate = cloneDate(day.date);
      }
    }
    return { firstMockEligibleDate, lastMockEligibleDate };
  }

  // ─── mockPlacementValid ───────────────────────────────────────────────────
  // Mock placement no longer has eligibility constraints — always valid.

  function mockPlacementValid(mocks, eligibility) {
    return true;
  }

  // ─── placeMocks ────────────────────────────────────────────────────────────
  // Placement rules (no eligibility constraints):
  //   Last mock  — last study day on or before (examDate − 3 days).
  //   Earlier mocks — each one exactly 7 days before the next, working backward.
  //   Manual dates (fixedMockDates: { [mockNumber]: Date }) override auto dates for those mocks only.

  function placeMocks(calendar, eligibility, numMocks, postMockSameDay = true, fixedMockDates = null, examDate) {
    if (numMocks === 0) return [];

    const studyDays = calendar.filter(d => d.totalSessions > 0);

    function firstStudyDayOnOrAfter(targetDate) {
      return studyDays.find(d => d.date.getTime() >= targetDate.getTime()) || null;
    }

    function lastStudyDayOnOrBefore(targetDate) {
      const candidates = studyDays.filter(d => d.date.getTime() <= targetDate.getTime());
      return candidates.length ? candidates[candidates.length - 1] : null;
    }

    const manualDates = fixedMockDates || {};

    // Last mock anchor: last study day on or before examDate − 3 days
    const lastTarget = examDate ? new Date(examDate.getTime() - 3 * MS_PER_DAY) : null;
    const lastAnchor = lastTarget
      ? lastStudyDayOnOrBefore(lastTarget)
      : studyDays[studyDays.length - 1];
    if (!lastAnchor) return [];

    // Build desired dates: mock N = lastAnchor, mock N-k = lastAnchor − k*7 days
    const desiredDates = [];
    for (let mockNum = 1; mockNum <= numMocks; mockNum++) {
      const weeksBack = numMocks - mockNum;   // 0 for last mock, 1 for penultimate, etc.
      if (manualDates[mockNum]) {
        const day = firstStudyDayOnOrAfter(manualDates[mockNum]);
        desiredDates.push(day ? day.date : cloneDate(lastAnchor.date));
      } else {
        const targetMs = lastAnchor.date.getTime() - weeksBack * 7 * MS_PER_DAY;
        const day      = lastStudyDayOnOrBefore(new Date(targetMs));
        desiredDates.push(day ? day.date : cloneDate(lastAnchor.date));
      }
    }

    // Deduplicate: bump any collision to the next available study day
    const usedKeys = new Set();
    const finalDates = [];
    for (const d of desiredDates) {
      let candidate = cloneDate(d);
      while (usedKeys.has(dateKey(candidate))) {
        const next = studyDays.find(sd => sd.date.getTime() > candidate.getTime());
        if (!next) break;
        candidate = cloneDate(next.date);
      }
      usedKeys.add(dateKey(candidate));
      finalDates.push(candidate);
    }

    // Block calendar days and build mockEvents array
    const mockEvents = [];
    const mockKeyMap = new Map();
    finalDates.forEach((d, i) => mockKeyMap.set(dateKey(d), i + 1));
    const mockDateKeys = new Set(mockKeyMap.keys());

    for (const day of calendar) {
      const mockNumber = mockKeyMap.get(dateKey(day.date));
      if (mockNumber === undefined) continue;
      day.blockedBy = 'mock';
      mockEvents.push({ date: cloneDate(day.date), type: 'mock', mockNumber });

      if (postMockSameDay) {
        mockEvents.push({ date: cloneDate(day.date), type: 'postMock', mockNumber });
      } else {
        // PostMock occupies the next study day (not already a mock or postMock day)
        const nextDay = calendar.find(d =>
          d.totalSessions > 0 &&
          d.date.getTime() > day.date.getTime() &&
          !d.blockedBy &&
          !mockDateKeys.has(dateKey(d.date))
        );
        if (nextDay) {
          nextDay.blockedBy = 'postMock';
          mockEvents.push({ date: cloneDate(nextDay.date), type: 'postMock', mockNumber });
        } else {
          // No subsequent study day — fall back to same day
          mockEvents.push({ date: cloneDate(day.date), type: 'postMock', mockNumber });
        }
      }
    }

    return mockEvents;
  }

  // ─── scheduleReview ───────────────────────────────────────────────────────
  // Schedule one review session for `topic` on `day` and advance its SR clock.

  function scheduleReview(day, topic, srIntervals) {
    day.sessions.push({
      topicId:      topic.id,
      activityType: 'review',
      reviewIndex:  topic.nextReviewIndex,
    });
    topic.reviewSessionsCompleted++;
    topic.reviewDates.push(cloneDate(day.date));

    // srIntervals[0] = PN→first-review gap (used when priming the SR clock).
    // srIntervals[curIdx+1] = gap from review curIdx to the next review.
    const curIdx = topic.nextReviewIndex;
    topic.nextReviewIndex = curIdx + 1;
    topic.nextReviewTargetDate = curIdx + 1 < srIntervals.length
      ? addDays(day.date, srIntervals[curIdx + 1])
      : null;
  }

  // ─── Pass 2: full schedule ─────────────────────────────────────────────────

  function runPass2(calendar, topicStates, srIntervals, settings, startDate) {
    const states = topicStates.map(t => ({
      ...t,
      reviewDates:          [],
      nextReviewIndex:      -1,
      nextReviewTargetDate: null,
      practiceDeadline:     null,
      learningStarted:      t.learningStarted,
    }));

    const {
      maxNewTopicsPerDay,
      maxDaysBetweenPractice = 7,
      learningMode           = 'interleaved',
    } = settings;

    const isSequential = learningMode === 'sequential';

    // Interleaved mode: pre-build a learning queue.
    const learningQueue  = isSequential ? [] : states.filter(t => t.remainingLN > 0);
    let   currentLearner = isSequential ? null : (learningQueue.shift() || null);

    // Sequential mode: index into states for the topic currently being worked on.
    let seqIdx = 0;

    // Prime SR clock for topics starting in Reviewing state.
    for (const topic of states) {
      if (topic.startingState === 'Reviewing' && !topic.skipReviews) {
        topic.nextReviewIndex      = 0;
        topic.nextReviewTargetDate = addDays(startDate, srIntervals[0]);
      }
    }

    // Interleaved only: set initial practice deadline for topics already past learning at plan start.
    if (!isSequential) {
      for (const topic of states) {
        if (topic.remainingLN === 0 && topic.remainingPN > 0) {
          topic.practiceDeadline = addDays(startDate, maxDaysBetweenPractice);
        }
      }
    }

    for (const day of calendar) {
      if (day.blockedBy || day.totalSessions === 0) continue;

      // Step 0: all due reviews — before learning or practice.
      //   Sort: first reviews (index 0) first; within tier, most-overdue first.
      const dueReviews = states
        .filter(t => !t.skipReviews &&
                     t.nextReviewTargetDate !== null &&
                     t.nextReviewTargetDate.getTime() <= day.date.getTime())
        .sort((a, b) => {
          const aFirst = a.nextReviewIndex === 0 ? 0 : 1;
          const bFirst = b.nextReviewIndex === 0 ? 0 : 1;
          if (aFirst !== bFirst) return aFirst - bFirst;
          return a.nextReviewTargetDate.getTime() - b.nextReviewTargetDate.getTime();
        });

      for (const topic of dueReviews) {
        if (day.sessions.length >= day.totalSessions) break;
        scheduleReview(day, topic, srIntervals);
      }

      if (isSequential) {
        // Sequential mode: complete one topic's LN then PN before starting the next.
        while (day.sessions.length < day.totalSessions) {
          // Advance past topics with no remaining learn/practice work.
          while (seqIdx < states.length &&
                 states[seqIdx].remainingLN === 0 && states[seqIdx].remainingPN === 0) {
            seqIdx++;
          }
          if (seqIdx >= states.length) break;

          const topic = states[seqIdx];
          if (topic.remainingLN > 0) {
            const isFirstSession = !topic.learningStarted;
            if (isFirstSession) topic.learningStarted = true;
            day.sessions.push({ topicId: topic.id, activityType: 'learn', isFirstSession });
            topic.remainingLN--;
          } else {
            // All learning done — now practice.
            schedulePractice(day, topic, maxDaysBetweenPractice);
          }
        }
      } else {
        // Interleaved mode: steps 1 and 2 as before.

        // Step 1: learning — always before practice.
        currentLearner = scheduleLearningForDay(day, learningQueue, currentLearner, maxNewTopicsPerDay);

        // Set practice deadline for topics that just finished all learning today.
        for (const topic of states) {
          if (
            topic.remainingLN === 0 &&
            topic.remainingPN > 0 &&
            topic.practiceDeadline === null &&
            topic.learningStarted
          ) {
            topic.practiceDeadline = addDays(day.date, maxDaysBetweenPractice);
          }
        }

        // Step 2: practice MCQs — urgent first, then normal.
        scheduleMCQsForDay(day, states, maxDaysBetweenPractice);
      }

      // Prime SR clock for any topic that just finished all PN on this day.
      for (const topic of states) {
        if (
          !topic.skipReviews &&
          topic.pnCompleteDate &&
          dateKey(topic.pnCompleteDate) === dateKey(day.date) &&
          topic.nextReviewIndex === -1
        ) {
          topic.nextReviewIndex      = 0;
          topic.nextReviewTargetDate = addDays(day.date, srIntervals[0]);
        }
      }
    }

    return { states };
  }

  // ─── detectOverflow ────────────────────────────────────────────────────────

  function detectOverflow(calendar, states, examDate) {
    const incompleteLearnTopics = states.filter(t => t.remainingLN > 0).map(t => t.id);
    const incompleteMCQTopics   = states.filter(t => t.remainingPN > 0).map(t => t.id);

    // A topic has a missed review if the next review falls before the exam but has no slot
    const missedReviewTopics = states
      .filter(t => t.nextReviewTargetDate !== null &&
                   t.nextReviewTargetDate.getTime() < examDate.getTime())
      .map(t => t.id);

    const totalMissingSessions =
      states.reduce((s, t) => s + t.remainingLN, 0) +
      states.reduce((s, t) => s + t.remainingPN, 0);

    const studyDaysLeft = calendar.filter(
      d => d.totalSessions > 0 && !d.blockedBy && d.date.getTime() >= Date.now()
    ).length;

    const estimatedExtraSessionsPerWeek = studyDaysLeft > 0
      ? Math.ceil((totalMissingSessions / studyDaysLeft) * 5)
      : totalMissingSessions;

    return {
      hasOverflow: incompleteLearnTopics.length > 0 || incompleteMCQTopics.length > 0,
      incompleteLearnTopics,
      incompleteMCQTopics,
      missedReviewTopics,
      estimatedExtraSessionsPerWeek,
      totalMissingSessions,
    };
  }

  // ─── generatePlan ──────────────────────────────────────────────────────────

  // Constants for the session-length optimiser
  const OVERHEAD_FACTOR = 1.25;  // estimated review overhead on top of LN+PN
  const SESSION_MIN     = 10;    // minimum allowed session length (minutes)
  const SESSION_MAX     = 60;    // maximum allowed session length (minutes)

  function generatePlan(config) {
    const {
      topics,
      startDate,
      examDate,
      firstWeek,            // minutes per day-of-week
      lastWeek,             // minutes per day-of-week (derived from firstWeek × intensityMultiplier)
      rampMode        = 'linear',
      numMocks        = 3,
      srIntervals     = [1, 6, 16, 45, 131],
      settings        = {},
      postMockSameDay = true,
      fixedMockDates  = null,
      blockedDays     = [],
      forcedSessionLength = null,  // if provided, bypass auto-computation (must be multiple of 5)
    } = config;

    const mergedSettings = {
      lnTable:                { easy: 1, medium: 2, hard: 3 },
      pnTable:                { easy: 3, medium: 4, hard: 5 },
      maxNewTopicsPerDay:     4,
      maxDaysBetweenPractice: 7,
      ...settings,
    };

    // 0. Compute optimal session length from available time and workload
    const totalMinutes   = countCalendarMinutes(startDate, examDate, firstWeek, lastWeek, rampMode, blockedDays);
    const totalWorkUnits = computeTotalWorkUnits(topics, mergedSettings);
    const rawT           = totalWorkUnits > 0 ? totalMinutes / (totalWorkUnits * OVERHEAD_FACTOR) : SESSION_MAX;
    const sessionLength  = forcedSessionLength != null
      ? Math.min(SESSION_MAX, Math.max(SESSION_MIN, Math.round(forcedSessionLength)))
      : computeOptimalSessionLength(totalMinutes, totalWorkUnits, OVERHEAD_FACTOR, SESSION_MIN, SESSION_MAX);
    const sessionLengthInsufficient = !forcedSessionLength && rawT < SESSION_MIN;

    // 1. Build the session calendar (sessions/day = floor(dailyMins / sessionLength))
    const calendar    = buildCalendar(startDate, examDate, firstWeek, lastWeek, rampMode, sessionLength, blockedDays);

    // 2. Initialise topic states (these are never mutated — each pass gets a fresh copy)
    const topicStates = initTopics(topics, mergedSettings);

    // 3. Clean run (no mocks) → real eligibility dates.
    //    runPass1 was a simplified approximation; this gives accurate dates because
    //    it runs the full scheduling logic without blocked days distorting placement.
    const cleanPass = runPass2(calendar, topicStates, srIntervals, mergedSettings, startDate);
    let eligibility = computeEligibility(calendar, cleanPass.states);

    // 4. Iterative mock placement
    //    Each iteration places mocks, runs Pass 2, then checks whether the mocks
    //    are still valid relative to the ACTUAL schedule (with blocked days).
    //    Converges in ≤ 2 iterations for normal inputs.
    let mocks       = [];
    let finalStates = topicStates;
    const MAX_ITERS = 3;

    for (let iter = 0; iter < MAX_ITERS; iter++) {
      // Reset calendar state from any previous iteration
      for (const day of calendar) {
        day.sessions  = [];
        day.blockedBy = null;
      }

      // Place mocks based on current eligibility estimate (manual overrides kept)
      mocks = placeMocks(calendar, eligibility, numMocks, postMockSameDay, fixedMockDates, examDate);

      // Pass 2: full schedule with blocked days
      const pass2 = runPass2(calendar, topicStates, srIntervals, mergedSettings, startDate);
      finalStates  = pass2.states;

      // Compute actual eligibility from the real Pass-2 schedule
      const actualEligibility = computeEligibility(calendar, finalStates);

      // If mocks are correctly placed after actual eligibility, we're done
      if (mockPlacementValid(mocks, actualEligibility)) break;

      // Otherwise use actual eligibility for the next iteration
      eligibility = actualEligibility;
    }

    // 5. Detect overflow
    const overflow = detectOverflow(calendar, finalStates, examDate);

    // 6. Detect mock shortfall (fewer mocks placed than requested)
    const placedMockCount = mocks.filter(m => m.type === 'mock').length;
    const mockShortfall   = numMocks - placedMockCount;
    overflow.mockShortfall   = mockShortfall;
    overflow.placedMockCount = placedMockCount;
    if (mockShortfall > 0) overflow.hasOverflow = true;

    // 7. Annotate with session-length diagnostics
    overflow.sessionLengthInsufficient = sessionLengthInsufficient;
    overflow.requiredSessionLength     = totalWorkUnits > 0
      ? Math.round(rawT * 10) / 10
      : 0;
    if (sessionLengthInsufficient) overflow.hasOverflow = true;

    // 8. Session-type counts for overhead-factor calibration
    const sessionCounts = countSessionTypes(calendar);
    const actualOverheadFactor = totalWorkUnits > 0
      ? Math.round((sessionCounts.total / totalWorkUnits) * 100) / 100
      : OVERHEAD_FACTOR;

    return {
      calendar,
      topics:        finalStates,
      mocks,
      overflow,
      sessionLength: Math.round(sessionLength * 10) / 10,
      sessionStats:  { totalWorkUnits, totalMinutes, sessionCounts, actualOverheadFactor },
    };
  }

  // ─── previewPlan ───────────────────────────────────────────────────────────
  // Lightweight single-pass version of generatePlan (no mock placement).
  // Used by the study-schedule page to get exact session counts without the
  // overhead of the iterative mock-convergence loop.
  function previewPlan(config) {
    const {
      topics, startDate, examDate,
      firstWeek, lastWeek, rampMode = 'linear',
      srIntervals = [1, 6, 16, 45, 131],
      settings = {}, blockedDays = [],
      forcedSessionLength = null,
    } = config;

    const mergedSettings = {
      lnTable:                { easy: 1, medium: 2, hard: 3 },
      pnTable:                { easy: 3, medium: 4, hard: 5 },
      maxNewTopicsPerDay:     4,
      maxDaysBetweenPractice: 7,
      ...settings,
    };

    const totalMinutes   = countCalendarMinutes(startDate, examDate, firstWeek, lastWeek, rampMode, blockedDays);
    const totalWorkUnits = computeTotalWorkUnits(topics, mergedSettings);

    const sessionLength = forcedSessionLength != null
      ? Math.min(SESSION_MAX, Math.max(SESSION_MIN, Math.round(forcedSessionLength)))
      : computeOptimalSessionLength(totalMinutes, totalWorkUnits, OVERHEAD_FACTOR, SESSION_MIN, SESSION_MAX);

    const calendar    = buildCalendar(startDate, examDate, firstWeek, lastWeek, rampMode, sessionLength, blockedDays);
    const topicStates = initTopics(topics, mergedSettings);
    const pass        = runPass2(calendar, topicStates, srIntervals, mergedSettings, startDate);
    const overflow    = detectOverflow(calendar, pass.states, examDate);
    const sessionCounts = countSessionTypes(calendar);

    const lpFits = overflow.incompleteLearnTopics.length === 0 &&
                   overflow.incompleteMCQTopics.length === 0;

    return {
      sessionLength,
      totalMinutes,
      totalWorkUnits,
      sessionCounts,
      overflow,
      lpFits,
    };
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  return {
    generatePlan,
    previewPlan,
    buildCalendar,
    initTopics,
    interpolateSessions,
    computeTotalWorkUnits,
    countCalendarMinutes,
    computeOptimalSessionLength,
    OVERHEAD_FACTOR,
    SESSION_MIN,
    SESSION_MAX,
  };
}));
