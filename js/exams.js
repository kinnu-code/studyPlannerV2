/**
 * exams.js — Predefined exam data loader.
 *
 * Reads exam JSON files from data/exams/.
 * Add new exams by dropping a <id>.json file in that folder and adding an
 * entry to data/exams/index.json — no code changes required.
 *
 * Exposed as window.StudyExams in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.StudyExams = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BASE = 'data/exams';

  async function loadIndex() {
    const res = await fetch(`${BASE}/index.json`);
    if (!res.ok) throw new Error(`Failed to load exam index (${res.status})`);
    return res.json();
  }

  async function loadExam(examId) {
    const res = await fetch(`${BASE}/${examId}.json`);
    if (!res.ok) throw new Error(`Failed to load exam "${examId}" (${res.status})`);
    return res.json();
  }

  return { loadIndex, loadExam };
}));
