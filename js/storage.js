/**
 * storage.js — localStorage persistence, CSV export, and JSON import/export.
 * Exposed as window.StudyStorage in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.StudyStorage = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LS_KEY_SETTINGS = 'studyPlanner_settings';
  const LS_KEY_PLAN     = 'studyPlanner_currentPlan';

  // ─── Settings ───────────────────────────────────────────────────────────────

  const DEFAULT_SETTINGS = {
    apiKey:                  '',
    model:                   'gpt-4o',
    sessionDuration:         20,     // minutes (display only)
    learningMode:            'interleaved', // 'interleaved' | 'sequential'
    maxNewTopicsPerDay:      4,
    postMockSameDay:         true,   // false = post-mock occupies next study day
    maxDaysBetweenPractice:  7,      // max gap (days) between learn→practice and practice→practice
    lnTable:     { easy: 1, medium: 2, hard: 3 },
    pnTable:     { easy: 3, medium: 4, hard: 5 },
    srIntervals: [1, 6, 16, 45, 131],
    numMocks:    3,
  };

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY_SETTINGS);
      if (!raw) return cloneDefaults();
      // Deep merge: start from fresh clone so nested objects aren't shared
      const defaults = cloneDefaults();
      const stored   = JSON.parse(raw);
      return Object.assign(defaults, stored, {
        lnTable: Object.assign(defaults.lnTable, stored.lnTable || {}),
        pnTable: Object.assign(defaults.pnTable, stored.pnTable || {}),
        srIntervals: Array.isArray(stored.srIntervals) ? stored.srIntervals : defaults.srIntervals,
      });
    } catch (_) {
      return cloneDefaults();
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(LS_KEY_SETTINGS, JSON.stringify(settings));
  }

  // ─── Current plan ───────────────────────────────────────────────────────────

  function loadCurrentPlan() {
    try {
      const raw = localStorage.getItem(LS_KEY_PLAN);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function saveCurrentPlan(planData) {
    localStorage.setItem(LS_KEY_PLAN, JSON.stringify(planData));
  }

  function clearCurrentPlan() {
    localStorage.removeItem(LS_KEY_PLAN);
  }

  // ─── JSON export / import ───────────────────────────────────────────────────

  /**
   * Download the full plan as a JSON file the user can reload later.
   * planData should be the complete app state (config + results + completionStatus).
   */
  function exportJSON(planData, filename = 'study-plan.json') {
    const blob = new Blob([JSON.stringify(planData, null, 2)], { type: 'application/json' });
    _download(blob, filename);
  }

  /**
   * Let the user pick a JSON file to load. Returns a Promise resolving to the parsed object.
   */
  function importJSON() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type  = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => {
        const file = input.files[0];
        if (!file) return reject(new Error('No file selected'));
        const reader = new FileReader();
        reader.onload = e => {
          try { resolve(JSON.parse(e.target.result)); }
          catch (err) { reject(new Error('Invalid JSON file: ' + err.message)); }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsText(file);
      };
      input.click();
    });
  }

  // ─── CSV helpers ────────────────────────────────────────────────────────────

  function csvEscape(val) {
    const s = String(val ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function rowsToCsv(rows) {
    return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  }

  // ─── Day-by-day CSV ─────────────────────────────────────────────────────────

  /**
   * Export the day-by-day plan as CSV.
   *
   * calendar is the array from generatePlan().calendar
   * completionStatus is a map: { [sessionKey]: boolean }
   * sessionKey = `${dateKey}|${topicTitle}|${activityType}|${sessionIndex}`
   */
  function exportDayByDayCsv(calendar, completionStatus = {}, sessionDuration = 20) {
    const header = ['Date', 'Session #', 'Topic', 'Activity', 'Sessions', 'Est. Time', 'Reason', 'Completed'];
    const rows   = [header];
    let sessionCounter = 0;

    for (const day of calendar) {
      if (!day.sessions || day.sessions.length === 0) continue;

      // Merge consecutive identical topic+activity blocks
      const merged = mergeSessions(day.sessions);

      for (const block of merged) {
        sessionCounter++;
        const estTime = block.activityType === 'mock'
          ? '90 min'
          : block.activityType === 'postMock'
            ? 'Full day'
            : `${block.count * sessionDuration} min`;

        const key = sessionKey(day.date, block, sessionCounter);
        const done = completionStatus[key] ? 'Yes' : '';

        rows.push([
          day.date.toISOString().slice(0, 10),
          sessionCounter,
          block.topicTitle || (block.activityType === 'mock' ? 'Mock Exam' : 'Post-Mock Revision'),
          activityLabel(block.activityType),
          block.count,
          estTime,
          block.reason || '',
          done,
        ]);
      }
    }

    _download(new Blob([rowsToCsv(rows)], { type: 'text/csv' }), 'study-plan-daily.csv');
  }

  // ─── Topic-by-topic CSV ─────────────────────────────────────────────────────

  /**
   * Export the topic-by-topic summary as CSV.
   * topicSummaries = array of { title, activities: [{date, activityType, count, reason}] }
   */
  function exportTopicCsv(topicSummaries, sessionDuration = 20) {
    const header = ['Topic', 'Activity', 'Date', 'Sessions', 'Est. Time', 'Reason', 'Learn Done', 'Practice Done', 'Review Done'];
    const rows   = [header];

    for (const topic of topicSummaries) {
      for (const act of topic.activities) {
        const estTime = act.activityType === 'mock'     ? '90 min'
          :             act.activityType === 'postMock' ? 'Full day'
          :             `${act.count * sessionDuration} min`;

        rows.push([
          topic.title,
          activityLabel(act.activityType),
          act.date instanceof Date ? act.date.toISOString().slice(0, 10) : act.date,
          act.count,
          estTime,
          act.reason || '',
          act.activityType === 'learn'    ? '' : '',  // tick columns left blank for printing
          act.activityType === 'practice' ? '' : '',
          act.activityType === 'review'   ? '' : '',
        ]);
      }
    }

    _download(new Blob([rowsToCsv(rows)], { type: 'text/csv' }), 'study-plan-topics.csv');
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────

  function mergeSessions(sessions) {
    if (!sessions.length) return [];
    const out = [];
    let cur = { ...sessions[0], count: 1 };
    for (let i = 1; i < sessions.length; i++) {
      const s = sessions[i];
      if (s.topicTitle === cur.topicTitle && s.activityType === cur.activityType) {
        cur.count++;
      } else {
        out.push(cur);
        cur = { ...s, count: 1 };
      }
    }
    out.push(cur);
    return out;
  }

  function activityLabel(type) {
    return {
      learn:    'Learning',
      practice: 'Practice MCQs',
      review:   'Review',
      mock:     'Mock Exam',
      postMock: 'Post-Mock Revision',
    }[type] || type;
  }

  function sessionKey(date, block, idx) {
    const d = date instanceof Date ? date.toISOString().slice(0, 10) : date;
    return `${d}|${block.topicTitle || ''}|${block.activityType}|${idx}`;
  }

  function _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href    = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  return {
    DEFAULT_SETTINGS,
    loadSettings,
    saveSettings,
    loadCurrentPlan,
    saveCurrentPlan,
    clearCurrentPlan,
    exportJSON,
    importJSON,
    exportDayByDayCsv,
    exportTopicCsv,
    mergeSessions,
    activityLabel,
  };
}));
