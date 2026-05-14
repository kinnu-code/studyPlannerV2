/**
 * prompts.js — OpenAI prompt templates for the Smart Study Planner.
 *
 * Edit this file to tweak how topics are generated and how free-text
 * notes are interpreted. All functions take plain strings and return
 * an object with { system, user } ready to send to the OpenAI API.
 *
 * Exposed as window.StudyPrompts in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.StudyPrompts = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ─── Shared JSON schema descriptions ───────────────────────────────────────

  const DIFFICULTY_AND_STATE_GUIDE = `
Difficulty guide:
  easy   — single concept, few MCQs needed (LN=1, PN=3 sessions)
  medium — moderate depth, typical study unit (LN=2, PN=4 sessions)
  hard   — broad or complex unit (LN=3, PN=5 sessions)

Starting state guide (default to "Not Started" unless user notes say otherwise):
  Not Started — topic not yet touched; full learn → practice → review pipeline
  Learned     — content already studied; skip learning; begin at Practice MCQs
  Practicing  — one practice MCQ session already done; PN−1 sessions remaining
  Reviewing   — all practice MCQs done; begin immediately at first Review session`.trim();

  // Flat schema — used for mode 3 (AI assigns difficulty to user-provided leaf topics only)
  const TOPIC_SCHEMA = `
Return ONLY a valid JSON array — no markdown fences, no commentary.
Each element must have exactly these fields:
  "title"        : string  — concise topic name (≤ 10 words)
  "difficulty"   : "easy" | "medium" | "hard"
  "startingState": "Not Started" | "Learned" | "Practicing" | "Reviewing"

${DIFFICULTY_AND_STATE_GUIDE}

Aim for genuinely granular topics — a study session covers one topic comfortably.
Avoid super-broad entries (e.g., "Contract Law") and avoid trivially narrow ones
(e.g., "Definition of offer"). Granularity similar to a single lecture or chapter.`.trim();

  // Hierarchical schema — used for modes 1 and 2 (AI produces a two-level structure)
  const HIERARCHY_SCHEMA = `
Return ONLY a valid JSON array — no markdown fences, no commentary.

The array contains GROUP items and/or STANDALONE items.

GROUP item — a subject area whose study units are listed as sub-topics:
{
  "title": string — short area name (≤ 6 words, e.g. "Contract Law"),
  "subTopics": [
    { "title": string, "difficulty": "easy"|"medium"|"hard", "startingState": "Not Started"|"Learned"|"Practicing"|"Reviewing" },
    ...
  ]
}

STANDALONE item — a single study unit with no sub-topics:
{ "title": string, "difficulty": "easy"|"medium"|"hard", "startingState": "Not Started"|"Learned"|"Practicing"|"Reviewing" }

${DIFFICULTY_AND_STATE_GUIDE}

Group titles are organisational headings only — no study sessions are assigned to them.
Sub-topic granularity: one sub-topic = one comfortable study session.
Avoid super-broad leaves (e.g., "Contract Law" as a sub-topic) and trivially narrow ones.`.trim();

  const FREE_TEXT_SCHEMA = `
Return ONLY a valid JSON object — no markdown fences, no commentary.
Extract EVERY piece of planning-relevant information. Include only fields where the text gives clear information.

Fields:
  "maxTopics"              : number   — user wants to cap the total topic count
  "globalStartingState"    : "Not Started"|"Learned"|"Practicing"|"Reviewing"
                             — if the user says they have already studied/practiced everything
  "weakAreas"              : string[] — topics the user struggles with, finds hard, or is bad at
                             → these will have difficulty set to "hard"
  "strongAreas"            : string[] — topics the user is confident in, has mastered, or finds easy
                             → these will have difficulty set to "easy"
  "topicOverrides"         : array of {
                               "pattern"      : string  — topic title or keyword to match (partial OK)
                               "difficulty"   : "easy"|"medium"|"hard"   (optional)
                               "startingState": "Not Started"|"Learned"|"Practicing"|"Reviewing" (optional)
                             }
  "sessionMinutes"         : number — preferred study session length in minutes
  "weekdayMinutesStart"    : number — daily study minutes on weekdays at the START of the plan
  "weekdayMinutesEnd"      : number — daily study minutes on weekdays near the EXAM (cram period)
  "weekendMinutesStart"    : number — daily study minutes on weekends at the START
  "weekendMinutesEnd"      : number — daily study minutes on weekends near the EXAM
  "startDate"              : string — when the user plans to start studying (ISO format YYYY-MM-DD)
  "examDate"               : string — the user's exam date (ISO format YYYY-MM-DD)
  "numMocks"               : number — how many mock exams the user wants
  "mustIncludeTopics"      : string[] — specific topics/areas the user explicitly wants included
                             (regardless of how the AI structures the syllabus)
  "otherNotes"             : string — anything else relevant

IMPORTANT schedule rules:
  — If the user gives a SINGLE intensity for the whole plan (no ramp), set BOTH the Start and End
    fields to the same value (e.g. "I do 1 hour a day" → weekdayMinutesStart:60 AND weekdayMinutesEnd:60).
  — If the user implies a ramp (different start vs. end), set the Start and End fields differently.
  — Convert hours to minutes (1h = 60, 1.5h = 90, etc.).
  — If the user mentions sessions instead of minutes and sessionMinutes is also given, multiply.
    If sessionMinutes is not given, use 20 as a default.
  — Vague intensity words map to approximate minutes:
      "light / easy start"         → ~30 min/day
      "moderate"                   → ~60 min/day
      "heavy / intensive"          → ~120 min/day
      "cram / maximum"             → ~180 min/day

IMPORTANT — TYPOS AND INFORMAL LANGUAGE:
  Users often misspell subject names or use shorthand. Always normalise to the standard
  subject/topic name when extracting (e.g. "derivates" → "Derivatives",
  "fin statement" → "Financial Statement Analysis", "corp fin" → "Corporate Finance").

Interpret these signals broadly. Many phrasings mean the same thing — here are examples:

WEAKNESS signals → weakAreas (difficulty = hard):
  "I struggle with Derivatives"
  "Derivatives is really hard for me"
  "I'm bad at Derivatives / terrible at Derivatives"
  "I find Derivatives very confusing / I can never get Derivatives right"
  "Derivatives trips me up / Derivatives is my weak spot"
  "I always lose marks on Derivatives"
  "I can't wrap my head around Derivatives"
  "Derivatives is where I always go wrong"
  "I have trouble with Derivatives"
  "struggle with derivates"  ← note: normalise typo → "Derivatives"
  All of the above → weakAreas: ["Derivatives"]

STRENGTH signals → strongAreas (difficulty = easy):
  "I'm good at Financial Statement Analysis"
  "I've mastered Financial Statement Analysis"
  "Financial Statement Analysis is easy for me / I find it straightforward"
  "I'm really confident in Financial Statement Analysis"
  "I know Financial Statement Analysis well / I'm comfortable with it"
  "Financial Statement Analysis is my strong suit"
  "I've done a lot of Financial Statement Analysis already"
  All of the above → strongAreas: ["Financial Statement Analysis"]

COMBINED patterns (very common — extract BOTH):
  "I'm really good at Financial Statement Analysis but struggle with Derivatives"
      → strongAreas: ["Financial Statement Analysis"], weakAreas: ["Derivatives"]
  "Ethics is easy for me but Fixed Income and Derivatives are hard"
      → strongAreas: ["Ethics"], weakAreas: ["Fixed Income", "Derivatives"]
  "I know Equity well, but Alternative Investments and Portfolio Management are weak"
      → strongAreas: ["Equity"], weakAreas: ["Alternative Investments", "Portfolio Management"]

PROGRESS signals → topicOverrides:
  "I've already studied / read / covered Z"
      → topicOverrides: [{ pattern: "Z", startingState: "Learned" }]
  "I've finished practicing / done all MCQs for Z"
      → topicOverrides: [{ pattern: "Z", startingState: "Practicing" }]
  "I've reviewed / completed Z"
      → topicOverrides: [{ pattern: "Z", startingState: "Reviewing" }]

SCHEDULE signals:
  "I study in 45-minute blocks / my sessions are 30 minutes"
      → sessionMinutes: 45
  "I want to do 1 hour a day at the beginning and cram at the end"
      → weekdayMinutesStart: 60, weekdayMinutesEnd: 180
  "start light and build up to 2 hours a day"
      → weekdayMinutesStart: 30, weekdayMinutesEnd: 120
  "I can do 1 hour on weekdays but 3 hours on weekends near the exam"
      → weekdayMinutesStart: 60, weekdayMinutesEnd: 60,
         weekendMinutesStart: 60, weekendMinutesEnd: 180

COUNT signals:
  "keep it to about 30 topics" / "limit to 25 sub-topics"
      → maxTopics: 30

DATE signals (convert any date format to YYYY-MM-DD; today's year if year is ambiguous):
  "my exam is on 15 June" / "exam date: June 15" / "sitting the exam on 15/06"
      → examDate: "YYYY-06-15"
  "I want to start studying on 1 March" / "starting March 1st"
      → startDate: "YYYY-03-01"
  "I'm starting next Monday" → infer approximate date from today if possible, else omit

MOCK signals:
  "I want 4 mock exams" / "do 4 mocks" / "schedule 4 practice exams"
      → numMocks: 4
  "just 2 mocks" / "only one mock" / "no mock exams"
      → numMocks: 2 / 1 / 0

MUST-INCLUDE signals → mustIncludeTopics (topics the user explicitly wants in the plan):
  "make sure to cover Composition, HDR, and Preprocessing"
      → mustIncludeTopics: ["Composition", "HDR", "Preprocessing"]
  "include a section on Portfolio Review"
      → mustIncludeTopics: ["Portfolio Review"]
  "I need topics on color grading and exposure"
      → mustIncludeTopics: ["Color Grading", "Exposure"]
  "don't forget Ethics" / "make sure Ethics is in there"
      → mustIncludeTopics: ["Ethics"]
  "I want chapters on Fixed Income and Derivatives"
      → mustIncludeTopics: ["Fixed Income", "Derivatives"]
  "please add Lighting Ratios to the list"
      → mustIncludeTopics: ["Lighting Ratios"]

Example output:
{
  "weakAreas": ["Derivatives", "Fixed Income"],
  "strongAreas": ["Equity Valuation"],
  "topicOverrides": [
    { "pattern": "Time Value of Money", "startingState": "Learned" },
    { "pattern": "Accounting", "difficulty": "hard" }
  ],
  "sessionMinutes": 25,
  "weekdayMinutesStart": 50,
  "weekdayMinutesEnd": 150,
  "weekendMinutesStart": 0,
  "weekendMinutesEnd": 100,
  "maxTopics": 40,
  "startDate": "2026-02-01",
  "examDate": "2026-06-15",
  "numMocks": 4
}`.trim();

  // ─── Mode 1: Exam name only ─────────────────────────────────────────────────

  /**
   * The user provided only an exam name.
   * Generate a hierarchical topic list (subject groups + granular sub-topics).
   * @param {string} examName  e.g. "SQE FLK1", "CFA Level 1"
   * @param {object} freeTextInfo  parsed output from parseFreeText (may be {})
   */
  function topicsFromExamName(examName, freeTextInfo = {}) {
    const maxNote = freeTextInfo.maxTopics
      ? `Limit the total number of sub-topics to at most ${freeTextInfo.maxTopics}.`
      : 'Aim for a complete list; typically 20–60 sub-topics across all groups.';

    const weakNote = (freeTextInfo.weakAreas || []).length
      ? `Mark sub-topics in these areas as "hard": ${freeTextInfo.weakAreas.join(', ')}.`
      : '';

    const strongNote = (freeTextInfo.strongAreas || []).length
      ? `Mark sub-topics in these areas as "easy": ${freeTextInfo.strongAreas.join(', ')}.`
      : '';

    const stateNote = freeTextInfo.globalStartingState && freeTextInfo.globalStartingState !== 'Not Started'
      ? `Set startingState to "${freeTextInfo.globalStartingState}" for ALL sub-topics unless a topicOverride says otherwise.`
      : '';

    const overrideNote = (freeTextInfo.topicOverrides || []).length
      ? `Apply these per-topic overrides where titles match:\n${JSON.stringify(freeTextInfo.topicOverrides, null, 2)}`
      : '';

    const mustIncludeNote = (freeTextInfo.mustIncludeTopics || []).length
      ? `You MUST include the following as topics or sub-topics (do not omit or merge them): ${freeTextInfo.mustIncludeTopics.join(', ')}.`
      : '';

    return {
      system: `You are an expert study planner with deep knowledge of professional and academic exam syllabuses.
Your job is to produce a well-organised, hierarchical topic list for a given exam.
Organise the content into logical subject groups, each containing granular study units as sub-topics.
${HIERARCHY_SCHEMA}`,

      user: [
        `Exam: ${examName}`,
        maxNote,
        mustIncludeNote,
        weakNote,
        strongNote,
        stateNote,
        overrideNote,
      ].filter(Boolean).join('\n'),
    };
  }

  // ─── Mode 2: Granular topic list ────────────────────────────────────────────

  /**
   * The user provided the full topic list already.
   * Only estimate difficulty (and apply any state overrides from free text).
   * @param {string[]} topics  the user's topic titles
   * @param {string}   examName  optional, used for context
   * @param {object}   freeTextInfo
   */
  function topicsFromGranularList(topics, examName = '', freeTextInfo = {}) {
    const examContext = examName ? `Exam context: ${examName}.` : '';

    const weakNote = (freeTextInfo.weakAreas || []).length
      ? `Mark these topics/areas as "hard": ${freeTextInfo.weakAreas.join(', ')}.`
      : '';

    const strongNote = (freeTextInfo.strongAreas || []).length
      ? `Mark these topics/areas as "easy": ${freeTextInfo.strongAreas.join(', ')}.`
      : '';

    const stateNote = freeTextInfo.globalStartingState && freeTextInfo.globalStartingState !== 'Not Started'
      ? `Set startingState to "${freeTextInfo.globalStartingState}" for ALL topics unless a topicOverride says otherwise.`
      : '';

    const overrideNote = (freeTextInfo.topicOverrides || []).length
      ? `Apply these per-topic overrides where titles match:\n${JSON.stringify(freeTextInfo.topicOverrides, null, 2)}`
      : '';

    return {
      system: `You are an expert study planner.
Your job is to assign difficulty ratings and starting states to a user-provided topic list.
Preserve the exact topic titles given — do not rename, split, or merge them.
${TOPIC_SCHEMA}`,

      user: [
        examContext,
        'Assign difficulty and startingState for each topic, preserving the original title exactly:',
        topics.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        weakNote,
        strongNote,
        stateNote,
        overrideNote,
      ].filter(Boolean).join('\n'),
    };
  }

  // ─── Free-text extraction ───────────────────────────────────────────────────

  /**
   * Extract structured planning information from the user's free-text notes.
   * @param {string} freeText  the raw notes entered by the user
   */
  function parseFreeText(freeText) {
    return {
      system: `You are a study planning assistant.
Extract structured planning information from the user's free-text notes.
${FREE_TEXT_SCHEMA}`,

      user: freeText.trim(),
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  return {
    topicsFromExamName,
    topicsFromGranularList,
    parseFreeText,
  };
}));
