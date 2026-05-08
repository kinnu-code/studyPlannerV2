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
Fields (all optional; omit fields where the text gives no relevant information):
  "maxTopics"         : number  — if the user wants to cap the topic count
  "globalStartingState": "Not Started" | "Learned" | "Practicing" | "Reviewing"
                        — if the user says they have already studied everything
  "topicOverrides"    : array of {
                          "pattern"      : string  — topic title or keyword to match
                          "difficulty"   : "easy" | "medium" | "hard"   (optional)
                          "startingState": "Not Started"|"Learned"|"Practicing"|"Reviewing" (optional)
                        }
  "focusAreas"        : string[]  — topics or areas the user wants extra emphasis on
  "weakAreas"         : string[]  — topics the user says they struggle with (bump to hard)
  "otherNotes"        : string    — anything else relevant to planning

Example output:
{
  "maxTopics": 30,
  "weakAreas": ["Consideration", "Land Law"],
  "topicOverrides": [
    { "pattern": "Contract Formation", "startingState": "Learned" }
  ]
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
      ? `Mark sub-topics in these areas as "hard" unless inherently simple: ${freeTextInfo.weakAreas.join(', ')}.`
      : '';

    const stateNote = freeTextInfo.globalStartingState && freeTextInfo.globalStartingState !== 'Not Started'
      ? `Set startingState to "${freeTextInfo.globalStartingState}" for ALL sub-topics unless a topicOverride says otherwise.`
      : '';

    const overrideNote = (freeTextInfo.topicOverrides || []).length
      ? `Apply these per-topic overrides where titles match:\n${JSON.stringify(freeTextInfo.topicOverrides, null, 2)}`
      : '';

    return {
      system: `You are an expert study planner with deep knowledge of professional and academic exam syllabuses.
Your job is to produce a well-organised, hierarchical topic list for a given exam.
Organise the content into logical subject groups, each containing granular study units as sub-topics.
${HIERARCHY_SCHEMA}`,

      user: [
        `Exam: ${examName}`,
        maxNote,
        weakNote,
        stateNote,
        overrideNote,
      ].filter(Boolean).join('\n'),
    };
  }

  // ─── Mode 2: User provides top-level areas, AI generates sub-topics ──────────

  /**
   * The user provided the top-level subject areas.
   * AI generates granular study units as sub-topics under each.
   * @param {string}   examName
   * @param {string[]} broadTopics  e.g. ["Contract Law", "Tort", "Land Law"]
   * @param {object}   freeTextInfo
   */
  function topicsFromBroadList(examName, broadTopics, freeTextInfo = {}) {
    const maxNote = freeTextInfo.maxTopics
      ? `Keep the total number of sub-topics to at most ${freeTextInfo.maxTopics}.`
      : '';

    const weakNote = (freeTextInfo.weakAreas || []).length
      ? `Mark sub-topics in these areas as "hard": ${freeTextInfo.weakAreas.join(', ')}.`
      : '';

    const stateNote = freeTextInfo.globalStartingState && freeTextInfo.globalStartingState !== 'Not Started'
      ? `Set startingState to "${freeTextInfo.globalStartingState}" for ALL sub-topics unless a topicOverride says otherwise.`
      : '';

    const overrideNote = (freeTextInfo.topicOverrides || []).length
      ? `Apply these per-topic overrides where titles match:\n${JSON.stringify(freeTextInfo.topicOverrides, null, 2)}`
      : '';

    return {
      system: `You are an expert study planner with deep knowledge of professional and academic exam syllabuses.
The user has provided their top-level subject areas. Your job is to generate granular study units as sub-topics for each.
Each broad topic becomes a GROUP in the output, with its study units listed as subTopics.
Use the exact titles given for the GROUP items; do not rename, merge, or split them.
${HIERARCHY_SCHEMA}`,

      user: [
        examName ? `Exam: ${examName}` : '',
        `For each of the following subject areas, generate granular study units as sub-topics:`,
        broadTopics.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        maxNote,
        weakNote,
        stateNote,
        overrideNote,
      ].filter(Boolean).join('\n'),
    };
  }

  // ─── Mode 3: Granular topic list ────────────────────────────────────────────

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
    topicsFromBroadList,
    topicsFromGranularList,
    parseFreeText,
  };
}));
