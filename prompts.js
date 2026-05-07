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

  // ─── Shared JSON schema description ────────────────────────────────────────

  const TOPIC_SCHEMA = `
Return ONLY a valid JSON array — no markdown fences, no commentary.
Each element must have exactly these fields:
  "title"        : string  — concise topic name (≤ 10 words)
  "difficulty"   : "easy" | "medium" | "hard"
  "startingState": "Not Started" | "Learned" | "Practicing" | "Reviewing"

Difficulty guide:
  easy   — single concept, few flashcards / MCQs (LN=1, PN=3 sessions needed)
  medium — moderate depth, typical topic      (LN=2, PN=4 sessions needed)
  hard   — broad topic, many sub-concepts     (LN=3, PN=5 sessions needed)

Starting state guide (default to "Not Started" unless user notes say otherwise):
  Not Started — topic not yet touched; full learn → practice → review pipeline
  Learned     — content already studied; skip learning; begin at Practice MCQs
  Practicing  — one practice MCQ session already done; PN−1 sessions remaining
  Reviewing   — all practice MCQs done; begin immediately at first Review session

Aim for genuinely granular topics — a study session covers one topic comfortably.
Avoid super-broad entries (e.g., "Contract Law") and avoid trivially narrow ones
(e.g., "Definition of offer"). Granularity similar to a single lecture or chapter.`.trim();

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
   * The user provided only an exam name. Generate a full granular topic list.
   * @param {string} examName  e.g. "SQE FLK1", "CFA Level 1"
   * @param {object} freeTextInfo  parsed output from parseFreeText (may be {})
   */
  function topicsFromExamName(examName, freeTextInfo = {}) {
    const maxNote = freeTextInfo.maxTopics
      ? `Limit the list to at most ${freeTextInfo.maxTopics} topics.`
      : 'Aim for a complete list; typically 20–60 topics depending on the exam breadth.';

    const weakNote = (freeTextInfo.weakAreas || []).length
      ? `Mark these topics as "hard" unless they are inherently simple: ${freeTextInfo.weakAreas.join(', ')}.`
      : '';

    const stateNote = freeTextInfo.globalStartingState && freeTextInfo.globalStartingState !== 'Not Started'
      ? `Set startingState to "${freeTextInfo.globalStartingState}" for ALL topics unless a topicOverride says otherwise.`
      : '';

    const overrideNote = (freeTextInfo.topicOverrides || []).length
      ? `Apply these per-topic overrides where titles match:\n${JSON.stringify(freeTextInfo.topicOverrides, null, 2)}`
      : '';

    return {
      system: `You are an expert study planner with deep knowledge of professional and academic exam syllabuses.
Your job is to produce a granular, well-calibrated topic list for a given exam.
${TOPIC_SCHEMA}`,

      user: [
        `Exam: ${examName}`,
        maxNote,
        weakNote,
        stateNote,
        overrideNote,
      ].filter(Boolean).join('\n'),
    };
  }

  // ─── Mode 2: High-level topics ──────────────────────────────────────────────

  /**
   * The user provided an exam name and broad topic headings.
   * Expand each into granular sub-topics.
   * @param {string}   examName
   * @param {string[]} broadTopics  e.g. ["Contract Law", "Tort", "Land Law"]
   * @param {object}   freeTextInfo
   */
  function topicsFromBroadList(examName, broadTopics, freeTextInfo = {}) {
    const maxNote = freeTextInfo.maxTopics
      ? `Keep the total list to at most ${freeTextInfo.maxTopics} topics.`
      : '';

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
      system: `You are an expert study planner with deep knowledge of professional and academic exam syllabuses.
Your job is to expand broad topic headings into granular, well-calibrated sub-topics for a given exam.
${TOPIC_SCHEMA}`,

      user: [
        `Exam: ${examName}`,
        `Expand each of these broad topics into granular sub-topics:`,
        broadTopics.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        'Follow the order of the broad topics; group sub-topics under their parent heading by listing them consecutively.',
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
