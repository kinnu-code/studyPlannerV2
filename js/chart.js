/**
 * chart.js — Canvas-based visual trajectory chart.
 *
 * Colour-blind-friendly palette. Legend is rendered as HTML outside the canvas
 * (see Vue template); the canvas only renders rows, date headers, and mock markers.
 *
 * Exposed as window.StudyChart in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.StudyChart = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ─── Colour palette (colour-blind friendly) ─────────────────────────────────
  // States: Not Started | Learning | Ready to Practice | Practicing |
  //         Practice Completed | Reviewing | Mock | PostMock

  const STATE_COLORS = {
    'Not Started':        { h: 0,   s: 0,   l: 91  },  // light grey
    'Learning':           { h: 214, s: 72,  l: 52  },  // blue
    'Ready to Practice':  { h: 180, s: 50,  l: 48  },  // teal/cyan
    'Practicing':         { h: 38,  s: 90,  l: 50  },  // amber  (saturation varies with n/PN)
    'Practice Completed': { h: 145, s: 22,  l: 72  },  // soft/pastel green  (passive baseline)
    'Reviewing':          { h: 145, s: 65,  l: 40  },  // rich green  (active review day)
    'Mock':               { h: 272, s: 60,  l: 45  },  // purple
    'PostMock':           { h: 272, s: 30,  l: 75  },  // light purple
  };

  function hsl(h, s, l) {
    return `hsl(${h},${s}%,${l}%)`;
  }

  /**
   * Return the CSS colour for a given state/progress combination.
   * progress ∈ [0,1]: used for variable saturation on Practicing and Reviewing.
   */
  function stateColor(state, progress) {
    const c = STATE_COLORS[state];
    if (!c) return '#e5e7eb';
    if (state === 'Practicing') {
      // Saturation scales from ~20% (first session) to 90% (all PN done)
      const sat = Math.round(20 + 70 * Math.max(0.15, progress == null ? 1 : progress));
      return hsl(c.h, sat, c.l);
    }
    if (state === 'Reviewing') {
      // Saturation scales from ~30% (first review) to full (later reviews)
      const sat = Math.round(30 + 35 * Math.max(0.2, progress == null ? 1 : progress));
      return hsl(c.h, sat, c.l);
    }
    return hsl(c.h, c.s, c.l);
  }

  // ─── Legend items (consumed by Vue for HTML legend) ─────────────────────────

  const LEGEND_ITEMS = [
    { label: 'Not Started',           state: 'Not Started',        progress: 0   },
    { label: 'Learning',              state: 'Learning',           progress: 1   },
    { label: 'Ready to Practice',     state: 'Ready to Practice',  progress: 1   },
    { label: 'Practicing (early)',    state: 'Practicing',         progress: 0.2 },
    { label: 'Practicing (complete)', state: 'Practicing',         progress: 1.0 },
    { label: 'Practice Completed',    state: 'Practice Completed', progress: 1   },
    { label: 'Review session',        state: 'Reviewing',          progress: 0.8 },
    { label: 'Mock Exam',             state: 'Mock',               progress: 1   },
    { label: 'Post-Mock Revision',    state: 'PostMock',           progress: 1   },
  ];

  // ─── Build per-topic, per-date state map ─────────────────────────────────────

  /**
   * @param {object[]} topics      [{ title, totalPN, startingState }]
   * @param {object[]} calendar    hydratedCalendar from UI
   * @param {object[]} mockEvents  from generatePlan()
   * @returns {object[]}  [{ title, states: Map<dateKey, {state, progress}> }]
   */
  function buildStateMap(topics, calendar, mockEvents) {
    const byId = {};
    topics.forEach(t => {
      byId[t.id] = { id: t.id, title: t.title, totalPN: t.totalPN || 4, states: new Map() };
    });

    // Index mock dates
    const mockDates     = new Set();
    const postMockDates = new Set();
    for (const ev of (mockEvents || [])) {
      const dk = ev.date instanceof Date ? ev.date.toISOString().slice(0, 10) : ev.date;
      if (ev.type === 'mock')     mockDates.add(dk);
      if (ev.type === 'postMock') postMockDates.add(dk);
    }

    // Initialise per-topic progress counters from starting state
    const progress = {};
    topics.forEach(t => {
      const ss = t.startingState || 'Not Started';
      progress[t.id] = {
        mcqDone:     ss === 'Reviewing'  ? (t.totalPN || 4) :
                     ss === 'Practicing' ? 1 : 0,
        reviewsDone: 0,
        wasLearning: ss !== 'Not Started',   // any non-fresh start = learning already done
      };
    });

    // Walk calendar day by day, topic by topic
    for (const day of calendar) {
      const dk       = day.date instanceof Date ? day.date.toISOString().slice(0, 10) : day.date;
      const sessions = day.sessions || [];

      for (const topic of topics) {
        const snap = byId[topic.id];
        if (!snap) continue;
        const prog = progress[topic.id];

        const hasLearn    = sessions.some(s => s.topicId === topic.id && s.activityType === 'learn');
        const hasPractice = sessions.some(s => s.topicId === topic.id && s.activityType === 'practice');
        const hasReview   = sessions.some(s => s.topicId === topic.id && s.activityType === 'review');

        if (hasLearn)    prog.wasLearning = true;
        if (hasPractice) prog.mcqDone++;
        if (hasReview)   prog.reviewsDone++;

        // Determine state in priority order
        let state;
        if (mockDates.has(dk))          { state = 'Mock'; }
        else if (postMockDates.has(dk)) { state = 'PostMock'; }
        else if (hasReview)             { state = 'Reviewing'; }
        else if (hasPractice)           { state = 'Practicing'; }
        else if (hasLearn)              { state = 'Learning'; }
        else if (prog.mcqDone >= snap.totalPN && prog.mcqDone > 0) {
          // All PN done — passive baseline between review sessions
          state = 'Practice Completed';
        } else if (prog.wasLearning) {
          // Learning done, some or no practice done — ready for next session
          state = 'Ready to Practice';
        } else {
          state = 'Not Started';
        }

        const pct = state === 'Practicing'
          ? prog.mcqDone / snap.totalPN
          : state === 'Reviewing'
            ? Math.min(1, prog.reviewsDone / 5)
            : 1;

        snap.states.set(dk, { state, progress: pct });
      }
    }

    return Object.values(byId);
  }

  // ─── Main draw function ─────────────────────────────────────────────────────

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object[]}  topics      [{ title, totalPN, startingState }]
   * @param {object[]}  calendar    hydratedCalendar
   * @param {object[]}  mockEvents
   * @param {object}    opts        { rowH, labelW, cellW, fontSize }
   */
  function draw(canvas, topics, calendar, mockEvents, opts = {}) {
    const ROW_H    = opts.rowH    || 28;
    const LABEL_W  = opts.labelW  || 180;
    const CELL_W   = opts.cellW   || 8;
    const FONT_SZ  = opts.fontSize || 11;
    const HEADER_H = 32;   // space for month labels at top

    const stateMap = buildStateMap(topics, calendar, mockEvents);

    const dateKeys = calendar.map(d =>
      d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date
    );

    const totalW = LABEL_W + dateKeys.length * CELL_W;
    const totalH = HEADER_H + stateMap.length * ROW_H + 4;

    canvas.width  = totalW;
    canvas.height = totalH;
    canvas.style.width  = totalW  + 'px';
    canvas.style.height = totalH  + 'px';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, totalW, totalH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);

    // ── Date header (month labels) ──────────────────────────────────────────
    ctx.font      = `${FONT_SZ}px system-ui, sans-serif`;
    ctx.fillStyle = '#374151';
    ctx.textBaseline = 'middle';
    let lastMonth = '';
    dateKeys.forEach((dk, i) => {
      const month = dk.slice(0, 7);
      if (month !== lastMonth) {
        lastMonth = month;
        const label = new Date(dk + 'T00:00:00Z')
          .toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
        ctx.fillText(label, LABEL_W + i * CELL_W + 2, HEADER_H / 2);
      }
    });

    // ── Rows ────────────────────────────────────────────────────────────────
    stateMap.forEach((topicSnap, rowIdx) => {
      const y = HEADER_H + rowIdx * ROW_H;

      // Zebra stripe
      ctx.fillStyle = rowIdx % 2 === 0 ? '#f9fafb' : '#ffffff';
      ctx.fillRect(0, y, totalW, ROW_H);

      // Topic label
      ctx.fillStyle    = '#111827';
      ctx.font         = `${FONT_SZ}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(topicSnap.title, LABEL_W - 8, ctx), 4, y + ROW_H / 2);

      // Colour cells
      dateKeys.forEach((dk, colIdx) => {
        const snap    = topicSnap.states.get(dk) || { state: 'Not Started', progress: 0 };
        ctx.fillStyle = stateColor(snap.state, snap.progress);
        ctx.fillRect(LABEL_W + colIdx * CELL_W, y + 2, CELL_W - 1, ROW_H - 4);
      });
    });

    // ── Mock exam vertical markers ──────────────────────────────────────────
    const mockDateKeys = (mockEvents || [])
      .filter(e => e.type === 'mock')
      .map(e => e.date instanceof Date ? e.date.toISOString().slice(0, 10) : e.date);

    mockDateKeys.forEach(dk => {
      const colIdx = dateKeys.indexOf(dk);
      if (colIdx < 0) return;
      const x = LABEL_W + colIdx * CELL_W;
      ctx.strokeStyle = '#7c3aed';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(x, HEADER_H);
      ctx.lineTo(x, HEADER_H + stateMap.length * ROW_H);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // ── Row grid lines ──────────────────────────────────────────────────────
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth   = 0.5;
    stateMap.forEach((_, rowIdx) => {
      const y = HEADER_H + rowIdx * ROW_H;
      ctx.beginPath();
      ctx.moveTo(LABEL_W, y);
      ctx.lineTo(totalW, y);
      ctx.stroke();
    });
  }

  // ─── Tooltip hit-test ───────────────────────────────────────────────────────

  function hitTest(evt, canvas, stateMap, dateKeys, opts = {}) {
    const ROW_H   = opts.rowH   || 28;
    const LABEL_W = opts.labelW || 180;
    const CELL_W  = opts.cellW  || 8;
    const HEADER_H = 32;

    const rect = canvas.getBoundingClientRect();
    const mx   = evt.clientX - rect.left;
    const my   = evt.clientY - rect.top;

    if (mx < LABEL_W || my < HEADER_H) return null;

    const colIdx = Math.floor((mx - LABEL_W) / CELL_W);
    const rowIdx = Math.floor((my - HEADER_H) / ROW_H);

    if (rowIdx < 0 || rowIdx >= stateMap.length)  return null;
    if (colIdx < 0 || colIdx >= dateKeys.length)  return null;

    const snap = stateMap[rowIdx].states.get(dateKeys[colIdx]);
    if (!snap) return null;

    return { topic: stateMap[rowIdx].title, date: dateKeys[colIdx], state: snap.state };
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────

  function truncate(text, maxWidth, ctx) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxWidth) {
      text = text.slice(0, -1);
    }
    return text + '…';
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  return { draw, buildStateMap, hitTest, stateColor, STATE_COLORS, LEGEND_ITEMS };
}));
