/**
 * api.js — OpenAI API wrapper for the Smart Study Planner.
 *
 * Uses fetch (no external SDK). Exposed as window.StudyApi in the browser.
 * All functions are async and throw on API or parse errors.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.StudyApi = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

  // ─── Core fetch helper ──────────────────────────────────────────────────────

  async function callOpenAI({ apiKey, model, messages, temperature = 0.2 }) {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature }),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch (_) {}
      throw new Error(`OpenAI API error ${res.status}${detail ? ': ' + detail : ''}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');
    return content.trim();
  }

  // ─── JSON parse helper ──────────────────────────────────────────────────────
  // Handles clean JSON, markdown-fenced JSON, and JSON embedded in prose
  // (preamble/postamble that models sometimes add despite instructions).

  function parseJSON(raw) {
    // 1. Strip ```json … ``` or ``` … ``` fences
    let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    // 2. Try direct parse (covers the vast majority of clean responses)
    try { return JSON.parse(s); } catch (_) {}

    // 3. Extract first complete JSON array or object via bracket-matching.
    //    This handles models that prepend/append explanatory prose.
    const arrayStart  = s.indexOf('[');
    const objectStart = s.indexOf('{');

    let start = -1;
    let isArray = false;
    if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
      start = arrayStart; isArray = true;
    } else if (objectStart !== -1) {
      start = objectStart; isArray = false;
    }

    if (start !== -1) {
      const open = isArray ? '[' : '{';
      const close = isArray ? ']' : '}';
      let depth = 0, inStr = false, escape = false, end = -1;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (escape)            { escape = false; continue; }
        if (ch === '\\' && inStr) { escape = true;  continue; }
        if (ch === '"')        { inStr = !inStr;   continue; }
        if (inStr)             continue;
        if (ch === open)       depth++;
        if (ch === close)      { if (--depth === 0) { end = i; break; } }
      }
      if (end !== -1) {
        try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
      }
    }

    throw new Error(`Failed to parse AI response as JSON.\n\nRaw response:\n${raw}`);
  }

  // ─── parseFreeText ──────────────────────────────────────────────────────────

  /**
   * Extract structured planning info from the user's free-text notes.
   * Returns an object (may be empty {}) — never throws on empty input.
   *
   * @param {string} freeText
   * @param {string} apiKey
   * @param {string} model
   * @returns {Promise<object>}
   */
  async function parseFreeText(freeText, apiKey, model) {
    if (!freeText || !freeText.trim()) return {};

    const prompts = _getPrompts();
    const { system, user } = prompts.parseFreeText(freeText);

    const raw = await callOpenAI({
      apiKey,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    });

    return parseJSON(raw);
  }

  // ─── generateTopics ─────────────────────────────────────────────────────────

  /**
   * Generate a topic list using one of three input modes.
   *
   * @param {object} opts
   * @param {'examName'|'broadList'|'granularList'} opts.mode
   * @param {string}   opts.examName      mode=examName or broadList
   * @param {string[]} opts.broadTopics   mode=broadList
   * @param {string[]} opts.granularTopics mode=granularList
   * @param {string}   opts.freeText      raw user notes (parsed internally)
   * @param {string}   opts.apiKey
   * @param {string}   opts.model
   * @returns {Promise<Array<{title:string, difficulty:string, startingState:string}>>}
   */
  async function generateTopics({ mode, examName = '', broadTopics = [], granularTopics = [], freeText = '', apiKey, model }) {
    const prompts = _getPrompts();

    // Parse free text first so topic generation can use the structured result
    const freeTextInfo = await parseFreeText(freeText, apiKey, model);

    let promptPair;
    if (mode === 'examName') {
      promptPair = prompts.topicsFromExamName(examName, freeTextInfo);
    } else if (mode === 'broadList') {
      promptPair = prompts.topicsFromBroadList(examName, broadTopics, freeTextInfo);
    } else if (mode === 'granularList') {
      promptPair = prompts.topicsFromGranularList(granularTopics, examName, freeTextInfo);
    } else {
      throw new Error(`Unknown topic input mode: ${mode}`);
    }

    const raw = await callOpenAI({
      apiKey,
      model,
      messages: [
        { role: 'system', content: promptPair.system },
        { role: 'user',   content: promptPair.user   },
      ],
    });

    const topics = parseJSON(raw);

    if (!Array.isArray(topics)) {
      throw new Error('AI response was not a JSON array of topics');
    }

    // Normalise and validate each entry
    return topics.map((t, i) => {
      if (!t.title || typeof t.title !== 'string') {
        throw new Error(`Topic ${i + 1} is missing a "title" field`);
      }
      const difficulty    = normaliseEnum(t.difficulty,    ['easy','medium','hard'],             'medium');
      const startingState = normaliseEnum(t.startingState, ['Not Started','Learned','Practicing','Reviewing'], 'Not Started');
      return { title: t.title.trim(), difficulty, startingState };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function normaliseEnum(value, allowed, fallback) {
    if (!value) return fallback;
    const lower = String(value).toLowerCase();
    const match = allowed.find(a => a.toLowerCase() === lower);
    return match || fallback;
  }

  function _getPrompts() {
    // Browser: window.StudyPrompts; Node.js tests: require('../prompts')
    if (typeof StudyPrompts !== 'undefined') return StudyPrompts;
    if (typeof require === 'function') return require('../prompts');
    throw new Error('StudyPrompts not loaded');
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  return {
    generateTopics,
    parseFreeText,
  };
}));
