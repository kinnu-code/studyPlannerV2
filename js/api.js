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
   * @param {'examName'|'granularList'} opts.mode
   * @param {string}   opts.examName       mode=examName
   * @param {string[]} opts.granularTopics mode=granularList
   * @param {string}   opts.freeText       raw user notes (parsed internally)
   * @param {string}   opts.apiKey
   * @param {string}   opts.model
   * @returns {Promise<Array<{title:string, difficulty:string, startingState:string}>>}
   */
  async function generateTopics({ mode, examName = '', granularTopics = [], freeText = '', freeTextInfo: prebuiltInfo = null, apiKey, model }) {
    const prompts = _getPrompts();

    // Use caller-supplied parsed info if available; otherwise parse raw freeText now.
    const freeTextInfo = prebuiltInfo || await parseFreeText(freeText, apiKey, model);

    let promptPair;
    if (mode === 'examName') {
      promptPair = prompts.topicsFromExamName(examName, freeTextInfo);
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

    const parsed = parseJSON(raw);

    if (!Array.isArray(parsed)) {
      throw new Error('AI response was not a JSON array of topics');
    }

    // Mode 1: AI returns a hierarchical structure → flatten to { title, isGroup, parentTitle, difficulty, startingState }
    if (mode === 'examName') {
      return flattenHierarchical(parsed);
    }

    // Mode 3: AI returns a flat list (leaf topics only); user hierarchy parsed separately in ui.js
    return parsed.map((t, i) => {
      if (!t.title || typeof t.title !== 'string') {
        throw new Error(`Topic ${i + 1} is missing a "title" field`);
      }
      const difficulty    = normaliseEnum(t.difficulty,    ['easy','medium','hard'],                              'medium');
      const startingState = normaliseEnum(t.startingState, ['Not Started','Learned','Practicing','Reviewing'], 'Not Started');
      return { title: t.title.trim(), difficulty, startingState };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Flatten a hierarchical AI response (modes 1 & 2) into a flat array.
   * Each item gets: { title, isGroup, parentTitle, difficulty, startingState }
   * Groups have isGroup=true, difficulty=null, startingState=null.
   */
  function flattenHierarchical(hierarchical) {
    const result = [];
    for (const item of hierarchical) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.subTopics) && item.subTopics.length > 0) {
        const parentTitle = (item.title || '').trim();
        result.push({ title: parentTitle, isGroup: true, parentTitle: null, difficulty: null, startingState: null });
        for (const sub of item.subTopics) {
          if (!sub || !sub.title || typeof sub.title !== 'string') continue;
          result.push({
            title:         sub.title.trim(),
            isGroup:       false,
            parentTitle,
            difficulty:    normaliseEnum(sub.difficulty,    ['easy','medium','hard'],                              'medium'),
            startingState: normaliseEnum(sub.startingState, ['Not Started','Learned','Practicing','Reviewing'], 'Not Started'),
          });
        }
      } else {
        if (!item.title || typeof item.title !== 'string') continue;
        result.push({
          title:         item.title.trim(),
          isGroup:       false,
          parentTitle:   null,
          difficulty:    normaliseEnum(item.difficulty,    ['easy','medium','hard'],                              'medium'),
          startingState: normaliseEnum(item.startingState, ['Not Started','Learned','Practicing','Reviewing'], 'Not Started'),
        });
      }
    }
    return result;
  }

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
    flattenHierarchical,
  };
}));
