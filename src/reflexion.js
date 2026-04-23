/**
 * Agent Reflexion Engine — decision logging, pattern analysis,
 * performance tracking, goal management, and improvement suggestions.
 *
 * SQLite-backed via better-sqlite3. DB at ~/.agent-reflexion-mcp/reflexion.db
 * (overridable via REFLEXION_DATA_DIR env var).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAgentDecisions(agent_id, task_type, time_range_days) {
  const db = getDb();
  const cutoff = new Date(Date.now() - time_range_days * 86400000).toISOString();

  let query = 'SELECT * FROM decisions WHERE agent_id = ? AND timestamp >= ?';
  const params = [agent_id, cutoff];

  if (task_type) {
    query += ' AND task_type = ?';
    params.push(task_type);
  }

  return db.prepare(query).all(...params).map(rowToDecision);
}

function rowToDecision(row) {
  return {
    ...row,
    tags: JSON.parse(row.tags_json || '[]'),
    resolved: row.resolved === 1,
  };
}

function computeTrend(values) {
  if (values.length < 2) return 'stable';
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  if (Math.abs(slope) < 0.01) return 'stable';
  return slope > 0 ? 'up' : 'down';
}

function rollingAverage(values, window = 10) {
  const slice = values.slice(-window);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ═══════════════════════════════════════════
// TOOL 1: log_decision
// ═══════════════════════════════════════════

export function logDecision(agent_id, task_type, decision, reasoning, expected_outcome, confidence, tags = []) {
  const db = getDb();
  const decision_id = randomUUID();
  const timestamp = new Date().toISOString();

  db.prepare(`
    INSERT INTO decisions (decision_id, agent_id, task_type, decision, reasoning, expected_outcome, confidence, tags_json, timestamp, resolved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(decision_id, agent_id, task_type, decision, reasoning, expected_outcome, confidence, JSON.stringify(tags), timestamp);

  return { decision_id, timestamp };
}

// ═══════════════════════════════════════════
// TOOL 2: log_outcome
// ═══════════════════════════════════════════

export function logOutcome(decision_id, actual_outcome, status, quality_score = null, lessons_learned = null) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM decisions WHERE decision_id = ?').get(decision_id);

  if (!row) {
    return { error: `Decision ${decision_id} not found` };
  }
  if (row.resolved === 1) {
    return { error: `Decision ${decision_id} already has an outcome recorded` };
  }

  const resolved_at = new Date().toISOString();

  db.prepare(`
    UPDATE decisions
    SET outcome = ?, status = ?, quality_score = ?, lessons_learned = ?, resolved = 1, resolved_at = ?
    WHERE decision_id = ?
  `).run(actual_outcome, status, quality_score, lessons_learned, resolved_at, decision_id);

  return {
    ...rowToDecision(db.prepare('SELECT * FROM decisions WHERE decision_id = ?').get(decision_id)),
  };
}

// ═══════════════════════════════════════════
// TOOL 3: analyze_patterns
// ═══════════════════════════════════════════

export function analyzePatterns(agent_id, task_type = null, time_range_days = 30, min_samples = 5) {
  const agentDecisions = getAgentDecisions(agent_id, task_type, time_range_days);
  const resolved = agentDecisions.filter((d) => d.resolved);

  if (resolved.length < min_samples) {
    return {
      error: `Insufficient data: found ${resolved.length} resolved decisions, need at least ${min_samples}`,
      total_decisions: agentDecisions.length,
      resolved_decisions: resolved.length,
    };
  }

  const successes = resolved.filter((d) => d.status === 'success').length;
  const failures = resolved.filter((d) => d.status === 'failure').length;
  const partials = resolved.filter((d) => d.status === 'partial').length;
  const success_rate = successes / resolved.length;

  const failureModes = {};
  for (const d of resolved.filter((dd) => dd.status === 'failure')) {
    const key = d.task_type;
    if (!failureModes[key]) failureModes[key] = { count: 0, examples: [] };
    failureModes[key].count++;
    if (failureModes[key].examples.length < 3) {
      failureModes[key].examples.push({
        decision: d.decision.slice(0, 100),
        outcome: d.outcome ? d.outcome.slice(0, 100) : null,
      });
    }
  }
  const failure_modes = Object.entries(failureModes)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([mode, data]) => ({ task_type: mode, count: data.count, examples: data.examples }));

  const avgConfidence = resolved.reduce((s, d) => s + d.confidence, 0) / resolved.length;
  const confidenceCalibration = {
    average_confidence: Math.round(avgConfidence * 1000) / 1000,
    actual_success_rate: Math.round(success_rate * 1000) / 1000,
    overconfident: avgConfidence > success_rate + 0.1,
    underconfident: avgConfidence < success_rate - 0.1,
    calibration_gap: Math.round(Math.abs(avgConfidence - success_rate) * 1000) / 1000,
  };

  const sorted = [...resolved].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const mid = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);

  const firstSuccessRate = firstHalf.filter((d) => d.status === 'success').length / (firstHalf.length || 1);
  const secondSuccessRate = secondHalf.filter((d) => d.status === 'success').length / (secondHalf.length || 1);

  const taskTypes = [...new Set(resolved.map((d) => d.task_type))];
  const improving_areas = [];
  const declining_areas = [];

  for (const tt of taskTypes) {
    const ttDecisions = sorted.filter((d) => d.task_type === tt);
    if (ttDecisions.length < 4) continue;
    const ttMid = Math.floor(ttDecisions.length / 2);
    const ttFirst = ttDecisions.slice(0, ttMid);
    const ttSecond = ttDecisions.slice(ttMid);
    const ttFirstRate = ttFirst.filter((d) => d.status === 'success').length / ttFirst.length;
    const ttSecondRate = ttSecond.filter((d) => d.status === 'success').length / ttSecond.length;
    const delta = ttSecondRate - ttFirstRate;
    if (delta > 0.1) improving_areas.push({ task_type: tt, improvement: Math.round(delta * 100) + '%' });
    if (delta < -0.1) declining_areas.push({ task_type: tt, decline: Math.round(Math.abs(delta) * 100) + '%' });
  }

  return {
    total_decisions: agentDecisions.length,
    resolved_decisions: resolved.length,
    success_rate: Math.round(success_rate * 1000) / 1000,
    successes,
    failures,
    partials,
    failure_modes,
    confidence_calibration: confidenceCalibration,
    trend: {
      first_half_success_rate: Math.round(firstSuccessRate * 1000) / 1000,
      second_half_success_rate: Math.round(secondSuccessRate * 1000) / 1000,
      direction:
        secondSuccessRate > firstSuccessRate + 0.05
          ? 'improving'
          : secondSuccessRate < firstSuccessRate - 0.05
          ? 'declining'
          : 'stable',
    },
    improving_areas,
    declining_areas,
  };
}

// ═══════════════════════════════════════════
// TOOL 4: get_suggestions
// ═══════════════════════════════════════════

export function getSuggestions(agent_id, task_type, current_context = null) {
  const db = getDb();
  const suggestions = [];

  const allResolved = db.prepare(
    "SELECT * FROM decisions WHERE agent_id = ? AND resolved = 1"
  ).all(agent_id).map(rowToDecision);

  if (allResolved.length === 0) {
    return {
      suggestions: [{
        suggestion: 'No historical data yet. Start logging decisions and outcomes to build your learning loop.',
        based_on: 'no_data',
        confidence: 1.0,
        evidence_count: 0,
      }],
    };
  }

  const taskDecisions = allResolved.filter((d) => d.task_type === task_type);
  const otherDecisions = allResolved.filter((d) => d.task_type !== task_type);

  // 1. Confidence calibration
  if (taskDecisions.length >= 3) {
    const avgConf = taskDecisions.reduce((s, d) => s + d.confidence, 0) / taskDecisions.length;
    const actualRate = taskDecisions.filter((d) => d.status === 'success').length / taskDecisions.length;

    if (avgConf > actualRate + 0.15) {
      suggestions.push({
        suggestion: `Your average confidence for '${task_type}' tasks is ${(avgConf * 100).toFixed(0)}% but actual success rate is ${(actualRate * 100).toFixed(0)}%. Consider more conservative estimates and additional verification steps before committing.`,
        based_on: 'confidence_calibration',
        confidence: 0.9,
        evidence_count: taskDecisions.length,
      });
    } else if (avgConf < actualRate - 0.15) {
      suggestions.push({
        suggestion: `You're underestimating yourself on '${task_type}' tasks — confidence ${(avgConf * 100).toFixed(0)}% vs actual success ${(actualRate * 100).toFixed(0)}%. You can be more decisive and spend less time second-guessing.`,
        based_on: 'confidence_calibration',
        confidence: 0.85,
        evidence_count: taskDecisions.length,
      });
    }
  }

  // 2. Failure pattern suggestion
  const taskFailures = taskDecisions.filter((d) => d.status === 'failure');
  if (taskFailures.length >= 2) {
    const outcomeWords = {};
    for (const d of taskFailures) {
      if (!d.outcome) continue;
      const words = d.outcome.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      for (const w of words) {
        outcomeWords[w] = (outcomeWords[w] || 0) + 1;
      }
    }
    const commonPatterns = Object.entries(outcomeWords)
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    if (commonPatterns.length > 0) {
      const patternStr = commonPatterns.map(([w, c]) => `"${w}" (${c}x)`).join(', ');
      suggestions.push({
        suggestion: `Recurring failure patterns in '${task_type}': ${patternStr}. Review these common failure themes and add explicit checks for them in your workflow.`,
        based_on: 'failure_pattern_analysis',
        confidence: 0.75,
        evidence_count: taskFailures.length,
      });
    }
  }

  // 3. Lessons from past successes
  const taskSuccesses = taskDecisions.filter((d) => d.status === 'success' && d.lessons_learned);
  if (taskSuccesses.length > 0) {
    const recentLessons = taskSuccesses
      .sort((a, b) => new Date(b.resolved_at) - new Date(a.resolved_at))
      .slice(0, 3)
      .map((d) => d.lessons_learned);

    suggestions.push({
      suggestion: `Apply your past successful lessons for '${task_type}': ${recentLessons.join('; ')}`,
      based_on: 'historical_lessons',
      confidence: 0.8,
      evidence_count: taskSuccesses.length,
    });
  }

  // 4. Cross-task insights
  if (otherDecisions.length >= 5) {
    const otherByType = {};
    for (const d of otherDecisions) {
      if (!otherByType[d.task_type]) otherByType[d.task_type] = { total: 0, success: 0 };
      otherByType[d.task_type].total++;
      if (d.status === 'success') otherByType[d.task_type].success++;
    }

    const bestType = Object.entries(otherByType)
      .filter(([_, v]) => v.total >= 3)
      .sort((a, b) => b[1].success / b[1].total - a[1].success / a[1].total)[0];

    if (bestType && taskDecisions.length >= 3) {
      const bestRate = bestType[1].success / bestType[1].total;
      const taskRate = taskDecisions.filter((d) => d.status === 'success').length / taskDecisions.length;

      if (bestRate > taskRate + 0.2) {
        suggestions.push({
          suggestion: `Your success rate for '${bestType[0]}' is ${(bestRate * 100).toFixed(0)}% vs ${(taskRate * 100).toFixed(0)}% for '${task_type}'. Consider what strategies you use for '${bestType[0]}' that could transfer here.`,
          based_on: 'cross_task_comparison',
          confidence: 0.65,
          evidence_count: bestType[1].total + taskDecisions.length,
        });
      }
    }
  }

  // 5. Volume suggestion
  if (taskDecisions.length < 5 && allResolved.length >= 10) {
    suggestions.push({
      suggestion: `You only have ${taskDecisions.length} logged decisions for '${task_type}'. Log more decisions to get richer pattern analysis and improvement suggestions.`,
      based_on: 'data_volume',
      confidence: 1.0,
      evidence_count: taskDecisions.length,
    });
  }

  // 6. Consecutive failures
  const recentFailures = taskFailures
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 3);
  if (recentFailures.length >= 2) {
    const lastTwoSame = recentFailures.length >= 2 && recentFailures[0].task_type === recentFailures[1].task_type;
    if (lastTwoSame) {
      suggestions.push({
        suggestion: `Your last ${recentFailures.length} '${task_type}' decisions failed. Consider a fundamentally different approach rather than iterating on the same strategy.`,
        based_on: 'consecutive_failures',
        confidence: 0.85,
        evidence_count: recentFailures.length,
      });
    }
  }

  if (suggestions.length === 0) {
    const rate = taskDecisions.length > 0
      ? taskDecisions.filter((d) => d.status === 'success').length / taskDecisions.length
      : null;

    suggestions.push({
      suggestion: rate !== null
        ? `Performance on '${task_type}' looks solid at ${(rate * 100).toFixed(0)}% success rate. Continue current strategies and log outcomes to track over time.`
        : `No specific patterns found yet for '${task_type}'. Keep logging decisions and outcomes to build actionable insights.`,
      based_on: 'general_assessment',
      confidence: 0.5,
      evidence_count: taskDecisions.length,
    });
  }

  return { suggestions };
}

// ═══════════════════════════════════════════
// TOOL 5: track_metric
// ═══════════════════════════════════════════

export function trackMetric(agent_id, metric_name, value, context = null) {
  const db = getDb();
  const metric_id = randomUUID();
  const timestamp = new Date().toISOString();

  db.prepare(`
    INSERT INTO metrics (metric_id, agent_id, metric_name, value, context, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(metric_id, agent_id, metric_name, value, context, timestamp);

  const metricValues = db.prepare(
    'SELECT value FROM metrics WHERE agent_id = ? AND metric_name = ? ORDER BY timestamp ASC'
  ).all(agent_id, metric_name).map((r) => r.value);

  const trend = computeTrend(metricValues);
  const rolling_average = Math.round(rollingAverage(metricValues) * 1000) / 1000;

  return { metric_id, trend, rolling_average, data_points: metricValues.length };
}

// ═══════════════════════════════════════════
// TOOL 6: get_performance_report
// ═══════════════════════════════════════════

export function getPerformanceReport(agent_id, time_range_days = 7) {
  const db = getDb();
  const agentDecisions = getAgentDecisions(agent_id, null, time_range_days);
  const resolved = agentDecisions.filter((d) => d.resolved);

  const total_decisions = agentDecisions.length;
  const success_rate = resolved.length > 0
    ? Math.round((resolved.filter((d) => d.status === 'success').length / resolved.length) * 1000) / 1000
    : null;

  const failureCounts = {};
  for (const d of resolved.filter((dd) => dd.status === 'failure')) {
    failureCounts[d.task_type] = (failureCounts[d.task_type] || 0) + 1;
  }
  const top_failure_modes = Object.entries(failureCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([task_type, count]) => ({ task_type, count }));

  const prevCutoff = new Date(Date.now() - time_range_days * 2 * 86400000).toISOString();
  const thisCutoff = new Date(Date.now() - time_range_days * 86400000).toISOString();

  const prevDecisions = db.prepare(
    "SELECT * FROM decisions WHERE agent_id = ? AND timestamp >= ? AND timestamp < ? AND resolved = 1"
  ).all(agent_id, prevCutoff, thisCutoff).map(rowToDecision);

  let improvement_trend = 'insufficient_data';
  if (resolved.length >= 3 && prevDecisions.length >= 3) {
    const currentRate = resolved.filter((d) => d.status === 'success').length / resolved.length;
    const prevRate = prevDecisions.filter((d) => d.status === 'success').length / prevDecisions.length;
    const delta = currentRate - prevRate;
    if (delta > 0.05) improvement_trend = 'improving';
    else if (delta < -0.05) improvement_trend = 'declining';
    else improvement_trend = 'stable';
  }

  // Metrics summary
  const metricNames = db.prepare(
    'SELECT DISTINCT metric_name FROM metrics WHERE agent_id = ?'
  ).all(agent_id).map((r) => r.metric_name);

  const metrics_summary = metricNames.map((name) => {
    const vals = db.prepare(
      'SELECT value FROM metrics WHERE agent_id = ? AND metric_name = ? ORDER BY timestamp ASC'
    ).all(agent_id, name).map((r) => r.value);
    return {
      metric_name: name,
      latest: vals[vals.length - 1],
      trend: computeTrend(vals),
      rolling_average: Math.round(rollingAverage(vals) * 1000) / 1000,
      data_points: vals.length,
    };
  });

  // Goals progress
  const agentGoals = db.prepare(
    "SELECT * FROM goals WHERE agent_id = ? AND status = 'active'"
  ).all(agent_id);

  const goals_progress = agentGoals.map((g) => {
    const metricVals = db.prepare(
      'SELECT value FROM metrics WHERE agent_id = ? AND metric_name = ? ORDER BY timestamp ASC'
    ).all(agent_id, g.metric_name).map((r) => r.value);
    const current = metricVals.length > 0 ? metricVals[metricVals.length - 1] : g.baseline_value;
    const progress = g.target_value !== g.baseline_value
      ? Math.round(((current - g.baseline_value) / (g.target_value - g.baseline_value)) * 100)
      : 0;
    return {
      goal_name: g.goal_name,
      target: g.target_value,
      current,
      progress_percent: Math.max(0, Math.min(100, progress)),
    };
  });

  return {
    agent_id,
    time_range_days,
    total_decisions,
    resolved_decisions: resolved.length,
    success_rate,
    top_failure_modes,
    improvement_trend,
    metrics_summary,
    goals_progress,
  };
}

// ═══════════════════════════════════════════
// TOOL 7: set_goal
// ═══════════════════════════════════════════

export function setGoal(agent_id, goal_name, metric_name, target_value, deadline_days) {
  const db = getDb();
  const goal_id = randomUUID();
  const created_at = new Date().toISOString();
  const deadline_at = new Date(Date.now() + deadline_days * 86400000).toISOString();

  const latestMetric = db.prepare(
    'SELECT value FROM metrics WHERE agent_id = ? AND metric_name = ? ORDER BY timestamp DESC LIMIT 1'
  ).get(agent_id, metric_name);
  const baseline_value = latestMetric ? latestMetric.value : 0;
  const required_improvement = target_value - baseline_value;

  db.prepare(`
    INSERT INTO goals (goal_id, agent_id, goal_name, metric_name, target_value, baseline_value, deadline_days, created_at, deadline_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(goal_id, agent_id, goal_name, metric_name, target_value, baseline_value, deadline_days, created_at, deadline_at);

  return { goal_id, baseline_value, required_improvement };
}

// ═══════════════════════════════════════════
// TOOL 8: check_goals
// ═══════════════════════════════════════════

export function checkGoals(agent_id) {
  const db = getDb();
  const agentGoals = db.prepare("SELECT * FROM goals WHERE agent_id = ? AND status = 'active'").all(agent_id);

  const result = agentGoals.map((g) => {
    const metricVals = db.prepare(
      'SELECT value FROM metrics WHERE agent_id = ? AND metric_name = ? ORDER BY timestamp ASC'
    ).all(agent_id, g.metric_name).map((r) => r.value);

    const current = metricVals.length > 0 ? metricVals[metricVals.length - 1] : g.baseline_value;
    const total_range = g.target_value - g.baseline_value;
    const progress_percent = total_range !== 0
      ? Math.max(0, Math.min(100, Math.round(((current - g.baseline_value) / total_range) * 100)))
      : (current >= g.target_value ? 100 : 0);

    const days_elapsed = (Date.now() - new Date(g.created_at).getTime()) / 86400000;
    const days_remaining = Math.max(0, Math.round(g.deadline_days - days_elapsed));
    const expected_progress = g.deadline_days > 0 ? (days_elapsed / g.deadline_days) * 100 : 100;
    const on_track = progress_percent >= expected_progress * 0.8;

    // Auto-complete if target reached
    let status = g.status;
    if (current >= g.target_value && total_range > 0) {
      const completed_at = new Date().toISOString();
      db.prepare("UPDATE goals SET status = 'completed', completed_at = ? WHERE goal_id = ?")
        .run(completed_at, g.goal_id);
      status = 'completed';
    }

    return {
      goal_id: g.goal_id,
      goal_name: g.goal_name,
      metric_name: g.metric_name,
      target: g.target_value,
      baseline: g.baseline_value,
      current,
      progress_percent,
      on_track,
      days_remaining,
      status,
    };
  });

  return { goals: result };
}

// ═══════════════════════════════════════════
// TESTING HELPERS
// ═══════════════════════════════════════════

export function _resetAll() {
  const db = getDb();
  db.exec('DELETE FROM decisions; DELETE FROM metrics; DELETE FROM goals; DELETE FROM reflections; DELETE FROM patterns;');
}

export function _getDecision(id) {
  const row = getDb().prepare('SELECT * FROM decisions WHERE decision_id = ?').get(id);
  return row ? rowToDecision(row) : undefined;
}
