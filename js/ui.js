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
  'gpt-5.4',
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
      return `Practice session ${num} of ${total} for ${t}`;
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
        reason = `Practice session ${num} of ${total} for ${title}`;
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

// ─── Parse hierarchical topic input (mode 3) ─────────────────────────────────
// Accepts indented text or Markdown # / ## headings.
// Returns a flat array with { title, isGroup, _parentTempId, _tempId, difficulty, startingState }.

function parseHierarchyInput(text) {
  const rawLines = text.split('\n');

  // Annotate each non-empty line
  const lines = [];
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const isMarkdown1 = /^#\s/.test(trimmed);
    const isMarkdown2 = /^##\s/.test(trimmed);
    const isIndented  = raw.startsWith('  ') || raw.startsWith('\t');
    lines.push({ raw, trimmed, isMarkdown1, isMarkdown2, isIndented });
  }

  // Determine type for each line (two-pass)
  // Pass 1: classify
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.isMarkdown1) {
      l.type = 'group';
      l.content = l.trimmed.replace(/^#+\s*/, '');
    } else if (l.isMarkdown2) {
      l.type = 'subtopic';
      l.content = l.trimmed.replace(/^#+\s*/, '');
    } else if (l.isIndented) {
      l.type = 'subtopic';
      l.content = l.trimmed;
    } else {
      // Non-indented, non-markdown: group if the NEXT non-empty line is indented, else standalone
      const next = lines[i + 1];
      l.type    = (next && (next.isIndented || next.isMarkdown2)) ? 'group' : 'standalone';
      l.content = l.trimmed;
    }
  }

  // Pass 2: build flat result with parent references
  let idCounter  = 1;
  let currentGrp = null;
  const result   = [];

  for (const l of lines) {
    if (l.type === 'group') {
      currentGrp = { _tempId: idCounter++, title: l.content, isGroup: true, _parentTempId: null };
      result.push(currentGrp);
    } else if (l.type === 'subtopic') {
      result.push({
        _tempId:       idCounter++,
        title:         l.content,
        isGroup:       false,
        _parentTempId: currentGrp ? currentGrp._tempId : null,
        difficulty:    'medium',
        startingState: 'Not Started',
      });
    } else {
      currentGrp = null;  // reset group context on standalone line
      result.push({
        _tempId:       idCounter++,
        title:         l.content,
        isGroup:       false,
        _parentTempId: null,
        difficulty:    'medium',
        startingState: 'Not Started',
      });
    }
  }

  return result;
}

// ─── Vue app definition ───────────────────────────────────────────────────────

window.StudyApp = {
  template: `
<div id="app-inner">

  <!-- ── Header ──────────────────────────────────────────────────────────── -->
  <header class="app-header">
    <span class="logo" style="cursor:pointer" @click="navigate('home')">
      <img src="assets/appLogo.png" class="header-app-logo" alt="">
      Study Planner
    </span>
    <div class="breadcrumb" v-if="screen !== 'home'">
      <span>›</span>
      <span>{{ screenLabel }}</span>
    </div>
    <div class="header-actions">
      <img src="assets/KinnuLogo.jpeg" class="header-kinnu-logo" alt="Kinnu">
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
        <img src="assets/appLogo.png" class="home-hero-logo" alt="Study Planner">
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
              <h4>AI generates everything</h4>
              <p>Enter the exam name. AI creates a structured hierarchy of subject areas and granular study units.</p>
            </div>
            <div class="mode-card" :class="{ selected: topicInputMode === 'broadList' }"
                 @click="topicInputMode = 'broadList'">
              <h4>You choose the areas</h4>
              <p>Enter your main subject areas (one per line). AI generates the granular study units under each area for you.</p>
            </div>
            <div class="mode-card" :class="{ selected: topicInputMode === 'granularList' }"
                 @click="topicInputMode = 'granularList'">
              <h4>Full topic list</h4>
              <p>Paste your complete list. Use indentation or # headings to create groups. AI estimates difficulty only.</p>
            </div>
          </div>

          <!-- Exam name field (mode 1 & 2) -->
          <div class="form-group" v-if="topicInputMode !== 'granularList'">
            <label>Exam name</label>
            <input type="text" v-model="examName" list="exam-suggestions"
                   placeholder="e.g. CFA Level 1, SQE FLK1…"
                   @input="onExamNameInput" />
            <datalist id="exam-suggestions">
              <option v-for="exam in predefinedExams" :key="exam.id" :value="exam.name">{{ exam.description }}</option>
            </datalist>
            <span class="form-hint" v-if="selectedPredefinedExam" style="color:var(--c-success)">
              ✓ Predefined exam — topics load instantly, no AI needed for the topic list.
            </span>
          </div>

          <!-- Broad topics (mode 2) -->
          <div class="form-group" v-if="topicInputMode === 'broadList'">
            <label>Your subject areas (one per line)</label>
            <textarea v-model="broadTopicsText" rows="5" placeholder="Contract Law&#10;Tort&#10;Land Law"></textarea>
            <span class="form-hint">AI will generate granular study units under each area. You'll be able to review and edit everything on the next screen.</span>
          </div>

          <!-- Granular list (mode 3) -->
          <div class="form-group" v-if="topicInputMode === 'granularList'">
            <label>Topic list</label>
            <textarea v-model="granularTopicsText" rows="10"
              placeholder="# Contract Law&#10;  Contract Formation&#10;  Consideration&#10;  Terms of a Contract&#10;&#10;# Tort&#10;  Negligence&#10;  Psychiatric Injury&#10;&#10;Standalone Topic"></textarea>
            <span class="form-hint">Use <strong>#</strong> headings or indentation (2 spaces / tab) to create subject groups. Topics without indentation and no indented children are treated as standalone. AI estimates difficulty only.</span>
          </div>

          <!-- Free text AI notes -->
          <div class="form-group">
            <label>Additional notes for the AI <span style="font-weight:400;color:var(--c-muted)">(optional)</span></label>
            <div class="form-hint" style="margin-bottom:6px">
              You can describe your strengths, weak areas, what you've already studied, preferred study hours, and anything else relevant to your plan.
              <strong>Please review the topic list on the next screen</strong> — AI interpretation is best-effort and may not capture every nuance correctly.
            </div>
            <textarea v-model="freeText" rows="3"
              placeholder="e.g. I struggle with derivatives. I find Financial Statement Analysis easy. I've already studied Ethics. Start with 1h/day and cram at the end. Limit to 40 topics."></textarea>
          </div>

          <div class="alert alert-warn" v-if="!settings.apiKey && !(selectedPredefinedExam && !freeText.trim())">
            No API key configured. <a href="#" @click.prevent="navigate('settings')">Set it in Settings</a> before generating topics.
            <span v-if="predefinedExams.length"> Predefined exams (like CFA Level 1) don't need an API key unless you add free-text notes.</span>
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

          <!-- Applied-from-notes banner -->
          <div v-if="freeTextApplied.length" class="free-text-applied-banner">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
              <div>
                <strong style="font-size:.84rem">✓ Applied from your notes:</strong>
                <ul style="margin:4px 0 0 16px;padding:0;font-size:.82rem">
                  <li v-for="line in freeTextApplied" :key="line">{{ line }}</li>
                </ul>
              </div>
              <button class="btn btn-ghost btn-sm" style="flex-shrink:0;font-size:.75rem"
                      @click="freeTextApplied = []">✕</button>
            </div>
          </div>

          <div class="section-sub" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span>
              {{ studyTopicCount }} study topic{{ studyTopicCount !== 1 ? 's' : '' }}
              <span v-if="groupCount > 0"> in {{ groupCount }} group{{ groupCount !== 1 ? 's' : '' }}</span>.
              Drag rows to reorder, or use ↑ ↓ arrows.
            </span>
            <button v-if="hasGroups" class="btn btn-secondary btn-sm" @click="toggleAllGroups()">
              {{ allGroupsCollapsed ? '↔ Expand all groups' : '⊟ Collapse all groups' }}
            </button>
          </div>

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
                <template v-for="(topic, idx) in topics" :key="topic.id">

                  <!-- Group header row -->
                  <tr v-if="topic.isGroup" class="topic-group-row"
                      draggable="true"
                      :class="{ 'drag-over': dragOverIdx === idx, 'dragging': dragSrcIdx === idx }"
                      @dragstart="onDragStart($event, idx)"
                      @dragover.prevent="onDragOver($event, idx)"
                      @drop.prevent="onDrop($event, idx)"
                      @dragend="onDragEnd">
                    <td class="col-num" style="cursor:pointer;text-align:center;font-size:.8rem"
                        @click="toggleGroupCollapse(topic.id)">
                      {{ isGroupCollapsed(topic.id) ? '▶' : '▼' }}
                    </td>
                    <td class="col-title">
                      <input type="text" v-model="topic.title" style="font-weight:600" />
                      <span style="font-size:.72rem;color:var(--c-muted);margin-left:6px">
                        {{ subtopicCount(topic.id) }} sub-topic{{ subtopicCount(topic.id) !== 1 ? 's' : '' }}
                      </span>
                    </td>
                    <td class="col-diff">
                      <select class="select-sm" @change="groupBulkDifficulty(topic.id, $event.target.value)">
                        <option value="">Set all…</option>
                        <option value="easy">All Easy</option>
                        <option value="medium">All Medium</option>
                        <option value="hard">All Hard</option>
                      </select>
                    </td>
                    <td class="col-state">
                      <select class="select-sm" @change="groupBulkState(topic.id, $event.target.value)">
                        <option value="">Set all…</option>
                        <option value="Not Started">All Not Started</option>
                        <option value="Learned">All Learned</option>
                        <option value="Practicing">All Practicing</option>
                        <option value="Reviewing">All Reviewing</option>
                      </select>
                    </td>
                    <td class="col-actions">
                      <button class="btn btn-ghost btn-icon" title="Move group up"   @click="moveGroup(topic.id, -1)">↑</button>
                      <button class="btn btn-ghost btn-icon" title="Move group down" @click="moveGroup(topic.id,  1)">↓</button>
                      <button class="btn btn-ghost btn-icon" title="Add sub-topic" @click="addSubTopic(topic.id)">+</button>
                      <button class="btn btn-ghost btn-icon" title="Delete group and all its sub-topics" @click="deleteGroup(topic.id)">🗑</button>
                    </td>
                  </tr>

                  <!-- Sub-topic row (hidden when group is collapsed) -->
                  <tr v-else-if="topic.parentId && !isGroupCollapsed(topic.parentId)"
                      class="topic-subtopic-row"
                      draggable="true"
                      :class="{ 'drag-over': dragOverIdx === idx, 'dragging': dragSrcIdx === idx }"
                      @dragstart="onDragStart($event, idx)"
                      @dragover.prevent="onDragOver($event, idx)"
                      @drop.prevent="onDrop($event, idx)"
                      @dragend="onDragEnd">
                    <td class="col-num" style="color:var(--c-muted);padding-left:20px">↳</td>
                    <td class="col-title">
                      <input type="text" v-model="topic.title" style="padding-left:4px" />
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
                      <button class="btn btn-ghost btn-icon" title="Move up"   @click="moveSubTopic(topic.id, -1)">↑</button>
                      <button class="btn btn-ghost btn-icon" title="Move down" @click="moveSubTopic(topic.id,  1)">↓</button>
                      <button class="btn btn-ghost btn-icon" title="Delete"    @click="deleteTopic(idx)">🗑</button>
                    </td>
                  </tr>

                  <!-- Standalone topic row -->
                  <tr v-else-if="!topic.isGroup && !topic.parentId"
                      class="topic-row"
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

                </template>
              </tbody>
            </table>
          </div>

          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" @click="addTopic()">+ Add Standalone Topic</button>
            <button class="btn btn-secondary btn-sm" @click="addGroup()">+ Add Group</button>
          </div>

          <!-- State legend -->
          <div class="state-legend">
            <h4>Starting state guide</h4>
            <table>
              <thead><tr><th>State</th><th>Meaning</th><th>Scheduler behaviour</th></tr></thead>
              <tbody>
                <tr><td><strong>Not Started</strong></td><td>Topic not yet touched</td><td>Full pipeline: Learn → Practice → Reviews</td></tr>
                <tr><td><strong>Learned</strong></td><td>Content studied, ready to practice</td><td>Skip learning; begin at Practice sessions</td></tr>
                <tr><td><strong>Practicing</strong></td><td>One practice session done</td><td>Skip learning; 1 practice session already counted</td></tr>
                <tr><td><strong>Reviewing</strong></td><td>All practice sessions done</td><td>Skip learning and practice; begin at first Review</td></tr>
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
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px">
              <label style="margin-bottom:0">Study time per day</label>
              <button class="btn btn-ghost btn-sm" style="font-size:.75rem;padding:2px 8px"
                      @click="scheduleViewMode = scheduleViewMode === 'time' ? 'sessions' : 'time'">
                {{ scheduleViewMode === 'time' ? '⇄ Switch to sessions view' : '⇄ Switch to time view' }}
              </button>
            </div>
            <div class="form-hint" style="margin-bottom:6px">
              Schedule ramps from First Week to Last Week.
              <span v-if="scheduleViewMode === 'time'"> Each ± step = one {{ settings.sessionDuration }}-min session.</span>
            </div>
            <div class="session-length-note" v-if="scheduleViewMode === 'time'">
              Session length: {{ settings.sessionDuration }} min
            </div>
            <div class="schedule-grid" :class="{ 'time-mode': scheduleViewMode === 'time' }">
              <div class="sg-header">Day</div>
              <div class="sg-header">First week</div>
              <div class="sg-header">Last week</div>
              <template v-for="dow in dowLabels" :key="dow.key">
                <div class="sg-day">{{ dow.label.slice(0,3) }}</div>
                <div class="sg-cell">
                  <div v-if="scheduleViewMode === 'time'" class="sg-time-ctrl">
                    <button class="sg-step-btn" @click="firstWeek[dow.key] = Math.max(0, firstWeek[dow.key] - 1)" :disabled="firstWeek[dow.key] === 0">−</button>
                    <span class="sg-time-val">{{ fmtMins(firstWeek[dow.key] * settings.sessionDuration) }}</span>
                    <button class="sg-step-btn" @click="firstWeek[dow.key] = Math.min(20, firstWeek[dow.key] + 1)">+</button>
                  </div>
                  <span v-if="scheduleViewMode === 'time'" class="sg-sessions-hint">{{ firstWeek[dow.key] > 0 ? firstWeek[dow.key] + (firstWeek[dow.key] !== 1 ? ' sessions' : ' session') : 'off' }}</span>
                  <input v-if="scheduleViewMode !== 'time'" type="number" min="0" max="20" v-model.number="firstWeek[dow.key]" />
                  <span v-if="scheduleViewMode !== 'time' && firstWeek[dow.key] > 0" class="sg-time">{{ fmtSessionHint(firstWeek[dow.key]) }}</span>
                </div>
                <div class="sg-cell">
                  <div v-if="scheduleViewMode === 'time'" class="sg-time-ctrl">
                    <button class="sg-step-btn" @click="lastWeek[dow.key] = Math.max(0, lastWeek[dow.key] - 1)" :disabled="lastWeek[dow.key] === 0">−</button>
                    <span class="sg-time-val">{{ fmtMins(lastWeek[dow.key] * settings.sessionDuration) }}</span>
                    <button class="sg-step-btn" @click="lastWeek[dow.key] = Math.min(20, lastWeek[dow.key] + 1)">+</button>
                  </div>
                  <span v-if="scheduleViewMode === 'time'" class="sg-sessions-hint">{{ lastWeek[dow.key] > 0 ? lastWeek[dow.key] + (lastWeek[dow.key] !== 1 ? ' sessions' : ' session') : 'off' }}</span>
                  <input v-if="scheduleViewMode !== 'time'" type="number" min="0" max="20" v-model.number="lastWeek[dow.key]" />
                  <span v-if="scheduleViewMode !== 'time' && lastWeek[dow.key] > 0" class="sg-time">{{ fmtSessionHint(lastWeek[dow.key]) }}</span>
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
            <span v-if="planResult.overflow.incompleteLearnTopics.length > 0 || planResult.overflow.incompleteMCQTopics.length > 0">⚠ Schedule Overflow — action required</span>
            <span v-else-if="(planResult.overflow.mockShortfall || 0) > 0">⚠ Mock exams could not all be scheduled — action required</span>
            <span v-else>✓ Plan fits — expand to tweak schedule</span>
          </h3>
          <span>{{ overflowExpanded ? '▲ collapse' : '▼ expand' }}</span>
        </div>

        <div class="overflow-body" v-if="overflowExpanded">
          <!-- Overflow message (only when there is one) -->
          <div class="overflow-summary" v-if="planResult.overflow.hasOverflow">
            {{ overflowSummaryText }}
          </div>

          <!-- Auto-adjust button — shown only when there is topic overflow (not mock-only shortfall) -->
          <div v-if="planResult.overflow.incompleteLearnTopics.length > 0 || planResult.overflow.incompleteMCQTopics.length > 0"
               style="margin-bottom:20px;padding:14px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px">
            <p style="font-size:.88rem;margin-bottom:10px;font-weight:500">
              Let the planner increase your sessions per day automatically to make everything fit:
            </p>
            <button class="btn btn-primary btn-sm" @click="doAdjustSchedule()">⚡ Adjust schedule for me</button>
          </div>

          <p style="font-weight:600;margin-bottom:12px">
            Or adjust manually:
          </p>

          <!-- Option 1: Update study schedule -->
          <div style="margin-bottom:16px">
            <button class="btn btn-secondary btn-sm" @click="overflowEditSchedule = !overflowEditSchedule">
              {{ overflowEditSchedule ? '▲ Hide schedule' : '1. Update study schedule' }}
            </button>
            <div v-if="overflowEditSchedule" style="margin-top:12px">
              <div class="session-length-note" v-if="scheduleViewMode === 'time'" style="margin-bottom:8px">
                Session length: {{ settings.sessionDuration }} min
              </div>
              <div class="schedule-grid" :class="{ 'time-mode': scheduleViewMode === 'time' }">
                <div class="sg-header">Day</div>
                <div class="sg-header">First week</div>
                <div class="sg-header">Last week</div>
                <template v-for="dow in dowLabels" :key="dow.key">
                  <div class="sg-day">{{ dow.label.slice(0,3) }}</div>
                  <div class="sg-cell">
                    <div v-if="scheduleViewMode === 'time'" class="sg-time-ctrl">
                      <button class="sg-step-btn" @click="firstWeek[dow.key] = Math.max(0, firstWeek[dow.key] - 1)" :disabled="firstWeek[dow.key] === 0">−</button>
                      <span class="sg-time-val">{{ firstWeek[dow.key] * settings.sessionDuration }} min</span>
                      <button class="sg-step-btn" @click="firstWeek[dow.key] = Math.min(20, firstWeek[dow.key] + 1)">+</button>
                    </div>
                    <span v-if="scheduleViewMode === 'time'" class="sg-sessions-hint">
                      {{ firstWeek[dow.key] > 0 ? firstWeek[dow.key] + (firstWeek[dow.key] === 1 ? ' session' : ' sessions') : 'off' }}
                    </span>
                    <input v-if="scheduleViewMode !== 'time'" type="number" min="0" max="20" v-model.number="firstWeek[dow.key]" />
                    <span v-if="scheduleViewMode !== 'time' && firstWeek[dow.key] > 0" class="sg-time">~{{ firstWeek[dow.key] * settings.sessionDuration }} min</span>
                  </div>
                  <div class="sg-cell">
                    <div v-if="scheduleViewMode === 'time'" class="sg-time-ctrl">
                      <button class="sg-step-btn" @click="lastWeek[dow.key] = Math.max(0, lastWeek[dow.key] - 1)" :disabled="lastWeek[dow.key] === 0">−</button>
                      <span class="sg-time-val">{{ lastWeek[dow.key] * settings.sessionDuration }} min</span>
                      <button class="sg-step-btn" @click="lastWeek[dow.key] = Math.min(20, lastWeek[dow.key] + 1)">+</button>
                    </div>
                    <span v-if="scheduleViewMode === 'time'" class="sg-sessions-hint">
                      {{ lastWeek[dow.key] > 0 ? lastWeek[dow.key] + (lastWeek[dow.key] === 1 ? ' session' : ' sessions') : 'off' }}
                    </span>
                    <input v-if="scheduleViewMode !== 'time'" type="number" min="0" max="20" v-model.number="lastWeek[dow.key]" />
                    <span v-if="scheduleViewMode !== 'time' && lastWeek[dow.key] > 0" class="sg-time">~{{ lastWeek[dow.key] * settings.sessionDuration }} min</span>
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

          <!-- Option 5: Adjust mock dates -->
          <div v-if="scheduledMocks.length > 0" style="margin-bottom:16px">
            <button class="btn btn-secondary btn-sm" @click="overflowEditMocks = !overflowEditMocks">
              {{ overflowEditMocks ? '▲ Hide mock dates' : '5. Adjust mock exam dates' }}
            </button>
            <div v-if="overflowEditMocks" style="margin-top:10px">
              <div v-for="m in scheduledMocks" :key="m.mockNumber"
                   style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
                <label style="font-size:.84rem;min-width:80px;font-weight:500">Mock {{ m.mockNumber }}</label>
                <input type="date" style="width:160px"
                       :value="mockDateOverrides[m.mockNumber] || m.dateStr"
                       @change="mockDateOverrides = { ...mockDateOverrides, [m.mockNumber]: $event.target.value }" />
                <span style="font-size:.78rem;color:var(--c-muted)" v-if="!mockDateOverrides[m.mockNumber]">scheduled</span>
                <span style="font-size:.78rem;color:#2563eb" v-else>changed</span>
              </div>
              <button class="btn btn-primary btn-sm" style="margin-top:4px"
                      @click="applyMockDateOverrides()">
                ✓ Apply &amp; recalculate
              </button>
            </div>
          </div>

          <div class="action-bar" style="padding-top:12px;margin-top:8px">
            <button class="btn btn-primary" @click="doGeneratePlan()">↺ Regenerate Plan</button>
          </div>
        </div>
      </div>

      <!-- Download / save row -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-secondary btn-sm" @click="doExportDailyCsv()">⬇ Day-by-day CSV</button>
        <button class="btn btn-secondary btn-sm" @click="doExportTopicsCsv()">⬇ Topics CSV</button>
        <button class="btn btn-secondary btn-sm" @click="doExportJson()">⬇ Save plan (JSON)</button>
      </div>

      <!-- Plan stats bar -->
      <div v-if="planTotalHours !== null" class="plan-stats-bar">
        <div class="plan-stat plan-stat--highlight">
          <span class="plan-stat-value">~{{ planTotalHours }} h</span>
          <span class="plan-stat-label">total study time</span>
        </div>
        <div class="plan-stat">
          <span class="plan-stat-value">{{ studyDaysWithSessions.length }}</span>
          <span class="plan-stat-label">study days</span>
        </div>
        <div class="plan-stat">
          <span class="plan-stat-value">{{ planResult.topics.length }}</span>
          <span class="plan-stat-label">topics</span>
        </div>
        <div class="plan-stat" v-if="planResult.mocks.filter(m => m.type === 'mock').length > 0">
          <span class="plan-stat-value">{{ planResult.mocks.filter(m => m.type === 'mock').length }}</span>
          <span class="plan-stat-label">mock exams</span>
        </div>
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
        <!-- Collapsed/expanded toggle (only shown when there are groups) -->
        <div v-if="hasGroups" style="margin-bottom:10px;display:flex;align-items:center;gap:10px">
          <button class="btn btn-secondary btn-sm" @click="toggleChartCollapsed()">
            {{ chartCollapsed ? '↔ Show all topics' : '⊟ Collapsed view (by group)' }}
          </button>
          <span style="font-size:.78rem;color:var(--c-muted)">
            {{ chartCollapsed ? 'Showing one row per group' : 'Showing one row per study topic' }}
          </span>
        </div>

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
        <div class="session-length-note" style="margin-bottom:10px">
          Session length: {{ settings.sessionDuration }} min &nbsp;·&nbsp; Mock exam: {{ settings.mockDuration || 90 }} min &nbsp;·&nbsp; Post-mock revision: full day
        </div>
        <div v-if="planTotalHours !== null" style="margin-bottom:12px;font-size:.85rem;color:var(--c-muted)">
          {{ studyDaysWithSessions.length }} study days &nbsp;·&nbsp; ~{{ planTotalHours }} h total
        </div>
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
        <div class="session-length-note" style="margin-bottom:10px">
          Session length: {{ settings.sessionDuration }} min &nbsp;·&nbsp; Mock exam: {{ settings.mockDuration || 90 }} min
        </div>

        <!-- Controls (only shown when there are groups) -->
        <div v-if="hasGroups" style="margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" @click="topicSummaryCollapsed = !topicSummaryCollapsed">
            {{ topicSummaryCollapsed ? '↔ Show all topics' : '⊟ Collapsed view (by group)' }}
          </button>
          <template v-if="!topicSummaryCollapsed">
            <button class="btn btn-ghost btn-sm" @click="expandAllTopicGroups()">▼ Expand all</button>
            <button class="btn btn-ghost btn-sm" @click="collapseAllTopicGroups()">▶ Collapse all</button>
          </template>
        </div>

        <!-- Collapsed summary: one row per group -->
        <div v-if="topicSummaryCollapsed && hasGroups" class="topics-table-wrap">
          <table class="topic-summary-table">
            <thead>
              <tr>
                <th style="width:200px">Group / Topic</th>
                <th style="width:110px">Sessions</th>
                <th style="width:110px">Est. time</th>
                <th>Learn start → last practice</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="grp in collapsedTopicGroups" :key="grp.groupId || grp.groupTitle">
                <td>
                  <strong>{{ grp.groupTitle }}</strong>
                  <span v-if="!grp.isGroup" style="font-size:.75rem;color:var(--c-muted);margin-left:4px">(standalone)</span>
                </td>
                <td>{{ grp.totalSessions }}</td>
                <td>~{{ grp.totalMins }} min</td>
                <td style="font-size:.82rem;color:var(--c-muted)">
                  <span v-if="grp.firstLearnDate">{{ formatDate(grp.firstLearnDate) }}</span>
                  <span v-if="grp.firstLearnDate && grp.lastPracticeDate"> → </span>
                  <span v-if="grp.lastPracticeDate">{{ formatDate(grp.lastPracticeDate) }}</span>
                  <span v-if="!grp.firstLearnDate && !grp.lastPracticeDate">—</span>
                </td>
              </tr>
              <!-- Total row -->
              <tr style="font-weight:600;border-top:2px solid var(--c-border)">
                <td>Total</td>
                <td>{{ collapsedTopicGroups.reduce((s, g) => s + g.totalSessions, 0) }}</td>
                <td>~{{ planTotalHours }} h</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Expanded: per-topic detail with collapsible group headers -->
        <div v-else class="topics-table-wrap">
          <table class="topic-summary-table">
            <thead>
              <tr>
                <th style="width:180px">Topic</th>
                <th>Scheduled activities</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="item in groupedTopicSummaries" :key="item.type === 'group' ? item.groupId : item.summary.title">

                <!-- Group header row -->
                <tr v-if="item.type === 'group'" class="topic-group-header-row"
                    @click="toggleTopicGroup(item.groupId)" style="cursor:pointer;user-select:none">
                  <td colspan="2">
                    <span class="day-expand-icon" style="margin-right:6px">{{ isTopicGroupExpanded(item.groupId) ? '▼' : '▶' }}</span>
                    <strong>{{ item.groupTitle }}</strong>
                    <span style="font-size:.78rem;color:var(--c-muted);margin-left:8px">
                      {{ item.subtopics.length }} topic{{ item.subtopics.length !== 1 ? 's' : '' }}
                    </span>
                  </td>
                </tr>

                <!-- Sub-topic rows (visible when group is expanded) -->
                <template v-if="item.type === 'group' && isTopicGroupExpanded(item.groupId)">
                  <tr v-for="ts in item.subtopics" :key="ts.title" class="topic-subtopic-row">
                    <td style="padding-left:20px">{{ ts.title }}</td>
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
                </template>

                <!-- Standalone topic row -->
                <tr v-if="item.type === 'standalone'">
                  <td><strong>{{ item.summary.title }}</strong></td>
                  <td>
                    <div class="activity-list">
                      <div class="activity-entry" v-for="(act, ai) in item.summary.activities" :key="ai">
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

              </template>
            </tbody>
          </table>
        </div>

      </div>

      <!-- ── Tab: Calendar View ── -->
      <div v-if="activeTab === 'calendar'" class="cal-wrap">
        <div class="session-length-note" style="margin-bottom:10px">
          Session length: {{ settings.sessionDuration }} min &nbsp;·&nbsp; Mock exam: {{ settings.mockDuration || 90 }} min &nbsp;·&nbsp; Post-mock revision: full day
        </div>

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
                <template v-for="(topic, idx) in topics" :key="topic.id">
                  <tr v-if="topic.isGroup" class="topic-group-row">
                    <td class="col-num" style="text-align:center;font-size:.8rem;cursor:pointer"
                        @click="toggleGroupCollapse(topic.id)">
                      {{ isGroupCollapsed(topic.id) ? '▶' : '▼' }}
                    </td>
                    <td class="col-title" colspan="3" style="font-weight:600">
                      {{ topic.title }}
                      <span style="font-size:.72rem;color:var(--c-muted);margin-left:6px">{{ subtopicCount(topic.id) }} sub-topics</span>
                    </td>
                  </tr>
                  <tr v-else-if="topic.parentId && !isGroupCollapsed(topic.parentId)" class="topic-subtopic-row">
                    <td class="col-num" style="color:var(--c-muted);padding-left:20px">↳</td>
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
                  <tr v-else-if="!topic.isGroup && !topic.parentId">
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
                </template>
              </tbody>
            </table>
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" @click="navigate('home')">Back</button>
            <button class="btn btn-secondary" @click="doGeneratePlan()">Regenerate Plan →</button>
            <button class="btn btn-primary" @click="doAdjustSchedule()">⚡ Adjust schedule for me</button>
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
                        <strong>Interleaved</strong> — once a topic&#39;s learning sessions are done, its practice sessions are distributed across the schedule alongside other topics.
                      </span>
                    </label>
                    <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
                      <input type="radio" value="sequential" v-model="settings.learningMode" style="margin-top:3px;flex-shrink:0" />
                      <span>
                        <strong>Sequential</strong> — fully complete one topic (all learning + all practice sessions) before moving to the next. Reviews still follow the spaced-repetition schedule.
                      </span>
                    </label>
                  </div>
                </div>

                <div class="form-group">
                  <label>Study session duration (display only)</label>
                  <div class="spinner-group">
                    <button @click="settings.sessionDuration = Math.max(5, settings.sessionDuration - 5)">−</button>
                    <input type="number" min="5" max="120" step="5" v-model.number="settings.sessionDuration" />
                    <button @click="settings.sessionDuration = Math.min(120, settings.sessionDuration + 5)">+</button>
                  </div>
                  <span class="form-hint">Minutes per regular study session. Does not affect scheduling — used for time estimates only.</span>
                </div>

                <div class="form-group">
                  <label>Mock exam duration (display only)</label>
                  <div class="spinner-group">
                    <button @click="settings.mockDuration = Math.max(30, (settings.mockDuration || 90) - 15)">−</button>
                    <input type="number" min="30" max="360" step="15" v-model.number="settings.mockDuration" />
                    <button @click="settings.mockDuration = Math.min(360, (settings.mockDuration || 90) + 15)">+</button>
                  </div>
                  <span class="form-hint">Minutes for a full mock exam sitting. Does not affect scheduling — used for time estimates only.</span>
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
                  <span class="form-hint" style="display:block;margin-bottom:8px">Number of sessions (not time) assigned to each topic based on difficulty.</span>
                  <table class="activity-count-table" style="margin-top:0">
                    <thead><tr><th>Activity</th><th>Easy</th><th>Medium</th><th>Hard</th></tr></thead>
                    <tbody>
                      <tr>
                        <td>Learning sessions</td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.easy" /></td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.medium" /></td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.hard" /></td>
                      </tr>
                      <tr>
                        <td>Practice sessions</td>
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
                         placeholder="1, 6, 16, 45, 131" />
                  <span class="form-hint">First value = days after last practice session before first review. Remaining values = gaps between consecutive reviews. Default: 1, 6, 16, 45, 131</span>
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
      predefinedExams:        [],   // loaded from data/exams/index.json

      // Step 2
      topics: [],
      dragSrcIdx:  null,
      dragOverIdx: null,
      _nextTopicId: 1,
      freeTextApplied: [],   // summary lines shown at top of step 2

      // Step 3
      startDate: today,
      examDate:  '',
      firstWeek: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 },
      lastWeek:  { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 1, sun: 0 },
      rampMode:  'linear',
      numMocks:  3,

      // Step 2 — group collapse state
      collapsedGroups: {},

      // Topic summary tab collapsed view
      topicSummaryCollapsed: false,

      // Step 4
      planResult:       null,
      hydratedCalendar: [],
      chartTopicsData:  [],
      activeTab:        'trajectory',
      completionStatus: {},
      overflowExpanded: false,
      overflowEditSchedule: false,
      overflowEditDate: false,
      overflowEditMocks: false,
      mockDateOverrides: {},
      scheduleViewMode: 'time',
      chartCollapsed:   false,

      // Day-by-day collapse state (default: all collapsed)
      expandedDays: {},

      // Topic summary group collapse state (default: all collapsed)
      expandedTopicGroups: {},

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
      settingsSrText:    (settings.srIntervals || [1,6,16,45,131]).join(', '),
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

    hasGroups() {
      return this.topics.some(t => t.isGroup);
    },

    studyTopicCount() {
      return this.topics.filter(t => !t.isGroup).length;
    },

    groupCount() {
      return this.topics.filter(t => t.isGroup).length;
    },

    allGroupsCollapsed() {
      const ids = this.topics.filter(t => t.isGroup).map(t => t.id);
      return ids.length > 0 && ids.every(id => this.collapsedGroups[id]);
    },

    // Collapsed topic summary: one entry per group (or standalone topic)
    collapsedTopicGroups() {
      if (!this.planResult || !this.hydratedCalendar.length) return [];
      const summaries = this.topicSummaries; // [{title, activities}] in planTopics order

      // Build lookup: planTopic id → parentId from this.topics
      const uiTopicById = {};
      this.topics.forEach(t => { uiTopicById[t.id] = t; });

      const groups = [];
      const groupMap = {}; // groupId → index in groups

      this.planResult.topics.forEach((pt, i) => {
        const uiTopic  = uiTopicById[pt.id];
        const parentId = uiTopic?.parentId || null;
        const sum      = summaries[i];
        if (!sum) return;

        if (parentId) {
          const groupUiTopic = this.topics.find(t => t.id === parentId);
          if (!(parentId in groupMap)) {
            groupMap[parentId] = groups.length;
            groups.push({
              groupTitle: groupUiTopic?.title || 'Group',
              groupId: parentId,
              isGroup: true,
              totalSessions: 0,
              totalMins: 0,
              firstLearnDate: null,
              lastPracticeDate: null,
            });
          }
          const grp = groups[groupMap[parentId]];
          for (const act of sum.activities) {
            grp.totalSessions += act.count;
            if (act.activityType !== 'mock' && act.activityType !== 'postMock') {
              grp.totalMins += act.count * (this.settings.sessionDuration || 20);
            }
            const d = act.date instanceof Date ? act.date : new Date((act.date || '') + 'T00:00:00Z');
            if (act.activityType === 'learn') {
              if (!grp.firstLearnDate || d < grp.firstLearnDate) grp.firstLearnDate = d;
            }
            if (act.activityType === 'practice') {
              if (!grp.lastPracticeDate || d > grp.lastPracticeDate) grp.lastPracticeDate = d;
            }
          }
        } else {
          // Standalone topic
          const totalSessions = sum.activities.reduce((s, a) => s + a.count, 0);
          const totalMins = sum.activities
            .filter(a => a.activityType !== 'mock' && a.activityType !== 'postMock')
            .reduce((s, a) => s + a.count * (this.settings.sessionDuration || 20), 0);
          let firstLearnDate = null, lastPracticeDate = null;
          for (const act of sum.activities) {
            const d = act.date instanceof Date ? act.date : new Date((act.date || '') + 'T00:00:00Z');
            if (act.activityType === 'learn' && (!firstLearnDate || d < firstLearnDate)) firstLearnDate = d;
            if (act.activityType === 'practice' && (!lastPracticeDate || d > lastPracticeDate)) lastPracticeDate = d;
          }
          groups.push({ groupTitle: sum.title, groupId: null, isGroup: false, totalSessions, totalMins, firstLearnDate, lastPracticeDate });
        }
      });

      return groups;
    },

    groupedTopicSummaries() {
      if (!this.planResult || !this.hydratedCalendar.length) return [];
      const summaries = this.topicSummaries;
      const uiTopicById = {};
      this.topics.forEach(t => { uiTopicById[t.id] = t; });

      const result = [];
      const groupMap = {}; // groupId → index in result

      this.planResult.topics.forEach((pt, i) => {
        const uiTopic  = uiTopicById[pt.id];
        const parentId = uiTopic?.parentId || null;
        const sum      = summaries[i];
        if (!sum) return;

        if (parentId) {
          const groupUiTopic = this.topics.find(t => t.id === parentId);
          if (!(parentId in groupMap)) {
            groupMap[parentId] = result.length;
            result.push({ type: 'group', groupId: parentId, groupTitle: groupUiTopic?.title || 'Group', subtopics: [] });
          }
          result[groupMap[parentId]].subtopics.push(sum);
        } else {
          result.push({ type: 'standalone', summary: sum });
        }
      });

      return result;
    },

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

    selectedPredefinedExam() {
      if (this.topicInputMode !== 'examName') return null;
      const name = this.examName.trim().toLowerCase();
      return this.predefinedExams.find(e => e.name.toLowerCase() === name) || null;
    },

    canGenerateTopics() {
      if (this.topicInputMode === 'examName' && !this.examName.trim()) return false;
      if (this.topicInputMode === 'broadList' && !this.broadTopicsText.trim()) return false;
      if (this.topicInputMode === 'granularList' && !this.granularTopicsText.trim()) return false;
      // Predefined exam with no free text: no API key needed
      if (this.selectedPredefinedExam && this.topicInputMode === 'examName' && !this.freeText.trim()) return true;
      // All other cases require an API key
      return !!this.settings.apiKey;
    },

    overflowSummaryText() {
      if (!this.planResult) return '';
      const ov = this.planResult.overflow;
      const nLearn    = ov.incompleteLearnTopics.length;
      const nMCQ      = ov.incompleteMCQTopics.length;
      const nReview   = ov.missedReviewTopics.length;
      const nTopics   = this.planResult.topics.length;
      const extraSess = ov.estimatedExtraSessionsPerWeek;
      let msg = '';
      if ((ov.mockShortfall || 0) > 0) {
        const placed    = ov.placedMockCount;
        const requested = placed + ov.mockShortfall;
        msg += `Only ${placed} of ${requested} mock exam${requested > 1 ? 's' : ''} could be scheduled — the study window is too short. Consider extending the exam date or adding more study days. `;
      }
      if (nMCQ > 0) {
        msg += `${nMCQ} of ${nTopics} topics will not complete all practice sessions before the exam. `;
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

    planTotalHours() {
      if (!this.hydratedCalendar.length) return null;
      const mockMins = this.settings.mockDuration || 90;
      let totalMins = 0;
      for (const day of this.hydratedCalendar) {
        for (const s of (day.sessions || [])) {
          if (s.activityType === 'mock')          totalMins += mockMins;
          else if (s.activityType !== 'postMock') totalMins += (this.settings.sessionDuration || 20);
        }
      }
      return Math.round(totalMins / 60);
    },

    scheduledMocks() {
      if (!this.planResult?.mocks) return [];
      return this.planResult.mocks
        .filter(m => m.type === 'mock')
        .map(m => {
          const d = m.date;
          const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
          return { mockNumber: m.mockNumber, dateStr };
        })
        .sort((a, b) => a.mockNumber - b.mockNumber);
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
        this.settingsSrText = (this.settings.srIntervals || [1,6,16,45,131]).join(', ');
        this.settingsSnapshot = JSON.stringify(this.settings);
      }
      this.screen = screen;
      this.error  = null;
    },

    // ── Step 1 → Step 2 ────────────────────────────────────────────────────

    onExamNameInput() {
      // selectedPredefinedExam is now a computed property — nothing to do here.
      // Kept as a hook in case additional on-input logic is needed later.
    },

    // Apply structured free-text overrides to this.topics (leaf topics only).
    _applyFreeTextInfo(info) {
      if (!info || !Object.keys(info).length) return;

      // Build id→topic map so sub-topics can look up their parent group title
      const byId = {};
      this.topics.forEach(t => { byId[t.id] = t; });

      this.topics = this.topics.map(t => {
        if (t.isGroup) return t;
        let { difficulty, startingState } = t;

        const titleLower  = t.title.toLowerCase();
        const parentLower = t.parentId ? (byId[t.parentId]?.title || '').toLowerCase() : '';

        // A keyword matches if it appears in the topic title OR in its parent group title.
        // This lets "Financial Statement Analysis" (a group) match all its sub-topics.
        const matches = kw => {
          const k = kw.toLowerCase();
          return titleLower.includes(k) || parentLower.includes(k);
        };

        // Global starting state
        if (info.globalStartingState) startingState = info.globalStartingState;

        // Strong areas → easy (applied first so weak can override below)
        for (const area of (info.strongAreas || [])) {
          if (matches(area)) difficulty = 'easy';
        }

        // Weak areas → hard
        for (const area of (info.weakAreas || [])) {
          if (matches(area)) difficulty = 'hard';
        }

        // Per-topic overrides — most specific, applied last
        for (const ov of (info.topicOverrides || [])) {
          if (matches(ov.pattern || '')) {
            if (ov.difficulty)    difficulty    = ov.difficulty;
            if (ov.startingState) startingState = ov.startingState;
          }
        }

        return { ...t, difficulty, startingState };
      });
    },

    // Apply any settings hints extracted from free text (session duration, schedule).
    _applyFreeTextToSettings(info) {
      if (!info) return;
      let changed = false;

      // Session duration — apply first so schedule conversions use the updated value
      if (info.sessionMinutes && info.sessionMinutes >= 5 && info.sessionMinutes <= 120) {
        this.settings.sessionDuration = Math.round(info.sessionMinutes / 5) * 5;
        changed = true;
      }

      const dur     = this.settings.sessionDuration || 20;
      const toN     = mins => Math.min(12, Math.max(0, Math.round(mins / dur)));
      const WDAYS   = ['mon','tue','wed','thu','fri'];
      const WEND    = ['sat','sun'];

      // Start-of-plan intensity → firstWeek
      if (info.weekdayMinutesStart != null) {
        const n = toN(info.weekdayMinutesStart);
        WDAYS.forEach(d => { this.firstWeek[d] = n; });
        changed = true;
      }
      if (info.weekendMinutesStart != null) {
        const n = toN(info.weekendMinutesStart);
        WEND.forEach(d => { this.firstWeek[d] = n; });
        changed = true;
      }

      // End-of-plan intensity → lastWeek
      if (info.weekdayMinutesEnd != null) {
        const n = toN(info.weekdayMinutesEnd);
        WDAYS.forEach(d => { this.lastWeek[d] = n; });
        changed = true;
      }
      if (info.weekendMinutesEnd != null) {
        const n = toN(info.weekendMinutesEnd);
        WEND.forEach(d => { this.lastWeek[d] = n; });
        changed = true;
      }

      // Ensure lastWeek is always >= firstWeek per day (can't ramp down)
      for (const d of [...WDAYS, ...WEND]) {
        if (this.lastWeek[d] < this.firstWeek[d]) this.lastWeek[d] = this.firstWeek[d];
      }

      if (changed) StudyStorage.saveSettings(this.settings);

      // Dates and mock count — applied directly to plan config fields
      if (info.startDate && /^\d{4}-\d{2}-\d{2}$/.test(info.startDate))
        this.startDate = info.startDate;
      if (info.examDate && /^\d{4}-\d{2}-\d{2}$/.test(info.examDate))
        this.examDate = info.examDate;
      if (typeof info.numMocks === 'number' && info.numMocks >= 0 && info.numMocks <= 10)
        this.numMocks = info.numMocks;
    },

    // Build a human-readable summary of what was extracted & applied.
    _buildFreeTextSummary(info) {
      if (!info || !Object.keys(info).length) return [];
      const lines = [];
      if ((info.weakAreas || []).length)
        lines.push(`Difficulty set to hard: ${info.weakAreas.join(', ')}`);
      if ((info.strongAreas || []).length)
        lines.push(`Difficulty set to easy: ${info.strongAreas.join(', ')}`);
      if ((info.topicOverrides || []).length) {
        info.topicOverrides.forEach(ov => {
          const parts = [];
          if (ov.difficulty)    parts.push(`difficulty → ${ov.difficulty}`);
          if (ov.startingState) parts.push(`state → ${ov.startingState}`);
          if (parts.length) lines.push(`"${ov.pattern}": ${parts.join(', ')}`);
        });
      }
      if (info.globalStartingState && info.globalStartingState !== 'Not Started')
        lines.push(`All topics starting state: ${info.globalStartingState}`);
      if (info.maxTopics)
        lines.push(`Topic count limited to ${info.maxTopics}`);
      if (info.sessionMinutes)
        lines.push(`Session length updated to ${Math.round(info.sessionMinutes / 5) * 5} min`);
      const dur = Math.round(info.sessionMinutes / 5) * 5 || 20;
      const fmtM = m => m >= 60
        ? (m % 60 === 0 ? `${m/60}h` : `${Math.floor(m/60)}h${m%60}`)
        : `${m}min`;
      if (info.weekdayMinutesStart != null && info.weekdayMinutesEnd != null) {
        if (info.weekdayMinutesStart === info.weekdayMinutesEnd)
          lines.push(`Weekday study: ${fmtM(info.weekdayMinutesStart)}/day`);
        else
          lines.push(`Weekday study: ${fmtM(info.weekdayMinutesStart)}/day → ${fmtM(info.weekdayMinutesEnd)}/day near exam`);
      } else if (info.weekdayMinutesStart != null) {
        lines.push(`Weekday study start: ${fmtM(info.weekdayMinutesStart)}/day`);
      } else if (info.weekdayMinutesEnd != null) {
        lines.push(`Weekday study near exam: ${fmtM(info.weekdayMinutesEnd)}/day`);
      }
      if (info.weekendMinutesStart != null && info.weekendMinutesEnd != null) {
        if (info.weekendMinutesStart === info.weekendMinutesEnd)
          lines.push(`Weekend study: ${fmtM(info.weekendMinutesStart)}/day`);
        else
          lines.push(`Weekend study: ${fmtM(info.weekendMinutesStart)}/day → ${fmtM(info.weekendMinutesEnd)}/day near exam`);
      } else if (info.weekendMinutesStart != null) {
        lines.push(`Weekend study start: ${fmtM(info.weekendMinutesStart)}/day`);
      } else if (info.weekendMinutesEnd != null) {
        lines.push(`Weekend study near exam: ${fmtM(info.weekendMinutesEnd)}/day`);
      }
      if (info.startDate) lines.push(`Start date set to ${info.startDate}`);
      if (info.examDate)  lines.push(`Exam date set to ${info.examDate}`);
      if (typeof info.numMocks === 'number') lines.push(`Number of mock exams: ${info.numMocks}`);
      return lines;
    },

    async doGenerateTopics() {
      this.loading        = true;
      this.loadingMsg     = 'Asking AI to generate your topic list…';
      this.error          = null;
      this.freeTextApplied = [];

      try {
        // ── Step 1: parse free-text notes upfront (single API call, all modes) ──
        let freeTextInfo = {};
        if (this.freeText.trim()) {
          this.loadingMsg = 'Interpreting your notes…';
          freeTextInfo = await StudyApi.parseFreeText(this.freeText, this.settings.apiKey, this.settings.model);
          // Apply settings hints (session duration, schedule) immediately
          this._applyFreeTextToSettings(freeTextInfo);
        }

        // ── Step 2: build/load topic list ────────────────────────────────────
        this.loadingMsg = 'Building your topic list…';

        if (this.selectedPredefinedExam && this.topicInputMode === 'examName') {
          // Predefined exam: load from JSON, no AI topic-generation call needed
          this.loadingMsg = `Loading ${this.selectedPredefinedExam.name}…`;
          const examData = await StudyExams.loadExam(this.selectedPredefinedExam.id);
          const flat = StudyApi.flattenHierarchical(examData.topics || []);
          const titleToId = {};
          this.topics = flat.map(t => {
            const id = this._nextTopicId++;
            if (t.isGroup) titleToId[t.title] = id;
            return {
              id,
              title:         t.title,
              isGroup:       t.isGroup,
              parentId:      t.parentTitle ? (titleToId[t.parentTitle] || null) : null,
              difficulty:    t.difficulty,
              startingState: t.startingState || 'Not Started',
            };
          });

        } else if (this.topicInputMode === 'granularList') {
          // Mode 3: user provided full list; AI assigns difficulty only
          const parsed    = parseHierarchyInput(this.granularTopicsText);
          const leafItems = parsed.filter(t => !t.isGroup);

          const raw = await StudyApi.generateTopics({
            mode:           'granularList',
            granularTopics: leafItems.map(t => t.title),
            examName:       this.examName,
            freeTextInfo,                    // pass already-parsed info (no double-call)
            apiKey:         this.settings.apiKey,
            model:          this.settings.model,
          });

          // Merge AI difficulty/state back into the parsed hierarchy (preserves groups)
          let leafIdx = 0;
          const tempIdToNewId = {};
          const allTopics = parsed.map(t => {
            const id = this._nextTopicId++;
            tempIdToNewId[t._tempId] = id;
            if (t.isGroup) {
              return { id, title: t.title, isGroup: true, parentId: null, difficulty: null, startingState: null, _tempId: t._tempId, _parentTempId: t._parentTempId };
            }
            const ai = raw[leafIdx++] || {};
            return { id, title: t.title, isGroup: false, difficulty: ai.difficulty || 'medium', startingState: ai.startingState || 'Not Started', _tempId: t._tempId, _parentTempId: t._parentTempId };
          });
          this.topics = allTopics.map(({ _tempId, _parentTempId, ...t }) => ({
            ...t,
            parentId: _parentTempId ? (tempIdToNewId[_parentTempId] || null) : null,
          }));

        } else {
          // Modes 1 & 2: AI generates the full hierarchy
          const broadTopics = this.topicInputMode === 'broadList'
            ? this.broadTopicsText.split('\n').map(s => s.trim()).filter(Boolean)
            : [];

          const flat = await StudyApi.generateTopics({
            mode:        this.topicInputMode,
            examName:    this.examName,
            broadTopics,
            freeTextInfo,                    // pass already-parsed info (no double-call)
            apiKey:      this.settings.apiKey,
            model:       this.settings.model,
          });

          const titleToId = {};
          const withIds = flat.map(t => {
            const id = this._nextTopicId++;
            if (t.isGroup) titleToId[t.title] = id;
            return { ...t, id };
          });
          this.topics = withIds.map(({ parentTitle, ...t }) => ({
            ...t,
            parentId: parentTitle ? (titleToId[parentTitle] || null) : null,
          }));
        }

        // ── Step 3: deterministic post-pass — always applied for every mode ──
        // This enforces weak/strong/override rules reliably regardless of whether
        // the AI prompt hints were followed, acting as a guaranteed second layer.
        this._applyFreeTextInfo(freeTextInfo);

        // Build the summary shown at the top of step 2
        this.freeTextApplied = this._buildFreeTextSummary(freeTextInfo);

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

    onDrop(evt, destIdx) {
      const srcIdx = this.dragSrcIdx;
      if (srcIdx === null) { this.onDragEnd(); return; }

      const srcTopic = this.topics[srcIdx];

      if (srcTopic?.isGroup) {
        const { start, end } = this._groupBlock(srcIdx);
        // Dropped within own block — no-op
        if (destIdx >= start && destIdx <= end) { this.onDragEnd(); return; }
        const block     = this.topics.splice(start, end - start + 1);
        const blockSize = block.length;
        const adjusted  = destIdx > end ? destIdx - blockSize : destIdx;
        this.topics.splice(Math.max(0, Math.min(adjusted, this.topics.length)), 0, ...block);
      } else {
        if (srcIdx === destIdx) { this.onDragEnd(); return; }
        const item = this.topics.splice(srcIdx, 1)[0];
        this.topics.splice(destIdx, 0, item);
      }

      this.onDragEnd();
    },

    onDragEnd() {
      this.dragSrcIdx  = null;
      this.dragOverIdx = null;
    },

    // Returns the index range [start, end] (inclusive) of a group header + its sub-topics.
    _groupBlock(groupIdx) {
      const groupId = this.topics[groupIdx].id;
      let end = groupIdx;
      for (let i = groupIdx + 1; i < this.topics.length; i++) {
        if (this.topics[i].parentId === groupId) end = i;
        else break;
      }
      return { start: groupIdx, end };
    },

    moveGroup(groupId, dir) {
      const idx = this.topics.findIndex(t => t.id === groupId);
      if (idx === -1) return;
      const { start, end } = this._groupBlock(idx);
      const block = this.topics.splice(start, end - start + 1);

      if (dir < 0) {
        // Move up: insert before the predecessor unit
        if (start === 0) { this.topics.splice(0, 0, ...block); return; }
        const prev = this.topics[start - 1];
        let insertAt;
        if (prev.isGroup) {
          insertAt = start - 1;
        } else if (prev.parentId) {
          insertAt = this.topics.findIndex(t => t.id === prev.parentId);
        } else {
          insertAt = start - 1;
        }
        this.topics.splice(insertAt, 0, ...block);
      } else {
        // Move down: insert after the successor unit
        if (start >= this.topics.length) { this.topics.push(...block); return; }
        const next = this.topics[start];
        let insertAfter;
        if (next.isGroup) {
          insertAfter = this._groupBlock(start).end;
        } else if (next.parentId) {
          insertAfter = start;
          for (let i = start + 1; i < this.topics.length; i++) {
            if (this.topics[i].parentId === next.parentId) insertAfter = i;
            else break;
          }
        } else {
          insertAfter = start;
        }
        this.topics.splice(insertAfter + 1, 0, ...block);
      }
    },

    // ── Group / hierarchy helpers ───────────────────────────────────────────

    addGroup() {
      this.topics.push({
        id:            this._nextTopicId++,
        title:         'New Group',
        isGroup:       true,
        parentId:      null,
        difficulty:    null,
        startingState: null,
      });
    },

    addSubTopic(parentId) {
      let insertIdx = this.topics.findIndex(t => t.id === parentId);
      // Find last existing sub-topic of this group
      for (let i = insertIdx + 1; i < this.topics.length; i++) {
        if (this.topics[i].parentId === parentId) insertIdx = i;
        else break;
      }
      this.topics.splice(insertIdx + 1, 0, {
        id:            this._nextTopicId++,
        title:         'New sub-topic',
        isGroup:       false,
        parentId,
        difficulty:    'medium',
        startingState: 'Not Started',
      });
    },

    deleteGroup(groupId) {
      this.topics = this.topics.filter(t => t.id !== groupId && t.parentId !== groupId);
    },

    toggleGroupCollapse(groupId) {
      this.collapsedGroups = {
        ...this.collapsedGroups,
        [groupId]: !this.collapsedGroups[groupId],
      };
    },

    isGroupCollapsed(groupId) {
      return !!this.collapsedGroups[groupId];
    },

    subtopicCount(groupId) {
      return this.topics.filter(t => t.parentId === groupId).length;
    },

    groupBulkDifficulty(groupId, value) {
      if (!value) return;
      this.topics = this.topics.map(t =>
        t.parentId === groupId ? { ...t, difficulty: value } : t
      );
    },

    groupBulkState(groupId, value) {
      if (!value) return;
      this.topics = this.topics.map(t =>
        t.parentId === groupId ? { ...t, startingState: value } : t
      );
    },

    moveSubTopic(topicId, dir) {
      const idx = this.topics.findIndex(t => t.id === topicId);
      if (idx < 0) return;
      const parentId = this.topics[idx].parentId;
      // Find siblings (same parentId)
      const siblings = this.topics
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t.parentId === parentId);
      const pos = siblings.findIndex(({ t }) => t.id === topicId);
      const swapPos = pos + dir;
      if (swapPos < 0 || swapPos >= siblings.length) return;
      const swapIdx = siblings[swapPos].i;
      const copy = [...this.topics];
      [copy[idx], copy[swapIdx]] = [copy[swapIdx], copy[idx]];
      this.topics = copy;
    },

    toggleAllGroups() {
      const ids = this.topics.filter(t => t.isGroup).map(t => t.id);
      const collapse = !this.allGroupsCollapsed;
      const next = {};
      ids.forEach(id => { next[id] = collapse; });
      this.collapsedGroups = next;
    },

    toggleChartCollapsed() {
      this.chartCollapsed = !this.chartCollapsed;
      this.$nextTick(() => this.renderChart());
    },

    // ── Step 3 → Step 4 ────────────────────────────────────────────────────

    // Build the generatePlan config from current Vue state.
    _planConfig() {
      // Groups are organisational only — filter them before passing to the scheduler
      const planTopics  = this.topics
        .filter(t => !t.isGroup)
        .map(t => ({
          id: t.id, name: t.title, difficulty: t.difficulty, startingState: t.startingState,
        }));
      const srIntervals = this.settingsSrText
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
      return {
        topics:          planTopics,
        startDate:       new Date(this.startDate + 'T00:00:00Z'),
        examDate:        new Date(this.examDate   + 'T00:00:00Z'),
        firstWeek:       this.firstWeek,
        lastWeek:        this.lastWeek,
        rampMode:        this.rampMode,
        numMocks:        this.numMocks,
        srIntervals:     srIntervals.length ? srIntervals : [1,6,16,45,131],
        postMockSameDay: this.settings.postMockSameDay !== false,
        fixedMockDates: this._buildFixedMockDates(),
        settings: {
          lnTable:                this.settings.lnTable,
          pnTable:                this.settings.pnTable,
          learningMode:           this.settings.learningMode || 'interleaved',
          maxNewTopicsPerDay:     this.settings.maxNewTopicsPerDay,
          maxDaysBetweenPractice: this.settings.maxDaysBetweenPractice || 7,
        },
      };
    },

    _buildFixedMockDates() {
      const keys = Object.keys(this.mockDateOverrides);
      if (!keys.length) return null;
      return keys
        .map(k => ({ n: Number(k), d: this.mockDateOverrides[k] }))
        .filter(x => x.d)
        .sort((a, b) => a.n - b.n)
        .map(x => new Date(x.d + 'T00:00:00Z'));
    },

    // Apply a finished generatePlan result to Vue state.
    _applyPlanResult(result) {
      this.planResult       = result;
      this.hydratedCalendar = hydrateCalendar(result.calendar, result.topics, result.mocks);

      // Build chartTopicsData from this.topics (includes groups) merged with plan results (leaf data)
      const planById = {};
      result.topics.forEach(pt => { planById[pt.id] = pt; });
      this.chartTopicsData = this.topics.map(t => ({
        id:            t.id,
        title:         t.title,
        isGroup:       t.isGroup  || false,
        parentId:      t.parentId || null,
        totalPN:       planById[t.id]?.totalPN       || 4,
        startingState: planById[t.id]?.startingState || t.startingState || 'Not Started',
      }));

      // Auto-expand the overflow panel and the schedule sub-section when the plan doesn't fit.
      this.overflowExpanded     = result.overflow.hasOverflow;
      this.overflowEditSchedule = result.overflow.hasOverflow;
      this.overflowEditMocks    = false;
      this.expandedDays         = {};
      this.expandedTopicGroups  = {};
      this.initCalMonth();
      StudyStorage.saveCurrentPlan(this.buildPlanData());
    },

    doGeneratePlan() {
      this.mockDateOverrides = {};
      this.loading    = true;
      this.loadingMsg = 'Building your study plan…';
      this.error      = null;

      setTimeout(() => {
        try {
          this._applyPlanResult(StudyPlanner.generatePlan(this._planConfig()));
          this.activeTab = 'trajectory';
          this.navigate('step4');
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loading = false;
          this.$nextTick(() => this.renderChart());
        }
      }, 50);
    },

    applyMockDateOverrides() {
      this.loading    = true;
      this.loadingMsg = 'Rescheduling with updated mock dates…';
      this.error      = null;

      setTimeout(() => {
        try {
          this._applyPlanResult(StudyPlanner.generatePlan(this._planConfig()));
          this.activeTab = 'trajectory';
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loading = false;
          this.$nextTick(() => this.renderChart());
        }
      }, 50);
    },

    // Scale firstWeek/lastWeek up so the plan fits, then regenerate.
    // Runs a first pass to measure overflow, adjusts, then runs a second pass.
    doAdjustSchedule() {
      this.loading    = true;
      this.loadingMsg = 'Adjusting schedule…';
      this.error      = null;

      setTimeout(() => {
        try {
          // First pass: measure the deficit.
          let result = StudyPlanner.generatePlan(this._planConfig());

          if (result.overflow.hasOverflow) {
            const capacity = result.calendar.reduce((s, d) => s + d.totalSessions, 0);
            const factor   = ((capacity + result.overflow.totalMissingSessions) / capacity) * 1.10;

            for (const key of Object.keys(this.firstWeek)) {
              if (this.firstWeek[key] > 0)
                this.firstWeek[key] = Math.min(12, Math.max(1, Math.round(this.firstWeek[key] * factor)));
              if (this.lastWeek[key] > 0)
                this.lastWeek[key]  = Math.min(36, Math.max(1, Math.round(this.lastWeek[key]  * factor)));
            }

            // Second pass with the adjusted schedule.
            result = StudyPlanner.generatePlan(this._planConfig());

            if (result.overflow.hasOverflow) {
              this.error = 'The schedule is at maximum capacity but the plan still overflows. Try removing some topics.';
            }
          }

          this._applyPlanResult(result);
          this.activeTab = 'trajectory';
          this.navigate('step4');
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loading = false;
          this.$nextTick(() => this.renderChart());
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

      const dateKeys = this.hydratedCalendar.map(d =>
        d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date
      );
      this._chartDateKeys = dateKeys;

      if (this.chartCollapsed && this.hasGroups) {
        // Collapsed view: one row per group (dominant state) + standalone topics
        const stateMap = StudyChart.buildCollapsedStateMap(
          this.chartTopicsData, this.hydratedCalendar, this.planResult.mocks,
        );
        this._chartStateMap = stateMap;
        StudyChart.draw(canvas, null, this.hydratedCalendar, this.planResult.mocks, {}, stateMap);
      } else {
        // Expanded view: one row per study topic, with group-header separator rows when groups exist
        let stateMap;
        if (this.hasGroups) {
          stateMap = StudyChart.buildExpandedStateMapWithGroups(
            this.chartTopicsData, this.hydratedCalendar, this.planResult.mocks,
          );
        } else {
          const leafTopics = this.chartTopicsData.filter(t => !t.isGroup);
          stateMap = StudyChart.buildStateMap(leafTopics, this.hydratedCalendar, this.planResult.mocks);
        }
        this._chartStateMap = stateMap;
        StudyChart.draw(canvas, null, this.hydratedCalendar, this.planResult.mocks, {}, stateMap);
      }
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

    // ── Topic summary group collapse ────────────────────────────────────────

    toggleTopicGroup(groupId) {
      this.expandedTopicGroups = { ...this.expandedTopicGroups, [groupId]: !this.expandedTopicGroups[groupId] };
    },

    isTopicGroupExpanded(groupId) {
      return !!this.expandedTopicGroups[groupId];
    },

    expandAllTopicGroups() {
      const expanded = {};
      this.groupedTopicSummaries.filter(g => g.type === 'group').forEach(g => { expanded[g.groupId] = true; });
      this.expandedTopicGroups = expanded;
    },

    collapseAllTopicGroups() {
      this.expandedTopicGroups = {};
    },

    dayEstimatedTime(sessions) {
      const mockMins = this.settings.mockDuration || 90;
      let mins = 0;
      for (const s of sessions) {
        if (s.activityType === 'mock')          { mins += mockMins; }
        else if (s.activityType !== 'postMock') { mins += this.settings.sessionDuration; }
      }
      return mins > 0 ? `~${mins} min` : '';
    },

    fmtMins(mins) {
      if (mins <= 0) return '0min';
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h === 0) return `${m}min`;
      return m > 0 ? `${h}h${m}` : `${h}h`;
    },

    fmtSessionHint(n) {
      if (n === 0) return 'off';
      const mins = n * (this.settings.sessionDuration || 20);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const timeStr = h > 0 ? (m > 0 ? `${h}h${m}` : `${h}h`) : `${m}m`;
      return `${n} session${n !== 1 ? 's' : ''} (${timeStr})`;
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

      // Keep _nextTopicId above the highest existing topic id to avoid collisions
      if (this.topics.length) {
        this._nextTopicId = Math.max(...this.topics.map(t => (t.id || 0))) + 1;
      }
    },

    // ── Settings ─────────────────────────────────────────────────────────────

    doCancelSettings() {
      if (this.settingsSnapshot) {
        Object.assign(this.settings, JSON.parse(this.settingsSnapshot));
        this.settingsSrText = (this.settings.srIntervals || [1,6,16,45,131]).join(', ');
      }
      this.screen    = this.prevScreen;
      this.activeTab = this.prevActiveTab;
      this.error     = null;
    },

    doSaveSettings() {
      const srArr = this.settingsSrText
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
      this.settings.srIntervals = srArr.length ? srArr : [1,6,16,45,131];

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
      if (newTab === 'trajectory' && !this.loading) {
        this.$nextTick(() => this.renderChart());
      }
    },
    screen(newScreen) {
      if (newScreen === 'step4' && this.activeTab === 'trajectory' && !this.loading) {
        this.$nextTick(() => this.renderChart());
      }
    },
  },

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  mounted() {
    this.settingsSrText = (this.settings.srIntervals || [1,6,16,45,131]).join(', ');

    // Load predefined exam index (silently ignore if unavailable — e.g. file:// protocol)
    if (typeof StudyExams !== 'undefined') {
      StudyExams.loadIndex()
        .then(list => { this.predefinedExams = list || []; })
        .catch(() => {});
    }

    // Restore in-progress plan from localStorage if present
    const saved = StudyStorage.loadCurrentPlan();
    if (saved) {
      try { this.restoreFromPlanData(saved); } catch (_) {}
    }
  },
};
