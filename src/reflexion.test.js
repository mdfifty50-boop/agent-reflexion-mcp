import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  logDecision,
  logOutcome,
  analyzePatterns,
  getSuggestions,
  trackMetric,
  getPerformanceReport,
  setGoal,
  checkGoals,
  _resetAll,
  _getDecision,
} from './reflexion.js';
import { _closeDb } from './db.js';

// Redirect to a temp SQLite DB before any test opens it
before(() => {
  _closeDb();
  process.env.REFLEXION_DATA_DIR = '/tmp/reflexion-test-' + Date.now();
});

beforeEach(() => {
  _resetAll();
});

// ═══════════════════════════════════════════
// log_decision
// ═══════════════════════════════════════════

describe('log_decision', () => {
  it('should create a decision and return decision_id and timestamp', () => {
    const result = logDecision('agent-1', 'code_review', 'Use regex', 'Faster parsing', 'Correct extraction', 0.8);
    assert.ok(result.decision_id);
    assert.ok(result.timestamp);
    assert.match(result.decision_id, /^[0-9a-f-]{36}$/);
  });

  it('should store the full decision record', () => {
    const result = logDecision('agent-1', 'deploy', 'Blue-green deploy', 'Zero downtime', 'No errors', 0.9, ['prod', 'deploy']);
    const record = _getDecision(result.decision_id);
    assert.equal(record.agent_id, 'agent-1');
    assert.equal(record.task_type, 'deploy');
    assert.equal(record.decision, 'Blue-green deploy');
    assert.equal(record.confidence, 0.9);
    assert.deepEqual(record.tags, ['prod', 'deploy']);
    assert.equal(record.resolved, false);
    assert.equal(record.outcome, null);
  });
});

// ═══════════════════════════════════════════
// log_outcome
// ═══════════════════════════════════════════

describe('log_outcome', () => {
  it('should update a decision with outcome', () => {
    const { decision_id } = logDecision('agent-1', 'test', 'Run unit tests', 'Coverage', 'All pass', 0.7);
    const result = logOutcome(decision_id, 'All 42 tests passed', 'success', 9, 'Tests are reliable');

    assert.equal(result.decision_id, decision_id);
    assert.equal(result.outcome, 'All 42 tests passed');
    assert.equal(result.status, 'success');
    assert.equal(result.quality_score, 9);
    assert.equal(result.lessons_learned, 'Tests are reliable');
    assert.equal(result.resolved, true);
    assert.ok(result.resolved_at);
  });

  it('should return error for unknown decision_id', () => {
    const result = logOutcome('nonexistent', 'outcome', 'success');
    assert.ok(result.error);
    assert.match(result.error, /not found/);
  });

  it('should return error if outcome already recorded', () => {
    const { decision_id } = logDecision('agent-1', 'test', 'd', 'r', 'e', 0.5);
    logOutcome(decision_id, 'ok', 'success');
    const result = logOutcome(decision_id, 'ok again', 'failure');
    assert.ok(result.error);
    assert.match(result.error, /already/);
  });
});

// ═══════════════════════════════════════════
// analyze_patterns
// ═══════════════════════════════════════════

describe('analyze_patterns', () => {
  function seedDecisions(agent_id, task_type, count, successRate) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const { decision_id } = logDecision(agent_id, task_type, `decision-${i}`, 'reason', 'expected', 0.8);
      const status = i < count * successRate ? 'success' : 'failure';
      logOutcome(decision_id, `outcome-${i}`, status);
      ids.push(decision_id);
    }
    return ids;
  }

  it('should return error with insufficient data', () => {
    seedDecisions('agent-1', 'code_review', 2, 1.0);
    const result = analyzePatterns('agent-1', 'code_review', 30, 5);
    assert.ok(result.error);
    assert.match(result.error, /Insufficient data/);
  });

  it('should calculate success rate correctly', () => {
    seedDecisions('agent-1', 'code_review', 10, 0.7);
    const result = analyzePatterns('agent-1', 'code_review', 30, 5);
    assert.equal(result.success_rate, 0.7);
    assert.equal(result.successes, 7);
    assert.equal(result.failures, 3);
    assert.equal(result.resolved_decisions, 10);
  });

  it('should detect confidence calibration', () => {
    // Log decisions with 0.9 confidence but only 50% success
    for (let i = 0; i < 10; i++) {
      const { decision_id } = logDecision('agent-1', 'deploy', `d-${i}`, 'r', 'e', 0.9);
      logOutcome(decision_id, `o-${i}`, i < 5 ? 'success' : 'failure');
    }
    const result = analyzePatterns('agent-1', 'deploy', 30, 5);
    assert.ok(result.confidence_calibration.overconfident);
    assert.ok(result.confidence_calibration.calibration_gap > 0.3);
  });

  it('should return failure modes ranked by frequency', () => {
    seedDecisions('agent-1', 'deploy', 8, 0.0); // all failures
    seedDecisions('agent-1', 'test', 3, 0.0);
    const result = analyzePatterns('agent-1', null, 30, 5);
    assert.ok(result.failure_modes.length > 0);
    assert.equal(result.failure_modes[0].task_type, 'deploy');
    assert.ok(result.failure_modes[0].count >= result.failure_modes[result.failure_modes.length - 1].count);
  });

  it('should analyze all task types when task_type is null', () => {
    seedDecisions('agent-1', 'code_review', 5, 0.8);
    seedDecisions('agent-1', 'deploy', 5, 0.4);
    const result = analyzePatterns('agent-1', null, 30, 5);
    assert.equal(result.total_decisions, 10);
    assert.equal(result.resolved_decisions, 10);
  });
});

// ═══════════════════════════════════════════
// get_suggestions
// ═══════════════════════════════════════════

describe('get_suggestions', () => {
  it('should return no_data suggestion when empty', () => {
    const result = getSuggestions('agent-1', 'code_review');
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].based_on, 'no_data');
  });

  it('should detect overconfidence', () => {
    for (let i = 0; i < 10; i++) {
      const { decision_id } = logDecision('agent-1', 'code_review', `d-${i}`, 'r', 'e', 0.95);
      logOutcome(decision_id, `o-${i}`, i < 4 ? 'success' : 'failure');
    }
    const result = getSuggestions('agent-1', 'code_review');
    const confSuggestion = result.suggestions.find(s => s.based_on === 'confidence_calibration');
    assert.ok(confSuggestion, 'Should have confidence calibration suggestion');
    assert.match(confSuggestion.suggestion, /conservative/i);
  });

  it('should detect underconfidence', () => {
    for (let i = 0; i < 10; i++) {
      const { decision_id } = logDecision('agent-1', 'test', `d-${i}`, 'r', 'e', 0.3);
      logOutcome(decision_id, `o-${i}`, 'success');
    }
    const result = getSuggestions('agent-1', 'test');
    const confSuggestion = result.suggestions.find(s => s.based_on === 'confidence_calibration');
    assert.ok(confSuggestion, 'Should have confidence calibration suggestion');
    assert.match(confSuggestion.suggestion, /underestimating/i);
  });

  it('should surface lessons from past successes', () => {
    for (let i = 0; i < 5; i++) {
      const { decision_id } = logDecision('agent-1', 'deploy', `d-${i}`, 'r', 'e', 0.8);
      logOutcome(decision_id, `o-${i}`, 'success', 8, 'Always check logs first');
    }
    const result = getSuggestions('agent-1', 'deploy');
    const lessonSuggestion = result.suggestions.find(s => s.based_on === 'historical_lessons');
    assert.ok(lessonSuggestion, 'Should have historical lessons suggestion');
    assert.match(lessonSuggestion.suggestion, /check logs/i);
  });

  it('should suggest cross-task-type insights', () => {
    // Agent is great at testing, bad at deploying
    for (let i = 0; i < 8; i++) {
      const { decision_id } = logDecision('agent-1', 'test', `d-${i}`, 'r', 'e', 0.8);
      logOutcome(decision_id, `o-${i}`, 'success');
    }
    for (let i = 0; i < 8; i++) {
      const { decision_id } = logDecision('agent-1', 'deploy', `d-${i}`, 'r', 'e', 0.8);
      logOutcome(decision_id, `o-${i}`, i < 3 ? 'success' : 'failure');
    }
    const result = getSuggestions('agent-1', 'deploy');
    const crossSuggestion = result.suggestions.find(s => s.based_on === 'cross_task_comparison');
    assert.ok(crossSuggestion, 'Should have cross-task comparison suggestion');
    assert.match(crossSuggestion.suggestion, /test/i);
  });
});

// ═══════════════════════════════════════════
// track_metric
// ═══════════════════════════════════════════

describe('track_metric', () => {
  it('should track a metric and return trend info', () => {
    const result = trackMetric('agent-1', 'accuracy', 0.85);
    assert.ok(result.metric_id);
    assert.equal(result.trend, 'stable');
    assert.equal(result.rolling_average, 0.85);
    assert.equal(result.data_points, 1);
  });

  it('should detect upward trend', () => {
    for (let i = 0; i < 10; i++) {
      trackMetric('agent-1', 'accuracy', 0.5 + i * 0.05);
    }
    const result = trackMetric('agent-1', 'accuracy', 1.0);
    assert.equal(result.trend, 'up');
  });

  it('should detect downward trend', () => {
    for (let i = 0; i < 10; i++) {
      trackMetric('agent-1', 'response_time', 100 - i * 8);
    }
    const result = trackMetric('agent-1', 'response_time', 10);
    assert.equal(result.trend, 'down');
  });

  it('should calculate rolling average correctly', () => {
    trackMetric('agent-1', 'score', 10);
    trackMetric('agent-1', 'score', 20);
    const result = trackMetric('agent-1', 'score', 30);
    assert.equal(result.rolling_average, 20);
  });
});

// ═══════════════════════════════════════════
// get_performance_report
// ═══════════════════════════════════════════

describe('get_performance_report', () => {
  it('should return a complete report', () => {
    for (let i = 0; i < 5; i++) {
      const { decision_id } = logDecision('agent-1', 'code_review', `d-${i}`, 'r', 'e', 0.8);
      logOutcome(decision_id, `o-${i}`, i < 4 ? 'success' : 'failure');
    }
    trackMetric('agent-1', 'accuracy', 0.9);
    setGoal('agent-1', 'Improve accuracy', 'accuracy', 0.95, 30);

    const report = getPerformanceReport('agent-1', 30);
    assert.equal(report.agent_id, 'agent-1');
    assert.equal(report.total_decisions, 5);
    assert.equal(report.resolved_decisions, 5);
    assert.equal(report.success_rate, 0.8);
    assert.ok(Array.isArray(report.top_failure_modes));
    assert.ok(Array.isArray(report.metrics_summary));
    assert.ok(Array.isArray(report.goals_progress));
    assert.equal(report.metrics_summary[0].metric_name, 'accuracy');
  });

  it('should handle agent with no data', () => {
    const report = getPerformanceReport('unknown-agent', 7);
    assert.equal(report.total_decisions, 0);
    assert.equal(report.success_rate, null);
    assert.deepEqual(report.top_failure_modes, []);
  });
});

// ═══════════════════════════════════════════
// set_goal
// ═══════════════════════════════════════════

describe('set_goal', () => {
  it('should create a goal with baseline from current metric', () => {
    trackMetric('agent-1', 'accuracy', 0.7);
    const result = setGoal('agent-1', 'Hit 90% accuracy', 'accuracy', 0.9, 30);
    assert.ok(result.goal_id);
    assert.equal(result.baseline_value, 0.7);
    assert.ok(Math.abs(result.required_improvement - 0.2) < 0.001);
  });

  it('should default baseline to 0 when no metric data', () => {
    const result = setGoal('agent-1', 'First goal', 'tasks_done', 100, 14);
    assert.equal(result.baseline_value, 0);
    assert.equal(result.required_improvement, 100);
  });
});

// ═══════════════════════════════════════════
// check_goals
// ═══════════════════════════════════════════

describe('check_goals', () => {
  it('should return empty goals for new agent', () => {
    const result = checkGoals('agent-1');
    assert.deepEqual(result.goals, []);
  });

  it('should show progress based on metric tracking', () => {
    trackMetric('agent-1', 'accuracy', 0.5);
    setGoal('agent-1', 'Accuracy goal', 'accuracy', 1.0, 30);
    trackMetric('agent-1', 'accuracy', 0.75);

    const result = checkGoals('agent-1');
    assert.equal(result.goals.length, 1);
    assert.equal(result.goals[0].goal_name, 'Accuracy goal');
    assert.equal(result.goals[0].target, 1.0);
    assert.equal(result.goals[0].current, 0.75);
    assert.equal(result.goals[0].progress_percent, 50);
    assert.ok(result.goals[0].days_remaining >= 29);
  });

  it('should auto-complete goal when target reached', () => {
    trackMetric('agent-1', 'score', 0);
    setGoal('agent-1', 'Score goal', 'score', 10, 30);
    trackMetric('agent-1', 'score', 10);

    const result = checkGoals('agent-1');
    assert.equal(result.goals.length, 1);
    assert.equal(result.goals[0].status, 'completed');
    assert.equal(result.goals[0].progress_percent, 100);
  });

  it('should track multiple goals independently', () => {
    trackMetric('agent-1', 'accuracy', 0.5);
    trackMetric('agent-1', 'speed', 100);
    setGoal('agent-1', 'Accuracy', 'accuracy', 0.9, 30);
    setGoal('agent-1', 'Speed', 'speed', 200, 14);
    trackMetric('agent-1', 'accuracy', 0.7);
    trackMetric('agent-1', 'speed', 150);

    const result = checkGoals('agent-1');
    assert.equal(result.goals.length, 2);
    const accuracyGoal = result.goals.find(g => g.goal_name === 'Accuracy');
    const speedGoal = result.goals.find(g => g.goal_name === 'Speed');
    assert.ok(accuracyGoal);
    assert.ok(speedGoal);
    assert.equal(accuracyGoal.current, 0.7);
    assert.equal(speedGoal.current, 150);
  });
});

// ═══════════════════════════════════════════
// Integration: full learning loop
// ═══════════════════════════════════════════

describe('integration: full learning loop', () => {
  it('should support the complete reflexion cycle', () => {
    // 1. Agent logs decisions over time
    const decisionIds = [];
    for (let i = 0; i < 12; i++) {
      const { decision_id } = logDecision(
        'agent-alpha', 'data_analysis',
        `Analyze dataset ${i}`, 'Standard approach', 'Accurate results',
        0.85, ['analysis']
      );
      decisionIds.push(decision_id);
    }

    // 2. Agent logs outcomes (7 success, 5 failure)
    for (let i = 0; i < 12; i++) {
      logOutcome(
        decisionIds[i],
        i < 7 ? 'Accurate analysis completed' : 'Analysis contained errors in validation',
        i < 7 ? 'success' : 'failure',
        i < 7 ? 8 : 3,
        i < 7 ? 'Standard approach works for clean data' : 'Need better validation for edge cases'
      );
    }

    // 3. Analyze patterns
    const patterns = analyzePatterns('agent-alpha', 'data_analysis', 30, 5);
    assert.ok(!patterns.error);
    assert.ok(patterns.success_rate > 0.5);
    assert.ok(patterns.confidence_calibration);

    // 4. Get suggestions
    const suggestions = getSuggestions('agent-alpha', 'data_analysis');
    assert.ok(suggestions.suggestions.length > 0);

    // 5. Track metrics
    trackMetric('agent-alpha', 'analysis_accuracy', 0.58);
    trackMetric('agent-alpha', 'analysis_accuracy', 0.65);
    const metric = trackMetric('agent-alpha', 'analysis_accuracy', 0.72);
    assert.equal(metric.trend, 'up');

    // 6. Set a goal
    const goal = setGoal('agent-alpha', 'Hit 90% accuracy', 'analysis_accuracy', 0.9, 30);
    assert.ok(goal.goal_id);

    // 7. Check goals
    const goalCheck = checkGoals('agent-alpha');
    assert.equal(goalCheck.goals.length, 1);
    assert.ok(goalCheck.goals[0].progress_percent < 100);

    // 8. Performance report
    const report = getPerformanceReport('agent-alpha', 30);
    assert.equal(report.total_decisions, 12);
    assert.ok(report.metrics_summary.length > 0);
    assert.ok(report.goals_progress.length > 0);
  });
});
