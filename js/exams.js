/**
 * exams.js — Predefined exam data.
 *
 * Exams are embedded directly so the app works without an HTTP server
 * (no fetch() required). The JSON files in data/exams/ are kept as
 * human-readable sources; this file is the canonical runtime version.
 *
 * To add a new exam:
 *  1. Create data/exams/<id>.json (same hierarchical format as below)
 *  2. Add an entry to BUILT_IN_INDEX
 *  3. Add the topics array to BUILT_IN_DATA keyed by the same id
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

  // ─── Built-in exam index ────────────────────────────────────────────────────

  const BUILT_IN_INDEX = [
    { id: 'cfa-level-1', name: 'CFA Level 1', description: 'CFA Institute Level 1 Examination' },
  ];

  // ─── Built-in exam topic data ───────────────────────────────────────────────

  const BUILT_IN_DATA = {
    'cfa-level-1': {
      examId: 'cfa-level-1',
      examName: 'CFA Level 1',
      description: 'CFA Institute Level 1 Examination. Difficulty based on CFA curriculum depth and typical candidate experience.',
      studyHoursNeeded: 300,
      topics: [
        { title: 'Ethical and Professional Standards', subTopics: [
          { title: 'The Profession', difficulty: 'easy' },
          { title: 'The Code of Ethics, Recognising the Standards', difficulty: 'medium' },
          { title: 'The Standards in Practice', difficulty: 'hard' },
          { title: 'GIPS', difficulty: 'medium' },
        ]},
        { title: 'Quantitative Methods', subTopics: [
          { title: 'Interest Rates and Measures of Return', difficulty: 'medium' },
          { title: 'Present Value, Implied Growth, and Cash Flow Additivity', difficulty: 'medium' },
          { title: 'Descriptive Statistics in Finance', difficulty: 'medium' },
          { title: 'Probability in Investment Management', difficulty: 'hard' },
          { title: 'Portfolio Management: Risk and Return Calculations', difficulty: 'hard' },
          { title: 'Log Returns, Monte Carlo Simulation, and Bootstrap Methods', difficulty: 'hard' },
          { title: 'Sampling, the Central Limit Theorem, and Resampling', difficulty: 'hard' },
          { title: 'Hypothesis Testing: Principles, Errors, and Statistical Test Methods', difficulty: 'hard' },
          { title: 'Tests of Independence', difficulty: 'hard' },
          { title: 'Simple Linear Regression', difficulty: 'hard' },
          { title: 'Big Data, AI, and Machine Learning in Investment Management', difficulty: 'medium' },
        ]},
        { title: 'Economics', subTopics: [
          { title: 'Market Structures and Firm Behavior', difficulty: 'medium' },
          { title: 'Business Cycles: Phases, Related Cycles, and Economic Indicators', difficulty: 'medium' },
          { title: 'The Roles, Objectives, and Tools of Fiscal Policy', difficulty: 'medium' },
          { title: 'The Roles, Objectives, and Tools of Monetary Policy', difficulty: 'medium' },
          { title: 'Geopolitics', difficulty: 'easy' },
          { title: 'Trade and Economic Integration', difficulty: 'medium' },
          { title: 'FX Quotes, Real Exchange Rate, Currency Pegging', difficulty: 'medium' },
          { title: 'FX Rates, Points, and Arbitrage', difficulty: 'hard' },
        ]},
        { title: 'Financial Statement Analysis', subTopics: [
          { title: 'Foundations of Financial Statement Analysis', difficulty: 'medium' },
          { title: 'Income Statements', difficulty: 'medium' },
          { title: 'Balance Sheets', difficulty: 'medium' },
          { title: 'Cash Flows', difficulty: 'hard' },
          { title: 'Inventories', difficulty: 'medium' },
          { title: 'Analyzing Long-Lived Assets', difficulty: 'hard' },
          { title: 'Leases, Pensions, and Share-Based Compensation', difficulty: 'hard' },
          { title: 'Income Taxation', difficulty: 'hard' },
          { title: 'Financial Reporting and Earnings Management', difficulty: 'medium' },
          { title: 'Core Tools of Financial Statement Analysis', difficulty: 'hard' },
          { title: 'Forecasting and Modeling', difficulty: 'hard' },
        ]},
        { title: 'Corporate Issuers', subTopics: [
          { title: 'Corporate Finance Fundamentals', difficulty: 'medium' },
          { title: 'Understanding Corporate Stakeholders', difficulty: 'easy' },
          { title: 'The Essentials of Corporate Governance', difficulty: 'easy' },
          { title: 'CCC, Working Capital, and Liquidity', difficulty: 'medium' },
          { title: 'Capital Allocation and Investment Decision-Making', difficulty: 'medium' },
          { title: 'Capital Structure', difficulty: 'medium' },
          { title: 'Deconstructing and Differentiating Business Models', difficulty: 'easy' },
        ]},
        { title: 'Equity Investments', subTopics: [
          { title: 'Introduction to Financial Markets', difficulty: 'easy' },
          { title: 'Market Index Construction and Analysis', difficulty: 'easy' },
          { title: 'Market Efficiency and Behavioral Finance', difficulty: 'medium' },
          { title: 'Fundamentals of Equity Securities', difficulty: 'medium' },
          { title: 'Company Analysis, Industry Analysis, Competitive Analysis, and Financial Forecasting', difficulty: 'hard' },
          { title: 'Introduction to Equity Valuation and Analysis', difficulty: 'medium' },
        ]},
        { title: 'Fixed Income', subTopics: [
          { title: 'Fixed Income Instruments: An Introduction', difficulty: 'easy' },
          { title: 'Bond Types, Cash Flows', difficulty: 'easy' },
          { title: 'The Bond Market', difficulty: 'easy' },
          { title: 'Funding and Corporate Issuers', difficulty: 'medium' },
          { title: 'Funding and Government Issuers', difficulty: 'medium' },
          { title: 'Bond Price & Yield Relationships', difficulty: 'medium' },
          { title: 'Advanced Yield Metrics', difficulty: 'hard' },
          { title: 'Money Market & Floater Pricing', difficulty: 'medium' },
          { title: 'Spot, Par, and Forward Dynamics', difficulty: 'hard' },
          { title: 'Horizon and Duration', difficulty: 'hard' },
          { title: 'Yield Duration', difficulty: 'hard' },
          { title: 'Convexity & Portfolio Risk', difficulty: 'hard' },
          { title: 'Effective Duration & Option Risks', difficulty: 'hard' },
          { title: 'Credit Risk', difficulty: 'medium' },
          { title: 'Creditworthiness of Governments', difficulty: 'medium' },
          { title: 'Creditworthiness of Corporations', difficulty: 'medium' },
          { title: 'Securitization', difficulty: 'medium' },
          { title: 'Asset-Backed Securities', difficulty: 'medium' },
          { title: 'Mortgage-Backed Securities', difficulty: 'medium' },
        ]},
        { title: 'Derivatives', subTopics: [
          { title: 'OTC, EDT, Commitments, Claims', difficulty: 'medium' },
          { title: 'Forwards, Futures, and Options', difficulty: 'medium' },
          { title: 'Benefits, Risks, Uses', difficulty: 'easy' },
          { title: 'Convenience Yield, Arbitrage, and Replication', difficulty: 'hard' },
          { title: 'Forwards: price and valuation', difficulty: 'hard' },
          { title: 'Futures: price and valuation', difficulty: 'hard' },
          { title: 'Swaps: price and valuation', difficulty: 'hard' },
          { title: 'Options: price and valuation', difficulty: 'hard' },
          { title: 'Options: replication, put-call parity', difficulty: 'hard' },
          { title: 'The One-Binomial Model', difficulty: 'hard' },
        ]},
        { title: 'Alternative Investments', subTopics: [
          { title: 'Introduction to Alternative Investments', difficulty: 'easy' },
          { title: 'Private Equity and Hedge Fund Performance', difficulty: 'medium' },
          { title: 'Private Capital', difficulty: 'medium' },
          { title: 'Real Estate', difficulty: 'medium' },
          { title: 'Investing in Land and Commodities', difficulty: 'easy' },
          { title: 'Hedge Funds', difficulty: 'medium' },
          { title: 'Intro to Crypto', difficulty: 'easy' },
        ]},
        { title: 'Portfolio Management', subTopics: [
          { title: 'Modern Portfolio Theory: Risk and Return', difficulty: 'hard' },
          { title: 'Modern Portfolio Theory: Asset Pricing Models', difficulty: 'hard' },
          { title: 'The Investment Environment and Portfolio Management Process', difficulty: 'easy' },
          { title: 'The Investment Policy Statement and Strategic Asset Allocation', difficulty: 'medium' },
          { title: 'Behavioural Finance Foundations', difficulty: 'medium' },
          { title: 'Risk Management: An Overview', difficulty: 'medium' },
        ]},
      ],
    },
  };

  // ─── Public API ─────────────────────────────────────────────────────────────

  async function loadIndex() {
    // Try fetch first (works when served via HTTP); fall back to built-in data
    try {
      const res = await fetch(`data/exams/index.json?v=${Date.now()}`);
      if (res.ok) {
        const list = await res.json();
        // Merge: built-in entries not already in the fetched list stay available
        const fetched = new Set(list.map(e => e.id));
        return [...list, ...BUILT_IN_INDEX.filter(e => !fetched.has(e.id))];
      }
    } catch (_) {}
    return BUILT_IN_INDEX;
  }

  async function loadExam(examId) {
    // Try fetch first; fall back to built-in data
    try {
      const res = await fetch(`data/exams/${examId}.json?v=${Date.now()}`);
      if (res.ok) return res.json();
    } catch (_) {}
    if (BUILT_IN_DATA[examId]) return BUILT_IN_DATA[examId];
    throw new Error(`Exam "${examId}" not found`);
  }

  return { loadIndex, loadExam };
}));
