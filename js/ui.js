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

// ─── Session reason helpers ───────────────────────────────────────────────────

// firstNum: session number where this block starts (1 = beginning of topic)
// lastNum:  session number where this block ends
// total:    total sessions of this type for the topic

function learnReasonText(firstNum, lastNum, total) {
  const pct = Math.round(lastNum / (total || 1) * 100 / 5) * 5;
  if (pct >= 100) return 'Finish learning 100% of this topic';
  if (firstNum <= 1) return `Learn the first ${pct}% of this topic`;
  return `Continue learning and complete ${pct}% of this topic`;
}

function practiceReasonText(firstNum, lastNum, total) {
  const pct = Math.round(lastNum / (total || 1) * 100 / 5) * 5;
  const displayPct = Math.min(pct, 100);
  return `Complete ${displayPct}% of the MCQs for this topic`;
}

// ─── Topic phase helpers ──────────────────────────────────────────────────────

function phasesFromState(startingState) {
  const s = startingState || 'Not Started';
  return {
    enabled:    true,
    doLearn:    s === 'Not Started',
    doPractice: s !== 'Reviewing',
    doRevise:   true,
  };
}

// ─── Hydrate calendar: add topicTitle and reason to each session ──────────────

function hydrateCalendar(calendar, planTopics, mocks, sessionMins) {
  sessionMins = sessionMins || 20;
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

  // Track session counts per topic as we walk the calendar
  const mcqCount  = {};
  const learnCount = {};

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
        const total = stateMap[s.topicId]?.totalPN || 1;
        reason = practiceReasonText(num, num, total);
        return { ...s, topicTitle: title, reason, _mcqNum: num, totalPN: total };
      }

      if (s.activityType === 'learn') {
        learnCount[s.topicId] = (learnCount[s.topicId] || 0) + 1;
        const num   = learnCount[s.topicId];
        const total = stateMap[s.topicId]?.totalLN || 1;
        reason = learnReasonText(num, num, total);
        return { ...s, topicTitle: title, reason, _lnNum: num, totalLN: total };
      } else if (s.activityType === 'review') {
        reason = `Revise this topic — at least ${sessionMins} min`;
      }

      return { ...s, topicTitle: title, reason };
    });

    return { ...day, sessions };
  });
}

// ─── Build topic summaries for the topic-by-topic table ──────────────────────

function mergeSessionsWithRanges(sessions) {
  if (!sessions.length) return [];
  const out = [];
  let cur = { ...sessions[0], count: 1 };
  for (let i = 1; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.topicTitle === cur.topicTitle && s.activityType === cur.activityType) {
      cur.count++;
      if (s.activityType === 'practice') cur._lastMcqNum = s._mcqNum;
      if (s.activityType === 'learn')    cur._lastLnNum  = s._lnNum;
    } else {
      out.push(cur);
      cur = { ...s, count: 1 };
    }
  }
  out.push(cur);
  for (const block of out) {
    if (block.activityType === 'practice' && block.count > 1 && block._mcqNum != null) {
      const last  = block._lastMcqNum ?? (block._mcqNum + block.count - 1);
      block.reason = practiceReasonText(block._mcqNum, last, block.totalPN ?? 1);
    }
    if (block.activityType === 'learn' && block.count > 1 && block._lnNum != null) {
      const last  = block._lastLnNum ?? (block._lnNum + block.count - 1);
      block.reason = learnReasonText(block._lnNum, last, block.totalLN ?? 1);
    }
  }
  return out;
}

function buildTopicSummaries(hydratedCalendar, planTopics) {
  const sums = {};
  planTopics.forEach(t => { sums[t.id] = { title: t.name, activities: [] }; });

  for (const day of hydratedCalendar) {
    const merged = mergeSessionsWithRanges(day.sessions);
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
          <div class="action-card" @click="startNewPlan()">
            <div class="action-icon">📚</div>
            <h3>Start New Plan</h3>
            <p>Enter your exam, topics, and schedule to build a fresh plan from scratch.</p>
          </div>
          <div class="action-card"
               :class="{ 'action-card--disabled': savedPlans.length === 0 }"
               @click="savedPlans.length > 0 && navigate('planList')">
            <div class="action-icon">📊</div>
            <h3>Track Progress</h3>
            <p>Continue an active plan, mark study days, and recalculate.</p>
            <span v-if="savedPlans.length === 0" style="font-size:.78rem;color:var(--c-muted);margin-top:4px;display:block">No saved plans yet.</span>
          </div>
          <div class="action-card" @click="loadPlanFile()">
            <div class="action-icon">🔄</div>
            <h3>Restore Plan</h3>
            <p>Restores and continues tracking a saved plan.</p>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ PLAN LIST ════════════════ -->
    <template v-else-if="!loading && screen === 'planList'">
      <div class="section-title">Your Saved Plans</div>
      <div class="section-sub">Select a plan to track, or delete plans you no longer need.</div>
      <div class="card">
        <div class="card-body">
          <div v-if="savedPlans.length === 0" style="color:var(--c-muted);padding:12px 0">
            No saved plans found. Generate a new plan to start tracking.
          </div>
          <div v-for="plan in savedPlans" :key="plan.id" class="plan-list-item">
            <div class="plan-list-info">
              <strong>{{ plan.examName || 'Unnamed Plan' }}</strong>
              <span v-if="plan.examDate" class="plan-list-meta">Exam: {{ plan.examDate }}</span>
              <span class="plan-list-meta">Last saved: {{ plan.lastSavedAt ? plan.lastSavedAt.slice(0,10) : '—' }}</span>
            </div>
            <div class="plan-list-actions">
              <button class="btn btn-primary btn-sm" @click="doTrackPlan(plan.id)">▶ Track</button>
              <button class="btn btn-ghost btn-sm" @click="doDeletePlan(plan.id)"
                      style="color:var(--c-danger)">🗑 Delete</button>
            </div>
          </div>
        </div>
      </div>
      <div class="action-bar">
        <button class="btn btn-secondary" style="margin-right:auto" @click="goBack()">← Back</button>
        <button v-if="savedPlans.length > 0" class="btn btn-sm" style="border-color:var(--c-danger);color:var(--c-danger)" @click="doDeleteAllPlans()">
          🗑 Delete all plans
        </button>
      </div>
    </template>

    <!-- ════════════════ STEP 1 — Topic Input ════════════════ -->
    <template v-else-if="!loading && screen === 'step1'">
      <div class="stepper">
        <div class="step active"><div class="step-num">1</div><span class="step-label">Exam Setup</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">2</div><span class="step-label">Topics Setup</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">3</div><span class="step-label">Study Schedule</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">4</div><span class="step-label">Your Plan</span></div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="section-title">Topic Input</div>
          <div class="section-sub">Choose how you want to specify your topics.</div>

          <!-- Mode selector — hidden in restricted mode -->
          <div v-if="!isRestrictedMode" class="mode-cards">
            <div class="mode-card" :class="{ selected: topicInputMode === 'examName' }"
                 @click="topicInputMode = 'examName'">
              <h4>Exam name only</h4>
              <p>Enter the exam name. AI creates a structured hierarchy of subject areas and granular study units.</p>
            </div>
            <div class="mode-card" :class="{ selected: topicInputMode === 'granularList' }"
                 @click="topicInputMode = 'granularList'">
              <h4>Manually enter topic list</h4>
              <p>Paste your complete list. Use indentation or # headings to create groups. AI estimates difficulty only.</p>
            </div>
          </div>

          <!-- Exam selector: restricted mode shows a dropdown (no free typing) -->
          <div class="form-group" v-if="isRestrictedMode">
            <label>Exam</label>
            <select v-model="examName">
              <option value="" disabled>Select an exam…</option>
              <option v-for="exam in predefinedExams" :key="exam.id" :value="exam.name">{{ exam.name }}</option>
            </select>
          </div>

          <!-- Exam name field — full mode only -->
          <div class="form-group" v-if="!isRestrictedMode && topicInputMode === 'examName'">
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

          <!-- Granular list — full mode only -->
          <div class="form-group" v-if="!isRestrictedMode && topicInputMode === 'granularList'">
            <label>Topic list</label>
            <textarea v-model="granularTopicsText" rows="10"
              placeholder="# Contract Law&#10;  Contract Formation&#10;  Consideration&#10;  Terms of a Contract&#10;&#10;# Tort&#10;  Negligence&#10;  Psychiatric Injury&#10;&#10;Standalone Topic"></textarea>
            <span class="form-hint">Use <strong>#</strong> headings or indentation (2 spaces / tab) to create subject groups. Topics without indentation and no indented children are treated as standalone. AI estimates difficulty only.</span>
          </div>

          <!-- Study dates -->
          <div class="row">
            <div class="col">
              <div class="form-group">
                <label>When would you start studying?</label>
                <input type="date" v-model="startDate" />
              </div>
            </div>
            <div class="col">
              <div class="form-group">
                <label>When do you need to be ready by?</label>
                <input type="date" v-model="examDate" />
              </div>
            </div>
          </div>

          <!-- Free text AI notes — full mode only -->
          <div class="form-group" v-if="!isRestrictedMode">
            <label>Additional notes for the AI <span style="font-weight:400;color:var(--c-muted)">(optional)</span></label>
            <div class="form-hint" style="margin-bottom:6px">
              You can describe your strengths, weak areas, what you've already studied, preferred study hours, and anything else relevant to your plan.
              <strong>Please review the topic list on the next screen</strong> — AI interpretation is best-effort and may not capture every nuance correctly.
            </div>
            <textarea v-model="freeText" rows="3"
              placeholder="e.g. I struggle with derivatives. I find Financial Statement Analysis easy. I've already studied Ethics. Make sure to cover Fixed Income and Portfolio Management. Start with 1h/day and cram at the end. Limit to 40 topics."></textarea>
          </div>

          <div class="alert alert-warn" v-if="!settings.apiKey && !(selectedPredefinedExam && !freeText.trim()) && !isRestrictedMode">
            No API key configured. <a href="#" @click.prevent="navigate('settings')">Set it in Settings</a> before generating topics.
            <span v-if="predefinedExams.length"> Predefined exams (like CFA Level 1) don't need an API key unless you add free-text notes.</span>
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" style="margin-right:auto" @click="goBack()">← Back</button>
            <button class="btn btn-primary btn-lg" @click="doGenerateTopics()"
                    :disabled="!canGenerateTopics">
              Continue →
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ STEP 2 — Topics Review Table ════════════════ -->
    <template v-else-if="!loading && screen === 'step2'">
      <div class="stepper">
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Exam Setup</span></div>
        <div class="step-connector"></div>
        <div class="step active"><div class="step-num">2</div><span class="step-label">Topics Setup</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">3</div><span class="step-label">Study Schedule</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">4</div><span class="step-label">Your Plan</span></div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="section-title">Choose Topics and Time Allocation</div>
          <hr>
          <div class="section-sub">Choose which topics to include, adjust their time allocation and<br>select the preparation you want to include in your plan</div>

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

          <!-- Top action bar -->
          <div class="action-bar" style="margin-bottom:12px">
            <button class="btn btn-secondary" style="margin-right:auto" @click="goBack()">← Back</button>
            <button class="btn btn-primary btn-lg" @click="navigate('step3')"
                    :disabled="topics.filter(t => !t.isGroup && t.enabled !== false).length === 0">
              Continue →
            </button>
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
                  <th class="col-check"></th>
                  <th class="col-title">Topic</th>
                  <th class="col-diff">Time allocation</th>
                  <th class="col-state">Areas of Preparation</th>
                  <th class="col-actions">Order</th>
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
                    <td class="col-check col-check-group">
                      <input type="checkbox"
                             :checked="isGroupAllEnabled(topic.id)"
                             @change="toggleGroupEnabled(topic.id, $event.target.checked)" />
                      <span class="group-collapse-btn" @click="toggleGroupCollapse(topic.id)">
                        {{ isGroupCollapsed(topic.id) ? '▶' : '▼' }}
                      </span>
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
                        <option value="easy">All Low</option>
                        <option value="medium">All Standard</option>
                        <option value="hard">All High</option>
                      </select>
                    </td>
                    <td class="col-state">
                      <label class="phase-check"><input type="checkbox" :checked="groupLearnState(topic.id) === 'all'" :indeterminate.prop="groupLearnState(topic.id) === 'mixed'" @change="setGroupLearn(topic.id, $event.target.checked)" /> Learning</label>
                      <label class="phase-check"><input type="checkbox" :checked="groupPracticeState(topic.id) === 'all'" :indeterminate.prop="groupPracticeState(topic.id) === 'mixed'" @change="setGroupPractice(topic.id, $event.target.checked)" /> Practicing</label>
                      <label class="phase-check"><input type="checkbox" :checked="groupReviseState(topic.id) === 'all'" :indeterminate.prop="groupReviseState(topic.id) === 'mixed'" @change="setGroupRevise(topic.id, $event.target.checked)" /> Revising</label>
                    </td>
                    <td class="col-actions">
                      <button class="btn btn-ghost btn-icon" title="Move group up"   @click="moveGroup(topic.id, -1)">↑</button>
                      <button class="btn btn-ghost btn-icon" title="Move group down" @click="moveGroup(topic.id,  1)">↓</button>
                      <button v-if="!isRestrictedMode" class="btn btn-ghost btn-icon" title="Add sub-topic" @click="addSubTopic(topic.id)">+</button>
                    </td>
                  </tr>

                  <!-- Sub-topic row (hidden when group is collapsed) -->
                  <tr v-else-if="topic.parentId && !isGroupCollapsed(topic.parentId)"
                      draggable="true"
                      :class="{ 'topic-subtopic-row': true, 'topic-row--disabled': topic.enabled === false, 'drag-over': dragOverIdx === idx, 'dragging': dragSrcIdx === idx }"
                      @dragstart="onDragStart($event, idx)"
                      @dragover.prevent="onDragOver($event, idx)"
                      @drop.prevent="onDrop($event, idx)"
                      @dragend="onDragEnd">
                    <td class="col-check" style="padding-left:20px">
                      <input type="checkbox"
                             :checked="topic.enabled !== false"
                             @change="topic.enabled = $event.target.checked" />
                    </td>
                    <td class="col-title">
                      <input type="text" v-model="topic.title" style="padding-left:4px" />
                    </td>
                    <td class="col-diff">
                      <select class="select-sm" v-model="topic.difficulty">
                        <option value="easy">Low</option>
                        <option value="medium">Standard</option>
                        <option value="hard">High</option>
                      </select>
                    </td>
                    <td class="col-state">
                      <label class="phase-check"><input type="checkbox" :checked="topic.doLearn !== false"    @change="topic.doLearn    = $event.target.checked" /> Learning</label>
                      <label class="phase-check"><input type="checkbox" :checked="topic.doPractice !== false" @change="topic.doPractice = $event.target.checked" /> Practicing</label>
                      <label class="phase-check"><input type="checkbox" :checked="topic.doRevise !== false"   @change="topic.doRevise   = $event.target.checked" /> Revising</label>
                    </td>
                    <td class="col-actions">
                      <button class="btn btn-ghost btn-icon" title="Move up"   @click="moveSubTopic(topic.id, -1)">↑</button>
                      <button class="btn btn-ghost btn-icon" title="Move down" @click="moveSubTopic(topic.id,  1)">↓</button>
                    </td>
                  </tr>

                  <!-- Standalone topic row -->
                  <tr v-else-if="!topic.isGroup && !topic.parentId"
                      draggable="true"
                      :class="{ 'topic-row': true, 'topic-row--disabled': topic.enabled === false, 'drag-over': dragOverIdx === idx, 'dragging': dragSrcIdx === idx }"
                      @dragstart="onDragStart($event, idx)"
                      @dragover.prevent="onDragOver($event, idx)"
                      @drop.prevent="onDrop($event, idx)"
                      @dragend="onDragEnd">
                    <td class="col-check">
                      <input type="checkbox"
                             :checked="topic.enabled !== false"
                             @change="topic.enabled = $event.target.checked" />
                    </td>
                    <td class="col-title">
                      <input type="text" v-model="topic.title" />
                    </td>
                    <td class="col-diff">
                      <select class="select-sm" v-model="topic.difficulty">
                        <option value="easy">Low</option>
                        <option value="medium">Standard</option>
                        <option value="hard">High</option>
                      </select>
                    </td>
                    <td class="col-state">
                      <label class="phase-check"><input type="checkbox" :checked="topic.doLearn !== false"    @change="topic.doLearn    = $event.target.checked" /> Learning</label>
                      <label class="phase-check"><input type="checkbox" :checked="topic.doPractice !== false" @change="topic.doPractice = $event.target.checked" /> Practicing</label>
                      <label class="phase-check"><input type="checkbox" :checked="topic.doRevise !== false"   @change="topic.doRevise   = $event.target.checked" /> Revising</label>
                    </td>
                    <td class="col-actions">
                      <button class="btn btn-ghost btn-icon" title="Move up"    @click="moveTopic(idx, -1)" :disabled="idx === 0">↑</button>
                      <button class="btn btn-ghost btn-icon" title="Move down"  @click="moveTopic(idx,  1)" :disabled="idx === topics.length - 1">↓</button>
                    </td>
                  </tr>

                </template>
              </tbody>
            </table>
          </div>

          <div v-if="!isRestrictedMode" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" @click="addTopic()">+ Add Standalone Topic</button>
            <button class="btn btn-secondary btn-sm" @click="addGroup()">+ Add Group</button>
          </div>

          <!-- Bottom action bar -->
          <div class="action-bar">
            <button class="btn btn-secondary" style="margin-right:auto" @click="goBack()">← Back</button>
            <button class="btn btn-primary btn-lg" @click="navigate('step3')"
                    :disabled="topics.filter(t => !t.isGroup && t.enabled !== false).length === 0">
              Continue →
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ STEP 3 — Schedule & Settings ════════════════ -->
    <template v-else-if="!loading && screen === 'step3'">
      <div class="stepper">
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Exam Setup</span></div>
        <div class="step-connector"></div>
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Topics Setup</span></div>
        <div class="step-connector"></div>
        <div class="step active"><div class="step-num">3</div><span class="step-label">Study Schedule</span></div>
        <div class="step-connector"></div>
        <div class="step"><div class="step-num">4</div><span class="step-label">Your Plan</span></div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="section-title">Study Schedule</div>
          <hr>
          <!-- Plan Summary Bar (step 3) -->
          <div v-if="calculatedStudyHours !== null || topics.filter(t => !t.isGroup).length > 0" class="plan-stats-bar" style="margin-bottom:8px">
            <div class="plan-stat plan-stat--highlight"
                 :class="planFits === true ? 'plan-stat--green' : planFits === false ? 'plan-stat--red' : ''">
              <span class="plan-stat-value">~{{ allocatedStudyHours ?? 0 }}h / ~{{ calculatedStudyHours ?? 0 }}h</span>
              <span class="plan-stat-label">study time allocated</span>
            </div>
            <div class="plan-stat" v-if="recommendedAvailableDays > 0">
              <span class="plan-stat-value">{{ recommendedAvailableDays }}</span>
              <span class="plan-stat-label">study days</span>
            </div>
            <div class="plan-stat">
              <span class="plan-stat-value">{{ topics.filter(t => !t.isGroup && t.enabled !== false).length }}</span>
              <span class="plan-stat-label">topics</span>
            </div>
            <div class="plan-stat" v-if="numMocks > 0">
              <span class="plan-stat-value">{{ numMocks }}</span>
              <span class="plan-stat-label">mock exams</span>
            </div>
          </div>
          <p v-if="planPreviewStatusText" class="plan-status-text"
             :class="planFits === false ? 'plan-status-text--red' : 'plan-status-text--green'"
             style="margin-bottom:16px">{{ planPreviewStatusText }}</p>

          <!-- Break days -->
          <div class="form-group">
            <label>Break days</label>
            <div class="form-hint" style="margin-bottom:8px">Dates excluded from study planning (holidays, travel, etc.).</div>
            <div v-if="breakDays.length" class="break-days-list">
              <span v-for="d in breakDays" :key="d" class="break-day-chip">
                {{ d }}
                <button class="break-day-remove" @click="removeBreakDay(d)" title="Remove">×</button>
              </span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
              <button class="btn btn-secondary btn-sm" @click="addBreakDay()">+ Add break day</button>
              <input ref="breakDayPicker" type="date" v-model="breakDayInputVal"
                     :min="startDate" :max="examDate"
                     @change="onBreakDayPicked"
                     style="position:absolute;opacity:0;pointer-events:none;width:0;height:0" />
            </div>
          </div>

          <div class="form-group">
            <label>Study schedule</label>
            <div class="form-hint" style="margin-bottom:10px">Set your base weekly pace. Each ± step = 20 minutes.</div>
            <div class="schedule-layout">

              <!-- Left: First week table -->
              <div class="schedule-left">
                <div class="sched-week-title">Week 1 — base pace</div>
                <div class="sched-table">
                  <div class="sched-row sched-header-row">
                    <span class="sched-day-col">Day</span>
                    <span class="sched-ctrl-col">Daily study</span>
                    <span class="sched-hint-col"></span>
                  </div>
                  <div v-for="dow in dowLabels" :key="dow.key" class="sched-row">
                    <span class="sched-day-col">{{ dow.label.slice(0,3) }}</span>
                    <div class="sched-ctrl-col">
                      <div class="sg-time-ctrl">
                        <button class="sg-step-btn" @click="firstWeek[dow.key] = Math.max(0, firstWeek[dow.key] - 20)" :disabled="firstWeek[dow.key] === 0">−</button>
                        <span class="sg-time-val">{{ fmtMins(firstWeek[dow.key]) }}</span>
                        <button class="sg-step-btn" @click="firstWeek[dow.key] = Math.min(720, firstWeek[dow.key] + 20)">+</button>
                      </div>
                    </div>
                    <span class="sched-hint-col sg-sessions-hint">
                      <template v-if="firstWeek[dow.key] > 0">
                        {{ Math.floor(firstWeek[dow.key] / unitLength) }} units
                      </template>
                      <template v-else>off</template>
                    </span>
                  </div>
                  <div class="sched-row sched-apply-row">
                    <span class="sched-day-col" style="font-size:.78rem;color:var(--c-muted)">All</span>
                    <div class="sched-ctrl-col">
                      <div class="sg-time-ctrl">
                        <button class="sg-step-btn" @click="adjustAllDays(-20)">−</button>
                        <span class="sg-time-val" style="font-size:.75rem;color:var(--c-muted)">apply to all</span>
                        <button class="sg-step-btn" @click="adjustAllDays(20)">+</button>
                      </div>
                    </div>
                    <span class="sched-hint-col"></span>
                  </div>
                </div>
                <div class="sched-total">
                  Week 1 total: <strong>{{ fmtMins(firstWeekTotalMins) }}</strong>
                </div>
              </div>

              <!-- Right: Chart + controls -->
              <div class="schedule-right">
                <!-- Spacer to align chart top with table rows (matches sched-week-title height) -->
                <div class="sched-week-title" style="visibility:hidden" aria-hidden="true">Week 1</div>
                <div class="sched-chart-wrap" @mousemove="onScheduleChartMouseMove" @mouseleave="scheduleTooltip.visible = false">
                  <canvas ref="scheduleCanvas" class="sched-chart-canvas"></canvas>
                  <div v-if="scheduleTooltip.visible" class="sched-tooltip"
                       :style="{ left: scheduleTooltip.x + 'px', top: scheduleTooltip.y + 'px' }">
                    {{ scheduleTooltip.text }}
                  </div>
                </div>
                <div class="sched-chart-meta" v-if="schedulePreviewData.length">
                  Total plan: ~<strong>{{ totalScheduleHours }}h</strong>
                  <span style="color:var(--c-muted);font-size:.78rem"> across {{ schedulePreviewData.length }} week{{ schedulePreviewData.length !== 1 ? 's' : '' }}</span>
                </div>
                <div class="sched-chart-meta" v-else style="color:var(--c-muted);font-size:.82rem">
                  Set study dates to see weekly preview
                </div>
                <div class="sched-ramp-row">
                  <label class="sched-radio-opt">
                    <input type="radio" value="linear" v-model="rampMode" />
                    <span>Linear increase</span>
                  </label>
                  <label class="sched-radio-opt">
                    <input type="radio" value="cram" v-model="rampMode" />
                    <span>Cram at the end</span>
                  </label>
                </div>
                <div class="sched-intensity-row">
                  <span class="sched-intensity-label">Peak intensity</span>
                  <div class="sg-time-ctrl">
                    <button class="sg-step-btn" @click="adjustIntensity(-0.25)" :disabled="intensityMultiplier <= 1">−</button>
                    <span class="sg-time-val" style="min-width:44px">×{{ intensityMultiplier.toFixed(2) }}</span>
                    <button class="sg-step-btn" @click="adjustIntensity(0.25)">+</button>
                  </div>
                  <span class="sched-intensity-hint">~{{ fmtMins(lastWeekTotalMins) }}/week at exam</span>
                </div>
              </div>

            </div>
          </div>

          <div class="form-group">
            <label>Number of mock exams</label>
            <div class="form-hint" style="margin-bottom:6px">Minimum 3 recommended. Set to 0 to skip mock exams entirely.</div>
            <div class="spinner-group">
              <button @click="numMocks = Math.max(0, numMocks - 1)">−</button>
              <input type="number" min="0" max="10" v-model.number="numMocks" />
              <button @click="numMocks = Math.min(10, numMocks + 1)">+</button>
            </div>
          </div>

          <div class="alert alert-warn" v-if="!examDate || !startDate">
            Please set a study start date and a "Be ready by" date on the previous screen.
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" style="margin-right:auto" @click="goBack()">← Back</button>
            <button class="btn btn-primary btn-lg" @click="doGeneratePlan()"
                    :disabled="!examDate || !startDate"
                    :style="planFits === false ? 'background:var(--c-danger);border-color:var(--c-danger)' : planFits === true ? 'background:#16a34a;border-color:#16a34a' : ''">
              Generate Plan →
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ STEP 4 — Plan View ════════════════ -->
    <template v-else-if="!loading && screen === 'step4' && planResult">

      <div v-if="!trackingMode" class="stepper">
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Exam Setup</span></div>
        <div class="step-connector"></div>
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Topics Setup</span></div>
        <div class="step-connector"></div>
        <div class="step done"><div class="step-num">✓</div><span class="step-label">Study Schedule</span></div>
        <div class="step-connector"></div>
        <div class="step active"><div class="step-num">4</div><span class="step-label">Your Plan</span></div>
      </div>

      <!-- ── Unmarked past activities prompt ── -->
      <div v-if="unmarkedPastPromptVisible" class="automark-overlay">
        <div class="automark-dialog">
          <h3 style="margin:0 0 10px">Unmarked past activities</h3>
          <p style="margin:0 0 18px;color:var(--c-muted);font-size:.9rem">
            There are past activities that haven't been marked as Done or Skip. All activities must have a status before updating. Would you like to <strong>mark all unmarked ones as Done</strong>, or go back and mark them manually?
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" @click="confirmAutoMarkPast()">Mark all as done</button>
            <button class="btn btn-secondary" @click="dismissUnmarkedPastPrompt()">I'll mark manually</button>
          </div>
        </div>
      </div>

      <!-- ── Reschedule-from prompt overlay ── -->
      <div v-if="rescheduleFromPromptVisible" class="automark-overlay">
        <div class="automark-dialog">
          <h3 style="margin:0 0 10px">Include today's activities?</h3>
          <p style="margin:0 0 18px;color:var(--c-muted);font-size:.9rem">
            Today has activities that haven't been marked as done. Should rescheduling start from <strong>today</strong> (so pending activities are included today), or from <strong>tomorrow</strong>?
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" @click="confirmRescheduleFromToday()">Start from today</button>
            <button class="btn btn-secondary" @click="confirmRescheduleFromTomorrow()">Start from tomorrow</button>
          </div>
        </div>
      </div>

      <!-- ── Auto-mark prompt overlay ── -->
      <div v-if="autoMarkPromptVisible" class="automark-overlay">
        <div class="automark-dialog">
          <h3 style="margin:0 0 10px">You have unreviewed past sessions</h3>
          <p style="margin:0 0 18px;color:var(--c-muted);font-size:.9rem">
            There are study sessions from previous days with no status marked.
            Would you like to automatically mark them all as <strong>Done</strong>?
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" @click="confirmAutoMark()">Yes, mark all as done</button>
            <button class="btn btn-secondary" @click="dismissAutoMark()">No, I'll mark manually</button>
          </div>
        </div>
      </div>

      <!-- ── TRACKING MODE header ── -->
      <template v-if="trackingMode">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h2 style="margin:0;font-size:1.6rem;font-weight:700">Your Study Plan</h2>
          <div style="display:flex;gap:8px;align-items:center">
            <span v-if="simulatedToday" class="tracking-simulated" @click="openDebugDialog()" style="cursor:pointer;font-size:.8rem">⚠ Simulated date</span>
            <button class="btn btn-secondary btn-sm" style="background:#111;border-color:#111;color:#fff" @click="navigate('settings')">⚙ Edit Study Plan</button>
          </div>
        </div>
        <hr style="margin:0 0 16px;border:none;border-top:1px solid var(--c-border)">
        <div style="font-weight:600;font-size:1rem;margin-bottom:10px">Progress</div>
        <!-- Tracking stats bar (amounts left) -->
        <div class="plan-stats-bar" style="margin-bottom:8px">
          <div class="plan-stat plan-stat--highlight"
               :class="(planFutureHours || 0) >= (studyTimeLeftHours || 0) ? 'plan-stat--green' : 'plan-stat--red'">
            <span class="plan-stat-value">~{{ planFutureHours }}h / ~{{ studyTimeLeftHours }}h</span>
            <span class="plan-stat-label">study time left</span>
          </div>
          <div class="plan-stat">
            <span class="plan-stat-value">{{ daysLeft }}</span>
            <span class="plan-stat-label">days left</span>
          </div>
          <div class="plan-stat">
            <span class="plan-stat-value">{{ topicsLeft }}</span>
            <span class="plan-stat-label">topics left</span>
          </div>
          <div class="plan-stat" v-if="planResult.mocks.filter(m => m.type === 'mock').length > 0">
            <span class="plan-stat-value">{{ mocksLeft }}</span>
            <span class="plan-stat-label">mock exams left</span>
          </div>
        </div>
        <!-- Status text -->
        <p v-if="planResultStatusText" class="plan-status-text"
           :class="planResult.overflow.hasOverflow ? 'plan-status-text--red' : 'plan-status-text--green'"
           style="margin-bottom:12px">{{ planResultStatusText }}</p>
        <!-- Dismissable warning -->
        <div v-if="manualMarkReminderVisible" class="manual-mark-reminder">
          <span>⚠ Unmarked past sessions will be rescheduled when you click Apply & Update. Mark each activity Done or Skip before applying.</span>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto;flex-shrink:0" @click="manualMarkReminderVisible = false">Dismiss</button>
        </div>
      </template>

      <!-- ── NON-TRACKING MODE header ── -->
      <template v-else>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <span class="section-title" style="margin:0">Your Study Plan</span>
          <button class="btn btn-secondary btn-sm" style="background:#111;border-color:#111;color:#fff" @click="navigate('settings')">⚙ Edit Study Plan</button>
        </div>
        <template v-if="planTotalHours !== null">
          <div class="plan-stats-bar" style="margin-bottom:8px">
            <div class="plan-stat plan-stat--highlight"
                 :class="planResult.overflow.hasOverflow ? 'plan-stat--red' : 'plan-stat--green'">
              <span class="plan-stat-value">~{{ planTotalHours }}h / ~{{ calculatedStudyHours ?? planTotalHours }}h</span>
              <span class="plan-stat-label">study time in plan</span>
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
          <p v-if="planResultStatusText" class="plan-status-text"
             :class="planResult.overflow.hasOverflow ? 'plan-status-text--red' : 'plan-status-text--green'"
             style="margin-bottom:12px">{{ planResultStatusText }}</p>
        </template>
      </template>

      <!-- Tabs -->
      <div class="tab-bar">
        <button class="tab-btn" :class="{ active: activeTab === 'calendar' }"   @click="setTab('calendar')">Calendar</button>
        <button class="tab-btn" :class="{ active: activeTab === 'daily' }"      @click="setTab('daily')">Day-by-Day</button>
        <button class="tab-btn" :class="{ active: activeTab === 'topics' }"     @click="setTab('topics')">Topic Summary</button>
        <button v-if="debugMode" class="tab-btn" :class="{ active: activeTab === 'trajectory' }" @click="setTab('trajectory')">Visual Trajectory</button>
      </div>

      <!-- ── Tab: Visual Trajectory (debug only) ── -->
      <div v-if="debugMode && activeTab === 'trajectory'">
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
        <div style="margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" @click="expandAllDays()">▼ Expand all</button>
          <button class="btn btn-ghost btn-sm" @click="collapseAllDays()">▶ Collapse all</button>
        </div>
        <template v-for="item in dailyViewItems" :key="item.dateKey">
          <!-- Break day row -->
          <div v-if="item.itemType === 'break'" class="day-block day-block--break"
               :class="{ 'day-block--past': isPast(item.dateKey) }">
            <div class="day-header">
              {{ formatDate(item.date) }}
              <span class="break-day-badge">Break day</span>
            </div>
          </div>
          <!-- Normal study day row -->
          <div v-else class="day-block"
               :class="{
                 'day-block--today':    item.dateKey === todayKey,
                 'day-block--blocked':  isBlockedDay(item.dateKey),
                 'day-block--past':     isPast(item.dateKey),
                 'day-block--all-done': fullyDoneDays[item.dateKey],
               }">
            <div class="day-header" @click="toggleDay(item.dateKey)" style="cursor:pointer;user-select:none">
              <span class="day-expand-icon">{{ isDayExpanded(item.dateKey) ? '▼' : '▶' }}</span>
              {{ formatDate(item.date) }}
              <span v-if="item.dateKey === todayKey" class="today-badge">Today</span>
              <span v-if="isBlockedDay(item.dateKey)" class="blocked-badge">Not studying</span>
              <span class="session-count">
                {{ item.sessions.length }} unit{{ item.sessions.length !== 1 ? 's' : '' }}
                <span class="day-time-est" v-if="dayEstimatedTime(item.sessions)">· {{ dayEstimatedTime(item.sessions) }}</span>
              </span>
              <button v-if="trackingMode" class="btn btn-ghost btn-sm day-block-btn"
                      :class="{ 'day-block-btn--blocked': isBlockedDay(item.dateKey) }"
                      @click.stop="toggleBlockedDay(item.dateKey)"
                      :title="isBlockedDay(item.dateKey) ? 'Mark as studied' : 'Mark as not studied'">
                {{ isBlockedDay(item.dateKey) ? '✓ Unblock' : '✕ Skip day' }}
              </button>
            </div>
            <template v-if="isDayExpanded(item.dateKey)">
              <!-- Ordered activity bar -->
              <div class="day-act-bar" v-if="item.sessions.length">
                <div v-for="(seg, si) in dayActivityBar(item.sessions)" :key="si"
                     class="day-act-seg"
                     :style="{ background: seg.color, flex: seg.pct }"
                     :title="seg.label">{{ si + 1 }}</div>
              </div>
              <!-- Session rows — grid layout for column alignment -->
              <div class="sessions-grid">
                <div v-for="(block, bi) in mergeSessions(item.sessions)" :key="bi"
                     class="session-row"
                     :class="{
                       'session-row--done': trackingMode && isSessionDone(item.dateKey, block),
                       'session-row--skip': trackingMode && isSessionSkipped(item.dateKey, block),
                     }">
                  <span class="session-num">{{ bi + 1 }}</span>
                  <span class="activity-pill" :class="pillClass(block.activityType)">{{ activityLabel(block.activityType) }}</span>
                  <span class="session-topic">{{ block.topicTitle || (block.activityType === 'mock' ? 'Mock Exam' : 'Post-Mock Revision') }}</span>
                  <span class="session-reason">{{ block.reason }}</span>
                  <span class="session-track">
                    <template v-if="trackingMode && item.dateKey <= todayKey">
                      <template v-if="lockedDays[item.dateKey]">
                        <span class="track-locked-badge">🔒</span>
                      </template>
                      <template v-else>
                        <button class="btn btn-xs track-btn"
                                :class="isSessionSkipped(item.dateKey, block) ? 'track-btn--skip' : ''"
                                @click.stop="setSessionStatus(item.dateKey, block, 'skip')">✕ Defer</button>
                        <button class="btn btn-xs track-btn"
                                :class="isSessionDone(item.dateKey, block) ? 'track-btn--done' : ''"
                                @click.stop="setSessionStatus(item.dateKey, block, 'done')">✓ Mark complete</button>
                      </template>
                    </template>
                  </span>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>

      <!-- ── Tab: Topic Summary ── -->
      <div v-if="activeTab === 'topics'">
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
                <td>~{{ fmtMins(grp.totalMins) }}</td>
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
                <td>~{{ planTotalHours }}h</td>
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
                        <div class="activity-entry" :class="{ 'activity-entry--past': isPastDate(act.date) }" v-for="(act, ai) in ts.activities" :key="ai">
                          <span class="date">{{ formatDate(act.date) }}</span>
                          <span class="type"><span class="activity-pill" :class="pillClass(act.activityType)">{{ activityLabel(act.activityType) }}</span></span>
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
                      <div class="activity-entry" :class="{ 'activity-entry--past': isPastDate(act.date) }" v-for="(act, ai) in item.summary.activities" :key="ai">
                        <span class="date">{{ formatDate(act.date) }}</span>
                        <span class="type"><span class="activity-pill" :class="pillClass(act.activityType)">{{ activityLabel(act.activityType) }}</span></span>
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

        <!-- Day navigation bar + detail panel -->
        <template v-if="calendarPopover">
          <!-- Day nav: prev | current | next -->
          <div class="cal-day-nav">
            <button class="cal-day-nav-btn" @click="calNavPrevDay()">
              <span class="cal-nav-arrow">‹</span>
              <span class="cal-nav-label">{{ calNavPrevLabel }}</span>
            </button>
            <div class="cal-day-nav-current">{{ calNavCurrentLabel }}</div>
            <button class="cal-day-nav-btn cal-day-nav-btn--right" @click="calNavNextDay()">
              <span class="cal-nav-label">{{ calNavNextLabel }}</span>
              <span class="cal-nav-arrow">›</span>
            </button>
          </div>

          <!-- Day detail box -->
          <div class="cal-detail">
            <div class="cal-detail-header">
              <strong>{{ calDetailTitle }}</strong>
            </div>
            <div>
              <div v-if="isBlockedDay(calendarPopover.dateKey)" class="cal-detail-blocked">
                This day is marked as a skip day. Submit and update plan to reschedule its sessions.
              </div>
              <div class="cal-detail-body" v-if="calendarPopover.sessions.length">
                <div class="day-act-bar" style="margin-bottom:8px">
                  <div v-for="(seg, si) in dayActivityBar(calendarPopover.sessions)" :key="si"
                       class="day-act-seg"
                       :style="{ background: seg.color, flex: seg.pct }"
                       :title="seg.label">{{ si + 1 }}</div>
                </div>
                <div class="sessions-grid">
                  <div v-for="(block, bi) in mergeSessions(calendarPopover.sessions)" :key="bi"
                       class="session-row"
                       :class="{
                         'session-row--done': isSessionDone(calendarPopover.dateKey, block),
                         'session-row--skip': isSessionSkipped(calendarPopover.dateKey, block),
                       }">
                    <span class="session-num">{{ bi + 1 }}</span>
                    <span class="activity-pill" :class="pillClass(block.activityType)">{{ activityLabel(block.activityType) }}</span>
                    <span class="session-topic">{{ block.topicTitle || (block.activityType === 'mock' ? 'Mock Exam' : 'Post-Mock Revision') }}</span>
                    <span class="session-reason">{{ block.reason }}</span>
                    <span class="session-track">
                      <template v-if="trackingMode && calendarPopover.dateKey <= todayKey">
                        <template v-if="lockedDays[calendarPopover.dateKey]">
                          <span class="track-locked-badge">🔒</span>
                        </template>
                        <template v-else>
                          <button class="btn btn-xs track-btn"
                                  :class="isSessionSkipped(calendarPopover.dateKey, block) ? 'track-btn--skip' : ''"
                                  @click="setSessionStatus(calendarPopover.dateKey, block, 'skip')">✕ Defer</button>
                          <button class="btn btn-xs track-btn"
                                  :class="isSessionDone(calendarPopover.dateKey, block) ? 'track-btn--done' : ''"
                                  @click="setSessionStatus(calendarPopover.dateKey, block, 'done')">✓ Mark complete</button>
                        </template>
                      </template>
                    </span>
                  </div>
                </div>
              </div>
              <div v-else class="cal-detail-empty">No sessions scheduled.</div>

              <!-- Tracking footer -->
              <div v-if="trackingMode" class="cal-detail-track-footer">
                <div class="cal-detail-footer-left">
                  <button v-if="trackingMode && calendarPopover.dateKey > todayKey"
                          class="btn btn-sm"
                          :class="isBlockedDay(calendarPopover.dateKey) ? 'btn-primary' : 'btn-secondary'"
                          @click="doSkipDayAndUpdate(calendarPopover.dateKey)">
                    {{ isBlockedDay(calendarPopover.dateKey) ? '✓ Unblock day' : '✕ Skip day and update plan' }}
                  </button>
                </div>
                <span class="cal-detail-footer-hint">Mark activities then submit to reschedule.</span>
                <button class="btn btn-primary btn-sm" @click="doApplyAndUpdate()">↺ Submit and update plan</button>
              </div>
            </div>
          </div>
        </template>

        <!-- Nav: view toggle + month/week navigation -->
        <div class="cal-nav">
          <div class="cal-view-toggle">
            <button class="cal-toggle-btn" :class="{ active: calViewMode === 'month' }" @click="switchCalView('month')">Month</button>
            <button class="cal-toggle-btn" :class="{ active: calViewMode === 'week' }"  @click="switchCalView('week')">Week</button>
          </div>
          <div class="cal-nav-pager" v-if="calViewMode === 'month'">
            <button class="btn btn-ghost btn-sm cal-today-btn" @click="goToToday()">Today</button>
            <button class="btn btn-ghost btn-sm" @click="prevCalMonth()">← Prev</button>
            <span class="cal-month-label">{{ calendarMonthLabel }}</span>
            <button class="btn btn-ghost btn-sm" @click="nextCalMonth()">Next →</button>
          </div>
          <div class="cal-nav-pager" v-else>
            <button class="btn btn-ghost btn-sm cal-today-btn" @click="goToToday()">Today</button>
            <button class="btn btn-ghost btn-sm" @click="prevCalWeek()">← Prev</button>
            <span class="cal-month-label">{{ calendarWeekLabel }}</span>
            <button class="btn btn-ghost btn-sm" @click="nextCalWeek()">Next →</button>
          </div>
        </div>

        <!-- Month view: Design B card grid -->
        <template v-if="calViewMode === 'month'">
          <div class="cal-grid">
            <div class="cal-dow" v-for="d in ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']" :key="d">{{ d }}</div>
            <template v-for="(cell, ci) in calendarCells" :key="ci">
              <div v-if="!cell" class="cal-cell cal-cell--pad"></div>
              <div v-else class="cal-cell"
                   :class="{
                     'cal-cell--study':    cell.isStudyDay && !isBlockedDay(cell.dateKey),
                     'cal-cell--blocked':  isBlockedDay(cell.dateKey),
                     'cal-cell--break':    isBreakDay(cell.dateKey),
                     'cal-cell--selected': calendarPopover && calendarPopover.dateKey === cell.dateKey,
                     'cal-cell--today':    cell.dateKey === todayKey,
                     'cal-cell--exam':     cell.dateKey === examDate,
                     'cal-cell--past':     isPast(cell.dateKey),
                   }"
                   @click="calCellClick(cell)">
                <div class="cal-cell-header">
                  <span class="cal-day-num">{{ cell.day }}</span>
                  <span class="cal-cell-time" v-if="dayEstimatedTime(cell.sessions)">{{ dayEstimatedTime(cell.sessions) }}</span>
                </div>
                <div class="cal-bars" v-if="cell.activityBars.length">
                  <div v-for="bar in cell.activityBars" :key="bar.type"
                       class="cal-bar"
                       :style="{ background: bar.color, width: bar.pct + '%' }"></div>
                </div>
                <div v-if="fullyDoneDays[cell.dateKey]" class="cal-past-x" aria-hidden="true">×</div>
              </div>
            </template>
          </div>
        </template>

        <!-- Week view: Design C agenda list -->
        <template v-else>
          <div class="cal-week-list">
            <div v-for="cell in calendarWeekCells" :key="cell.dateKey"
                 class="cal-wday"
                 :class="{
                   'cal-wday--study':    cell.isStudyDay && !isBlockedDay(cell.dateKey),
                   'cal-wday--blocked':  isBlockedDay(cell.dateKey),
                   'cal-wday--break':    isBreakDay(cell.dateKey),
                   'cal-wday--selected': calendarPopover && calendarPopover.dateKey === cell.dateKey,
                   'cal-wday--today':    cell.dateKey === todayKey,
                   'cal-wday--exam':     cell.dateKey === examDate,
                   'cal-wday--off':      !cell.isStudyDay && !isBlockedDay(cell.dateKey) && !isBreakDay(cell.dateKey),
                   'cal-wday--past':     isPast(cell.dateKey),
                 }"
                 @click="calCellClick(cell)">
              <!-- Date column -->
              <div class="cal-wday-date">
                <div class="cal-wday-dow">{{ cell.dow }}</div>
                <div class="cal-wday-num"
                     :class="{ 'cal-wday-num--today': cell.dateKey === todayKey, 'cal-wday-num--exam': cell.dateKey === examDate }">
                  {{ cell.day }}
                </div>
                <div v-if="fullyDoneDays[cell.dateKey]" class="cal-wday-past-x" aria-hidden="true">×</div>
              </div>
              <!-- Bar region -->
              <div class="cal-wday-bar">
                <div v-if="cell.relWidth > 0" class="cal-wday-bar-track" :style="{ width: cell.relWidth + '%' }">
                  <div v-for="seg in cell.activityBars" :key="seg.type"
                       class="cal-wday-seg"
                       :style="{ background: seg.color, flex: seg.pct }">
                    {{ seg.label }}
                  </div>
                </div>
                <span v-else-if="isBreakDay(cell.dateKey)" class="cal-wday-off-label cal-wday-break-label">— break day —</span>
                <span v-else class="cal-wday-off-label">— off —</span>
              </div>
              <!-- Time -->
              <div class="cal-wday-time" v-if="cell.isStudyDay">{{ dayEstimatedTime(cell.sessions) }}</div>
              <div class="cal-wday-time" v-else></div>
            </div>
          </div>
        </template>



      </div>

      <!-- Export Plan -->
      <div class="card" style="margin-top:20px">
        <div class="card-body">
          <div class="section-title" style="margin-bottom:12px">Export Plan</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" @click="doExportDailyCsv()">⬇ Day-by-day CSV</button>
            <button class="btn btn-secondary btn-sm" @click="doExportTopicsCsv()">⬇ Topics CSV</button>
            <button class="btn btn-secondary btn-sm" @click="doExportJson()">⬇ Backup plan</button>
          </div>
        </div>
      </div>

      <!-- Post-generation prompt -->
      <div class="alert alert-info" style="margin-top:24px">
        Use ⚙ Edit Study Plan to adjust topics, schedule, exam date, or even save the plan as a CSV file.
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
                <label>When would you start studying?</label>
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
            <button class="btn btn-secondary" style="margin-right:auto" @click="goBack()">← Back</button>
            <button class="btn btn-secondary" @click="doGeneratePlan()">Regenerate Plan →</button>
            <button class="btn btn-primary" @click="doAdjustSchedule()">⚡ Adjust schedule for me</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════ SETTINGS ════════════════ -->
    <template v-else-if="!loading && screen === 'settings'">
      <div class="section-title">Edit Study Plan</div>

      <div class="card" style="margin-bottom:20px">
        <div class="card-body">

          <!-- ── 1. Exam Setup (read-only except exam date) ── -->
          <div class="settings-section">
            <h3>Exam Setup</h3>

            <div v-if="!isRestrictedMode" class="mode-cards" style="pointer-events:none;opacity:.65">
              <div class="mode-card" :class="{ selected: topicInputMode === 'examName' }">
                <h4>Exam name only</h4>
                <p>Enter the exam name. AI creates a structured hierarchy of subject areas and granular study units.</p>
              </div>
              <div class="mode-card" :class="{ selected: topicInputMode === 'granularList' }">
                <h4>Manually enter topic list</h4>
                <p>Paste your complete list. Use indentation or # headings to create groups. AI estimates difficulty only.</p>
              </div>
            </div>

            <div class="form-group" v-if="isRestrictedMode">
              <label>Exam</label>
              <select v-model="examName" disabled>
                <option v-for="exam in predefinedExams" :key="exam.id" :value="exam.name">{{ exam.name }}</option>
              </select>
            </div>

            <div class="form-group" v-if="!isRestrictedMode && topicInputMode === 'examName'">
              <label>Exam name</label>
              <input type="text" v-model="examName" disabled />
            </div>

            <div class="form-group" v-if="!isRestrictedMode && topicInputMode === 'granularList'">
              <label>Topic list</label>
              <textarea v-model="granularTopicsText" rows="6" disabled></textarea>
            </div>

            <div class="row">
              <div class="col">
                <div class="form-group">
                  <label>When would you start studying?</label>
                  <input type="date" v-model="startDate" disabled />
                </div>
              </div>
              <div class="col">
                <div class="form-group">
                  <label>When do you need to be ready by?</label>
                  <input type="date" v-model="examDate" />
                </div>
              </div>
            </div>

            <div class="form-group" v-if="!isRestrictedMode && freeText">
              <label>Additional notes <span style="font-weight:400;color:var(--c-muted)">(read only)</span></label>
              <textarea v-model="freeText" rows="3" disabled></textarea>
            </div>
          </div>

          <!-- ── 2. Topics Setup ── -->
          <div class="settings-section">
            <h3>Topics Setup</h3>

            <div class="section-sub" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
              <span>
                {{ studyTopicCount }} study topic{{ studyTopicCount !== 1 ? 's' : '' }}
                <span v-if="groupCount > 0"> in {{ groupCount }} group{{ groupCount !== 1 ? 's' : '' }}</span>.
              </span>
              <button v-if="hasGroups" class="btn btn-secondary btn-sm" @click="toggleAllGroups()">
                {{ allGroupsCollapsed ? '↔ Expand all groups' : '⊟ Collapse all groups' }}
              </button>
            </div>

            <div class="topics-table-wrap">
              <table class="topics-table">
                <thead>
                  <tr>
                    <th class="col-check"></th>
                    <th class="col-title">Topic</th>
                    <th class="col-diff">Time allocation</th>
                    <th class="col-state">Areas of Preparation</th>
                    <th class="col-actions">Order</th>
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
                      <td class="col-check col-check-group">
                        <input type="checkbox"
                               :checked="isGroupAllEnabled(topic.id)"
                               @change="toggleGroupEnabled(topic.id, $event.target.checked)" />
                        <span class="group-collapse-btn" @click="toggleGroupCollapse(topic.id)">
                          {{ isGroupCollapsed(topic.id) ? '▶' : '▼' }}
                        </span>
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
                          <option value="easy">All Low</option>
                          <option value="medium">All Standard</option>
                          <option value="hard">All High</option>
                        </select>
                      </td>
                      <td class="col-state">
                        <label class="phase-check"><input type="checkbox" :checked="groupLearnState(topic.id) === 'all'" :indeterminate.prop="groupLearnState(topic.id) === 'mixed'" @change="setGroupLearn(topic.id, $event.target.checked)" /> Learning</label>
                        <label class="phase-check"><input type="checkbox" :checked="groupPracticeState(topic.id) === 'all'" :indeterminate.prop="groupPracticeState(topic.id) === 'mixed'" @change="setGroupPractice(topic.id, $event.target.checked)" /> Practicing</label>
                        <label class="phase-check"><input type="checkbox" :checked="groupReviseState(topic.id) === 'all'" :indeterminate.prop="groupReviseState(topic.id) === 'mixed'" @change="setGroupRevise(topic.id, $event.target.checked)" /> Revising</label>
                      </td>
                      <td class="col-actions">
                        <button class="btn btn-ghost btn-icon" title="Move group up"   @click="moveGroup(topic.id, -1)">↑</button>
                        <button class="btn btn-ghost btn-icon" title="Move group down" @click="moveGroup(topic.id,  1)">↓</button>
                        <button v-if="!isRestrictedMode" class="btn btn-ghost btn-icon" title="Add sub-topic" @click="addSubTopic(topic.id)">+</button>
                      </td>
                    </tr>

                    <!-- Sub-topic row (hidden when group is collapsed) -->
                    <tr v-else-if="topic.parentId && !isGroupCollapsed(topic.parentId)"
                        draggable="true"
                        :class="{ 'topic-subtopic-row': true, 'topic-row--disabled': topic.enabled === false, 'drag-over': dragOverIdx === idx, 'dragging': dragSrcIdx === idx }"
                        @dragstart="onDragStart($event, idx)"
                        @dragover.prevent="onDragOver($event, idx)"
                        @drop.prevent="onDrop($event, idx)"
                        @dragend="onDragEnd">
                      <td class="col-check" style="padding-left:20px">
                        <input type="checkbox"
                               :checked="topic.enabled !== false"
                               @change="topic.enabled = $event.target.checked" />
                      </td>
                      <td class="col-title">
                        <input type="text" v-model="topic.title" style="padding-left:4px" />
                      </td>
                      <td class="col-diff">
                        <select class="select-sm" v-model="topic.difficulty">
                          <option value="easy">Low</option>
                          <option value="medium">Standard</option>
                          <option value="hard">High</option>
                        </select>
                      </td>
                      <td class="col-state">
                        <label class="phase-check"><input type="checkbox" :checked="topic.doLearn !== false"    @change="topic.doLearn    = $event.target.checked" /> Learning</label>
                        <label class="phase-check"><input type="checkbox" :checked="topic.doPractice !== false" @change="topic.doPractice = $event.target.checked" /> Practicing</label>
                        <label class="phase-check"><input type="checkbox" :checked="topic.doRevise !== false"   @change="topic.doRevise   = $event.target.checked" /> Revising</label>
                      </td>
                      <td class="col-actions">
                        <button class="btn btn-ghost btn-icon" title="Move up"   @click="moveSubTopic(topic.id, -1)">↑</button>
                        <button class="btn btn-ghost btn-icon" title="Move down" @click="moveSubTopic(topic.id,  1)">↓</button>
                      </td>
                    </tr>

                    <!-- Standalone topic row -->
                    <tr v-else-if="!topic.isGroup && !topic.parentId"
                        draggable="true"
                        :class="{ 'topic-row': true, 'topic-row--disabled': topic.enabled === false, 'drag-over': dragOverIdx === idx, 'dragging': dragSrcIdx === idx }"
                        @dragstart="onDragStart($event, idx)"
                        @dragover.prevent="onDragOver($event, idx)"
                        @drop.prevent="onDrop($event, idx)"
                        @dragend="onDragEnd">
                      <td class="col-check">
                        <input type="checkbox"
                               :checked="topic.enabled !== false"
                               @change="topic.enabled = $event.target.checked" />
                      </td>
                      <td class="col-title">
                        <input type="text" v-model="topic.title" />
                      </td>
                      <td class="col-diff">
                        <select class="select-sm" v-model="topic.difficulty">
                          <option value="easy">Low</option>
                          <option value="medium">Standard</option>
                          <option value="hard">High</option>
                        </select>
                      </td>
                      <td class="col-state">
                        <label class="phase-check"><input type="checkbox" :checked="topic.doLearn !== false"    @change="topic.doLearn    = $event.target.checked" /> Learning</label>
                        <label class="phase-check"><input type="checkbox" :checked="topic.doPractice !== false" @change="topic.doPractice = $event.target.checked" /> Practicing</label>
                        <label class="phase-check"><input type="checkbox" :checked="topic.doRevise !== false"   @change="topic.doRevise   = $event.target.checked" /> Revising</label>
                      </td>
                      <td class="col-actions">
                        <button class="btn btn-ghost btn-icon" title="Move up"    @click="moveTopic(idx, -1)" :disabled="idx === 0">↑</button>
                        <button class="btn btn-ghost btn-icon" title="Move down"  @click="moveTopic(idx,  1)" :disabled="idx === topics.length - 1">↓</button>
                      </td>
                    </tr>

                  </template>
                </tbody>
              </table>
            </div>

            <div v-if="!isRestrictedMode" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-secondary btn-sm" @click="addTopic()">+ Add Standalone Topic</button>
              <button class="btn btn-secondary btn-sm" @click="addGroup()">+ Add Group</button>
            </div>
          </div>

          <!-- ── 3. Study Schedule ── -->
          <div class="settings-section">
            <h3>Study Schedule</h3>

            <!-- Plan Summary Bar -->
            <div v-if="calculatedStudyHours !== null || topics.filter(t => !t.isGroup).length > 0" class="plan-stats-bar" style="margin-bottom:8px">
              <div class="plan-stat plan-stat--highlight"
                   :class="planFits === true ? 'plan-stat--green' : planFits === false ? 'plan-stat--red' : ''">
                <span class="plan-stat-value">~{{ allocatedStudyHours ?? 0 }}h / ~{{ calculatedStudyHours ?? 0 }}h</span>
                <span class="plan-stat-label">study time allocated</span>
              </div>
              <div class="plan-stat" v-if="recommendedAvailableDays > 0">
                <span class="plan-stat-value">{{ recommendedAvailableDays }}</span>
                <span class="plan-stat-label">study days</span>
              </div>
              <div class="plan-stat">
                <span class="plan-stat-value">{{ topics.filter(t => !t.isGroup && t.enabled !== false).length }}</span>
                <span class="plan-stat-label">topics</span>
              </div>
              <div class="plan-stat" v-if="numMocks > 0">
                <span class="plan-stat-value">{{ numMocks }}</span>
                <span class="plan-stat-label">mock exams</span>
              </div>
            </div>
            <p v-if="planPreviewStatusText" class="plan-status-text"
               :class="planFits === false ? 'plan-status-text--red' : 'plan-status-text--green'"
               style="margin-bottom:16px">{{ planPreviewStatusText }}</p>

            <!-- Break days -->
            <div class="form-group">
              <label>Break days</label>
              <div class="form-hint" style="margin-bottom:8px">Dates excluded from study planning (holidays, travel, etc.).</div>
              <div v-if="breakDays.length" class="break-days-list">
                <span v-for="d in breakDays" :key="d" class="break-day-chip">
                  {{ d }}
                  <button class="break-day-remove" @click="removeBreakDay(d)" title="Remove">×</button>
                </span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
                <button class="btn btn-secondary btn-sm" @click="addBreakDay()">+ Add break day</button>
                <input ref="breakDayPicker" type="date" v-model="breakDayInputVal"
                       :min="startDate" :max="examDate"
                       @change="onBreakDayPicked"
                       style="position:absolute;opacity:0;pointer-events:none;width:0;height:0" />
              </div>
            </div>

            <!-- Weekly schedule table + chart -->
            <div class="form-group">
              <label>Study schedule</label>
              <div class="form-hint" style="margin-bottom:10px">Set your base weekly pace. Each ± step = 20 minutes.</div>
              <div class="schedule-layout">
                <div class="schedule-left">
                  <div class="sched-week-title">Week 1 — base pace</div>
                  <div class="sched-table">
                    <div class="sched-row sched-header-row">
                      <span class="sched-day-col">Day</span>
                      <span class="sched-ctrl-col">Daily study</span>
                      <span class="sched-hint-col"></span>
                    </div>
                    <div v-for="dow in dowLabels" :key="dow.key" class="sched-row">
                      <span class="sched-day-col">{{ dow.label.slice(0,3) }}</span>
                      <div class="sched-ctrl-col">
                        <div class="sg-time-ctrl">
                          <button class="sg-step-btn" @click="firstWeek[dow.key] = Math.max(0, firstWeek[dow.key] - 20)" :disabled="firstWeek[dow.key] === 0">−</button>
                          <span class="sg-time-val">{{ fmtMins(firstWeek[dow.key]) }}</span>
                          <button class="sg-step-btn" @click="firstWeek[dow.key] = Math.min(720, firstWeek[dow.key] + 20)">+</button>
                        </div>
                      </div>
                      <span class="sched-hint-col sg-sessions-hint">
                        <template v-if="firstWeek[dow.key] > 0">{{ Math.floor(firstWeek[dow.key] / unitLength) }} units</template>
                        <template v-else>off</template>
                      </span>
                    </div>
                    <div class="sched-row sched-apply-row">
                      <span class="sched-day-col" style="font-size:.78rem;color:var(--c-muted)">All</span>
                      <div class="sched-ctrl-col">
                        <div class="sg-time-ctrl">
                          <button class="sg-step-btn" @click="adjustAllDays(-20)">−</button>
                          <span class="sg-time-val" style="font-size:.75rem;color:var(--c-muted)">apply to all</span>
                          <button class="sg-step-btn" @click="adjustAllDays(20)">+</button>
                        </div>
                      </div>
                      <span class="sched-hint-col"></span>
                    </div>
                  </div>
                  <div class="sched-total">Week 1 total: <strong>{{ fmtMins(firstWeekTotalMins) }}</strong></div>
                </div>
                <div class="schedule-right">
                  <div class="sched-week-title" style="visibility:hidden" aria-hidden="true">Week 1</div>
                  <div class="sched-chart-wrap" @mousemove="onScheduleChartMouseMove" @mouseleave="scheduleTooltip.visible = false">
                    <canvas ref="scheduleCanvas" class="sched-chart-canvas"></canvas>
                    <div v-if="scheduleTooltip.visible" class="sched-tooltip"
                         :style="{ left: scheduleTooltip.x + 'px', top: scheduleTooltip.y + 'px' }">
                      {{ scheduleTooltip.text }}
                    </div>
                  </div>
                  <div class="sched-chart-meta" v-if="schedulePreviewData.length">
                    Total plan: ~<strong>{{ totalScheduleHours }}h</strong>
                    <span style="color:var(--c-muted);font-size:.78rem"> across {{ schedulePreviewData.length }} week{{ schedulePreviewData.length !== 1 ? 's' : '' }}</span>
                  </div>
                  <div class="sched-chart-meta" v-else style="color:var(--c-muted);font-size:.82rem">
                    Set study dates to see weekly preview
                  </div>
                  <div class="sched-ramp-row">
                    <label class="sched-radio-opt">
                      <input type="radio" value="linear" v-model="rampMode" />
                      <span>Linear increase</span>
                    </label>
                    <label class="sched-radio-opt">
                      <input type="radio" value="cram" v-model="rampMode" />
                      <span>Cram at the end</span>
                    </label>
                  </div>
                  <div class="sched-intensity-row">
                    <span class="sched-intensity-label">Peak intensity</span>
                    <div class="sg-time-ctrl">
                      <button class="sg-step-btn" @click="adjustIntensity(-0.25)" :disabled="intensityMultiplier <= 1">−</button>
                      <span class="sg-time-val" style="min-width:44px">×{{ intensityMultiplier.toFixed(2) }}</span>
                      <button class="sg-step-btn" @click="adjustIntensity(0.25)">+</button>
                    </div>
                    <span class="sched-intensity-hint">~{{ fmtMins(lastWeekTotalMins) }}/week at exam</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Number of mocks -->
            <div class="form-group">
              <label>Number of mock exams</label>
              <div class="form-hint" style="margin-bottom:6px">Minimum 3 recommended. Set to 0 to skip mock exams entirely.</div>
              <div class="spinner-group">
                <button @click="numMocks = Math.max(0, numMocks - 1)">−</button>
                <input type="number" min="0" max="10" v-model.number="numMocks" />
                <button @click="numMocks = Math.min(10, numMocks + 1)">+</button>
              </div>
            </div>

            <!-- Mock date overrides -->
            <div v-if="scheduledMocks.length > 0" class="form-group">
              <label>Mock exam dates</label>
              <div v-for="m in scheduledMocks" :key="m.mockNumber"
                   style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
                <label style="font-size:.84rem;min-width:80px;font-weight:500">Mock {{ m.mockNumber }}</label>
                <input type="date" style="width:160px"
                       :value="mockDateOverrides[m.mockNumber] || m.dateStr"
                       @change="mockDateOverrides = { ...mockDateOverrides, [m.mockNumber]: $event.target.value }" />
                <span style="font-size:.78rem;color:var(--c-muted)" v-if="!mockDateOverrides[m.mockNumber]">scheduled</span>
                <span style="font-size:.78rem;color:#2563eb" v-else>changed</span>
              </div>
            </div>
          </div>

          <!-- ── 4. API Configuration ── -->

          <!-- ── 5. API Configuration ── -->
          <div class="settings-section" v-if="entryMode === 'full'">
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

          <!-- ── 6. Advanced Settings ── -->
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
                        <strong>Interleaved</strong> — once a topic&#39;s learning units are done, its practice units are distributed across the schedule alongside other topics.
                      </span>
                    </label>
                    <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
                      <input type="radio" value="sequential" v-model="settings.learningMode" style="margin-top:3px;flex-shrink:0" />
                      <span>
                        <strong>Sequential</strong> — fully complete one topic (all learning + all practice units) before moving to the next. Reviews still follow the spaced-repetition schedule.
                      </span>
                    </label>
                  </div>
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
                  <label>Max days between practice units</label>
                  <div class="spinner-group">
                    <button @click="settings.maxDaysBetweenPractice = Math.max(1, (settings.maxDaysBetweenPractice || 7) - 1)">−</button>
                    <input type="number" min="1" max="60" v-model.number="settings.maxDaysBetweenPractice" />
                    <button @click="settings.maxDaysBetweenPractice = Math.min(60, (settings.maxDaysBetweenPractice || 7) + 1)">+</button>
                  </div>
                  <span class="form-hint">Maximum gap (days) between learning and first practice, and between consecutive practice units.</span>
                </div>

                <div class="form-group">
                  <label>Time units per topic (editable defaults)</label>
                  <span class="form-hint" style="display:block;margin-bottom:8px">Relative time units for learning and practice per topic, by difficulty. Higher values = more units allocated per topic.</span>
                  <table class="activity-count-table" style="margin-top:0">
                    <thead><tr><th>Activity</th><th>Easy</th><th>Medium</th><th>Hard</th></tr></thead>
                    <tbody>
                      <tr>
                        <td>Learning units</td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.easy" /></td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.medium" /></td>
                        <td><input type="number" min="1" max="10" v-model.number="settings.lnTable.hard" /></td>
                      </tr>
                      <tr>
                        <td>Practice units</td>
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
                  <span class="form-hint">First value = days after last practice unit before first review. Remaining values = gaps between consecutive reviews. Default: 1, 6, 16, 45, 131</span>
                </div>

                <div class="form-group" style="padding-top:14px;border-top:1px solid var(--c-border)">
                  <label style="color:var(--c-danger)">Danger zone</label>
                  <div style="margin-top:8px;display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
                    <button class="btn btn-sm" style="border-color:var(--c-danger);color:var(--c-danger)" @click="doClearCachedData()">
                      Delete cached data
                    </button>
                    <span class="form-hint" style="margin:0;align-self:center">Clears the current unsaved plan from memory. Saved &amp; tracked plans are not affected.</span>
                  </div>
                </div>

              </div>
            </div>
          </div>

          <div class="action-bar">
            <button class="btn btn-secondary" @click="doCancelSettings()">Cancel</button>
            <button class="btn btn-primary" @click="doSaveSettings()">{{ planResult ? 'Save &amp; Regenerate' : 'Save Settings' }}</button>
          </div>
        </div>
      </div>
    </template>

  </main>

  <!-- ── Debug date simulator (Ctrl+Shift+D) ── -->
  <div v-if="debugDialogVisible" class="debug-overlay" @click.self="closeDebugDialog()">
    <div class="debug-dialog">
      <h3 style="margin:0 0 12px">🛠 Simulate Date</h3>
      <p style="font-size:.82rem;color:var(--c-muted);margin-bottom:12px">
        Override today's date for testing. Affects all "today" computations. Cleared on page refresh.
      </p>
      <div class="form-group" style="margin-bottom:12px">
        <label>Simulated today</label>
        <input type="date" v-model="debugDateInput" style="width:180px" />
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" @click="applyDebugDate()">Apply</button>
        <button class="btn btn-secondary btn-sm" @click="clearDebugDate()">Clear (use real today)</button>
        <button class="btn btn-ghost btn-sm" @click="closeDebugDialog()">Close</button>
      </div>
      <p v-if="simulatedToday" style="margin-top:10px;font-size:.82rem;color:#b45309">
        ⚠ Currently simulating: <strong>{{ simulatedToday }}</strong>
      </p>
    </div>
  </div>

</div>`,

  // ─── Data ──────────────────────────────────────────────────────────────────

  data() {
    const today    = new Date().toISOString().slice(0, 10);
    const settings = StudyStorage.loadSettings();

    return {
      screen: 'home',
      settings,

      // Entry mode — set from ?exam= URL param in mounted()
      entryMode:  'predefined',   // 'predefined' | 'full'
      debugMode:  false,

      // Step 1
      topicInputMode: 'examName',
      examName: '',
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
      firstWeek: { mon: 60, tue: 60, wed: 60, thu: 60, fri: 60, sat: 60, sun: 60 },
      rampMode:  'linear',
      intensityMultiplier: 1,
      numMocks:  3,
      unitLength: 20,  // minutes per study unit (fixed by user, used as forcedSessionLength)
      scheduleTooltip: { visible: false, text: '', x: 0, y: 0 },
      breakDays: [],               // array of 'YYYY-MM-DD' date strings excluded from planning
      breakDayInputVal: '',        // bound to the hidden date picker
      recommendedStudyHours: null, // from predefined exam JSON `studyHoursNeeded` field

      recommendedHoursApplied: false,

      // Populated by _runPlanPreview() — exact results from a real (no-mock) plan run.
      // All step-3 bar calculations read from here instead of using OVERHEAD_FACTOR estimates.
      planPreviewData: null,
      _planPreviewTimer: null,

      // Step 2 — group collapse state
      collapsedGroups: {},

      // Topic summary tab collapsed view
      topicSummaryCollapsed: false,

      // Step 4
      planResult:       null,
      hydratedCalendar: [],
      chartTopicsData:  [],
      activeTab:        'calendar',
      completionStatus: {},
      lockedDays: {},
      autoMarkPromptVisible: false,
      manualMarkReminderVisible: false,
      rescheduleFromPromptVisible: false,
      unmarkedPastPromptVisible: false,
      lastTrackedDate: null,
      mockDateOverrides: {},
      chartCollapsed:   false,

      // Day-by-day collapse state (default: all collapsed)
      expandedDays: {},

      // Topic summary group collapse state (default: all collapsed)
      expandedTopicGroups: {},

      // Calendar view
      currentCalMonth:    null,
      currentCalWeekStart: null,
      calViewMode:        'month',   // 'month' | 'week'
      calendarPopover:     null,

      // Chart tooltip
      tooltip:  null,
      tooltipX: 0,
      tooltipY: 0,
      _chartStateMap: null,
      _chartDateKeys: null,

      // Settings page
      advancedExpanded:  false,
      settingsSrText:    (settings.srIntervals || [1,6,16,45,131]).join(', '),
      navHistory:        [],
      settingsSnapshot:  null,

      // Loading / error
      loading:    false,
      loadingMsg: '',
      error:      null,

      // Tracking
      trackingMode:       false,
      activePlanId:       null,
      trackedBlockedDays: [],
      savedPlans:         [],

      // Debug date simulator (Ctrl+Shift+D)
      simulatedToday:    null,
      debugDialogVisible: false,
      debugDateInput:    '',
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
      return ids.length > 0 && ids.every(id => this.collapsedGroups[id] !== false);
    },

    allTopicsLearnState() {
      const leaves = this.topics.filter(t => !t.isGroup && t.enabled !== false);
      if (!leaves.length) return 'none';
      const allOn  = leaves.every(t => t.doLearn !== false);
      const allOff = leaves.every(t => t.doLearn === false);
      return allOn ? 'all' : allOff ? 'none' : 'mixed';
    },
    allTopicsPracticeState() {
      const leaves = this.topics.filter(t => !t.isGroup && t.enabled !== false);
      if (!leaves.length) return 'none';
      const allOn  = leaves.every(t => t.doPractice !== false);
      const allOff = leaves.every(t => t.doPractice === false);
      return allOn ? 'all' : allOff ? 'none' : 'mixed';
    },
    allTopicsReviseState() {
      const leaves = this.topics.filter(t => !t.isGroup && t.enabled !== false);
      if (!leaves.length) return 'none';
      const allOn  = leaves.every(t => t.doRevise !== false);
      const allOff = leaves.every(t => t.doRevise === false);
      return allOn ? 'all' : allOff ? 'none' : 'mixed';
    },

    // Collapsed topic summary: one entry per group (or standalone topic)
    collapsedTopicGroups() {
      if (!this.planResult || !this.hydratedCalendar.length) return [];
      const summaries   = this.topicSummaries;
      const sessionMins = this.planResult.sessionLength || 20;

      const uiTopicById = {};
      this.topics.forEach(t => { uiTopicById[t.id] = t; });

      const groups = [];
      const groupMap = {};

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
              grp.totalMins += act.count * sessionMins;
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
          const totalSessions = sum.activities.reduce((s, a) => s + a.count, 0);
          const totalMins = sum.activities
            .filter(a => a.activityType !== 'mock' && a.activityType !== 'postMock')
            .reduce((s, a) => s + a.count * sessionMins, 0);
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
        step1:    'New Plan — Step 1: Exam Setup',
        step2:    'New Plan — Step 2: Topics Setup',
        step3:    'New Plan — Step 3: Study Schedule',
        step4:    this.trackingMode ? 'Tracking Plan' : 'Your Study Plan',
        settings: 'Settings',
        update:   'Update Existing Plan',
        planList: 'Saved Plans',
      }[this.screen] || '';
    },

    isRestrictedMode() {
      return this.entryMode === 'predefined';
    },

    selectedPredefinedExam() {
      if (this.topicInputMode !== 'examName') return null;
      const name = this.examName.trim().toLowerCase();
      return this.predefinedExams.find(e => e.name.toLowerCase() === name) || null;
    },

    canGenerateTopics() {
      if (this.topicInputMode === 'examName' && !this.examName.trim()) return false;
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
      if (ov.sessionLengthInsufficient) {
        const minLen = typeof StudyPlanner !== 'undefined' ? StudyPlanner.SESSION_MIN : 10;
        msg += `Not enough daily study time: the computed unit length would be ~${ov.requiredSessionLength} min, but the minimum is ${minLen} min. Increase your daily study time to make the plan work. `;
      }
      if (nMCQ > 0) {
        msg += `${nMCQ} of ${nTopics} topics will not complete all practice units before the exam. `;
      }
      if (nLearn > 0) {
        msg += `${nLearn} topic${nLearn > 1 ? 's' : ''} will not finish learning before the exam. `;
      }
      if (nReview > 0) {
        msg += `${nReview} topic${nReview > 1 ? 's' : ''} will miss scheduled review units. `;
      }
      if (extraSess > 0) {
        msg += `You need approximately ${extraSess} more study units per week to complete the full plan. `;
      }
      if ((ov.mockShortfall || 0) > 0) {
        const placed    = ov.placedMockCount;
        const requested = placed + ov.mockShortfall;
        msg += `Only ${placed} of ${requested} mock exam${requested > 1 ? 's' : ''} could be scheduled — the study window is too short. Consider extending the exam date or adding more study days.`;
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

    // Study days interleaved with break-day markers, sorted by date, for the Day-by-Day tab
    dailyViewItems() {
      const studyItems = this.studyDaysWithSessions.map(d => ({ ...d, itemType: 'study' }));
      if (!this.breakDays.length) return studyItems;
      // Only show break days that fall within the plan range
      const allKeys = new Set(this.hydratedCalendar.map(d =>
        d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date
      ));
      const breakItems = this.breakDays
        .filter(dk => allKeys.has(dk))
        .map(dk => ({
          dateKey: dk,
          date: new Date(dk + 'T00:00:00Z'),
          sessions: [],
          itemType: 'break',
        }));
      return [...studyItems, ...breakItems].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    },

    planTotalHours() {
      if (!this.hydratedCalendar.length) return null;
      const mockMins    = this.settings.mockDuration || 90;
      const sessionMins = this.planResult?.sessionLength || 20;
      let totalMins = 0;
      for (const day of this.hydratedCalendar) {
        for (const s of (day.sessions || [])) {
          if (s.activityType === 'mock')          totalMins += mockMins;
          else if (s.activityType !== 'postMock') totalMins += sessionMins;
        }
      }
      return Math.round(totalMins / 60);
    },

    allocatedStudyHours() {
      const total = this.schedulePreviewData.reduce((s, w) => s + w.hours, 0);
      return total > 0 ? Math.round(total) : null;
    },

    calculatedStudyHours() {
      return this.computedSessionLengthPreview?.requiredHours ?? null;
    },

    planFits() {
      const prev = this.computedSessionLengthPreview;
      if (!prev) return null;
      return prev.lpFits;
    },

    // Status text for the step-3 bar (pre-generation, from planPreviewData).
    planPreviewStatusText() {
      const p = this.planPreviewData;
      if (!p) return null;
      const y = p.totalTopics;
      const x = p.learnComplete;
      const n = p.practiceComplete;
      const prefix = !p.lpFits ? 'WARNING: ' : '';
      let msg = `${prefix}Complete learning of ${x} out of ${y} topics. Complete practice of ${n} out of ${y} topics.`;
      if (!p.lpFits && p.extraHours > 0) {
        msg += ` You need ~${p.extraHours} more hour${p.extraHours !== 1 ? 's' : ''} to complete the full plan.`;
      }
      if (p.sessionLength) {
        msg += ` Estimated time to complete a basic unit of activity with this schedule is ${p.sessionLength} minutes.`;
      }
      return msg;
    },

    // Status text for the step-4 bar (post-generation, from planResult.overflow).
    planResultStatusText() {
      if (!this.planResult) return null;
      const ov = this.planResult.overflow;
      const y  = this.planResult.topics.length;
      const x  = y - ov.incompleteLearnTopics.length;
      const n  = y - ov.incompleteMCQTopics.length;
      const prefix = ov.hasOverflow ? 'WARNING: ' : '';
      let msg = `${prefix}Complete learning of ${x} out of ${y} topics. Complete practice of ${n} out of ${y} topics.`;
      if (ov.hasOverflow && ov.totalMissingSessions > 0) {
        const extra = Math.ceil(ov.totalMissingSessions * this.planResult.sessionLength / 60);
        if (extra > 0) msg += ` You need ~${extra} more hour${extra !== 1 ? 's' : ''} to complete the full plan.`;
      }
      if (this.planResult.sessionLength) {
        msg += ` Estimated time to complete a basic unit of activity with this schedule is ${this.planResult.sessionLength} minutes.`;
      }
      return msg;
    },

    planFutureHours() {
      if (!this.hydratedCalendar.length) return null;
      const today      = this.todayKey;
      const mockMins   = (this.settings && this.settings.mockDuration) || 90;
      const sessionMins = this.planResult?.sessionLength || 20;
      let totalMins = 0;
      for (const day of this.hydratedCalendar) {
        const dk = day.date instanceof Date ? day.date.toISOString().slice(0, 10) : String(day.date);
        if (dk < today) continue;
        for (const s of (day.sessions || [])) {
          if (s.activityType === 'mock')          totalMins += mockMins;
          else if (s.activityType !== 'postMock') totalMins += sessionMins;
        }
      }
      return Math.round(totalMins / 60);
    },

    daysLeft() {
      if (!this.examDate) return null;
      const today = new Date(this.todayKey + 'T00:00:00Z');
      const exam  = new Date(this.examDate  + 'T00:00:00Z');
      return Math.max(0, Math.floor((exam - today) / 86400000));
    },

    studyTimeLeftHours() {
      if (!this.hydratedCalendar.length || !this.trackingMode) return null;
      const today      = this.todayKey;
      const mockMins   = (this.settings && this.settings.mockDuration) || 90;
      const sessionMins = this.planResult?.sessionLength || 20;
      let totalMins = 0;
      for (const day of this.hydratedCalendar) {
        const dk = day.date instanceof Date ? day.date.toISOString().slice(0, 10) : String(day.date);
        if (dk < today) continue;
        for (const s of (day.sessions || [])) {
          const key = this.sessionKey(dk, s);
          if (this.completionStatus[key] === 'done' || this.completionStatus[key] === 'skip') continue;
          if (s.activityType === 'mock')          totalMins += mockMins;
          else if (s.activityType !== 'postMock') totalMins += sessionMins;
        }
      }
      return Math.round(totalMins / 60);
    },

    topicsLeft() {
      if (!this.planResult || !this.hydratedCalendar.length || !this.trackingMode) return null;
      const topicIds = this.planResult.topics.map(t => t.id);
      const learnKeys = {}, practiceKeys = {};
      for (const day of this.hydratedCalendar) {
        const dk = day.date instanceof Date ? day.date.toISOString().slice(0, 10) : String(day.date);
        for (const s of (day.sessions || [])) {
          if (s.topicId == null) continue;
          const key = this.sessionKey(dk, s);
          if (s.activityType === 'learn')    { (learnKeys[s.topicId]    = learnKeys[s.topicId]    || []).push(key); }
          if (s.activityType === 'practice') { (practiceKeys[s.topicId] = practiceKeys[s.topicId] || []).push(key); }
        }
      }
      return topicIds.filter(id => {
        const l = (learnKeys[id]    || []).every(k => this.completionStatus[k] === 'done');
        const p = (practiceKeys[id] || []).every(k => this.completionStatus[k] === 'done');
        return !(l && p);
      }).length;
    },

    mocksLeft() {
      if (!this.planResult || !this.trackingMode) return null;
      const total = this.planResult.mocks.filter(m => m.type === 'mock').length;
      let done = 0;
      for (const day of this.hydratedCalendar) {
        const dk = day.date instanceof Date ? day.date.toISOString().slice(0, 10) : String(day.date);
        for (const s of (day.sessions || [])) {
          if (s.activityType === 'mock' && this.completionStatus[this.sessionKey(dk, s)] === 'done') done++;
        }
      }
      return Math.max(0, total - done);
    },

    scheduledMocks() {
      if (!this.planResult?.mocks) return [];
      return this.planResult.mocks
        .filter(m => m.type === 'mock')
        .map(m => {
          const dateStr = m.date instanceof Date
            ? m.date.toISOString().slice(0, 10)
            : (typeof m.date === 'string' ? m.date.slice(0, 10) : '');
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
      return this.simulatedToday || new Date().toISOString().slice(0, 10);
    },

    fullyDoneDays() {
      const status = this.completionStatus;
      const result = {};
      for (const d of this.hydratedCalendar) {
        const dk = d.date instanceof Date ? d.date.toISOString().slice(0,10) : String(d.date).slice(0,10);
        if (!d.sessions || !d.sessions.length) continue;
        const merged = this.mergeSessions(d.sessions);
        if (merged.length > 0 && merged.every(b => status[this.sessionKey(dk, b)] === 'done')) {
          result[dk] = true;
        }
      }
      return result;
    },

    calendarMonthLabel() {
      if (!this.currentCalMonth) return '';
      return this.currentCalMonth.toLocaleDateString('en-GB', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
      });
    },

    calNavPrevKey() {
      if (!this.calendarPopover) return '';
      const d = new Date(this.calendarPopover.dateKey + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    },
    calNavNextKey() {
      if (!this.calendarPopover) return '';
      const d = new Date(this.calendarPopover.dateKey + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    },
    calNavPrevLabel() { return this._calShortLabel(this.calNavPrevKey); },
    calNavNextLabel() { return this._calShortLabel(this.calNavNextKey); },
    calNavCurrentLabel() {
      if (!this.calendarPopover) return '';
      const dk = this.calendarPopover.dateKey;
      const label = this._calShortLabel(dk);
      return dk === this.todayKey ? `Today – ${label}` : label;
    },
    calDetailTitle() {
      if (!this.calendarPopover) return '';
      const dk = this.calendarPopover.dateKey;
      const timeStr = this.dayEstimatedTime(this.calendarPopover.sessions || []);
      const prefix = dk === this.todayKey ? "Today's" : this._calShortLabel(dk);
      return timeStr ? `${prefix} Study Time – ${timeStr}` : prefix;
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

        // Unique activity dots (kept for legend compatibility)
        const seen = new Set();
        const activityDots = [];
        for (const s of sessions) {
          if (!seen.has(s.activityType)) {
            seen.add(s.activityType);
            activityDots.push({ type: s.activityType, color: DOT_COLORS[s.activityType] || '#999' });
          }
        }

        // Activity bars: stacked proportional bars (Design B style)
        const typeCount = {};
        for (const s of sessions) typeCount[s.activityType] = (typeCount[s.activityType] || 0) + 1;
        const totalS = sessions.length;
        const activityBars = totalS > 0
          ? Object.entries(typeCount).map(([type, n]) => ({ type, color: DOT_COLORS[type] || '#999', pct: (n / totalS) * 100 }))
          : [];

        cells.push({ date, dateKey: dk, day: d, sessions, activityDots, activityBars, isStudyDay: sessions.length > 0 });
      }

      // Trailing padding to complete last row
      const tail = (7 - (cells.length % 7)) % 7;
      for (let i = 0; i < tail; i++) cells.push(null);

      return cells;
    },

    calendarWeekLabel() {
      if (!this.currentCalWeekStart) return '';
      const s = this.currentCalWeekStart;
      const e = new Date(s.getTime() + 6 * 86400000);
      const sDay = s.getUTCDate();
      const eDay = e.getUTCDate();
      const sMon = s.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
      const eMon = e.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
      const yr   = e.getUTCFullYear();
      return sMon === eMon ? `${sDay}–${eDay} ${sMon} ${yr}` : `${sDay} ${sMon} – ${eDay} ${eMon} ${yr}`;
    },

    calendarWeekCells() {
      if (!this.currentCalWeekStart) return [];
      const DOT_COLORS = { learn: '#3b82f6', practice: '#f59e0b', review: '#16a34a', mock: '#7c3aed', postMock: '#c084fc' };
      const SEG_LABELS = { learn: 'Learn', practice: 'Practice', review: 'Review', mock: 'Mock', postMock: 'Post-mock' };
      const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const unitMins   = this.unitLength || 20;
      const mockMins   = (this.settings && this.settings.mockDuration) || 90;

      const dayMap = {};
      for (const day of this.hydratedCalendar) {
        const dk = day.date instanceof Date ? day.date.toISOString().slice(0, 10) : day.date;
        dayMap[dk] = day;
      }

      // First pass: build cells and compute dayMins (excluding postMock from time sum)
      const cells = [];
      for (let i = 0; i < 7; i++) {
        const date     = new Date(this.currentCalWeekStart.getTime() + i * 86400000);
        const dk       = date.toISOString().slice(0, 10);
        const sessions = (dayMap[dk] || {}).sessions || [];
        const hasPostMock = sessions.some(s => s.activityType === 'postMock');
        let dayMins = 0;
        for (const s of sessions) {
          if (s.activityType === 'postMock') continue;
          dayMins += s.activityType === 'mock' ? mockMins : unitMins;
        }
        cells.push({ date, dateKey: dk, day: date.getUTCDate(), dow: DOW_LABELS[i],
                     sessions, isStudyDay: sessions.length > 0, hasPostMock, dayMins });
      }

      // Scale reference: longest non-post-mock day
      const maxMins = Math.max(...cells.filter(c => !c.hasPostMock).map(c => c.dayMins), 1);

      // Second pass: compute relWidth and activityBars
      for (const cell of cells) {
        if (cell.hasPostMock) {
          // Post-mock is a full-day activity — always fills 100%
          cell.relWidth    = 100;
          cell.activityBars = [{ type: 'postMock', color: DOT_COLORS.postMock, label: 'full day activity', pct: 100 }];
        } else {
          const typeMins = {};
          for (const s of cell.sessions) {
            const m = s.activityType === 'mock' ? mockMins : unitMins;
            typeMins[s.activityType] = (typeMins[s.activityType] || 0) + m;
          }
          cell.relWidth    = cell.dayMins > 0 ? Math.min(100, (cell.dayMins / maxMins) * 100) : 0;
          cell.activityBars = cell.dayMins > 0
            ? Object.entries(typeMins).map(([type, mins]) => ({
                type, color: DOT_COLORS[type] || '#999', label: SEG_LABELS[type] || type,
                pct: (mins / cell.dayMins) * 100,
              }))
            : [];
        }
      }
      return cells;
    },

    lastWeekComputed() {
      const out = {};
      for (const dow of ['mon','tue','wed','thu','fri','sat','sun']) {
        const base = this.firstWeek[dow] || 0;
        out[dow] = base === 0 ? 0 : Math.min(720, Math.round(base * this.intensityMultiplier));
      }
      return out;
    },

    firstWeekTotalMins() {
      return Object.values(this.firstWeek).reduce((s, v) => s + (v || 0), 0);
    },

    lastWeekTotalMins() {
      return Object.values(this.lastWeekComputed).reduce((s, v) => s + (v || 0), 0);
    },

    schedulePreviewData() {
      if (!this.startDate || !this.examDate) return [];
      const start = new Date(this.startDate + 'T00:00:00Z');
      const exam  = new Date(this.examDate  + 'T00:00:00Z');
      const totalDays  = Math.max(0, Math.floor((exam - start) / 86400000));
      if (totalDays < 7) return [];
      const totalWeeks = Math.max(2, Math.ceil(totalDays / 7));
      const last = this.lastWeekComputed;
      const DOW_KEYS = ['sun','mon','tue','wed','thu','fri','sat']; // getUTCDay order
      const breakSet = new Set(this.breakDays || []);
      const data = [];
      for (let w = 0; w < totalWeeks; w++) {
        let mins = 0;
        for (let di = 0; di < 7; di++) {
          const dayDate = new Date(start.getTime() + (w * 7 + di) * 86400000);
          if (dayDate >= exam) break;
          const dk = dayDate.toISOString().slice(0, 10);
          if (breakSet.has(dk)) continue;
          const dow = DOW_KEYS[dayDate.getUTCDay()];
          mins += StudyPlanner.interpolateSessions(
            this.firstWeek[dow] || 0, last[dow] || 0, w, totalWeeks, this.rampMode
          );
        }
        data.push({ week: w + 1, hours: mins / 60 });
      }
      return data;
    },

    // Available days between start and exam (excluding break days), used for recommended hours
    recommendedAvailableDays() {
      if (!this.startDate || !this.examDate) return 0;
      const start = new Date(this.startDate + 'T00:00:00Z');
      const exam  = new Date(this.examDate  + 'T00:00:00Z');
      const breakSet = new Set(this.breakDays || []);
      let count = 0;
      let cur = new Date(start);
      while (cur < exam) {
        if (!breakSet.has(cur.toISOString().slice(0, 10))) count++;
        cur = new Date(cur.getTime() + 86400000);
      }
      return count;
    },

    // Suggested daily minutes based on recommendedStudyHours and available days
    recommendedDailyMins() {
      if (!this.recommendedStudyHours || !this.recommendedAvailableDays) return 0;
      const unit = this.unitLength || 20;
      const totalMins = Math.ceil(this.recommendedStudyHours * 60 / unit) * unit;
      return Math.round(totalMins / this.recommendedAvailableDays / unit) * unit;
    },

    // Reads from planPreviewData (populated by _runPlanPreview via a debounced watcher).
    // All step-3 bar values flow through here so there is one calculation path.
    computedSessionLengthPreview() {
      const p = this.planPreviewData;
      if (!p) return null;
      return p;
    },

    totalScheduleHours() {
      return Math.round(this.schedulePreviewData.reduce((s, d) => s + d.hours, 0));
    },
  },

  // ─── Methods ───────────────────────────────────────────────────────────────

  methods: {

    navigate(screen) {
      if (screen === 'home') {
        this.navHistory = [];
      } else {
        this.navHistory = [...this.navHistory, { screen: this.screen, activeTab: this.activeTab }];
      }
      if (screen === 'settings') {
        this.settingsSrText   = (this.settings.srIntervals || [1,6,16,45,131]).join(', ');
        this.settingsSnapshot = JSON.stringify(this.settings);
      }
      if (screen === 'step1') {
        this.trackingMode = false;
        this.activePlanId = null;
        this.unitLength   = 20;
      }
      if (screen === 'planList') {
        this.loadSavedPlans();
      }
      this.screen = screen;
      this.error  = null;
    },

    goBack() {
      if (!this.navHistory.length) {
        this.screen = 'home';
        this.error  = null;
        return;
      }
      const { screen, activeTab } = this.navHistory[this.navHistory.length - 1];
      this.navHistory = this.navHistory.slice(0, -1);
      if (screen === 'planList') this.loadSavedPlans();
      this.screen    = screen;
      this.activeTab = activeTab;
      this.error     = null;
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

        return { ...t, difficulty, startingState, ...phasesFromState(startingState) };
      });
    },

    // Apply any settings hints extracted from free text (schedule, dates).
    _applyFreeTextToSettings(info) {
      if (!info) return;
      let changed = false;
      const WDAYS = ['mon','tue','wed','thu','fri'];
      const WEND  = ['sat','sun'];

      // Start-of-plan intensity → firstWeek (minutes directly)
      if (info.weekdayMinutesStart != null) {
        const mins = Math.max(0, Math.min(720, Math.round(info.weekdayMinutesStart / 20) * 20));
        WDAYS.forEach(d => { this.firstWeek[d] = mins; });
        changed = true;
      }
      if (info.weekendMinutesStart != null) {
        const mins = Math.max(0, Math.min(720, Math.round(info.weekendMinutesStart / 20) * 20));
        WEND.forEach(d => { this.firstWeek[d] = mins; });
        changed = true;
      }

      // End-of-plan intensity → derive intensityMultiplier from weekday end vs start ratio
      if (info.weekdayMinutesEnd != null) {
        const startMins = WDAYS.reduce((s, d) => s + (this.firstWeek[d] || 0), 0) / WDAYS.length;
        if (startMins > 0 && info.weekdayMinutesEnd > 0) {
          this.intensityMultiplier = Math.max(1, Math.min(8, parseFloat((info.weekdayMinutesEnd / startMins).toFixed(2))));
        }
        changed = true;
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
      if ((info.mustIncludeTopics || []).length)
        lines.push(`Must-include topics: ${info.mustIncludeTopics.join(', ')}`);
      return lines;
    },

    async doGenerateTopics() {
      this.loading        = true;
      this.loadingMsg     = 'Asking AI to generate your topic list…';
      this.error          = null;
      this.freeTextApplied = [];

      try {
        // ── API key check: required unless predefined exam with no free-text ──
        const needsApi = !(this.selectedPredefinedExam && this.topicInputMode === 'examName' && !this.freeText.trim());
        if (needsApi && !this.settings.apiKey) {
          throw new Error('An API key is required. Please go to Settings and enter your API key.');
        }

        // ── Step 1: parse free-text notes upfront (single API call, all modes) ──
        let freeTextInfo = {};
        if (this.freeText.trim()) {
          this.loadingMsg = 'Interpreting your notes…';
          freeTextInfo = await StudyApi.parseFreeText(this.freeText, this.settings.apiKey, this.settings.model);
          // Apply schedule hints (daily minutes, dates, mock count) immediately
          this._applyFreeTextToSettings(freeTextInfo);
        }

        // ── Step 2: build/load topic list ────────────────────────────────────
        this.loadingMsg = 'Building your topic list…';

        if (this.selectedPredefinedExam && this.topicInputMode === 'examName') {
          // Predefined exam: load from JSON, no AI topic-generation call needed
          this.loadingMsg = `Loading ${this.selectedPredefinedExam.name}…`;
          const examData = await StudyExams.loadExam(this.selectedPredefinedExam.id);

          // Apply exam-specific settings (overrides localStorage/defaults for this session)
          if (examData.settings) this._applyExamSettings(examData.settings);

          const rawHrs = examData.studyHoursNeeded;
          this.recommendedStudyHours = rawHrs != null ? (parseInt(rawHrs, 10) || null) : null;
          this.recommendedHoursApplied = false;

          const flat = StudyApi.flattenHierarchical(examData.topics || []);
          const titleToId = {};
          this.topics = flat.map(t => {
            const id = this._nextTopicId++;
            if (t.isGroup) titleToId[t.title] = id;
            const ss = t.startingState || 'Not Started';
            return {
              id,
              title:         t.title,
              isGroup:       t.isGroup,
              parentId:      t.parentTitle ? (titleToId[t.parentTitle] || null) : null,
              difficulty:    t.difficulty,
              startingState: ss,
              ...phasesFromState(t.isGroup ? null : ss),
            };
          });

        } else if (this.topicInputMode === 'granularList') {
          this.recommendedStudyHours = null;

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
              return { id, title: t.title, isGroup: true, parentId: null, difficulty: null, startingState: null, enabled: true, doLearn: true, doPractice: true, doRevise: true, _tempId: t._tempId, _parentTempId: t._parentTempId };
            }
            const ai = raw[leafIdx++] || {};
            const ss = ai.startingState || 'Not Started';
            return { id, title: t.title, isGroup: false, difficulty: ai.difficulty || 'medium', startingState: ss, ...phasesFromState(ss), _tempId: t._tempId, _parentTempId: t._parentTempId };
          });
          this.topics = allTopics.map(({ _tempId, _parentTempId, ...t }) => ({
            ...t,
            parentId: _parentTempId ? (tempIdToNewId[_parentTempId] || null) : null,
          }));

        } else {
          this.recommendedStudyHours = null;

          // Mode 1: AI generates the full hierarchy
          const flat = await StudyApi.generateTopics({
            mode:        this.topicInputMode,
            examName:    this.examName,
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
            ...phasesFromState(t.isGroup ? null : (t.startingState || 'Not Started')),
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
        ...phasesFromState('Not Started'),
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
        enabled:       true,
        doLearn:       true,
        doPractice:    true,
        doRevise:      true,
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
        ...phasesFromState('Not Started'),
      });
    },

    deleteGroup(groupId) {
      this.topics = this.topics.filter(t => t.id !== groupId && t.parentId !== groupId);
    },

    toggleGroupCollapse(groupId) {
      const collapsed = this.collapsedGroups[groupId] !== false;
      this.collapsedGroups = { ...this.collapsedGroups, [groupId]: !collapsed };
    },

    isGroupCollapsed(groupId) {
      return this.collapsedGroups[groupId] !== false;
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
      const phases = phasesFromState(value);
      this.topics = this.topics.map(t =>
        t.parentId === groupId ? { ...t, startingState: value, ...phases } : t
      );
    },

    toggleGroupEnabled(groupId, enabled) {
      this.topics = this.topics.map(t =>
        t.parentId === groupId ? { ...t, enabled } : t
      );
    },

    isGroupAllEnabled(groupId) {
      const subs = this.topics.filter(t => t.parentId === groupId);
      return subs.length === 0 || subs.every(t => t.enabled !== false);
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

    _applyExamSettings(s) {
      const KEYS = ['mockDuration', 'learningMode', 'maxNewTopicsPerDay', 'postMockSameDay',
                    'maxDaysBetweenPractice', 'lnTable', 'pnTable', 'srIntervals'];
      KEYS.forEach(k => { if (s[k] !== undefined) this.settings[k] = s[k]; });
      if (typeof s.numMocks === 'number' && s.numMocks >= 0) this.numMocks = s.numMocks;
      this.settingsSrText = (this.settings.srIntervals || [1,6,16,45,131]).join(', ');
    },

    setAllTopicsLearn(checked) {
      this.topics.filter(t => !t.isGroup).forEach(t => { t.doLearn = checked; });
    },
    setAllTopicsPractice(checked) {
      this.topics.filter(t => !t.isGroup).forEach(t => { t.doPractice = checked; });
    },
    setAllTopicsRevise(checked) {
      this.topics.filter(t => !t.isGroup).forEach(t => { t.doRevise = checked; });
    },

    groupLearnState(groupId) {
      const children = this.topics.filter(t => t.parentId === groupId && t.enabled !== false);
      if (!children.length) return 'none';
      const allOn = children.every(t => t.doLearn !== false);
      const allOff = children.every(t => t.doLearn === false);
      return allOn ? 'all' : allOff ? 'none' : 'mixed';
    },
    groupPracticeState(groupId) {
      const children = this.topics.filter(t => t.parentId === groupId && t.enabled !== false);
      if (!children.length) return 'none';
      const allOn = children.every(t => t.doPractice !== false);
      const allOff = children.every(t => t.doPractice === false);
      return allOn ? 'all' : allOff ? 'none' : 'mixed';
    },
    groupReviseState(groupId) {
      const children = this.topics.filter(t => t.parentId === groupId && t.enabled !== false);
      if (!children.length) return 'none';
      const allOn = children.every(t => t.doRevise !== false);
      const allOff = children.every(t => t.doRevise === false);
      return allOn ? 'all' : allOff ? 'none' : 'mixed';
    },
    setGroupLearn(groupId, checked) {
      this.topics.filter(t => t.parentId === groupId).forEach(t => { t.doLearn = checked; });
    },
    setGroupPractice(groupId, checked) {
      this.topics.filter(t => t.parentId === groupId).forEach(t => { t.doPractice = checked; });
    },
    setGroupRevise(groupId, checked) {
      this.topics.filter(t => t.parentId === groupId).forEach(t => { t.doRevise = checked; });
    },

    toggleChartCollapsed() {
      this.chartCollapsed = !this.chartCollapsed;
      this.$nextTick(() => this.renderChart());
    },

    // ── Plan preview (step 3 bar) ───────────────────────────────────────────

    // Schedules a debounced call to _runPlanPreview (300 ms).
    _schedulePlanPreview() {
      if (this._planPreviewTimer) clearTimeout(this._planPreviewTimer);
      this._planPreviewTimer = setTimeout(() => this._runPlanPreview(), 300);
    },

    // Runs the actual scheduler (no mock placement) up to twice to converge on
    // an accurate session length, then stores the result in planPreviewData.
    // This is the single calculation point for all step-3 bar values.
    _runPlanPreview() {
      if (typeof StudyPlanner === 'undefined' || !StudyPlanner.previewPlan) return;
      if (!this.startDate || !this.examDate) { this.planPreviewData = null; return; }

      const leafTopics = this.topics.filter(t => !t.isGroup && t.enabled !== false);
      if (!leafTopics.length) { this.planPreviewData = null; return; }

      const srIntervals = (this.settingsSrText || '')
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);

      const base = {
        topics: leafTopics.map(t => {
          const doLearn    = t.doLearn    !== false;
          const doPractice = t.doPractice !== false;
          const doRevise   = t.doRevise   !== false;
          return {
            id: t.id, name: t.title, difficulty: t.difficulty || 'medium',
            startingState: doLearn ? 'Not Started' : doPractice ? 'Learned' : 'Reviewing',
            skipReviews: !doRevise,
          };
        }),
        startDate:   new Date(this.startDate + 'T00:00:00Z'),
        examDate:    new Date(this.examDate   + 'T00:00:00Z'),
        firstWeek:   this.firstWeek,
        lastWeek:    this.lastWeekComputed,
        rampMode:    this.rampMode,
        srIntervals: srIntervals.length ? srIntervals : [1, 6, 16, 45, 131],
        blockedDays: this.breakDays || [],
        settings: {
          lnTable:                this.settings.lnTable,
          pnTable:                this.settings.pnTable,
          learningMode:           this.settings.learningMode || 'interleaved',
          maxNewTopicsPerDay:     this.settings.maxNewTopicsPerDay,
          maxDaysBetweenPractice: this.settings.maxDaysBetweenPractice || 7,
        },
        forcedSessionLength: this.unitLength || null,
      };

      // Mirror doGeneratePlan exactly: start at the computed T, search downward until
      // LP fits or we hit SESSION_MIN. This guarantees step-3 and step-4 agree.
      let r = StudyPlanner.previewPlan(base);
      if (!r.lpFits) {
        const minT = StudyPlanner.SESSION_MIN || 10;
        for (let t = r.sessionLength - 1; t >= minT; t--) {
          const candidate = StudyPlanner.previewPlan({ ...base, forcedSessionLength: t });
          if (candidate.lpFits) { r = candidate; break; }
          if (t === minT) r = candidate;
        }
      }

      const MIN = StudyPlanner.SESSION_MIN || 10;
      const totalTopics = leafTopics.length;
      const totalSessionsNeeded = r.sessionCounts.total + r.overflow.totalMissingSessions;
      const requiredHours = Math.round(totalSessionsNeeded * r.sessionLength / 60);
      const allocatedHours = Math.round(r.totalMinutes / 60);
      const extraHours = r.lpFits ? 0 : Math.max(0, requiredHours - allocatedHours);

      this.planPreviewData = {
        sessionLength:   r.sessionLength,
        insufficient:    !r.lpFits && r.sessionLength <= MIN,
        rawT:            r.totalMinutes > 0 && r.totalWorkUnits > 0
                           ? Math.round(r.totalMinutes / (r.totalWorkUnits * (StudyPlanner.OVERHEAD_FACTOR || 1.25)) * 10) / 10
                           : 0,
        totalWorkUnits:  r.totalWorkUnits,
        requiredHours,
        lpFits:          r.lpFits,
        overflow:        r.overflow,
        totalTopics,
        learnComplete:   totalTopics - r.overflow.incompleteLearnTopics.length,
        practiceComplete: totalTopics - r.overflow.incompleteMCQTopics.length,
        extraHours,
      };
    },

    // ── Step 3 → Step 4 ────────────────────────────────────────────────────

    // Build the generatePlan config from current Vue state.
    _planConfig() {
      // Groups are organisational only — filter them before passing to the scheduler
      const planTopics  = this.topics
        .filter(t => !t.isGroup && t.enabled !== false)
        .map(t => {
          const doLearn    = t.doLearn    !== false;
          const doPractice = t.doPractice !== false;
          const doRevise   = t.doRevise   !== false;
          const startingState = doLearn ? 'Not Started' : doPractice ? 'Learned' : 'Reviewing';
          return {
            id: t.id, name: t.title, difficulty: t.difficulty,
            startingState, skipReviews: !doRevise,
          };
        });
      const srIntervals = this.settingsSrText
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
      return {
        topics:              planTopics,
        startDate:           new Date(this.startDate + 'T00:00:00Z'),
        examDate:            new Date(this.examDate   + 'T00:00:00Z'),
        firstWeek:           this.firstWeek,
        lastWeek:            this.lastWeekComputed,
        rampMode:            this.rampMode,
        numMocks:            this.numMocks,
        srIntervals:         srIntervals.length ? srIntervals : [1,6,16,45,131],
        postMockSameDay:     this.settings.postMockSameDay !== false,
        fixedMockDates:      this._buildFixedMockDates(),
        blockedDays:         this.breakDays || [],
        forcedSessionLength: this.unitLength,
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
      const result = {};
      for (const k of keys) {
        if (this.mockDateOverrides[k]) {
          result[Number(k)] = new Date(this.mockDateOverrides[k] + 'T00:00:00Z');
        }
      }
      return Object.keys(result).length ? result : null;
    },

    // Apply a finished generatePlan result to Vue state.
    _applyPlanResult(result) {
      this.planResult       = result;
      this.hydratedCalendar = hydrateCalendar(result.calendar, result.topics, result.mocks, result.sessionLength);

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

      this.expandedDays         = {};
      this.expandedTopicGroups  = {};
      this.calendarPopover      = null;
      if (result.overflow.hasOverflow) this.$nextTick(() => this.drawScheduleChart());
      this.initCalMonth();
      this.initCalWeek();
      this.$nextTick(() => this._openTodayPopover());
      StudyStorage.saveCurrentPlan(this.buildPlanData());
      this._savePlanToStorage();
    },

    doGeneratePlan() {
      this.mockDateOverrides = {};
      this.unitLength = 20;   // always recalculate from scratch; auto-adjust will find the right value
      this.loading    = true;
      this.loadingMsg = 'Building your study plan…';
      this.error      = null;
      // Assign a plan ID if this is a fresh generation (not a recalculation in tracking mode)
      if (!this.activePlanId) this.activePlanId = StudyStorage.createPlanId();

      setTimeout(() => {
        try {
          let result = StudyPlanner.generatePlan(this._planConfig());
          // Auto-adjust unit length downward if the plan overflows
          if (result.overflow.hasOverflow) {
            const minT = typeof StudyPlanner !== 'undefined' ? StudyPlanner.SESSION_MIN : 10;
            const startT = result.sessionLength - 1;
            for (let t = startT; t >= minT; t--) {
              const candidate = StudyPlanner.generatePlan({ ...this._planConfig(), forcedSessionLength: t });
              if (!candidate.overflow.hasOverflow) {
                this.unitLength = t;
                result = candidate;
                break;
              }
              if (t === minT) result = candidate; // apply min-T result even if still overflow
            }
          }
          this._applyPlanResult(result);
          this.activeTab = 'calendar';
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
          this.activeTab = 'calendar';
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loading = false;
          this.$nextTick(() => this.renderChart());
        }
      }, 50);
    },

    // Try progressively shorter unit lengths (1-min steps) keeping daily minutes fixed.
    // Uses forcedSessionLength to override the planner's auto-computed T.
    doAdjustSessionLength() {
      this.loading    = true;
      this.loadingMsg = 'Finding optimal unit length…';
      this.error      = null;

      setTimeout(() => {
        try {
          const currentT = this.planResult.sessionLength;
          const minT     = typeof StudyPlanner !== 'undefined' ? StudyPlanner.SESSION_MIN : 10;
          let   result   = null;
          let   found    = false;

          for (let t = currentT - 1; t >= minT; t -= 1) {
            const cfg = { ...this._planConfig(), forcedSessionLength: t };
            result = StudyPlanner.generatePlan(cfg);
            if (!result.overflow.hasOverflow) {
              found = true;
              break;
            }
          }

          if (!found) {
            this.error = `Reducing unit length to ${minT} min is not enough to fix the overflow. Try increasing daily study time instead.`;
            // Still apply the result at minimum T so the user sees what's left
            result = StudyPlanner.generatePlan({ ...this._planConfig(), forcedSessionLength: minT });
          }

          if (found) this.unitLength = result.sessionLength;
          this._applyPlanResult(result);
          this.activeTab = 'calendar';
          this.navigate('step4');
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loading = false;
          this.$nextTick(() => this.renderChart());
        }
      }, 50);
    },

    // Scale firstWeek daily minutes up so the plan fits, then regenerate.
    doAdjustSchedule() {
      this.loading    = true;
      this.loadingMsg = 'Adjusting schedule…';
      this.error      = null;

      setTimeout(() => {
        try {
          let result = StudyPlanner.generatePlan(this._planConfig());

          if (result.overflow.hasOverflow) {
            const { overflow, sessionStats, sessionLength } = result;
            let factor = 1;

            // Session-length overflow: need more total minutes so T ≥ SESSION_MIN
            if (overflow.sessionLengthInsufficient && overflow.requiredSessionLength > 0) {
              const rawT    = overflow.requiredSessionLength;
              const minT    = StudyPlanner.SESSION_MIN;
              factor = Math.max(factor, (minT / rawT) * 1.05);
            }

            // Topic overflow: need more sessions
            if ((overflow.incompleteLearnTopics.length > 0 || overflow.incompleteMCQTopics.length > 0) &&
                overflow.totalMissingSessions > 0 && sessionStats.totalMinutes > 0) {
              const addedMins = overflow.totalMissingSessions * sessionLength;
              const f = ((sessionStats.totalMinutes + addedMins) / sessionStats.totalMinutes) * 1.10;
              factor = Math.max(factor, f);
            }

            if (factor > 1) {
              for (const key of Object.keys(this.firstWeek)) {
                if (this.firstWeek[key] > 0) {
                  // Round to nearest 20-min increment
                  const raw = this.firstWeek[key] * factor;
                  this.firstWeek[key] = Math.min(720, Math.max(20, Math.round(raw / 20) * 20));
                }
              }
              result = StudyPlanner.generatePlan(this._planConfig());
              if (result.overflow.hasOverflow) {
                this.error = 'Schedule adjusted but the plan still overflows. Try adding more days or removing topics.';
              }
            }
          }

          this._applyPlanResult(result);
          this.activeTab = 'calendar';
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
      if (tab === 'daily' && this.trackingMode) {
        this.$nextTick(() => this.scrollToToday());
      }
      if (tab === 'calendar') {
        this.$nextTick(() => this._openTodayPopover());
      }
    },

    _openTodayPopover() {
      const cells = this.calViewMode === 'week' ? this.calendarWeekCells : this.calendarCells;
      const flat  = cells.filter(c => c);
      const today = flat.find(c => c.dateKey === this.todayKey);
      if (today) { this.calendarPopover = today; return; }
      const firstStudy = flat.find(c => c.sessions.length > 0);
      this.calendarPopover = firstStudy || flat[0] || null;
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

      // Draw today marker (vertical dashed red line)
      if (this._chartDateKeys) {
        const todayIdx = this._chartDateKeys.indexOf(this.todayKey);
        if (todayIdx >= 0) {
          const ctx = canvas.getContext('2d');
          const LABEL_W = 180, CELL_W = 8;
          const x = LABEL_W + todayIdx * CELL_W + Math.floor(CELL_W / 2);
          ctx.save();
          ctx.strokeStyle = 'rgba(239,68,68,0.85)';
          ctx.lineWidth   = 2;
          ctx.setLineDash([5, 3]);
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
          ctx.stroke();
          ctx.restore();
        }
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
      const anchor = this.trackingMode ? this.todayKey : this.startDate;
      const d = new Date((anchor || this.startDate) + 'T00:00:00Z');
      this.currentCalMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      this.calendarPopover = null;
    },

    initCalWeek() {
      const anchor = this.trackingMode ? this.todayKey : (this.startDate || this.todayKey);
      const d   = new Date(anchor + 'T00:00:00Z');
      const dow = (d.getUTCDay() + 6) % 7;  // 0=Mon … 6=Sun
      this.currentCalWeekStart = new Date(d.getTime() - dow * 86400000);
      this.calendarPopover = null;
    },

    prevCalMonth() {
      const d = this.currentCalMonth;
      this.currentCalMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
      this.$nextTick(() => this._openTodayPopover());
    },

    nextCalMonth() {
      const d = this.currentCalMonth;
      this.currentCalMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      this.$nextTick(() => this._openTodayPopover());
    },

    prevCalWeek() {
      const d = this.currentCalWeekStart;
      this.currentCalWeekStart = new Date(d.getTime() - 7 * 86400000);
      this.$nextTick(() => this._openTodayPopover());
    },

    nextCalWeek() {
      const d = this.currentCalWeekStart;
      this.currentCalWeekStart = new Date(d.getTime() + 7 * 86400000);
      this.$nextTick(() => this._openTodayPopover());
    },

    switchCalView(mode) {
      const prevKey = this.calendarPopover?.dateKey || null;
      this.calViewMode = mode;

      if (prevKey) {
        // A day was selected — navigate to show it in the new view, re-select it
        const d = new Date(prevKey + 'T00:00:00Z');
        if (mode === 'week') {
          const dow = (d.getUTCDay() + 6) % 7;
          this.currentCalWeekStart = new Date(d.getTime() - dow * 86400000);
        } else {
          this.currentCalMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
        }
        this.calendarPopover = null;
        this.$nextTick(() => {
          const cells = mode === 'week' ? this.calendarWeekCells : this.calendarCells;
          const cell  = cells.find(c => c && c.dateKey === prevKey);
          this.calendarPopover = cell || null;
        });
      } else {
        // No selection — navigate contextually
        if (mode === 'week') {
          // First week of the current month
          const m = this.currentCalMonth;
          if (m) {
            const first = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1));
            const dow   = (first.getUTCDay() + 6) % 7;
            this.currentCalWeekStart = new Date(first.getTime() - dow * 86400000);
          } else {
            this.initCalWeek();
          }
        } else {
          // Month containing the current week's Monday
          const w = this.currentCalWeekStart;
          if (w) {
            this.currentCalMonth = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), 1));
          } else {
            this.initCalMonth();
          }
        }
        this.$nextTick(() => this._openTodayPopover());
      }
    },

    isPast(dateKey) {
      return typeof dateKey === 'string' && dateKey < this.todayKey;
    },

    isPastDate(date) {
      if (!date) return false;
      const dk = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
      return dk < this.todayKey;
    },

    goToToday() {
      if (this.calViewMode === 'month') this.initCalMonth();
      else this.initCalWeek();
      this.$nextTick(() => this._openTodayPopover());
    },

    calCellClick(cell) {
      if (!cell) return;
      this.calendarPopover = cell;
    },

    _calShortLabel(dateKey) {
      if (!dateKey) return '';
      return new Date(dateKey + 'T00:00:00Z')
        .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    },

    calNavPrevDay() { this._calNavGoTo(this.calNavPrevKey); },
    calNavNextDay() { this._calNavGoTo(this.calNavNextKey); },

    _calNavGoTo(targetKey) {
      if (!targetKey) return;
      const targetDate = new Date(targetKey + 'T00:00:00Z');

      // Navigate the view if the target day is outside the current view
      if (this.calViewMode === 'month') {
        const tm = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), 1));
        if (tm.getTime() !== this.currentCalMonth?.getTime()) this.currentCalMonth = tm;
      } else {
        const ws = this.currentCalWeekStart;
        const we = ws ? new Date(ws.getTime() + 6 * 86400000) : null;
        if (!ws || targetDate < ws || targetDate > we) {
          const dow = (targetDate.getUTCDay() + 6) % 7;
          this.currentCalWeekStart = new Date(targetDate.getTime() - dow * 86400000);
        }
      }

      // After Vue recomputes the cell arrays, pick the real cell (with activityBars etc.)
      // or fall back to a minimal stub for days outside the plan range
      this.$nextTick(() => {
        const cells = this.calViewMode === 'week' ? this.calendarWeekCells : this.calendarCells;
        const found = cells.find(c => c && c.dateKey === targetKey);
        if (found) { this.calendarPopover = found; return; }
        // Stub for out-of-plan days
        const hydr = this.hydratedCalendar.find(d => {
          const dk = d.date instanceof Date ? d.date.toISOString().slice(0,10) : String(d.date).slice(0,10);
          return dk === targetKey;
        });
        this.calendarPopover = {
          date: targetDate, dateKey: targetKey,
          sessions: hydr ? hydr.sessions : [],
          isStudyDay: false, activityBars: [],
        };
      });
    },

    // ── Day-by-day collapse ─────────────────────────────────────────────────

    toggleDay(dateKey) {
      this.expandedDays = { ...this.expandedDays, [dateKey]: !this.expandedDays[dateKey] };
    },

    isDayExpanded(dateKey) {
      return !!this.expandedDays[dateKey];
    },

    expandAllDays() {
      const expanded = {};
      this.studyDaysWithSessions.forEach(d => { expanded[d.dateKey] = true; });
      this.expandedDays = expanded;
    },

    collapseAllDays() {
      this.expandedDays = {};
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
      const mockMins    = this.settings.mockDuration || 90;
      const sessionMins = this.planResult?.sessionLength || 20;
      let mins = 0;
      for (const s of sessions) {
        if (s.activityType === 'mock')          { mins += mockMins; }
        else if (s.activityType !== 'postMock') { mins += sessionMins; }
      }
      return mins > 0 ? this.fmtMins(Math.round(mins)) : '';
    },

    fmtMins(mins) {
      if (mins <= 0) return '0min';
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h === 0) return `${m}min`;
      return m > 0 ? `${h}h${m}` : `${h}h`;
    },

    adjustAllDays(delta) {
      for (const dow of ['mon','tue','wed','thu','fri','sat','sun']) {
        if (this.firstWeek[dow] > 0) {
          this.firstWeek[dow] = Math.min(720, Math.max(0, this.firstWeek[dow] + delta));
        }
      }
    },

    applyRecommendedHours() {
      if (!this.recommendedStudyHours || !this.startDate || !this.examDate) return;
      const start = new Date(this.startDate + 'T00:00:00Z');
      const exam  = new Date(this.examDate  + 'T00:00:00Z');
      let nWeekday = 0, nWeekend = 0;
      for (let cur = new Date(start); cur < exam; cur = new Date(cur.getTime() + 86400000)) {
        const dow = cur.getUTCDay();
        if (dow === 0 || dow === 6) nWeekend++; else nWeekday++;
      }
      const denominator = nWeekday + 3 * nWeekend;
      if (!denominator) return;
      const unit = 20;
      const weekdayMins = Math.max(unit, Math.ceil(this.recommendedStudyHours * 60 / denominator / unit) * unit);
      const weekendMins = Math.min(720, weekdayMins * 3);
      this.firstWeek = {
        mon: weekdayMins, tue: weekdayMins, wed: weekdayMins,
        thu: weekdayMins, fri: weekdayMins,
        sat: weekendMins, sun: weekendMins,
      };
      this.intensityMultiplier = 1;
      this.recommendedHoursApplied = true;
      this.$nextTick(() => this._runPlanPreview());
    },

    addBreakDay() {
      const input = this.$refs.breakDayPicker;
      if (input) input.showPicker ? input.showPicker() : input.click();
    },

    onBreakDayPicked(e) {
      const val = (e && e.target && e.target.value) || this.breakDayInputVal;
      if (val && !this.breakDays.includes(val)) {
        this.breakDays = [...this.breakDays, val].sort();
      }
      this.breakDayInputVal = '';
    },

    removeBreakDay(d) {
      this.breakDays = this.breakDays.filter(x => x !== d);
    },

    adjustIntensity(delta) {
      const val = Math.round((this.intensityMultiplier + delta) * 100) / 100;
      this.intensityMultiplier = Math.max(1, Math.min(8, val));
    },

    drawScheduleChart() {
      const canvas = this.$refs.scheduleCanvas;
      if (!canvas) return;
      const data = this.schedulePreviewData;
      const dpr  = window.devicePixelRatio || 1;
      const W    = canvas.clientWidth;
      const H    = canvas.clientHeight;
      if (!W || !H) return;
      canvas.width  = W * dpr;
      canvas.height = H * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);

      if (!data.length) {
        ctx.fillStyle = '#9ca3af';
        ctx.font = '12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Set study dates above to see preview', W / 2, H / 2);
        this._scheduleBars = [];
        return;
      }

      const padL = 36, padR = 8, padT = 10, padB = 40;
      const cW   = W - padL - padR;
      const cH   = H - padT - padB;
      const maxH = Math.max(...data.map(d => d.hours), 1);
      const yMax = Math.ceil(maxH / 5) * 5 || 5;
      const n    = data.length;

      // grid lines + y-axis labels
      const ySteps = 4;
      for (let i = 0; i <= ySteps; i++) {
        const y = padT + cH - (i / ySteps) * cH;
        ctx.strokeStyle = i === 0 ? '#d1d5db' : '#f3f4f6';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cW, y); ctx.stroke();
        ctx.fillStyle = '#9ca3af';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(i * yMax / ySteps) + 'h', padL - 3, y + 3);
      }

      // bars
      const slot = cW / n;
      const barW = Math.max(2, Math.floor(slot * 0.65));
      this._scheduleBars = [];
      const startMs = this.startDate ? new Date(this.startDate + 'T00:00:00Z').getTime() : null;

      data.forEach((d, i) => {
        const h  = (d.hours / yMax) * cH;
        const bx = padL + i * slot + (slot - barW) / 2;
        const by = padT + cH - Math.max(1, h);
        ctx.fillStyle = 'rgba(99,102,241,0.75)';
        ctx.fillRect(bx, by, barW, Math.max(1, h));
        this._scheduleBars.push({
          colX: padL + i * slot, slot,
          barX: bx, barW, barY: by, barH: Math.max(1, h),
          hours: d.hours, week: d.week,
        });
      });

      // x-axis labels: week number + date
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const labelStep = Math.max(1, Math.ceil(n / 8));
      data.forEach((d, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return;
        const cx = padL + i * slot + slot / 2;
        // week label
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('W' + d.week, cx, H - padB + 13);
        // date label
        if (startMs) {
          const dt = new Date(startMs + (d.week - 1) * 7 * 86400000);
          const dateStr = dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()];
          ctx.fillStyle = '#9ca3af';
          ctx.font = '9px system-ui';
          ctx.fillText(dateStr, cx, H - padB + 24);
        }
      });
    },

    onScheduleChartMouseMove(event) {
      const canvas = this.$refs.scheduleCanvas;
      if (!canvas || !this._scheduleBars || !this._scheduleBars.length) {
        this.scheduleTooltip.visible = false;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mx   = event.clientX - rect.left;
      const bar  = this._scheduleBars.find(b => mx >= b.colX && mx < b.colX + b.slot);
      if (bar) {
        const ttX = bar.colX + bar.slot / 2;
        const ttY = bar.barY - 4;
        this.scheduleTooltip = { visible: true, text: bar.hours.toFixed(1) + 'h', x: ttX, y: ttY };
      } else {
        this.scheduleTooltip.visible = false;
      }
    },

    // ── Export ──────────────────────────────────────────────────────────────

    doExportDailyCsv() {
      StudyStorage.exportDayByDayCsv(
        this.hydratedCalendar,
        this.completionStatus,
        this.planResult?.sessionLength || 20,
      );
    },

    doExportTopicsCsv() {
      StudyStorage.exportTopicCsv(
        this.topicSummaries,
        this.planResult?.sessionLength || 20,
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
        lastWeek:         this.lastWeekComputed,
        intensityMultiplier: this.intensityMultiplier,
        rampMode:         this.rampMode,
        numMocks:         this.numMocks,
        unitLength:       this.unitLength,
        settings:         (({ apiKey, ...rest }) => rest)(this.settings),
        settingsSrText:   this.settingsSrText,
        completionStatus: this.completionStatus,
        breakDays:        this.breakDays,
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
      if (data.intensityMultiplier != null) {
        this.intensityMultiplier = data.intensityMultiplier;
      } else if (data.lastWeek && data.firstWeek) {
        const wdays = ['mon','tue','wed','thu','fri'];
        const sumF = wdays.reduce((s, d) => s + (data.firstWeek[d] || 0), 0);
        const sumL = wdays.reduce((s, d) => s + (data.lastWeek[d]  || 0), 0);
        if (sumF > 0) this.intensityMultiplier = Math.max(1, parseFloat((sumL / sumF).toFixed(2)));
      }
      if (data.rampMode)           this.rampMode    = data.rampMode;
      if (data.numMocks)           this.numMocks    = data.numMocks;
      if (data.unitLength != null) this.unitLength  = data.unitLength;
      if (data.examName)           this.examName    = data.examName;
      if (data.topicInputMode) this.topicInputMode = data.topicInputMode;
      if (data.settings)      Object.assign(this.settings, data.settings);
      if (data.settingsSrText) this.settingsSrText = data.settingsSrText;
      if (Array.isArray(data.breakDays)) this.breakDays = data.breakDays;
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
      this.goBack();
    },

    doSaveSettings() {
      const srArr = this.settingsSrText
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
      this.settings.srIntervals = srArr.length ? srArr : [1,6,16,45,131];

      StudyStorage.saveSettings(this.settings);

      if (this.planResult) {
        // Regenerate with updated settings, topics, schedule, and exam date.
        this.doGeneratePlan();
      } else {
        this.goBack();
      }
    },

    // ── Display helpers ───────────────────────────────────────────────────────

    formatDate(date) {
      if (!date) return '';
      let d;
      if (date instanceof Date) {
        d = date;
      } else {
        const s = String(date);
        d = new Date(s.length === 10 ? s + 'T00:00:00Z' : s);
      }
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

    dayActivityBar(sessions) {
      const COLORS = { learn: '#3b82f6', practice: '#f59e0b', review: '#16a34a', mock: '#7c3aed', postMock: '#c084fc' };
      const LABELS = { learn: 'Learn', practice: 'Practice', review: 'Revise', mock: 'Mock Exam', postMock: 'Post-mock' };
      const merged = this.mergeSessions(sessions);
      const total  = merged.reduce((s, b) => s + b.count, 0);
      if (!total) return [];
      return merged.map(b => ({
        color:        COLORS[b.activityType] || '#999',
        pct:          (b.count / total) * 100,
        label:        b.topicTitle ? `${LABELS[b.activityType] || b.activityType} · ${b.topicTitle}` : (LABELS[b.activityType] || b.activityType),
        activityType: b.activityType,
      }));
    },

    mergeSessions(sessions) {
      if (!sessions.length) return [];
      const out = [];
      let cur = { ...sessions[0], count: 1 };
      for (let i = 1; i < sessions.length; i++) {
        const s = sessions[i];
        if (s.topicTitle === cur.topicTitle && s.activityType === cur.activityType) {
          cur.count++;
          if (s.activityType === 'practice') cur._lastMcqNum = s._mcqNum;
          if (s.activityType === 'learn')    cur._lastLnNum  = s._lnNum;
        } else {
          out.push(cur);
          cur = { ...s, count: 1 };
        }
      }
      out.push(cur);
      for (const block of out) {
        if (block.activityType === 'practice' && block.count > 1 && block._mcqNum != null) {
          const last = block._lastMcqNum ?? (block._mcqNum + block.count - 1);
          block.reason = practiceReasonText(block._mcqNum, last, block.totalPN ?? 1);
        }
        if (block.activityType === 'learn' && block.count > 1 && block._lnNum != null) {
          const last = block._lastLnNum ?? (block._lnNum + block.count - 1);
          block.reason = learnReasonText(block._lnNum, last, block.totalLN ?? 1);
        }
      }
      return out;
    },

    // ── New Plan helper ─────────────────────────────────────────────────────

    startNewPlan() {
      this.trackingMode = false;
      this.activePlanId = null;
      this.trackedBlockedDays = [];
      this.unitLength = 20;
      this.firstWeek = { mon: 60, tue: 60, wed: 60, thu: 60, fri: 60, sat: 60, sun: 60 };
      this.intensityMultiplier = 1;
      this.rampMode = 'linear';
      this.breakDays = [];
      this.recommendedStudyHours = null;
      this.recommendedHoursApplied = false;
      this.navigate('step1');
    },

    // ── Tracking: plan list ─────────────────────────────────────────────────

    loadSavedPlans() {
      this.savedPlans = StudyStorage.listPlans()
        .slice()
        .sort((a, b) => (b.lastSavedAt || '').localeCompare(a.lastSavedAt || ''));
    },

    // Revive serialized Date strings back to Date objects in a loaded planResult.
    _revivePlanResult(pr) {
      if (!pr) return pr;
      const toDate = s => {
        if (s instanceof Date) return s;
        if (!s) return s;
        const str = String(s);
        return new Date(str.length === 10 ? str + 'T00:00:00Z' : str);
      };
      return {
        ...pr,
        calendar: (pr.calendar || []).map(d => ({ ...d, date: toDate(d.date) })),
        mocks:    (pr.mocks    || []).map(m => ({ ...m, date: toDate(m.date) })),
      };
    },

    doTrackPlan(planId) {
      const saved = StudyStorage.loadPlan(planId);
      if (!saved) { this.error = 'Could not load plan.'; return; }

      // Restore all plan state
      const data = saved.inputs || {};
      if (data.topics)        this.topics          = data.topics;
      if (data.startDate)     this.startDate       = data.startDate;
      if (data.examDate)      this.examDate        = data.examDate;
      if (data.firstWeek)     this.firstWeek       = data.firstWeek;
      if (data.intensityMultiplier != null) {
        this.intensityMultiplier = data.intensityMultiplier;
      } else if (data.lastWeek && data.firstWeek) {
        const wdays = ['mon','tue','wed','thu','fri'];
        const sumF = wdays.reduce((s, d) => s + (data.firstWeek[d] || 0), 0);
        const sumL = wdays.reduce((s, d) => s + (data.lastWeek[d]  || 0), 0);
        if (sumF > 0) this.intensityMultiplier = Math.max(1, parseFloat((sumL / sumF).toFixed(2)));
      }
      if (data.rampMode)           this.rampMode    = data.rampMode;
      if (data.numMocks != null)   this.numMocks   = data.numMocks;
      if (data.unitLength != null) this.unitLength = data.unitLength;
      if (data.examNameStr)        this.examName   = data.examNameStr;
      if (data.topicInputMode) this.topicInputMode = data.topicInputMode;
      if (data.settings)      Object.assign(this.settings, data.settings);
      if (data.settingsSrText) this.settingsSrText = data.settingsSrText;
      if (this.topics.length) this._nextTopicId = Math.max(...this.topics.map(t => t.id || 0)) + 1;

      // Restore plan result — revive date strings → Date objects
      if (saved.planResult) {
        const pr = this._revivePlanResult(saved.planResult);
        this.planResult = pr;
        this.hydratedCalendar = hydrateCalendar(pr.calendar, pr.topics, pr.mocks, pr.sessionLength);
        const planById = {};
        pr.topics.forEach(pt => { planById[pt.id] = pt; });
        this.chartTopicsData = this.topics.map(t => ({
          id: t.id, title: t.title, isGroup: t.isGroup || false, parentId: t.parentId || null,
          totalPN: planById[t.id]?.totalPN || 4,
          startingState: planById[t.id]?.startingState || t.startingState || 'Not Started',
        }));
        this.expandedDays         = {};
        this.expandedTopicGroups  = {};
      }

      // Restore tracking state
      this.trackedBlockedDays  = (saved.tracking?.blockedDays || []).slice();
      this.completionStatus    = saved.tracking?.completionStatus || {};
      this.lockedDays          = saved.tracking?.lockedDays || {};
      this.lastTrackedDate     = saved.tracking?.lastTrackedDate || null;
      this.trackingMode  = true;
      this.activePlanId  = planId;

      // Check if we need the auto-mark prompt
      const yesterday = (() => {
        const d = new Date(this.todayKey + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      const toDkLocal = d => d.date instanceof Date ? d.date.toISOString().slice(0,10) : String(d.date).slice(0,10);
      // When lastTrackedDate is known: gap exists if last check-in was before yesterday.
      // When null (first open): gap exists only if the plan has sessions from before yesterday
      // (i.e. started 2+ days ago) — a 1-day-old plan opened for the first time never prompts.
      const gapExists = this.lastTrackedDate
        ? this.lastTrackedDate < yesterday
        : this.hydratedCalendar.some(d => toDkLocal(d) < yesterday && (d.sessions || []).length > 0);

      if (gapExists) {
        this.autoMarkPromptVisible = true;
        // Don't auto-advance yet — wait for user response (confirmAutoMark / dismissAutoMark will call it)
      } else {
        this.autoMarkPromptVisible = false;
        this.topics = this._autoAdvanceTopicStates(saved);
      }

      this.initCalMonth();
      this.initCalWeek();
      this.activeTab = 'calendar';
      this.navigate('step4');
      this.$nextTick(() => {
        this.renderChart();
        this._openTodayPopover();
      });
    },

    doDeletePlan(planId) {
      if (!confirm('Delete this plan? This cannot be undone.')) return;
      StudyStorage.deletePlan(planId);
      this.loadSavedPlans();
      if (this.activePlanId === planId) {
        this.trackingMode = false;
        this.activePlanId = null;
      }
    },

    doDeleteAllPlans() {
      const n = this.savedPlans.length;
      if (!confirm(`Permanently delete all ${n} saved plan${n !== 1 ? 's' : ''}?\n\nThis cannot be undone.`)) return;
      StudyStorage.clearAllPlans();
      this.savedPlans         = [];
      this.trackingMode       = false;
      this.activePlanId       = null;
      this.trackedBlockedDays = [];
      this.lockedDays         = {};
      this.navigate('home');
    },

    doClearCachedData() {
      if (!confirm('Clear the current unsaved plan from memory?\n\nSaved and tracked plans will not be affected.')) return;
      StudyStorage.clearCurrentPlan();
      this.planResult       = null;
      this.hydratedCalendar = [];
      this.completionStatus            = {};
      this.lockedDays                  = {};
      this.autoMarkPromptVisible       = false;
      this.manualMarkReminderVisible   = false;
      this.rescheduleFromPromptVisible = false;
      this.unmarkedPastPromptVisible   = false;
      this.lastTrackedDate             = null;
      this.calendarPopover  = null;
    },

    // ── Tracking: blocked days ──────────────────────────────────────────────

    isBlockedDay(dateKey) {
      return this.trackedBlockedDays.includes(dateKey);
    },

    sessionKey(dateKey, block) {
      const id = block.topicId != null ? block.topicId : block.activityType;
      return `${dateKey}|${id}|${block.activityType}`;
    },

    isSessionDone(dateKey, block) {
      return this.completionStatus[this.sessionKey(dateKey, block)] === 'done';
    },

    isSessionSkipped(dateKey, block) {
      return this.completionStatus[this.sessionKey(dateKey, block)] === 'skip';
    },

    setSessionStatus(dateKey, block, status) {
      if (this.lockedDays[dateKey]) return;
      const key = this.sessionKey(dateKey, block);
      const next = { ...this.completionStatus };
      if (next[key] === status) {
        delete next[key];
      } else {
        next[key] = status;
      }
      this.completionStatus = next;
      this._savePlanToStorage();
    },

    _autoMarkPastDays() {
      const today = this.todayKey;
      const blocked = new Set(this.trackedBlockedDays);
      const next = { ...this.completionStatus };
      for (const d of this.hydratedCalendar) {
        const dk = d.date instanceof Date ? d.date.toISOString().slice(0,10) : String(d.date).slice(0,10);
        if (!dk || dk >= today || blocked.has(dk)) continue;
        const merged = this.mergeSessions(d.sessions || []);
        for (const block of merged) {
          const key = this.sessionKey(dk, block);
          if (next[key] === undefined) next[key] = 'done';
        }
      }
      this.completionStatus = next;
    },

    confirmAutoMark() {
      this._autoMarkPastDays();
      this.topics = this._autoAdvanceTopicStates(StudyStorage.loadPlan(this.activePlanId));
      this.autoMarkPromptVisible = false;
      this._savePlanToStorage();
    },

    dismissAutoMark() {
      this.topics = this._autoAdvanceTopicStates(StudyStorage.loadPlan(this.activePlanId));
      this.autoMarkPromptVisible = false;
      this.manualMarkReminderVisible = true;
    },

    isBreakDay(dateKey) {
      return this.breakDays.includes(dateKey);
    },

    toggleBlockedDay(dateKey) {
      if (this.trackedBlockedDays.includes(dateKey)) {
        this.trackedBlockedDays = this.trackedBlockedDays.filter(d => d !== dateKey);
      } else {
        this.trackedBlockedDays = [...this.trackedBlockedDays, dateKey];
      }
      this._savePlanToStorage();
    },

    doSkipDayAndUpdate(dateKey) {
      if (this.isBlockedDay(dateKey)) {
        this.toggleBlockedDay(dateKey);
      } else {
        if (!this.trackedBlockedDays.includes(dateKey)) {
          this.trackedBlockedDays = [...this.trackedBlockedDays, dateKey];
          this._savePlanToStorage();
        }
        this.doApplyAndUpdate();
      }
    },

    // ── Tracking: recalculate ───────────────────────────────────────────────

    _nextDay(dateKey) {
      const d = new Date(dateKey + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    },

    _hasUnmarkedPastActivities() {
      const today   = this.todayKey;
      const blocked = new Set(this.trackedBlockedDays);
      for (const d of this.hydratedCalendar) {
        const dk = d.date instanceof Date ? d.date.toISOString().slice(0,10) : String(d.date).slice(0,10);
        if (!dk || dk >= today || blocked.has(dk)) continue;
        for (const block of this.mergeSessions(d.sessions || [])) {
          if (!this.completionStatus[this.sessionKey(dk, block)]) return true;
        }
      }
      return false;
    },

    doApplyAndUpdate() {
      if (!this.activePlanId) return;

      // Step 1: ensure all past activities have a status before proceeding
      if (this._hasUnmarkedPastActivities()) {
        this.unmarkedPastPromptVisible = true;
        return;
      }

      this._checkTodayAndProceed();
    },

    // Auto-mark all unmarked past activities as done, then continue
    confirmAutoMarkPast() {
      this._autoMarkPastDays();
      this.unmarkedPastPromptVisible = false;
      this._checkTodayAndProceed();
    },

    dismissUnmarkedPastPrompt() {
      this.unmarkedPastPromptVisible = false;
    },

    _checkTodayAndProceed() {
      const todayEntry = this.hydratedCalendar.find(d => {
        const dk = d.date instanceof Date ? d.date.toISOString().slice(0,10) : String(d.date).slice(0,10);
        return dk === this.todayKey;
      });
      const todayBlocks = todayEntry ? this.mergeSessions(todayEntry.sessions || []) : [];

      if (todayBlocks.length === 0) {
        this._executeApplyAndUpdate(this.todayKey);
        return;
      }

      const allTodayDone = todayBlocks.every(b => this.isSessionDone(this.todayKey, b));
      if (allTodayDone) {
        this._executeApplyAndUpdate(this._nextDay(this.todayKey));
        return;
      }

      this.rescheduleFromPromptVisible = true;
    },

    confirmRescheduleFromToday() {
      this.rescheduleFromPromptVisible = false;
      this._executeApplyAndUpdate(this.todayKey);
    },

    confirmRescheduleFromTomorrow() {
      this.rescheduleFromPromptVisible = false;
      this._executeApplyAndUpdate(this._nextDay(this.todayKey));
    },

    _executeApplyAndUpdate(effectiveStartDate) {
      const saved = StudyStorage.loadPlan(this.activePlanId);
      if (!saved) { this.error = 'Could not load plan for recalculation.'; return; }

      this.loading    = true;
      this.loadingMsg = 'Recalculating plan…';
      this.error      = null;

      setTimeout(() => {
        try {
          const advancedTopics = this._autoAdvanceTopicStates(saved);
          this.topics    = advancedTopics;
          this.startDate = effectiveStartDate;

          const srIntervals = this.settingsSrText
            .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
          const config = {
            topics: advancedTopics.filter(t => !t.isGroup && t.enabled !== false).map(t => {
              const doLearn    = t.doLearn    !== false;
              const doPractice = t.doPractice !== false;
              const doRevise   = t.doRevise   !== false;
              const startingState = doLearn ? 'Not Started' : doPractice ? 'Learned' : 'Reviewing';
              return { id: t.id, name: t.title, difficulty: t.difficulty, startingState, skipReviews: !doRevise };
            }),
            startDate:           new Date(effectiveStartDate + 'T00:00:00Z'),
            examDate:            new Date(this.examDate + 'T00:00:00Z'),
            firstWeek:           this.firstWeek,
            lastWeek:            this.lastWeekComputed,
            rampMode:            this.rampMode,
            numMocks:            this.numMocks,
            srIntervals:         srIntervals.length ? srIntervals : [1,6,16,45,131],
            postMockSameDay:     this.settings.postMockSameDay !== false,
            blockedDays:         this.trackedBlockedDays,
            forcedSessionLength: this.unitLength,
            settings: {
              lnTable:                this.settings.lnTable,
              pnTable:                this.settings.pnTable,
              learningMode:           this.settings.learningMode || 'interleaved',
              maxNewTopicsPerDay:     this.settings.maxNewTopicsPerDay,
              maxDaysBetweenPractice: this.settings.maxDaysBetweenPractice || 7,
            },
          };

          // Preserve past entries only if they have at least one explicitly-marked session
          // (done or skip). Days with no status entries are "limbo" days from a prior
          // recalculation — the new plan will reschedule them, so including them here
          // would create duplicates.
          const toDk = d => d.date instanceof Date ? d.date.toISOString().slice(0,10) : String(d.date).slice(0,10);
          const pastHydrated = this.hydratedCalendar.filter(d => {
            const dk = toDk(d);
            if (dk >= effectiveStartDate) return false;
            const merged = this.mergeSessions(d.sessions || []);
            return merged.some(b => this.completionStatus[this.sessionKey(dk, b)] !== undefined);
          });

          // Lock all preserved past days — their statuses are now permanent
          const newLocks = {};
          for (const d of pastHydrated) newLocks[toDk(d)] = true;
          this.lockedDays = { ...this.lockedDays, ...newLocks };

          const result = StudyPlanner.generatePlan(config);
          this._applyPlanResult(result);

          // Splice preserved past entries back in
          this.hydratedCalendar = [
            ...pastHydrated,
            ...this.hydratedCalendar,
          ].sort((a, b) => toDk(a).localeCompare(toDk(b)));

          // Update lastTrackedDate on successful apply
          this.lastTrackedDate = this.todayKey;
          this._savePlanToStorage();

          this.activeTab = 'calendar';
          this.$nextTick(() => {
            this.renderChart();
          });
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loading = false;
        }
      }, 50);
    },

    _autoAdvanceTopicStates(savedPlan) {
      const today      = this.todayKey;
      const calendar   = savedPlan?.planResult?.calendar || this.hydratedCalendar;
      const baseTopics = savedPlan?.inputs?.topics || [];
      const baseById   = {};
      baseTopics.forEach(t => { baseById[t.id] = t; });

      const learnDone    = {};
      const practiceDone = {};

      for (const day of calendar) {
        const dk = day.date instanceof Date
          ? day.date.toISOString().slice(0, 10)
          : (typeof day.date === 'string' ? day.date.slice(0, 10) : '');
        if (!dk || dk >= today) continue;
        const merged = this.mergeSessions(day.sessions || []);
        for (const block of merged) {
          if (!block.topicId) continue;
          if (this.completionStatus[this.sessionKey(dk, block)] !== 'done') continue;
          if (block.activityType === 'learn')
            learnDone[block.topicId] = (learnDone[block.topicId] || 0) + block.count;
          if (block.activityType === 'practice')
            practiceDone[block.topicId] = (practiceDone[block.topicId] || 0) + block.count;
        }
      }

      return this.topics.map(t => {
        if (t.isGroup) return t;
        const base      = baseById[t.id];
        const origState = base?.startingState || t.startingState || 'Not Started';
        const LN = (this.settings.lnTable || {})[t.difficulty] || 2;
        const PN = (this.settings.pnTable || {})[t.difficulty] || 4;

        let effectiveLN = learnDone[t.id]    || 0;
        let effectivePN = practiceDone[t.id] || 0;

        if (origState === 'Learned'    || origState === 'Practicing' || origState === 'Reviewing') effectiveLN = LN;
        if (origState === 'Practicing') effectivePN += 1;
        if (origState === 'Reviewing')  effectivePN  = PN;

        let newState;
        if      (effectivePN >= PN) newState = 'Reviewing';
        else if (effectivePN  > 0)  newState = 'Practicing';
        else if (effectiveLN >= LN) newState = 'Learned';
        else                        newState = 'Not Started';

        const ORDER = { 'Not Started': 0, 'Learned': 1, 'Practicing': 2, 'Reviewing': 3 };
        if ((ORDER[newState] || 0) < (ORDER[origState] || 0)) newState = origState;

        return { ...t, startingState: newState };
      });
    },

    // ── Tracking: persistence ───────────────────────────────────────────────

    _savePlanToStorage() {
      if (!this.activePlanId) return;
      const existing = StudyStorage.loadPlan(this.activePlanId) || {};
      const planData = {
        examName:  this.examName || existing.examName || '',
        createdAt: existing.createdAt || new Date().toISOString(),
        inputs: {
          topicInputMode: this.topicInputMode,
          topics:         this.topics,
          startDate:      this.startDate,
          examDate:       this.examDate,
          firstWeek:      this.firstWeek,
          lastWeek:       this.lastWeekComputed,
          intensityMultiplier: this.intensityMultiplier,
          rampMode:       this.rampMode,
          numMocks:       this.numMocks,
          unitLength:     this.unitLength,
          settings:       this.settings,
          settingsSrText: this.settingsSrText,
          examNameStr:    this.examName,
        },
        planResult: this.planResult || existing.planResult,
        tracking: {
          blockedDays:      this.trackedBlockedDays,
          completionStatus: this.completionStatus,
          lockedDays:       this.lockedDays,
          lastTrackedDate:  this.lastTrackedDate,
        },
      };
      StudyStorage.savePlan(this.activePlanId, planData);
      this.loadSavedPlans();
    },

    // ── Day-by-day scroll to today ──────────────────────────────────────────

    scrollToToday() {
      const el = document.querySelector('.day-block--today');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    // ── Debug date simulator ────────────────────────────────────────────────

    openDebugDialog() {
      this.debugDateInput     = this.simulatedToday || this.todayKey;
      this.debugDialogVisible = true;
    },

    closeDebugDialog() {
      this.debugDialogVisible = false;
    },

    applyDebugDate() {
      if (this.debugDateInput && /^\d{4}-\d{2}-\d{2}$/.test(this.debugDateInput)) {
        this.simulatedToday = this.debugDateInput;
      }
      this.debugDialogVisible = false;
    },

    clearDebugDate() {
      this.simulatedToday = null;
      this.debugDialogVisible = false;
    },
  },

  // ─── Watchers ──────────────────────────────────────────────────────────────

  watch: {
    activeTab(newTab) {
      if (newTab === 'trajectory') {
        if (!this.debugMode) { this.activeTab = 'calendar'; return; }
        if (!this.loading) this.$nextTick(() => this.renderChart());
      }
    },
    screen(newScreen) {
      if (newScreen === 'step4' && this.activeTab === 'trajectory') {
        if (!this.debugMode) { this.activeTab = 'calendar'; return; }
        if (!this.loading) this.$nextTick(() => this.renderChart());
      }
      if (newScreen === 'step3' || newScreen === 'settings') {
        this.$nextTick(() => {
          this.drawScheduleChart();
          if (newScreen === 'step3' && this.recommendedStudyHours && !this.recommendedHoursApplied) {
            this.applyRecommendedHours();
          }
          this._runPlanPreview();
        });
      }
    },
    firstWeek: {
      deep: true,
      handler() { this.$nextTick(() => { this.drawScheduleChart(); this._schedulePlanPreview(); }); },
    },
    intensityMultiplier() { this.$nextTick(() => { this.drawScheduleChart(); this._schedulePlanPreview(); }); },
    rampMode()            { this.$nextTick(() => { this.drawScheduleChart(); this._schedulePlanPreview(); }); },
    startDate()           { this.$nextTick(() => { this.drawScheduleChart(); this._schedulePlanPreview(); }); },
    examDate()            { this.$nextTick(() => { this.drawScheduleChart(); this._schedulePlanPreview(); }); },
    breakDays: {
      deep: true,
      handler() { this.$nextTick(() => { this.drawScheduleChart(); this._schedulePlanPreview(); }); },
    },
    topics: {
      deep: true,
      handler() { this._schedulePlanPreview(); },
    },
  },

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  mounted() {
    this.settingsSrText = (this.settings.srIntervals || [1,6,16,45,131]).join(', ');

    // Parse ?exam= URL parameter to set entry mode
    const urlExamParam = new URLSearchParams(window.location.search).get('exam') || '';
    const examKey = urlExamParam.toLowerCase();
    if (examKey === 'debug') {
      this.entryMode = 'full';
      this.debugMode = true;
    } else if (examKey === 'user_defined') {
      this.entryMode = 'full';
    } else {
      this.entryMode = 'predefined';
      this.topicInputMode = 'examName';
      if (examKey === 'cfa') this.examName = 'CFA Level 1';
      else if (examKey === 'sqe') this.examName = 'SQE FLK1';
    }

    // Load predefined exam index (silently ignore if unavailable — e.g. file:// protocol)
    if (typeof StudyExams !== 'undefined') {
      StudyExams.loadIndex()
        .then(list => { this.predefinedExams = list || []; })
        .catch(() => {});

      // For user_defined mode, apply data/settings.json as the scheduling defaults
      if (this.entryMode === 'full') {
        StudyExams.loadGlobalSettings()
          .then(s => {
            if (s) {
              StudyStorage.setDefaults(s);
              this.settings = StudyStorage.loadSettings();
              this.settingsSrText = (this.settings.srIntervals || [1,6,16,45,131]).join(', ');
            }
          })
          .catch(() => {});
      }
    }

    // Restore in-progress plan from localStorage if present
    const saved = StudyStorage.loadCurrentPlan();
    if (saved) {
      try { this.restoreFromPlanData(saved); } catch (_) {}
    }

    // Load saved plans list for home screen
    this.loadSavedPlans();

    // Ctrl+Shift+D → debug date simulator
    this._debugKeyHandler = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        this.openDebugDialog();
      }
    };
    document.addEventListener('keydown', this._debugKeyHandler);
  },

  beforeUnmount() {
    if (this._debugKeyHandler) document.removeEventListener('keydown', this._debugKeyHandler);
  },
};
