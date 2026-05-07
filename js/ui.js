'use strict';
/* global Vue, StudyPlanner, StudyApi, StudyStorage, StudyChart, StudyPrompts */

const DOW_LABELS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

const RECENT_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
];

// ─── Reason generator ─────────────────────────────────────────────────────────

function sessionReason(session, allSessions, topicFinalState) {
  const t = session.topicTitle || '';
  switch (session.activityType) {
    case 'learn':
      return session.isFirstSession ? `First learning session for ${t}` : `Continuing learning for ${t}`;
    case 'practice': {
      const done = (topicFinalState?.mcqSessionsDone || 0) - (session._mcqNum || 0);
      const total = topicFinalState?.totalPN || '?';
      const num = session._mcqNum || '?';
      return `Practice MCQ session ${num} of ${total} for ${t}`;
    }
    case 'review':
      return `Spaced review of ${t}`;
    case 'mock':
      return `Full mock exam ${session.mockNumber || ''}`.trim();
    case 'postMock':
      return `Post-mock revision ${session.mockNumber || ''}`.trim();
    default:
      return '';
  }
}

// ─── Hydrate calendar: add topicTitle and reason to each session ──────────────

function hydrateCalendar(calendar, planTopics, mocks) {
  const topicMap = {};
  const stateMap = {};
  planTopics.forEach(t => {
    topicMap[t.id] = t.name;
    stateMap[t.id] = t;
  });

  const mockDateMap = {};
  mocks.forEach(m => {
    const dk = m.date instanceof Date ? m.date.toISOString().slice(0, 10) : m.date;
    if (m.type === 'mock')     mockDateMap[dk] = { ...mockDateMap[dk], mock: m.mockNumber };
    if (m.type === 'postMock') mockDateMap[dk] = { ...mockDateMap[dk], postMock: m.mockNumber };
  });

  // Track mcqNum per topic as we walk the calendar
  const mcqCount = {};

  return calendar.map(day => {
    const dk = day.date instanceof Date ? day.date.toISOString().slice(0, 10) : day.date;

    if (mockDateMap[dk]) {
      const mockInfo = mockDateMap[dk];
      const synth = [];
      if (mockInfo.mock !== undefined) {
        synth.push({
          activityType: 'mock',
          topicTitle: '',
          mockNumber: mockInfo.mock,
          reason: `Full mock exam ${mockInfo.mock}`,
          count: 1,
        });
      }
      if (mockInfo.postMock !== undefined) {
        synth.push({
          activityType: 'postMock',
          topicTitle: '',
          mockNumber: mockInfo.postMock,
          reason: `Post-mock revision — deep review of mock ${mockInfo.postMock} results`,
          count: 1,
        });
      }
      return { ...day, sessions: synth };
    }

    const sessions = day.sessions.map(s => {
      const title = topicMap[s.topicId] || '';
      let reason = '';

      if (s.activityType === 'practice') {
        mcqCount[s.topicId] = (mcqCount[s.topicId] || 0) + 1;
        const num   = mcqCount[s.topicId];
        const total = stateMap[s.topicId]?.totalPN || '?';
        reason = `Practice MCQ session ${num} of ${total} for ${title}`;
        return { ...s, topicTitle: title, reason, _mcqNum: num };
      }

      if (s.activityType === 'learn') {
        reason = s.isFirstSession
          ? `First learning session for ${title}`
          : `Continuing learning for ${title}`;
      } else if (s.activityType === 'review') {
        reason = `Spaced review of ${title} (interval ${s.reviewIndex !== undefined ? s.reviewIndex + 1 : '?'})`;
      }

      return { ...s, topicTitle: title, reason };
    });

    return { ...day, sessions };
  });
}

// ─── Build topic summaries for the topic-by-topic table ──────────────────────

function buildTopicSummaries(hydratedCalendar, planTopics) {
  const sums = {};
  planTopics.forEach(t => { sums[t.id] = { title: t.name, activities: [] }; });

  for (const day of hydratedCalendar) {
    const merged = StudyStorage.mergeSessions(day.sessions);
    for (const block of merged) {
      if (!block.topicId || !sums[block.topicId]) continue;
      sums[block.topicId].activities.push({
        date:         day.date,
        activityType: block.activityType,
        count:        block.count,
        reason:       block.reason || '',
      });
    }
  }

  return planTopics.map(t => sums[t.id]).filter(Boolean);
}

// ─── Vue app definition ───────────────────────────────────────────────────────

window.StudyApp = {
  template: `
<div id="app-inner">

  <!-- ── Header ──────────────────────────────────────────────────────────── -->
  <header class="app-header">
    <span class="logo" style="cursor:pointer" @click="navigate('home')">Study Planner</span>
    <div class="breadcrumb" v-if="screen !== 'home'">
      <span>›</span>
      <span>{{ screenLabel }}</span>
    </div>
    <div class="header-actions">
      <button class="btn btn-ghost btn-sm" @click="navigate('settings')">⚙ Settings</button>
    </div>
  </header>

  <!-- ── Main ─────────────────────────────────────────────────────────────── -->
  <main class="main">

    <!-- Global error banner -->
    <div class="alert alert-error" v-if="error" style="margin-bottom:16px">
      {{ error }}
      <button class="btn btn-ghost btn-sm" style="margin-left:12px" @click="error=null">✕</button>
    </div>

    <!-- Global loading overlay -->
    <div class="loading-overlay" v-if="loading">
      <div class="spinner"></div>
      <span>{{ loadingMsg || 'Working…' }}</span>
    </div>

    <!-- ════════════════ HOME ════════════════ -->
    <template v-if="!loading && screen === 'home'">
      <div class="home-hero">
        <h1>Smart Study Planner</h1>
        <p>Generate an optimised, day-by-day study plan with spaced repetition — tailored to your exam and schedule.</p>
        <div class="home-actions">
          <div class="action-card" @click="navigate('step1')">
            <div class="action-icon">📚</div>
            <h3>Start New Plan</h3>
            <p>Enter your exam, topics, and schedule to build a fresh plan from scratch.</p>
          </div>
          <div class="action-card" @click="loadPlanFile()">
            <div class="action-icon">🔄</div>
            <h3>Update Existing Plan</h3>
            <p>Load a saved plan JSON file to replan based on your current progress.</p>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ STEP 1 — Topic Input ════════════════ -->
    <template v-else-if="!loading && screen === 'step1'">
      <div class="stepper">
        <div class="step active"><div class="step-num">1</div><span class="step-label">Topic Input</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">2</div><span class="step-label">Review Topics</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">3</div><span class="step-label">Schedule</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">4</div><span class="step-label">Your Plan</span></div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="section-title">Topic Input</div>
          <div class="section-sub">Choose how you want to specify your topics.</div>

          <div class="mode-cards">
            <div class="mode-card" :class="{ selected: topicInputMode === 'examName' }"
                 @click="topicInputMode = 'examName'">
              <h4>Exam name only</h4>
              <p>Enter the exam name and the AI generates a complete topic list for you.</p>
            </div>
            <div class="mode-card" :class="{ selected: topicInputMode === 'broadList' }"
                 @click="topicInputMode = 'broadList'">
              <h4>High-level topics</h4>
              <p>Enter broad topic headings and the AI breaks each into granular sub-topics.</p>
            </div>
            <div class="mode-card" :class="{ selected: topicInputMode === 'granularList' }"
                 @click="topicInputMode = 'granularList'">
              <h4>Full topic list</h4>
              <p>Paste your complete list. The AI estimates difficulty only.</p>
            </div>
          </div>

          <!-- Exam name field (mode 1 & 2) -->
          <div class="form-group" v-if="topicInputMode !== 'granularList'">
            <label>Exam name</label>
            <input type="text" v-model="examName" placeholder="e.g. SQE FLK1, CFA Level 1" />
          </div>

          <!-- Broad topics (mode 2) -->
          <div class="form-group" v-if="topicInputMode === 'broadList'">
            <label>Broad topics (one per line)</label>
            <textarea v-model="broadTopicsText" rows="5" placeholder="Contract Law&#10;Tort&#10;Land Law"></textarea>
          </div>

          <!-- Granular list (mode 3) -->
          <div class="form-group" v-if="topicInputMode === 'granularList'">
            <label>Topic list (one per line)</label>
            <textarea v-model="granularTopicsText" rows="8" placeholder="Contract Formation&#10;Consideration&#10;Terms of a Contract&#10;…"></textarea>
            <span class="form-hint">You can also paste from a spreadsheet — one topic per line.</span>
          </div>

          <!-- Free text AI notes -->
          <div class="form-group">
            <label>Additional notes for the AI <span style="font-weight:400;color:var(--c-muted)">(optional)</span></label>
            <textarea v-model="freeText" rows="3"
              placeholder="e.g. I struggle with Land Law. Limit to 30 topics. I have already studied everything, focus on practice."></textarea>
          </div>

          <div class="alert alert-warn" v-if="!settings.apiKey">
            No API key configured. <a href="#" @click.prevent="navigate('settings')">Set it in Settings</a> before generating topics.
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" @click="navigate('home')">Back</button>
            <button class="btn btn-primary btn-lg" @click="doGenerateTopics()"
                    :disabled="!canGenerateTopics">
              Generate Topics →
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ STEP 2 — Topics Review Table ════════════════ -->
    <template v-else-if="!loading && screen === 'step2'">
      <div class="stepper">
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Topic Input</span></div>
        <div class="step-connector"></div>
        <div class="step active"><div class="step-num">2</div><span class="step-label">Review Topics</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">3</div><span class="step-label">Schedule</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">4</div><span class="step-label">Your Plan</span></div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="section-title">Review & Confirm Topics</div>
          <div class="section-sub">{{ topics.length }} topics. Drag rows to reorder, or use ↑ ↓ arrows.</div>

          <div class="topics-table-wrap">
            <table class="topics-table">
              <thead>
                <tr>
                  <th class="col-num">#</th>
                  <th class="col-title">Topic</th>
                  <th class="col-diff">Difficulty</th>
                  <th class="col-state">Starting state</th>
                  <th class="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(topic, idx) in topics" :key="topic.id"
                    draggable="true"
                    :class="{ 'drag-over': dragOverIdx === idx, 'dragging': dragSrcIdx === idx }"
                    @dragstart="onDragStart($event, idx)"
                    @dragover.prevent="onDragOver($event, idx)"
                    @drop.prevent="onDrop($event, idx)"
                    @dragend="onDragEnd">
                  <td class="col-num">{{ idx + 1 }}</td>
                  <td class="col-title">
                    <input type="text" v-model="topic.title" />
                  </td>
                  <td class="col-diff">
                    <select class="select-sm" v-model="topic.difficulty">
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </select>
                  </td>
                  <td class="col-state">
                    <select class="select-sm" v-model="topic.startingState">
                      <option value="Not Started">Not Started</option>
                      <option value="Learned">Learned</option>
                      <option value="Practicing">Practicing</option>
                      <option value="Reviewing">Reviewing</option>
                    </select>
                  </td>
                  <td class="col-actions">
                    <button class="btn btn-ghost btn-icon" title="Move up"    @click="moveTopic(idx, -1)" :disabled="idx === 0">↑</button>
                    <button class="btn btn-ghost btn-icon" title="Move down"  @click="moveTopic(idx,  1)" :disabled="idx === topics.length - 1">↓</button>
                    <button class="btn btn-ghost btn-icon" title="Delete"     @click="deleteTopic(idx)">🗑</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style="margin-top:10px">
            <button class="btn btn-secondary btn-sm" @click="addTopic()">+ Add Topic</button>
          </div>

          <!-- State legend -->
          <div class="state-legend">
            <h4>Starting state guide</h4>
            <table>
              <thead><tr><th>State</th><th>Meaning</th><th>Scheduler behaviour</th></tr></thead>
              <tbody>
                <tr><td><strong>Not Started</strong></td><td>Topic not yet touched</td><td>Full pipeline: Learn → Practice MCQs → Reviews</td></tr>
                <tr><td><strong>Learned</strong></td><td>Content studied, ready to practice</td><td>Skip learning; begin at Practice MCQs</td></tr>
                <tr><td><strong>Practicing</strong></td><td>One MCQ session done</td><td>Skip learning; 1 MCQ session already counted</td></tr>
                <tr><td><strong>Reviewing</strong></td><td>All MCQs done</td><td>Skip learning and MCQs; begin at first Review</td></tr>
              </tbody>
            </table>
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" @click="navigate('step1')">← Back</button>
            <button v-if="planResult" class="btn btn-secondary" @click="navigate('step4')">Return to Plan</button>
            <button class="btn btn-primary btn-lg" @click="navigate('step3')"
                    :disabled="topics.length === 0">
              Confirm Topics →
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ STEP 3 — Schedule & Settings ════════════════ -->
    <template v-else-if="!loading && screen === 'step3'">
      <div class="stepper">
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Topic Input</span></div>
        <div class="step-connector"></div>
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Review Topics</span></div>
        <div class="step-connector"></div>
        <div class="step active"><div class="step-num">3</div><span class="step-label">Schedule</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">4</div><span class="step-label">Your Plan</span></div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="section-title">Schedule & Settings</div>
          <div class="section-sub">Define your study dates and how many sessions per day.</div>

          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>Study start date</label>
                <input type="date" v-model="startDate" />
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>Exam date</label>
                <input type="date" v-model="examDate" />
              </div>
            </div>
          </div>

          <div class="form-group">
            <label>Sessions per day</label>
            <div class="form-hint" style="margin-bottom:8px">Set how many sessions you plan for each weekday. The schedule ramps from First Week to Last Week.</div>
            <div class="schedule-grid">
              <div class="sg-header">Day</div>
              <div class="sg-header">First week</div>
              <div class="sg-header">Last week</div>
              <template v-for="dow in dowLabels" :key="dow.key">
                <div class="sg-day">{{ dow.label.slice(0,3) }}</div>
                <div class="sg-cell">
                  <input type="number" min="0" max="20" v-model.number="firstWeek[dow.key]" />
                  <span class="sg-time" v-if="firstWeek[dow.key] > 0">~{{ firstWeek[dow.key] * settings.sessionDuration }} min</span>
                </div>
                <div class="sg-cell">
                  <input type="number" min="0" max="20" v-model.number="lastWeek[dow.key]" />
                  <span class="sg-time" v-if="lastWeek[dow.key] > 0">~{{ lastWeek[dow.key] * settings.sessionDuration }} min</span>
                </div>
              </template>
            </div>
          </div>

          <div class="form-group">
            <label>Schedule ramp mode</label>
            <div class="radio-group" style="margin-top:6px">
              <label class="radio-option">
                <input type="radio" value="linear" v-model="rampMode" />
                <div>
                  <div class="option-label">Increase linearly</div>
                  <div class="option-desc">Session count scales evenly week by week.</div>
                </div>
              </label>
              <label class="radio-option">
                <input type="radio" value="cram" v-model="rampMode" />
                <div>
                  <div class="option-label">Cram at the end</div>
                  <div class="option-desc">Slow increase at first, then a significant step-up in the final weeks.</div>
                </div>
              </label>
            </div>
          </div>

          <div class="form-group">
            <label>Number of mock exams</label>
            <div class="form-hint" style="margin-bottom:6px">Minimum 3 recommended.</div>
            <div class="spinner-group">
              <button @click="numMocks = Math.max(1, numMocks - 1)">−</button>
              <input type="number" min="1" max="10" v-model.number="numMocks" />
              <button @click="numMocks = Math.min(10, numMocks + 1)">+</button>
            </div>
          </div>

          <div class="alert alert-warn" v-if="!examDate || !startDate">
            Please set both a study start date and an exam date.
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" @click="navigate('step2')">Back</button>
            <button class="btn btn-primary btn-lg" @click="doGeneratePlan()"
                    :disabled="!examDate || !startDate">
              Generate Plan →
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ STEP 4 — Plan View ════════════════ -->
    <template v-else-if="!loading && screen === 'step4' && planResult">

      <div class="stepper">
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Topic Input</span></div>
        <div class="step-connector"></div>
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Review Topics</span></div>
        <div class="step-connector"></div>
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Schedule</span></div>
        <div class="step-connector"></div>
        <div class="step active"><div class="step-num">4</div><span class="step-label">Your Plan</span></div>
      </div>

      <!-- Overflow / tweak panel — always expandable; auto-opens when overflow -->
      <div class="overflow-panel" :class="{ ok: !planResult.overflow.hasOverflow }">
        <div class="overflow-header" @click="overflowExpanded = !overflowExpanded">
          <h3>
            <span v-if="planResult.overflow.hasOverflow">⚠ Schedule Overflow — action required</span>
            <span v-else>✓ Plan fits — expand to tweak schedule</span>
          </h3>
          <span>{{ overflowExpanded ? '▲ collapse' : '▼ expand' }}</span>
        </div>

        <div class="overflow-body" v-if="overflowExpanded">
          <!-- Overflow message (only when there is one) -->
          <div class="overflow-summary" v-if="planResult.overflow.hasOverflow">
            {{ overflowSummaryText }}
          </div>

          <p style="font-weight:600;margin-bottom:12px">
            Adjust any of the options below then press Regenerate:
          </p>

          <!-- Option 1: Update study schedule -->
          <div style="margin-bottom:16px">
            <button class="btn btn-secondary btn-sm" @click="overflowEditSchedule = !overflowEditSchedule">
              {{ overflowEditSchedule ? '▲ Hide schedule' : '1. Update study schedule' }}
            </button>
            <div v-if="overflowEditSchedule" style="margin-top:12px">
              <div class="schedule-grid">
                <div class="sg-header">Day</div>
                <div class="sg-header">First week</div>
                <div class="sg-header">Last week</div>
                <template v-for="dow in dowLabels" :key="dow.key">
                  <div class="sg-day">{{ dow.label.slice(0,3) }}</div>
                  <div class="sg-cell">
                    <input type="number" min="0" max="20" v-model.number="firstWeek[dow.key]" />
                    <span class="sg-time" v-if="firstWeek[dow.key] > 0">~{{ firstWeek[dow.key] * settings.sessionDuration }} min</span>
                  </div>
                  <div class="sg-cell">
                    <input type="number" min="0" max="20" v-model.number="lastWeek[dow.key]" />
                    <span class="sg-time" v-if="lastWeek[dow.key] > 0">~{{ lastWeek[dow.key] * settings.sessionDuration }} min</span>
                  </div>
                </template>
              </div>
            </div>
          </div>

          <!-- Option 2: Update exam date -->
          <div style="margin-bottom:16px">
            <button class="btn btn-secondary btn-sm" @click="overflowEditDate = !overflowEditDate">
              {{ overflowEditDate ? '▲ Hide date' : '2. Update exam date' }}
            </button>
            <div v-if="overflowEditDate" style="margin-top:8px;display:flex;align-items:center;gap:12px">
              <div class="form-group" style="margin-bottom:0">
                <label style="font-size:.82rem">New exam date</label>
                <input type="date" v-model="examDate" style="width:160px" />
              </div>
            </div>
          </div>

          <!-- Option 3: Update topics -->
          <div style="margin-bottom:16px">
            <button class="btn btn-secondary btn-sm" @click="navigate('step2')">
              3. Update topics table
            </button>
          </div>

          <!-- Option 4: Fewer mocks -->
          <div style="margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:.88rem;font-weight:500">4. Number of mock exams:</span>
              <div class="spinner-group">
                <button @click="numMocks = Math.max(1, numMocks - 1)">−</button>
                <input type="number" min="1" max="10" v-model.number="numMocks" style="width:48px" />
                <button @click="numMocks = Math.min(10, numMocks + 1)">+</button>
              </div>
            </div>
          </div>

          <div class="action-bar" style="padding-top:12px;margin-top:8px">
            <button class="btn btn-primary" @click="doGeneratePlan()">↺ Regenerate Plan</button>
          </div>
        </div>
      </div>

      <!-- Download / save row -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
        <button class="btn btn-secondary btn-sm" @click="doExportDailyCsv()">⬇ Day-by-day CSV</button>
        <button class="btn btn-secondary btn-sm" @click="doExportTopicsCsv()">⬇ Topics CSV</button>
        <button class="btn btn-secondary btn-sm" @click="doExportJson()">⬇ Save plan (JSON)</button>
      </div>

      <!-- Tabs -->
      <div class="tab-bar">
        <button class="tab-btn" :class="{ active: activeTab === 'trajectory' }" @click="setTab('trajectory')">Visual Trajectory</button>
        <button class="tab-btn" :class="{ active: activeTab === 'daily' }"      @click="setTab('daily')">Day-by-Day</button>
        <button class="tab-btn" :class="{ active: activeTab === 'topics' }"     @click="setTab('topics')">Topic Summary</button>
        <button class="tab-btn" :class="{ active: activeTab === 'calendar' }"   @click="setTab('calendar')">Calendar</button>
      </div>

      <!-- ── Tab: Visual Trajectory ── -->
      <div v-if="activeTab === 'trajectory'">
        <!-- Legend above -->
        <div class="chart-legend">
          <span v-for="item in chartLegendItems" :key="item.label" class="legend-item">
            <span class="legend-swatch" :style="{ background: item.color }"></span>
            <span class="legend-label">{{ item.label }}</span>
          </span>
        </div>

        <div class="chart-outer" ref="chartOuter"
             @mousemove="onChartMouseMove"
             @mouseleave="onChartMouseLeave">
          <canvas ref="chartCanvas"></canvas>
        </div>

        <!-- Legend below -->
        <div class="chart-legend" style="margin-top:6px">
          <span v-for="item in chartLegendItems" :key="'b-'+item.label" class="legend-item">
            <span class="legend-swatch" :style="{ background: item.color }"></span>
            <span class="legend-label">{{ item.label }}</span>
          </span>
        </div>

        <div class="chart-tooltip" v-if="tooltip"
             :style="{ left: tooltipX + 'px', top: tooltipY + 'px' }">
          <strong>{{ tooltip.topic }}</strong> · {{ tooltip.date }} · {{ tooltip.state }}
        </div>
      </div>

      <!-- ── Tab: Day-by-Day ── -->
      <div v-if="activeTab === 'daily'">
        <template v-for="day in studyDaysWithSessions" :key="day.dateKey">
          <div class="day-block">
            <div class="day-header" @click="toggleDay(day.dateKey)" style="cursor:pointer;user-select:none">
              <span class="day-expand-icon">{{ isDayExpanded(day.dateKey) ? '▼' : '▶' }}</span>
              {{ formatDate(day.date) }}
              <span class="session-count">
                {{ day.sessions.length }} session{{ day.sessions.length !== 1 ? 's' : '' }}
                <span class="day-time-est" v-if="dayEstimatedTime(day.sessions)">· {{ dayEstimatedTime(day.sessions) }}</span>
              </span>
            </div>
            <template v-if="isDayExpanded(day.dateKey)">
              <template v-for="(block, bi) in mergeSessions(day.sessions)" :key="bi">
                <div class="session-row">
                  <span class="activity-pill" :class="pillClass(block.activityType)">{{ activityLabel(block.activityType) }}</span>
                  <span class="session-topic">{{ block.topicTitle || (block.activityType === 'mock' ? 'Mock Exam' : 'Post-Mock Revision') }}</span>
                  <span class="session-count-badge" v-if="block.count > 1">× {{ block.count }}</span>
                  <span class="session-reason">{{ block.reason }}</span>
                </div>
              </template>
            </template>
          </div>
        </template>
      </div>

      <!-- ── Tab: Topic Summary ── -->
      <div v-if="activeTab === 'topics'">
        <div class="topics-table-wrap">
          <table class="topic-summary-table">
            <thead>
              <tr>
                <th style="width:180px">Topic</th>
                <th>Scheduled activities</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ts in topicSummaries" :key="ts.title">
                <td><strong>{{ ts.title }}</strong></td>
                <td>
                  <div class="activity-list">
                    <div class="activity-entry" v-for="(act, ai) in ts.activities" :key="ai">
                      <span class="date">{{ formatDate(act.date) }}</span>
                      <span class="type">
                        <span class="activity-pill" :class="pillClass(act.activityType)">{{ activityLabel(act.activityType) }}</span>
                        <span v-if="act.count > 1" style="margin-left:4px">× {{ act.count }}</span>
                      </span>
                      <span class="note">{{ act.reason }}</span>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ── Tab: Calendar View ── -->
      <div v-if="activeTab === 'calendar'" class="cal-wrap">

        <!-- Month navigation -->
        <div class="cal-nav">
          <button class="btn btn-ghost btn-sm" @click="prevCalMonth()">← Prev</button>
          <span class="cal-month-label">{{ calendarMonthLabel }}</span>
          <button class="btn btn-ghost btn-sm" @click="nextCalMonth()">Next →</button>
        </div>

        <!-- Day-of-week headers -->
        <div class="cal-grid">
          <div class="cal-dow" v-for="d in ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']" :key="d">{{ d }}</div>

          <!-- Day cells -->
          <template v-for="(cell, ci) in calendarCells" :key="ci">
            <div v-if="!cell" class="cal-cell cal-cell--pad"></div>
            <div v-else class="cal-cell"
                 :class="{
                   'cal-cell--study':    cell.isStudyDay,
                   'cal-cell--selected': calendarPopover && calendarPopover.dateKey === cell.dateKey,
                   'cal-cell--today':    cell.dateKey === todayKey,
                   'cal-cell--exam':     cell.dateKey === examDate,
                 }"
                 @click="calCellClick(cell)">
              <span class="cal-day-num">{{ cell.day }}</span>
              <div class="cal-dots" v-if="cell.activityDots.length">
                <span v-for="dot in cell.activityDots" :key="dot.type"
                      class="cal-dot" :style="{ background: dot.color }"></span>
              </div>
              <span class="cal-cell-time" v-if="dayEstimatedTime(cell.sessions)">{{ dayEstimatedTime(cell.sessions) }}</span>
            </div>
          </template>
        </div>

        <!-- Legend -->
        <div class="cal-legend">
          <span v-for="item in calDotLegend" :key="item.label" class="cal-legend-item">
            <span class="cal-dot" :style="{ background: item.color }"></span>
            {{ item.label }}
          </span>
          <span class="cal-legend-item">
            <span class="cal-cell--today cal-legend-swatch"></span> Today
          </span>
          <span class="cal-legend-item">
            <span class="cal-cell--exam cal-legend-swatch"></span> Exam date
          </span>
        </div>

        <!-- Day detail panel (shown when a study day is selected) -->
        <div class="cal-detail" v-if="calendarPopover">
          <div class="cal-detail-header">
            <strong>{{ formatDate(calendarPopover.date) }}</strong>
            <span class="cal-detail-meta">
              {{ calendarPopover.sessions.length }} session{{ calendarPopover.sessions.length !== 1 ? 's' : '' }}
              <span v-if="dayEstimatedTime(calendarPopover.sessions)">
                · {{ dayEstimatedTime(calendarPopover.sessions) }}
              </span>
            </span>
            <button class="btn btn-ghost btn-sm" @click="calendarPopover = null" style="margin-left:auto;padding:2px 8px">✕</button>
          </div>
          <div class="cal-detail-body">
            <div v-for="(block, bi) in mergeSessions(calendarPopover.sessions)" :key="bi" class="cal-detail-row">
              <span class="activity-pill" :class="pillClass(block.activityType)">{{ activityLabel(block.activityType) }}</span>
              <span class="cal-detail-topic">{{ block.topicTitle || (block.activityType === 'mock' ? 'Mock Exam' : 'Post-Mock Revision') }}</span>
              <span class="session-count-badge" v-if="block.count > 1">× {{ block.count }}</span>
              <span class="session-reason">{{ block.reason }}</span>
            </div>
          </div>
        </div>

      </div>

      <!-- Post-generation prompt -->
      <div class="alert alert-info" style="margin-top:24px">
        Happy with this plan? Save it using the buttons above, or adjust using the overflow panel.
      </div>
    </template>

    <!-- ════════════════ UPDATE EXISTING PLAN ════════════════ -->
    <template v-else-if="!loading && screen === 'update'">
      <div class="section-title">Update Existing Plan</div>
      <div class="section-sub">Review the current state of each topic and adjust anything that deviated from the original plan.</div>

      <div class="card" style="margin-bottom:20px">
        <div class="card-body">
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>Study start date</label>
                <input type="date" v-model="startDate" />
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>Exam date</label>
                <input type="date" v-model="examDate" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div class="card-body">
          <p style="margin-bottom:12px;font-size:.88rem;color:var(--c-muted)">
            The states below have been pre-filled assuming you followed the original plan up to today. Correct any rows where you deviated.
          </p>
          <div class="topics-table-wrap">
            <table class="topics-table">
              <thead>
                <tr>
                  <th class="col-num">#</th>
                  <th class="col-title">Topic</th>
                  <th class="col-diff">Difficulty</th>
                  <th class="col-state">Current state</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(topic, idx) in topics" :key="topic.id">
                  <td class="col-num">{{ idx + 1 }}</td>
                  <td class="col-title">{{ topic.title }}</td>
                  <td class="col-diff">
                    <select class="select-sm" v-model="topic.difficulty">
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </select>
                  </td>
                  <td class="col-state">
                    <select class="select-sm" v-model="topic.startingState">
                      <option value="Not Started">Not Started</option>
                      <option value="Learned">Learned</option>
                      <option value="Practicing">Practicing</option>
                      <option value="Reviewing">Reviewing</option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" @click="navigate('home')">Back</button>
            <button class="btn btn-primary" @click="doGeneratePlan()">Regenerate Plan →</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ SETTINGS ════════════════ -->
    <template v-else-if="!loading && screen === 'settings'">
      <div class="section-title">Settings</div>

      <div class="card" style="margin-bottom:20px">
        <div class="card-body">
          <div class="settings-section">
            <h3>API Configuration</h3>
            <div class="form-group">
              <label>OpenAI API key</label>
              <input type="password" v-model="settings.apiKey" placeholder="sk-…" autocomplete="off" />
              <span class="form-hint">Stored locally only — never sent to any server except OpenAI.</span>
            </div>
            <div class="form-group">
              <label>Model</label>
              <select v-model="settings.model">
                <option v-for="m in recentModels" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
          </div>

          <div class="settings-section">
            <div class="expandable">
              <div class="expandable-header" @click="advancedExpanded = !advancedExpanded">
                Advanced Settings
                <span>{{ advancedExpanded ? '▲' : '▼' }}</span>
              </div>
              <div class="expandable-body" v-if="advancedExpanded">

                <div class="form-group">
                  <label>Learning mode</label>
                  <div style="display:flex;flex-direction:column;gap:10px;margin-top:6px">
                    <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
                      <input type="radio" value="interleaved" v-model="settings.learningMode" style="margin-top:3px;flex-shrink:0" />
                      <span>
                        <strong>Interleaved</strong> — once a topic&#39;s learning sessions are done, its practice MCQs are distributed across the schedule alongside other topics.
                      </span>
                    </label>
                    <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
                      <input type="radio" value="sequential" v-model="settings.learningMode" style="margin-top:3px;flex-shrink:0" />
                      <span>
                        <strong>Sequential</strong> — fully complete one topic (all learning + all practice MCQs) before moving to the next. Reviews still follow the spaced-repetition schedule.
                      </span>
                    </label>
                  </div>
                </div>

                <div class="form-group">
                  <label>Session duration (display only)</label>
                  <div class="spinner-group">
                    <button @click="settings.sessionDuration = Math.max(5, settings.sessionDuration - 5)">−</button>
                    <input type="number" min="5" max="120" step="5" v-model.number="settings.sessionDuration" />
                    <button @click="settings.sessionDuration = Math.min(120, settings.sessionDuration + 5)">+</button>
                  </div>
                  <span class="form-hint">Minutes per session. Does not affect scheduling. Mock exam = always 90 min; post-mock = full day.</span>
                </div>

                <div class="form-group">
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="settings.postMockSameDay" />
                    Post-mock revision on same day as mock exam
                  </label>
                  <span class="form-hint">When unchecked, post-mock revision occupies the next study day (blocks it entirely).</span>
                </div>

                <div class="form-group">
                  <label>Max new learning topics per day</label>
                  <div class="spinner-group">
                    <button @click="settings.maxNewTopicsPerDay = Math.max(1, settings.maxNewTopicsPerDay - 1)">−</button>
                    <input type="number" min="1" max="20" v-model.number="settings.maxNewTopicsPerDay" />
                    <button @click="settings.maxNewTopicsPerDay = Math.min(20, settings.maxNewTopicsPerDay + 1)">+</button>
                  </div>
                </div>

                <div class="form-group">
                  <label>Max days between practice sessions</label>
                  <div class="spinner-group">
                    <button @click="settings.maxDaysBetweenPractice = Math.max(1, (settings.maxDaysBetweenPractice || 7) - 1)">−</button>
                    <input type="number" min="1" max="60" v-model.number="settings.maxDaysBetweenPractice" />
                    <button @click="settings.maxDaysBetweenPractice = Math.min(60, (settings.maxDaysBetweenPractice || 7) + 1)">+</button>
                  </div>
                  <span class="form-hint">Maximum gap (days) between learning and first practice, and between consecutive practice sessions.</span>
                </div>

                <div class="form-group">
                  <label>Sessions per topic (editable defaults)</label>
                  <table class="activity-count-table" style="margin-top:8px">
                    <thead><tr><th>Activity</th><th>Easy</th><th>Medium</th><th>Hard</th></tr></thead>
                    <tbody>
                      <tr>
                        <td>Learning sessions (LN)</td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.easy" /></td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.medium" /></td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.hard" /></td>
                      </tr>
                      <tr>
                        <td>Practice MCQ sessions (PN)</td>
                        <td><input type="number" min="1" max="20" v-model.number="settings.pnTable.easy" /></td>
                        <td><input type="number" min="1" max="20" v-model.number="settings.pnTable.medium" /></td>
                        <td><input type="number" min="1" max="20" v-model.number="settings.pnTable.hard" /></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div class="form-group">
                  <label>Spaced repetition intervals (comma-separated day gaps)</label>
                  <input type="text" class="sr-input" v-model="settingsSrText"
                         placeholder="6, 16, 45, 131" />
                  <span class="form-hint">Gaps between consecutive review sessions. Default: 6, 16, 45, 131</span>
                </div>

              </div>
            </div>
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" @click="doCancelSettings()">Cancel</button>
            <button class="btn btn-primary" @click="doSaveSettings()">Save Settings</button>
          </div>
        </div>
      </div>
    </template>

  </main>
</div>`,

  // ─── Data ──────────────────────────────────────────────────────────────────

  data() {
    const today    = new Date().toISOString().slice(0, 10);
    const settings = StudyStorage.loadSettings();

    return {
      screen: 'home',
      settings,

      // Step 1
      topicInputMode: 'examName',
      examName: '',
      broadTopicsText: '',
      granularTopicsText: '',
      freeText: '',

      // Step 2
      topics: [],
      dragSrcIdx:  null,
      dragOverIdx: null,
      _nextTopicId: 1,

      // Step 3
      startDate: today,
      examDate:  '',
      firstWeek: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 },
      lastWeek:  { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 1, sun: 0 },
      rampMode:  'linear',
      numMocks:  3,

      // Step 4
      planResult:       null,
      hydratedCalendar: [],
      chartTopicsData:  [],
      activeTab:        'trajectory',
      completionStatus: {},
      overflowExpanded: false,
      overflowEditSchedule: false,
      overflowEditDate: false,

      // Day-by-day collapse state (default: all collapsed)
      expandedDays: {},

      // Calendar view
      currentCalMonth: null,
      calendarPopover: null,

      // Chart tooltip
      tooltip:  null,
      tooltipX: 0,
      tooltipY: 0,
      _chartStateMap: null,
      _chartDateKeys: null,

      // Settings page
      advancedExpanded:  false,
      settingsSrText:    (settings.srIntervals || [6,16,45,131]).join(', '),
      prevScreen:        'home',
      prevActiveTab:     'trajectory',
      settingsSnapshot:  null,

      // Loading / error
      loading:    false,
      loadingMsg: '',
      error:      null,
    };
  },

  // ─── Computed ──────────────────────────────────────────────────────────────

  computed: {
    dowLabels() { return DOW_LABELS; },
    recentModels() { return RECENT_MODELS; },

    screenLabel() {
      return {
        step1:    'New Plan — Step 1: Topic Input',
        step2:    'New Plan — Step 2: Review Topics',
        step3:    'New Plan — Step 3: Schedule',
        step4:    'Your Study Plan',
        settings: 'Settings',
        update:   'Update Existing Plan',
      }[this.screen] || '';
    },

    canGenerateTopics() {
      if (!this.settings.apiKey) return false;
      if (this.topicInputMode === 'examName'     && !this.examName.trim())         return false;
      if (this.topicInputMode === 'broadList'    && !this.broadTopicsText.trim())  return false;
      if (this.topicInputMode === 'granularList' && !this.granularTopicsText.trim()) return false;
      return true;
    },

    overflowSummaryText() {
      if (!this.planResult) return '';
      const ov = this.planResult.overflow;
      const nameOf = id => {
        const t = this.planResult.topics.find(t => t.id === id);
        return t ? t.name : `topic ${id}`;
      };
      const nLearn    = ov.incompleteLearnTopics.length;
      const nMCQ      = ov.incompleteMCQTopics.length;
      const nReview   = ov.missedReviewTopics.length;
      const nTopics   = this.planResult.topics.length;
      const extraSess = ov.estimatedExtraSessionsPerWeek;
      let msg = '';
      if (nMCQ > 0) {
        msg += `${nMCQ} of ${nTopics} topics will not complete all Practice MCQ sessions before the exam. `;
      }
      if (nLearn > 0) {
        msg += `${nLearn} topic${nLearn > 1 ? 's' : ''} will not finish learning before the exam. `;
      }
      if (nReview > 0) {
        msg += `${nReview} topic${nReview > 1 ? 's' : ''} will miss scheduled review sessions. `;
      }
      if (extraSess > 0) {
        msg += `You need approximately ${extraSess} more sessions per week to complete the full plan.`;
      }
      return msg;
    },

    studyDaysWithSessions() {
      if (!this.hydratedCalendar.length) return [];
      return this.hydratedCalendar.filter(d => d.sessions && d.sessions.length > 0).map(d => ({
        ...d,
        dateKey: d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date,
      }));
    },

    topicSummaries() {
      if (!this.planResult || !this.hydratedCalendar.length) return [];
      return buildTopicSummaries(this.hydratedCalendar, this.planResult.topics);
    },

    chartLegendItems() {
      if (typeof StudyChart === 'undefined') return [];
      return StudyChart.LEGEND_ITEMS.map(item => ({
        label: item.label,
        color: StudyChart.stateColor(item.state, item.progress),
      }));
    },

    todayKey() {
      return new Date().toISOString().slice(0, 10);
    },

    calendarMonthLabel() {
      if (!this.currentCalMonth) return '';
      return this.currentCalMonth.toLocaleDateString('en-GB', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
      });
    },

    calDotLegend() {
      return [
        { type: 'learn',    label: 'Learning',  color: '#3b82f6' },
        { type: 'practice', label: 'Practice',  color: '#f59e0b' },
        { type: 'review',   label: 'Review',    color: '#16a34a' },
        { type: 'mock',     label: 'Mock',      color: '#7c3aed' },
        { type: 'postMock', label: 'Post-mock', color: '#c084fc' },
      ];
    },

    calendarCells() {
      if (!this.currentCalMonth || !this.hydratedCalendar.length) return [];

      const DOT_COLORS = {
        learn:    '#3b82f6',
        practice: '#f59e0b',
        review:   '#16a34a',
        mock:     '#7c3aed',
        postMock: '#c084fc',
      };

      const year  = this.currentCalMonth.getUTCFullYear();
      const month = this.currentCalMonth.getUTCMonth();

      // Index hydratedCalendar by dateKey
      const dayMap = {};
      for (const day of this.hydratedCalendar) {
        const dk = day.date instanceof Date ? day.date.toISOString().slice(0, 10) : day.date;
        dayMap[dk] = day;
      }

      // Leading padding (Mon-first grid)
      const firstDow   = new Date(Date.UTC(year, month, 1)).getUTCDay();
      const leadingPad = (firstDow + 6) % 7;

      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

      const cells = [];
      for (let i = 0; i < leadingPad; i++) cells.push(null);

      for (let d = 1; d <= lastDay; d++) {
        const date = new Date(Date.UTC(year, month, d));
        const dk   = date.toISOString().slice(0, 10);
        const hydr = dayMap[dk];
        const sessions = hydr ? hydr.sessions : [];

        // Unique activity dots in display order
        const seen = new Set();
        const activityDots = [];
        for (const s of sessions) {
          if (!seen.has(s.activityType)) {
            seen.add(s.activityType);
            activityDots.push({ type: s.activityType, color: DOT_COLORS[s.activityType] || '#999' });
          }
        }

        cells.push({ date, dateKey: dk, day: d, sessions, activityDots, isStudyDay: sessions.length > 0 });
      }

      // Trailing padding to complete last row
      const tail = (7 - (cells.length % 7)) % 7;
      for (let i = 0; i < tail; i++) cells.push(null);

      return cells;
    },
  },

  // ─── Methods ───────────────────────────────────────────────────────────────

  methods: {

    navigate(screen) {
      if (screen === 'settings') {
        this.prevScreen    = this.screen;
        this.prevActiveTab = this.activeTab;
        this.settingsSrText = (this.settings.srIntervals || [6,16,45,131]).join(', ');
        this.settingsSnapshot = JSON.stringify(this.settings);
      }
      this.screen = screen;
      this.error  = null;
    },

    // ── Step 1 → Step 2 ────────────────────────────────────────────────────

    async doGenerateTopics() {
      this.loading    = true;
      this.loadingMsg = 'Asking AI to generate your topic list…';
      this.error      = null;

      try {
        let broadTopics    = [];
        let granularTopics = [];

        if (this.topicInputMode === 'broadList') {
          broadTopics = this.broadTopicsText.split('\n').map(s => s.trim()).filter(Boolean);
        }
        if (this.topicInputMode === 'granularList') {
          granularTopics = this.granularTopicsText.split('\n').map(s => s.trim()).filter(Boolean);
        }

        const raw = await StudyApi.generateTopics({
          mode:            this.topicInputMode,
          examName:        this.examName,
          broadTopics,
          granularTopics,
          freeText:        this.freeText,
          apiKey:          this.settings.apiKey,
          model:           this.settings.model,
        });

        this.topics = raw.map((t, i) => ({
          id:            this._nextTopicId++,
          title:         t.title,
          difficulty:    t.difficulty,
          startingState: t.startingState,
        }));

        this.navigate('step2');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // ── Topics table manipulation ───────────────────────────────────────────

    addTopic() {
      this.topics.push({
        id:            this._nextTopicId++,
        title:         '',
        difficulty:    'medium',
        startingState: 'Not Started',
      });
    },

    deleteTopic(idx) {
      this.topics.splice(idx, 1);
    },

    moveTopic(idx, dir) {
      const swap = idx + dir;
      if (swap < 0 || swap >= this.topics.length) return;
      [this.topics[idx], this.topics[swap]] = [this.topics[swap], this.topics[idx]];
    },

    // ── Drag-and-drop ───────────────────────────────────────────────────────

    onDragStart(evt, idx) {
      this.dragSrcIdx = idx;
      evt.dataTransfer.effectAllowed = 'move';
    },

    onDragOver(evt, idx) {
      this.dragOverIdx = idx;
    },

    onDrop(evt, idx) {
      const src  = this.dragSrcIdx;
      const dest = idx;
      if (src === null || src === dest) return;
      const item = this.topics.splice(src, 1)[0];
      this.topics.splice(dest, 0, item);
    },

    onDragEnd() {
      this.dragSrcIdx  = null;
      this.dragOverIdx = null;
    },

    // ── Step 3 → Step 4 ────────────────────────────────────────────────────

    doGeneratePlan() {
      this.loading    = true;
      this.loadingMsg = 'Building your study plan…';
      this.error      = null;

      // Yield to the browser to paint the loading state
      setTimeout(() => {
        try {
          const planTopics = this.topics.map(t => ({
            id:            t.id,
            name:          t.title,
            difficulty:    t.difficulty,
            startingState: t.startingState,
          }));

          const srIntervals = this.settingsSrText
            .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);

          const config = {
            topics:         planTopics,
            startDate:      new Date(this.startDate + 'T00:00:00Z'),
            examDate:       new Date(this.examDate   + 'T00:00:00Z'),
            firstWeek:      this.firstWeek,
            lastWeek:       this.lastWeek,
            rampMode:       this.rampMode,
            numMocks:       this.numMocks,
            srIntervals:    srIntervals.length ? srIntervals : [6,16,45,131],
            postMockSameDay: this.settings.postMockSameDay !== false,
            settings: {
              lnTable:                this.settings.lnTable,
              pnTable:                this.settings.pnTable,
              learningMode:           this.settings.learningMode || 'interleaved',
              maxNewTopicsPerDay:     this.settings.maxNewTopicsPerDay,
              maxDaysBetweenPractice: this.settings.maxDaysBetweenPractice || 7,
            },
          };

          this.planResult = StudyPlanner.generatePlan(config);

          this.hydratedCalendar = hydrateCalendar(
            this.planResult.calendar,
            this.planResult.topics,
            this.planResult.mocks,
          );

          this.chartTopicsData = this.planResult.topics.map(t => ({
            id:            t.id,
            title:         t.name,
            totalPN:       t.totalPN,
            startingState: t.startingState,
          }));

          this.overflowExpanded = this.planResult.overflow.hasOverflow;
          this.activeTab        = 'trajectory';
          this.expandedDays     = {};
          this.initCalMonth();

          // Save to localStorage
          StudyStorage.saveCurrentPlan(this.buildPlanData());

          this.navigate('step4');
          // Render chart after Vue paints the canvas into the DOM
          this.$nextTick(() => this.renderChart());
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loading = false;
        }
      }, 50);
    },

    // ── Chart ───────────────────────────────────────────────────────────────

    setTab(tab) {
      this.activeTab = tab;
      if (tab === 'trajectory') {
        this.$nextTick(() => this.renderChart());
      }
    },

    renderChart() {
      const canvas = this.$refs.chartCanvas;
      if (!canvas || !this.planResult) return;

      const stateMap = StudyChart.buildStateMap(
        this.chartTopicsData,
        this.hydratedCalendar,
        this.planResult.mocks,
      );
      const dateKeys = this.hydratedCalendar.map(d =>
        d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date
      );

      this._chartStateMap = stateMap;
      this._chartDateKeys = dateKeys;

      StudyChart.draw(canvas, this.chartTopicsData, this.hydratedCalendar, this.planResult.mocks);
    },

    onChartMouseMove(evt) {
      const canvas = this.$refs.chartCanvas;
      if (!canvas || !this._chartStateMap) return;
      const hit = StudyChart.hitTest(evt, canvas, this._chartStateMap, this._chartDateKeys);
      if (hit) {
        this.tooltip  = hit;
        this.tooltipX = evt.clientX + 12;
        this.tooltipY = evt.clientY + 12;
      } else {
        this.tooltip = null;
      }
    },

    onChartMouseLeave() {
      this.tooltip = null;
    },

    // ── Calendar view ───────────────────────────────────────────────────────

    initCalMonth() {
      const d = new Date(this.startDate + 'T00:00:00Z');
      this.currentCalMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      this.calendarPopover = null;
    },

    prevCalMonth() {
      const d = this.currentCalMonth;
      this.currentCalMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
      this.calendarPopover = null;
    },

    nextCalMonth() {
      const d = this.currentCalMonth;
      this.currentCalMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      this.calendarPopover = null;
    },

    calCellClick(cell) {
      if (!cell || !cell.sessions.length) { this.calendarPopover = null; return; }
      this.calendarPopover = this.calendarPopover?.dateKey === cell.dateKey ? null : cell;
    },

    // ── Day-by-day collapse ─────────────────────────────────────────────────

    toggleDay(dateKey) {
      this.expandedDays = { ...this.expandedDays, [dateKey]: !this.expandedDays[dateKey] };
    },

    isDayExpanded(dateKey) {
      return !!this.expandedDays[dateKey];
    },

    dayEstimatedTime(sessions) {
      let mins = 0;
      for (const s of sessions) {
        if (s.activityType === 'mock')     { mins += 90; }
        else if (s.activityType !== 'postMock') { mins += this.settings.sessionDuration; }
      }
      return mins > 0 ? `~${mins} min` : '';
    },

    // ── Export ──────────────────────────────────────────────────────────────

    doExportDailyCsv() {
      StudyStorage.exportDayByDayCsv(
        this.hydratedCalendar,
        this.completionStatus,
        this.settings.sessionDuration,
      );
    },

    doExportTopicsCsv() {
      StudyStorage.exportTopicCsv(
        this.topicSummaries,
        this.settings.sessionDuration,
      );
    },

    doExportJson() {
      StudyStorage.exportJSON(this.buildPlanData(), 'study-plan.json');
    },

    buildPlanData() {
      return {
        version:          2,
        exportedAt:       new Date().toISOString(),
        examName:         this.examName,
        topicInputMode:   this.topicInputMode,
        topics:           this.topics,
        startDate:        this.startDate,
        examDate:         this.examDate,
        firstWeek:        this.firstWeek,
        lastWeek:         this.lastWeek,
        rampMode:         this.rampMode,
        numMocks:         this.numMocks,
        settings:         this.settings,
        settingsSrText:   this.settingsSrText,
        completionStatus: this.completionStatus,
        planTopics:       this.planResult?.topics || [],
      };
    },

    // ── Load existing plan ───────────────────────────────────────────────────

    async loadPlanFile() {
      try {
        const data = await StudyStorage.importJSON();
        this.restoreFromPlanData(data);
        this.navigate('update');
      } catch (e) {
        this.error = e.message;
      }
    },

    restoreFromPlanData(data) {
      if (data.topics)        this.topics        = data.topics;
      if (data.startDate)     this.startDate     = data.startDate;
      if (data.examDate)      this.examDate      = data.examDate;
      if (data.firstWeek)     this.firstWeek     = data.firstWeek;
      if (data.lastWeek)      this.lastWeek      = data.lastWeek;
      if (data.rampMode)      this.rampMode      = data.rampMode;
      if (data.numMocks)      this.numMocks      = data.numMocks;
      if (data.examName)      this.examName      = data.examName;
      if (data.topicInputMode) this.topicInputMode = data.topicInputMode;
      if (data.settings)      Object.assign(this.settings, data.settings);
      if (data.settingsSrText) this.settingsSrText = data.settingsSrText;
      if (data.completionStatus) this.completionStatus = data.completionStatus;

      // Update topic start dates to "today" for replanning
      const today = new Date().toISOString().slice(0, 10);
      if (!this.startDate || this.startDate < today) this.startDate = today;

      // Pre-fill "current" state from planTopics if available
      if (data.planTopics && data.planTopics.length) {
        const stateFromPlan = {};
        data.planTopics.forEach(pt => { stateFromPlan[pt.name] = pt; });
        this.topics = this.topics.map(t => {
          const pt = stateFromPlan[t.title];
          if (!pt) return t;
          // Infer current starting state from planTopics remaining counts
          let startingState = 'Not Started';
          if (pt.remainingLN > 0)                                    startingState = 'Not Started';
          else if (pt.remainingPN > 0 && pt.mcqSessionsDone === 0)   startingState = 'Learned';
          else if (pt.remainingPN > 0 && pt.mcqSessionsDone > 0)     startingState = 'Practicing';
          else                                                          startingState = 'Reviewing';
          return { ...t, startingState };
        });
      }

      // Keep _nextTopicId above the highest existing topic id to avoid collisions
      if (this.topics.length) {
        this._nextTopicId = Math.max(...this.topics.map(t => (t.id || 0))) + 1;
      }
    },

    // ── Settings ─────────────────────────────────────────────────────────────

    doCancelSettings() {
      if (this.settingsSnapshot) {
        Object.assign(this.settings, JSON.parse(this.settingsSnapshot));
        this.settingsSrText = (this.settings.srIntervals || [6,16,45,131]).join(', ');
      }
      this.screen    = this.prevScreen;
      this.activeTab = this.prevActiveTab;
      this.error     = null;
    },

    doSaveSettings() {
      const srArr = this.settingsSrText
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
      this.settings.srIntervals = srArr.length ? srArr : [6,16,45,131];

      const changed = JSON.stringify(this.settings) !== this.settingsSnapshot;
      StudyStorage.saveSettings(this.settings);

      // Return to wherever the user came from
      this.screen    = this.prevScreen;
      this.activeTab = this.prevActiveTab;
      this.error     = null;

      // Regenerate if scheduling-relevant settings changed and a plan exists
      const SCHEDULING_KEYS = ['lnTable', 'pnTable', 'learningMode', 'maxNewTopicsPerDay',
                                'postMockSameDay', 'maxDaysBetweenPractice', 'srIntervals'];
      const prev = this.settingsSnapshot ? JSON.parse(this.settingsSnapshot) : {};
      const scheduleChanged = SCHEDULING_KEYS.some(
        k => JSON.stringify(this.settings[k]) !== JSON.stringify(prev[k])
      );
      if (changed && scheduleChanged && this.planResult) {
        this.doGeneratePlan();
      }
    },

    // ── Display helpers ───────────────────────────────────────────────────────

    formatDate(date) {
      if (!date) return '';
      const d = date instanceof Date ? date : new Date(date + 'T00:00:00Z');
      return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    },

    activityLabel(type) { return StudyStorage.activityLabel(type); },

    pillClass(type) {
      return {
        learn:    'pill-learn',
        practice: 'pill-practice',
        review:   'pill-review',
        mock:     'pill-mock',
        postMock: 'pill-postmock',
      }[type] || '';
    },

    mergeSessions(sessions) {
      return StudyStorage.mergeSessions(sessions);
    },
  },

  // ─── Watchers ──────────────────────────────────────────────────────────────

  watch: {
    activeTab(newTab) {
      if (newTab === 'trajectory') {
        this.$nextTick(() => this.renderChart());
      }
    },
    // Re-render chart whenever we return to step4 (e.g. after regeneration on the same tab)
    screen(newScreen) {
      if (newScreen === 'step4' && this.activeTab === 'trajectory') {
        this.$nextTick(() => this.renderChart());
      }
    },
  },

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  mounted() {
    this.settingsSrText = (this.settings.srIntervals || [6,16,45,131]).join(', ');

    // Restore in-progress plan from localStorage if present
    const saved = StudyStorage.loadCurrentPlan();
    if (saved) {
      try { this.restoreFromPlanData(saved); } catch (_) {}
    }
  },
};
