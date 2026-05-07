'use strict';

const { describe, test, expect, runAll } = require('./runner.js');
const planner = require('../js/planner.js');

// ─── Reference fixture ────────────────────────────────────────────────────────
// 3 topics: Easy(LN=1,PN=3), Medium(LN=2,PN=4), Hard(LN=3,PN=5)
// 14 weeks Mon–Fri, linear ramp 2→4 sessions/day, 3 mocks

const D = s => new Date(s + 'T00:00:00.000Z'); // UTC dates

const TOPICS = [
  { id: 'A', name: 'Topic A', difficulty: 'easy',   startingState: 'Not Started' },
  { id: 'B', name: 'Topic B', difficulty: 'medium',  startingState: 'Not Started' },
  { id: 'C', name: 'Topic C', difficulty: 'hard',    startingState: 'Not Started' },
];

const START  = D('2026-06-01'); // Monday
const EXAM   = D('2026-09-07'); // 14 weeks later (Monday)

const FIRST_WEEK = { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 0, sun: 0 };
const LAST_WEEK  = { mon: 4, tue: 4, wed: 4, thu: 4, fri: 4, sat: 0, sun: 0 };

const SR = [6, 16, 45, 131];

const SETTINGS = {
  lnTable: { easy: 1, medium: 2, hard: 3 },
  pnTable: { easy: 3, medium: 4, hard: 5 },
  maxNewTopicsPerDay: 4,
  sessionDurationMin: 20,
};

function makePlan(overrides = {}) {
  return planner.generatePlan({
    topics:    TOPICS,
    startDate: START,
    examDate:  EXAM,
    firstWeek: FIRST_WEEK,
    lastWeek:  LAST_WEEK,
    rampMode:  'linear',
    numMocks:  3,
    srIntervals: SR,
    settings:  SETTINGS,
    ...overrides,
  });
}

// ─── T1  Calendar generation ──────────────────────────────────────────────────
describe('T1 – Calendar generation', () => {

  test('T1.1 week-1 days have firstWeek session count', () => {
    const cal = planner.buildCalendar(START, EXAM, FIRST_WEEK, LAST_WEEK, 'linear');
    // Days 0-4 = Mon-Fri of week 1 (Jun 1-5)
    const week1Days = cal.filter(d => d.totalSessions > 0).slice(0, 5);
    for (const day of week1Days) {
      expect(day.totalSessions).toBe(2);
    }
  });

  test('T1.2 last week days have lastWeek session count', () => {
    const cal = planner.buildCalendar(START, EXAM, FIRST_WEEK, LAST_WEEK, 'linear');
    const studyDays = cal.filter(d => d.totalSessions > 0);
    const lastFive = studyDays.slice(-5);
    for (const day of lastFive) {
      expect(day.totalSessions).toBe(4);
    }
  });

  test('T1.3 linear ramp: mid-point week is the midpoint value', () => {
    // 14 weeks, week 6 (0-indexed) out of 13 ≈ 46% → 2 + 2*0.46 = 2.92 → rounds to 3
    const val = planner.interpolateSessions(2, 4, 6, 14, 'linear');
    expect(val).toBe(3);
  });

  test('T1.4 cram mode: week 6 stays close to firstWeek value', () => {
    // t = 6/13 ≈ 0.46; factor = 0.46^3 ≈ 0.097 → 2 + 2*0.097 ≈ 2.19 → rounds to 2
    const val = planner.interpolateSessions(2, 4, 6, 14, 'cram');
    expect(val).toBeLessThanOrEqual(3);
    expect(val).toBeGreaterThanOrEqual(2);
  });

  test('T1.5 cram mode: final week is lastWeek value', () => {
    const val = planner.interpolateSessions(2, 4, 13, 14, 'cram');
    expect(val).toBe(4);
  });

  test('T1.6 days with 0 sessions in firstWeek are included but have 0 sessions', () => {
    const cal = planner.buildCalendar(START, EXAM, FIRST_WEEK, LAST_WEEK, 'linear');
    // Saturday = index 6, Sunday = index 0 in JS getDay()
    const saturdays = cal.filter(d => d.date.getUTCDay() === 6);
    for (const day of saturdays) {
      expect(day.totalSessions).toBe(0);
    }
  });

  test('T1.7 exam date itself is not in the calendar', () => {
    const cal = planner.buildCalendar(START, EXAM, FIRST_WEEK, LAST_WEEK, 'linear');
    const examInCal = cal.find(d => d.date.getTime() === EXAM.getTime());
    expect(!!examInCal).toBe(false);
  });
});

// ─── T2  Topic initialisation ─────────────────────────────────────────────────
describe('T2 – Topic initialisation', () => {

  test('T2.1 Not Started: full LN and PN assigned', () => {
    const states = planner.initTopics(
      [{ id: 'x', name: 'X', difficulty: 'medium', startingState: 'Not Started' }],
      SETTINGS
    );
    expect(states[0].remainingLN).toBe(2);
    expect(states[0].remainingPN).toBe(4);
    expect(states[0].mcqSessionsDone).toBe(0);
  });

  test('T2.2 Learned: LN=0, full PN, mcqDone=0', () => {
    const states = planner.initTopics(
      [{ id: 'x', name: 'X', difficulty: 'hard', startingState: 'Learned' }],
      SETTINGS
    );
    expect(states[0].remainingLN).toBe(0);
    expect(states[0].remainingPN).toBe(5);
    expect(states[0].mcqSessionsDone).toBe(0);
  });

  test('T2.3 Practicing: LN=0, PN-1 remaining, mcqDone=1', () => {
    const states = planner.initTopics(
      [{ id: 'x', name: 'X', difficulty: 'hard', startingState: 'Practicing' }],
      SETTINGS
    );
    expect(states[0].remainingLN).toBe(0);
    expect(states[0].remainingPN).toBe(4);
    expect(states[0].mcqSessionsDone).toBe(1);
  });

  test('T2.4 Reviewing: LN=0, PN=0, mcqDone=PN', () => {
    const states = planner.initTopics(
      [{ id: 'x', name: 'X', difficulty: 'medium', startingState: 'Reviewing' }],
      SETTINGS
    );
    expect(states[0].remainingLN).toBe(0);
    expect(states[0].remainingPN).toBe(0);
    expect(states[0].mcqSessionsDone).toBe(4);
  });

  test('T2.5 reviewSessionsCompleted initialises to 0', () => {
    const states = planner.initTopics(TOPICS, SETTINGS);
    for (const s of states) {
      expect(s.reviewSessionsCompleted).toBe(0);
    }
  });
});

// ─── T3  Learning scheduling ──────────────────────────────────────────────────
describe('T3 – Learning scheduling', () => {

  test('T3.1 each topic gets exactly LN learn sessions', () => {
    const { topics } = makePlan();
    const A = topics.find(t => t.id === 'A');
    const B = topics.find(t => t.id === 'B');
    const C = topics.find(t => t.id === 'C');
    // After scheduling, remainingLN should be 0 for all
    expect(A.remainingLN).toBe(0);
    expect(B.remainingLN).toBe(0);
    expect(C.remainingLN).toBe(0);
  });

  test('T3.2 learn sessions appear in calendar before any practice session for the same topic', () => {
    const { calendar } = makePlan();
    for (const topicId of ['A', 'B', 'C']) {
      let lastLearnDate = null;
      let firstPracticeDate = null;
      for (const day of calendar) {
        for (const s of day.sessions) {
          if (s.topicId !== topicId) continue;
          if (s.activityType === 'learn' && !firstPracticeDate) lastLearnDate = day.date;
          if (s.activityType === 'practice' && !firstPracticeDate) firstPracticeDate = day.date;
        }
      }
      if (firstPracticeDate && lastLearnDate) {
        expect(firstPracticeDate >= lastLearnDate).toBe(true);
      }
    }
  });

  test('T3.3 at most maxNewTopicsPerDay distinct topics start learning on any one day', () => {
    const { calendar } = makePlan();
    for (const day of calendar) {
      const topicsStartingToday = new Set();
      let prevTopicInDay = null;
      for (const s of day.sessions) {
        if (s.activityType === 'learn' && s.isFirstSession) {
          topicsStartingToday.add(s.topicId);
        }
      }
      expect(topicsStartingToday.size).toBeLessThanOrEqual(SETTINGS.maxNewTopicsPerDay);
    }
  });

  test('T3.4 all learn sessions for a topic appear before the topic switches to practice', () => {
    const { calendar } = makePlan();
    for (const topicId of ['A', 'B', 'C']) {
      const sessions = calendar
        .flatMap(day => day.sessions.map(s => ({ ...s, date: day.date })))
        .filter(s => s.topicId === topicId);
      const learnDone = sessions.filter(s => s.activityType === 'learn').length;
      const expectedLN = SETTINGS.lnTable[TOPICS.find(t => t.id === topicId).difficulty];
      expect(learnDone).toBe(expectedLN);
    }
  });
});

// ─── T4  Practice MCQ scheduling ─────────────────────────────────────────────
describe('T4 – Practice MCQ scheduling', () => {

  test('T4.1 each topic gets exactly PN practice sessions in the calendar', () => {
    const { calendar } = makePlan();
    for (const topic of TOPICS) {
      const count = calendar.flatMap(d => d.sessions)
        .filter(s => s.topicId === topic.id && s.activityType === 'practice').length;
      expect(count).toBe(SETTINGS.pnTable[topic.difficulty]);
    }
  });

  test('T4.2 at most one practice session per topic per day', () => {
    const { calendar } = makePlan();
    for (const day of calendar) {
      const practicePerTopic = {};
      for (const s of day.sessions) {
        if (s.activityType !== 'practice') continue;
        practicePerTopic[s.topicId] = (practicePerTopic[s.topicId] || 0) + 1;
      }
      for (const count of Object.values(practicePerTopic)) {
        expect(count).toBeLessThanOrEqual(1);
      }
    }
  });

  test('T4.4 no topic receives more practice sessions than its totalPN (calendar-wide)', () => {
    const { calendar, topics } = makePlan();
    const counts = {};
    for (const day of calendar) {
      for (const s of day.sessions) {
        if (s.activityType === 'practice') counts[s.topicId] = (counts[s.topicId] || 0) + 1;
      }
    }
    for (const topic of topics) {
      expect(counts[topic.id] || 0).toBeLessThanOrEqual(topic.totalPN);
    }
  });

  test('T4.3 no practice session is scheduled on same day as topics last learn session or earlier', () => {
    const { calendar } = makePlan();
    for (const topicId of ['A', 'B', 'C']) {
      let lastLearnDay = -1;
      let firstPracticeDay = Infinity;
      calendar.forEach((day, i) => {
        for (const s of day.sessions) {
          if (s.topicId !== topicId) continue;
          if (s.activityType === 'learn') lastLearnDay = i;
          if (s.activityType === 'practice') firstPracticeDay = Math.min(firstPracticeDay, i);
        }
      });
      if (firstPracticeDay < Infinity && lastLearnDay >= 0) {
        expect(firstPracticeDay).toBeGreaterThanOrEqual(lastLearnDay);
      }
    }
  });
});

// ─── T5  Mock eligibility ─────────────────────────────────────────────────────
describe('T5 – Mock eligibility gates', () => {

  test('T5.1 first mock date is after or on the day all topics have at least 1 MCQ done', () => {
    const { calendar, mocks } = makePlan();
    const firstMock = mocks.find(m => m.type === 'mock' && m.mockNumber === 1);
    if (!firstMock) return; // overflow case, skip

    // Find the date all topics have mcqDone >= 1
    const mcqDonePerTopic = {};
    let eligibleDate = null;
    for (const day of calendar) {
      for (const s of day.sessions) {
        if (s.activityType !== 'practice') continue;
        mcqDonePerTopic[s.topicId] = (mcqDonePerTopic[s.topicId] || 0) + 1;
      }
      if (!eligibleDate && TOPICS.every(t => (mcqDonePerTopic[t.id] || 0) >= 1)) {
        eligibleDate = day.date;
      }
    }
    if (eligibleDate) {
      expect(firstMock.date.getTime()).toBeGreaterThanOrEqual(eligibleDate.getTime());
    }
  });

  test('T5.2 last mock date is after or on the day all topics have PN MCQs done', () => {
    const { calendar, mocks } = makePlan();
    const lastMock = mocks.find(m => m.type === 'mock' && m.mockNumber === 3);
    if (!lastMock) return;

    const mcqDonePerTopic = {};
    let eligibleDate = null;
    for (const day of calendar) {
      for (const s of day.sessions) {
        if (s.activityType !== 'practice') continue;
        mcqDonePerTopic[s.topicId] = (mcqDonePerTopic[s.topicId] || 0) + 1;
      }
      if (!eligibleDate && TOPICS.every(t =>
        (mcqDonePerTopic[t.id] || 0) >= SETTINGS.pnTable[t.difficulty]
      )) {
        eligibleDate = day.date;
      }
    }
    if (eligibleDate) {
      expect(lastMock.date.getTime()).toBeGreaterThanOrEqual(eligibleDate.getTime());
    }
  });

  test('T5.3 with numMocks=1 only one mock event is scheduled', () => {
    const { mocks } = makePlan({ numMocks: 1 });
    const mockEvents = mocks.filter(m => m.type === 'mock');
    expect(mockEvents.length).toBe(1);
  });

  test('T5.4 with numMocks=0 no mocks are scheduled', () => {
    const { mocks } = makePlan({ numMocks: 0 });
    expect(mocks.length).toBe(0);
  });
});

// ─── T6  Mock scheduling strategy ────────────────────────────────────────────
describe('T6 – Mock scheduling strategy', () => {

  test('T6.1 all mocks fall before exam date', () => {
    const { mocks } = makePlan();
    for (const m of mocks.filter(e => e.type === 'mock')) {
      expect(m.date.getTime()).toBeLessThan(EXAM.getTime());
    }
  });

  test('T6.2 with 3 mocks there are exactly 3 mock events and 3 postMock events', () => {
    const { mocks } = makePlan();
    expect(mocks.filter(m => m.type === 'mock').length).toBe(3);
    expect(mocks.filter(m => m.type === 'postMock').length).toBe(3);
  });

  test('T6.3 middle mock date is between first and last mock dates', () => {
    const { mocks } = makePlan();
    const mockDates = mocks.filter(m => m.type === 'mock').map(m => m.date.getTime());
    mockDates.sort((a, b) => a - b);
    expect(mockDates[1]).toBeGreaterThan(mockDates[0]);
    expect(mockDates[1]).toBeLessThan(mockDates[2]);
  });

  test('T6.4 mock events are chronologically ordered by mock number', () => {
    const { mocks } = makePlan();
    const mocksSorted = mocks.filter(m => m.type === 'mock').sort((a, b) => a.mockNumber - b.mockNumber);
    for (let i = 1; i < mocksSorted.length; i++) {
      expect(mocksSorted[i].date.getTime()).toBeGreaterThan(mocksSorted[i-1].date.getTime());
    }
  });
});

// ─── T7  Post-mock revision ───────────────────────────────────────────────────
describe('T7 – Post-mock revision', () => {

  test('T7.1 every mock has a corresponding postMock event', () => {
    const { mocks } = makePlan();
    const mockNums   = mocks.filter(m => m.type === 'mock').map(m => m.mockNumber).sort();
    const postNums   = mocks.filter(m => m.type === 'postMock').map(m => m.mockNumber).sort();
    expect(mockNums).toEqual(postNums);
  });

  test('T7.2 postMock is on the same day as mock or the next study day', () => {
    const { calendar, mocks } = makePlan();
    const studyDays = calendar.filter(d => d.totalSessions > 0).map(d => d.date.getTime());

    for (const mock of mocks.filter(m => m.type === 'mock')) {
      const postMock = mocks.find(m => m.type === 'postMock' && m.mockNumber === mock.mockNumber);
      if (!postMock) continue;
      const mockTime    = mock.date.getTime();
      const postTime    = postMock.date.getTime();
      const sameDay     = mockTime === postTime;
      // Next study day after mock
      const nextStudyDay = studyDays.find(t => t > mockTime);
      const nextDayMatch = postTime === nextStudyDay;
      expect(sameDay || nextDayMatch).toBe(true);
    }
  });

  test('T7.4 postMockSameDay=false places postMock on a later day than the mock', () => {
    const { mocks } = makePlan({ postMockSameDay: false });
    const mockEvents = mocks.filter(m => m.type === 'mock');
    expect(mockEvents.length).toBeGreaterThan(0);
    for (const mock of mockEvents) {
      const postMock = mocks.find(m => m.type === 'postMock' && m.mockNumber === mock.mockNumber);
      expect(postMock).toBeTruthy();
      expect(postMock.date.getTime()).toBeGreaterThan(mock.date.getTime());
    }
  });

  test('T7.3 no regular sessions scheduled on a mock/postMock day', () => {
    const { calendar } = makePlan();
    for (const day of calendar) {
      if (day.blockedBy) {
        const regularSessions = day.sessions.filter(
          s => s.activityType !== 'mock' && s.activityType !== 'postMock'
        );
        expect(regularSessions.length).toBe(0);
      }
    }
  });
});

// ─── T8  Spaced repetition ────────────────────────────────────────────────────
describe('T8 – Spaced repetition', () => {

  test('T8.1 first review is on or after pnCompleteDate + 1 day', () => {
    const { calendar, topics } = makePlan();
    for (const topic of topics) {
      if (!topic.pnCompleteDate) continue;
      const reviews = calendar
        .filter(day => day.sessions.some(s => s.topicId === topic.id && s.activityType === 'review'))
        .map(day => day.date.getTime());
      if (reviews.length === 0) continue;
      const earliest = Math.min(...reviews);
      const target   = topic.pnCompleteDate.getTime() + 86400000; // always 1 day
      expect(earliest).toBeGreaterThanOrEqual(target);
    }
  });

  test('T8.4 first review lands on the first study day after PN completes', () => {
    // Single topic, ample sessions — no competition for the slot
    const { calendar, topics } = planner.generatePlan({
      topics:    [{ id: 'X', name: 'X', difficulty: 'easy', startingState: 'Not Started' }],
      startDate: START, examDate: EXAM,
      firstWeek: { mon:4, tue:4, wed:4, thu:4, fri:4, sat:0, sun:0 },
      lastWeek:  { mon:4, tue:4, wed:4, thu:4, fri:4, sat:0, sun:0 },
      rampMode: 'linear', numMocks: 0, srIntervals: SR, settings: SETTINGS,
    });
    const topic = topics[0];
    if (!topic.pnCompleteDate) return;
    const firstStudyDayAfterPN = calendar.find(d =>
      d.totalSessions > 0 && !d.blockedBy &&
      d.date.getTime() > topic.pnCompleteDate.getTime()
    );
    const firstReviewDay = calendar.find(d =>
      d.sessions.some(s => s.topicId === 'X' && s.activityType === 'review')
    );
    expect(firstReviewDay).toBeTruthy();
    expect(firstStudyDayAfterPN).toBeTruthy();
    expect(firstReviewDay.date.getTime()).toBe(firstStudyDayAfterPN.date.getTime());
  });

  test('T8.2 each successive review respects the minimum gap from the previous', () => {
    const { calendar } = makePlan();
    for (const topicId of ['A', 'B', 'C']) {
      const reviewDays = calendar
        .filter(day => day.sessions.some(s => s.topicId === topicId && s.activityType === 'review'))
        .map(day => day.date.getTime());
      reviewDays.sort((a, b) => a - b);
      for (let i = 1; i < reviewDays.length; i++) {
        const gapDays = (reviewDays[i] - reviewDays[i - 1]) / 86400000;
        // SR[i-1] is the inter-review gap applied after completing review i-1
        expect(gapDays).toBeGreaterThanOrEqual(SR[i - 1]);
      }
    }
  });

  test('T8.3 topic starting in Reviewing state gets its first review on or after startDate + 1 day', () => {
    const reviewingTopics = [
      { id: 'R', name: 'R', difficulty: 'easy', startingState: 'Reviewing' },
    ];
    const { calendar } = planner.generatePlan({
      topics:    reviewingTopics,
      startDate: START,
      examDate:  EXAM,
      firstWeek: FIRST_WEEK,
      lastWeek:  LAST_WEEK,
      rampMode:  'linear',
      numMocks:  0,
      srIntervals: SR,
      settings:  SETTINGS,
    });
    const firstReview = calendar.find(day =>
      day.sessions.some(s => s.topicId === 'R' && s.activityType === 'review')
    );
    expect(firstReview).toBeTruthy();
    const minTarget = START.getTime() + 86400000; // 1 day after plan start
    expect(firstReview.date.getTime()).toBeGreaterThanOrEqual(minTarget);
  });
});

// ─── T9  Starting state effects ───────────────────────────────────────────────
describe('T9 – Starting state effects', () => {

  test('T9.1 Learned topic has no learn sessions in calendar', () => {
    const { calendar } = planner.generatePlan({
      topics:    [{ id: 'L', name: 'L', difficulty: 'medium', startingState: 'Learned' }],
      startDate: START, examDate: EXAM,
      firstWeek: FIRST_WEEK, lastWeek: LAST_WEEK, rampMode: 'linear',
      numMocks: 0, srIntervals: SR, settings: SETTINGS,
    });
    const learnSessions = calendar.flatMap(d => d.sessions).filter(s => s.activityType === 'learn');
    expect(learnSessions.length).toBe(0);
  });

  test('T9.2 Practicing topic has PN-1 practice sessions in calendar', () => {
    const { calendar } = planner.generatePlan({
      topics:    [{ id: 'P', name: 'P', difficulty: 'medium', startingState: 'Practicing' }],
      startDate: START, examDate: EXAM,
      firstWeek: FIRST_WEEK, lastWeek: LAST_WEEK, rampMode: 'linear',
      numMocks: 0, srIntervals: SR, settings: SETTINGS,
    });
    const practiceCount = calendar.flatMap(d => d.sessions)
      .filter(s => s.activityType === 'practice').length;
    expect(practiceCount).toBe(SETTINGS.pnTable.medium - 1);
  });

  test('T9.3 Reviewing topic has no learn or practice sessions in calendar', () => {
    const { calendar } = planner.generatePlan({
      topics:    [{ id: 'V', name: 'V', difficulty: 'easy', startingState: 'Reviewing' }],
      startDate: START, examDate: EXAM,
      firstWeek: FIRST_WEEK, lastWeek: LAST_WEEK, rampMode: 'linear',
      numMocks: 0, srIntervals: SR, settings: SETTINGS,
    });
    const bad = calendar.flatMap(d => d.sessions)
      .filter(s => s.activityType === 'learn' || s.activityType === 'practice');
    expect(bad.length).toBe(0);
  });
});

// ─── T10  Overflow detection ──────────────────────────────────────────────────
describe('T10 – Overflow detection', () => {

  test('T10.1 tight schedule with too few sessions reports overflow', () => {
    // 1 session/day Mon-Fri for only 2 weeks — not enough for 12 MCQs + 6 learns
    const { overflow } = planner.generatePlan({
      topics:    TOPICS,
      startDate: START,
      examDate:  D('2026-06-15'), // only 2 weeks
      firstWeek: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 },
      lastWeek:  { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 },
      rampMode: 'linear', numMocks: 3, srIntervals: SR, settings: SETTINGS,
    });
    expect(overflow.hasOverflow).toBe(true);
  });

  test('T10.2 comfortable schedule reports no overflow for learning and MCQs', () => {
    const { overflow } = makePlan();
    // 14 weeks is more than enough for all LN + PN
    expect(overflow.incompleteMCQTopics.length).toBe(0);
    expect(overflow.incompleteLearnTopics.length).toBe(0);
  });

  test('T10.3 overflow lists topic IDs not names', () => {
    const { overflow } = planner.generatePlan({
      topics:    TOPICS,
      startDate: START,
      examDate:  D('2026-06-15'),
      firstWeek: { mon: 1, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 },
      lastWeek:  { mon: 1, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 },
      rampMode: 'linear', numMocks: 0, srIntervals: SR, settings: SETTINGS,
    });
    if (overflow.incompleteMCQTopics.length > 0) {
      expect(['A', 'B', 'C']).toContain(overflow.incompleteMCQTopics[0]);
    }
  });
});

// ─── T11  End-to-end reference scenario ──────────────────────────────────────
describe('T11 – End-to-end reference scenario', () => {

  test('T11.1 all 6 learning sessions are placed (A:1 + B:2 + C:3)', () => {
    const { calendar } = makePlan();
    const total = calendar.flatMap(d => d.sessions)
      .filter(s => s.activityType === 'learn').length;
    expect(total).toBe(1 + 2 + 3);
  });

  test('T11.2 all 12 practice MCQ sessions are placed (A:3 + B:4 + C:5)', () => {
    const { calendar } = makePlan();
    const total = calendar.flatMap(d => d.sessions)
      .filter(s => s.activityType === 'practice').length;
    expect(total).toBe(3 + 4 + 5);
  });

  test('T11.3 exactly 3 mocks and 3 postMocks are placed before exam date', () => {
    const { mocks } = makePlan();
    expect(mocks.filter(m => m.type === 'mock').length).toBe(3);
    expect(mocks.filter(m => m.type === 'postMock').length).toBe(3);
    for (const m of mocks) {
      expect(m.date.getTime()).toBeLessThan(EXAM.getTime());
    }
  });

  test('T11.4 all topics have at least 1 review session scheduled', () => {
    const { calendar } = makePlan();
    for (const topicId of ['A', 'B', 'C']) {
      const hasReview = calendar.some(day =>
        day.sessions.some(s => s.topicId === topicId && s.activityType === 'review')
      );
      expect(hasReview).toBe(true);
    }
  });

  test('T11.5 exam date has no sessions', () => {
    const { calendar } = makePlan();
    const examDay = calendar.find(d => d.date.getTime() === EXAM.getTime());
    expect(!!examDay).toBe(false); // exam date excluded from calendar
  });

  test('T11.6 blocked (mock) days have no regular study sessions', () => {
    const { calendar } = makePlan();
    const blockedDays = calendar.filter(d => d.blockedBy);
    expect(blockedDays.length).toBeGreaterThan(0);
    for (const day of blockedDays) {
      const hasRegular = day.sessions.some(
        s => s.activityType !== 'mock' && s.activityType !== 'postMock'
      );
      expect(hasRegular).toBe(false);
    }
  });

  test('T11.7 topics final state has remainingLN=0 and remainingPN=0', () => {
    const { topics } = makePlan();
    for (const topic of topics) {
      expect(topic.remainingLN).toBe(0);
      expect(topic.remainingPN).toBe(0);
    }
  });

  test('T11.8 reviewSessionsCompleted is tracked and > 0 for completed reviews', () => {
    const { topics } = makePlan();
    for (const topic of topics) {
      expect(topic.reviewSessionsCompleted).toBeGreaterThan(0);
    }
  });
});

// ─── T12  Practice freshness constraint ──────────────────────────────────────
describe('T12 – Practice freshness', () => {

  // A tight-but-passing scenario: 1 topic (easy: LN=1, PN=3), 4 weeks, 2 sessions/day.
  // maxDaysBetweenPractice = 7 means first practice must be within 7 days of learning,
  // and no two consecutive practice sessions > 7 days apart.

  function freshnessGaps(calendar, topicId) {
    const practiceDates = [];
    let learnEndDate = null;
    for (const day of calendar) {
      for (const s of day.sessions) {
        if (s.topicId !== topicId) continue;
        if (s.activityType === 'learn')    learnEndDate = day.date;
        if (s.activityType === 'practice') practiceDates.push(day.date);
      }
    }
    return { learnEndDate, practiceDates };
  }

  test('T12.1 first practice starts within maxDaysBetweenPractice days of learning end', () => {
    const MAX = 7;
    const { calendar } = planner.generatePlan({
      topics:    [{ id: 'A', name: 'A', difficulty: 'easy', startingState: 'Not Started' }],
      startDate: START, examDate: D('2026-06-29'), // 4 weeks
      firstWeek: { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 0, sun: 0 },
      lastWeek:  { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 0, sun: 0 },
      rampMode: 'linear', numMocks: 0, srIntervals: SR,
      settings: { ...SETTINGS, maxDaysBetweenPractice: MAX },
    });
    const { learnEndDate, practiceDates } = freshnessGaps(calendar, 'A');
    if (!learnEndDate || practiceDates.length === 0) return; // overflow — skip
    const gap = Math.round((practiceDates[0] - learnEndDate) / (24 * 60 * 60 * 1000));
    expect(gap).toBeLessThanOrEqual(MAX);
  });

  test('T12.2 consecutive practice sessions are no more than maxDaysBetweenPractice days apart', () => {
    const MAX = 7;
    const { calendar } = planner.generatePlan({
      topics: [
        { id: 'A', name: 'A', difficulty: 'easy',   startingState: 'Not Started' },
        { id: 'B', name: 'B', difficulty: 'medium',  startingState: 'Not Started' },
      ],
      startDate: START, examDate: D('2026-08-31'), // 13 weeks
      firstWeek: { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 0, sun: 0 },
      lastWeek:  { mon: 3, tue: 3, wed: 3, thu: 3, fri: 3, sat: 0, sun: 0 },
      rampMode: 'linear', numMocks: 0, srIntervals: SR,
      settings: { ...SETTINGS, maxDaysBetweenPractice: MAX },
    });
    for (const topicId of ['A', 'B']) {
      const { practiceDates } = freshnessGaps(calendar, topicId);
      for (let i = 1; i < practiceDates.length; i++) {
        const gap = Math.round((practiceDates[i] - practiceDates[i - 1]) / (24 * 60 * 60 * 1000));
        expect(gap).toBeLessThanOrEqual(MAX);
      }
    }
  });
});

// ─── T13  Per-topic session integrity ────────────────────────────────────────
describe('T13 – Per-topic session integrity', () => {

  test('T13.1 each topic gets exactly its LN learning sessions (not just total)', () => {
    const { calendar } = makePlan();
    const lnExpected = { A: 1, B: 2, C: 3 };
    for (const [id, expected] of Object.entries(lnExpected)) {
      const count = calendar.flatMap(d => d.sessions)
        .filter(s => s.topicId === id && s.activityType === 'learn').length;
      expect(count).toBe(expected);
    }
  });

  test('T13.2 each topic gets exactly its PN practice sessions (not just total)', () => {
    const { calendar } = makePlan();
    const pnExpected = { A: 3, B: 4, C: 5 };
    for (const [id, expected] of Object.entries(pnExpected)) {
      const count = calendar.flatMap(d => d.sessions)
        .filter(s => s.topicId === id && s.activityType === 'practice').length;
      expect(count).toBe(expected);
    }
  });

  test('T13.3 no topic has a practice session after its first review session', () => {
    const { calendar } = makePlan();
    for (const topicId of ['A', 'B', 'C']) {
      const allSessions = calendar
        .flatMap(d => d.sessions.map(s => ({ date: d.date, ...s })))
        .filter(s => s.topicId === topicId);

      const firstReview = allSessions.find(s => s.activityType === 'review');
      if (!firstReview) continue;

      const practiceAfterReview = allSessions.filter(
        s => s.activityType === 'practice' && s.date.getTime() > firstReview.date.getTime()
      );
      expect(practiceAfterReview.length).toBe(0);
    }
  });

  test('T13.4 no topic has more than one practice session on any single day', () => {
    const { calendar } = makePlan();
    for (const day of calendar) {
      const practicedTopics = day.sessions
        .filter(s => s.activityType === 'practice')
        .map(s => s.topicId);
      const unique = new Set(practicedTopics);
      expect(practicedTopics.length).toBe(unique.size);
    }
  });

  test('T13.5 no topic has a learn session after its first practice session', () => {
    const { calendar } = makePlan();
    for (const topicId of ['A', 'B', 'C']) {
      const allSessions = calendar
        .flatMap(d => d.sessions.map(s => ({ date: d.date, ...s })))
        .filter(s => s.topicId === topicId);

      const firstPractice = allSessions.find(s => s.activityType === 'practice');
      if (!firstPractice) continue;

      const learnAfterPractice = allSessions.filter(
        s => s.activityType === 'learn' && s.date.getTime() > firstPractice.date.getTime()
      );
      expect(learnAfterPractice.length).toBe(0);
    }
  });

  test('T13.6 duplicate-named topics each get their own correct session counts', () => {
    // Two topics with the same name — must NOT merge their session counts
    const { calendar } = planner.generatePlan({
      topics: [
        { id: 'X1', name: 'Same Name', difficulty: 'easy',   startingState: 'Not Started' },
        { id: 'X2', name: 'Same Name', difficulty: 'medium',  startingState: 'Not Started' },
      ],
      startDate: START, examDate: EXAM,
      firstWeek: FIRST_WEEK, lastWeek: LAST_WEEK, rampMode: 'linear',
      numMocks: 0, srIntervals: SR, settings: SETTINGS,
    });
    const countById = (id, type) =>
      calendar.flatMap(d => d.sessions).filter(s => s.topicId === id && s.activityType === type).length;

    expect(countById('X1', 'learn')).toBe(1);    // easy LN=1
    expect(countById('X2', 'learn')).toBe(2);    // medium LN=2
    expect(countById('X1', 'practice')).toBe(3); // easy PN=3
    expect(countById('X2', 'practice')).toBe(4); // medium PN=4
  });
});

// ─── Run ─────────────────────────────────────────────────────────────────────
runAll();
