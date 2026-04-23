#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  logDecision,
  logOutcome,
  analyzePatterns,
  getSuggestions,
  trackMetric,
  getPerformanceReport,
  setGoal,
  checkGoals,
} from './reflexion.js';

const server = new McpServer({
  name: 'agent-reflexion-mcp',
  version: '0.1.0',
  description: 'Agent self-improvement MCP — decision logging, pattern analysis, performance tracking, and goal-based learning loops',
});

// ═══════════════════════════════════════════
// TOOL: log_decision
// ═══════════════════════════════════════════

server.tool(
  'log_decision',
  'Record a decision with context, reasoning, and expected outcome. Returns a decision_id to later log the actual outcome.',
  {
    agent_id: z.string().describe('Unique identifier for the agent'),
    task_type: z.string().describe('Category of task (e.g. "code_review", "research", "deployment")'),
    decision: z.string().describe('What was decided'),
    reasoning: z.string().describe('Why this decision was made'),
    expected_outcome: z.string().describe('What the agent expects to happen'),
    confidence: z.number().min(0).max(1).describe('Agent confidence in this decision (0.0 to 1.0)'),
    tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
  },
  async ({ agent_id, task_type, decision, reasoning, expected_outcome, confidence, tags }) => {
    const result = logDecision(agent_id, task_type, decision, reasoning, expected_outcome, confidence, tags || []);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: log_outcome
// ═══════════════════════════════════════════

server.tool(
  'log_outcome',
  'Record the actual outcome of a previous decision. Links outcome to the original decision for pattern analysis.',
  {
    decision_id: z.string().describe('ID of the decision to update (from log_decision)'),
    actual_outcome: z.string().describe('What actually happened'),
    status: z.enum(['success', 'failure', 'partial']).describe('Outcome status'),
    quality_score: z.number().min(0).max(10).optional().describe('Quality rating 0-10 (optional)'),
    lessons_learned: z.string().optional().describe('What was learned from this outcome (optional)'),
  },
  async ({ decision_id, actual_outcome, status, quality_score, lessons_learned }) => {
    const result = logOutcome(decision_id, actual_outcome, status, quality_score ?? null, lessons_learned ?? null);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: analyze_patterns
// ═══════════════════════════════════════════

server.tool(
  'analyze_patterns',
  'Analyze decision patterns over time — success rates, failure modes, confidence calibration, trend detection, and improving/declining areas.',
  {
    agent_id: z.string().describe('Agent to analyze'),
    task_type: z.string().optional().describe('Filter by task type (optional — analyzes all types if omitted)'),
    time_range_days: z.number().default(30).describe('How far back to analyze (default 30 days)'),
    min_samples: z.number().default(5).describe('Minimum resolved decisions required for analysis (default 5)'),
  },
  async ({ agent_id, task_type, time_range_days, min_samples }) => {
    const result = analyzePatterns(agent_id, task_type ?? null, time_range_days, min_samples);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: get_suggestions
// ═══════════════════════════════════════════

server.tool(
  'get_suggestions',
  'Get specific, actionable improvement suggestions based on historical patterns. Analyzes confidence calibration, failure modes, cross-task insights, and lessons learned.',
  {
    agent_id: z.string().describe('Agent to generate suggestions for'),
    task_type: z.string().describe('Task type to focus suggestions on'),
    current_context: z.string().optional().describe('Optional current context for more relevant suggestions'),
  },
  async ({ agent_id, task_type, current_context }) => {
    const result = getSuggestions(agent_id, task_type, current_context ?? null);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: track_metric
// ═══════════════════════════════════════════

server.tool(
  'track_metric',
  'Track a named metric over time. Returns trend direction (up/down/stable) and rolling average.',
  {
    agent_id: z.string().describe('Agent tracking this metric'),
    metric_name: z.string().describe('Name of the metric (e.g. "response_time_ms", "accuracy", "tasks_completed")'),
    value: z.number().describe('Current value of the metric'),
    context: z.string().optional().describe('Optional context for this data point'),
  },
  async ({ agent_id, metric_name, value, context }) => {
    const result = trackMetric(agent_id, metric_name, value, context ?? null);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: get_performance_report
// ═══════════════════════════════════════════

server.tool(
  'get_performance_report',
  'Generate a comprehensive performance summary — decision counts, success rate, failure modes, improvement trend, metrics, and goals progress.',
  {
    agent_id: z.string().describe('Agent to report on'),
    time_range_days: z.number().default(7).describe('Time range for the report (default 7 days)'),
  },
  async ({ agent_id, time_range_days }) => {
    const result = getPerformanceReport(agent_id, time_range_days);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: set_goal
// ═══════════════════════════════════════════

server.tool(
  'set_goal',
  'Set an improvement goal for a specific metric. Automatically captures baseline and calculates required improvement.',
  {
    agent_id: z.string().describe('Agent setting the goal'),
    goal_name: z.string().describe('Human-readable name for this goal'),
    metric_name: z.string().describe('Name of the metric to track (must match track_metric calls)'),
    target_value: z.number().describe('Target value to reach'),
    deadline_days: z.number().describe('Days to achieve this goal'),
  },
  async ({ agent_id, goal_name, metric_name, target_value, deadline_days }) => {
    const result = setGoal(agent_id, goal_name, metric_name, target_value, deadline_days);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: check_goals
// ═══════════════════════════════════════════

server.tool(
  'check_goals',
  'Check progress against all active improvement goals. Shows current vs target, progress percentage, and whether on track.',
  {
    agent_id: z.string().describe('Agent to check goals for'),
  },
  async ({ agent_id }) => {
    const result = checkGoals(agent_id);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Agent Reflexion MCP Server running on stdio');
}

main().catch(console.error);
