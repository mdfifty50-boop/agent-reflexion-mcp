# agent-reflexion-mcp

MCP server for agent self-improvement and reflection. Agents call this server to log decisions and outcomes, analyze performance patterns, get actionable improvement suggestions, track metrics, set goals, and build a continuous learning loop.

## Installation

```bash
npx agent-reflexion-mcp
```

Or install globally:

```bash
npm install -g agent-reflexion-mcp
```

### Claude Desktop / Cline / Cursor

Add to your MCP settings:

```json
{
  "mcpServers": {
    "agent-reflexion": {
      "command": "npx",
      "args": ["agent-reflexion-mcp"],
      "env": {
        "REFLEXION_DATA_DIR": "/path/to/data"
      }
    }
  }
}
```

### Smithery

```bash
npx @smithery/cli install agent-reflexion-mcp
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `REFLEXION_DATA_DIR` | `~/.agent-reflexion/` | Directory for JSON file persistence |

## Tools

### `log_decision`

Record a decision with context, reasoning, and expected outcome.

**Input:**
- `agent_id` (string) — Unique identifier for the agent
- `task_type` (string) — Category of task (e.g. "code_review", "research", "deployment")
- `decision` (string) — What was decided
- `reasoning` (string) — Why this decision was made
- `expected_outcome` (string) — What the agent expects to happen
- `confidence` (number 0-1) — Agent confidence in this decision
- `tags` (string[], optional) — Tags for categorization

**Output:** `{ decision_id, timestamp }`

### `log_outcome`

Record the actual outcome of a previous decision.

**Input:**
- `decision_id` (string) — ID from `log_decision`
- `actual_outcome` (string) — What actually happened
- `status` ("success" | "failure" | "partial") — Outcome status
- `quality_score` (number 0-10, optional) — Quality rating
- `lessons_learned` (string, optional) — What was learned

**Output:** Updated decision record

### `analyze_patterns`

Analyze decision patterns over time with statistical analysis.

**Input:**
- `agent_id` (string) — Agent to analyze
- `task_type` (string, optional) — Filter by task type
- `time_range_days` (number, default 30) — How far back to look
- `min_samples` (number, default 5) — Minimum data points required

**Output:**
- `success_rate` — Overall success rate
- `failure_modes` — Ranked list of failure categories with examples
- `confidence_calibration` — Average confidence vs actual success rate, overconfident/underconfident flags
- `trend` — First-half vs second-half success rate comparison
- `improving_areas` / `declining_areas` — Task types trending up or down

### `get_suggestions`

Get specific, actionable improvement suggestions based on historical patterns.

**Input:**
- `agent_id` (string) — Agent to advise
- `task_type` (string) — Task type to focus on
- `current_context` (string, optional) — Current situation for context

**Output:** Array of suggestions, each with:
- `suggestion` — Specific actionable advice
- `based_on` — What analysis produced this (confidence_calibration, failure_pattern_analysis, historical_lessons, cross_task_comparison, etc.)
- `confidence` — How confident the suggestion is
- `evidence_count` — How many data points support it

Example suggestion: *"Your average confidence for 'code_review' tasks is 90% but actual success rate is 60%. Consider more conservative estimates and additional verification steps."*

### `track_metric`

Track a named metric over time with automatic trend detection.

**Input:**
- `agent_id` (string) — Agent tracking this metric
- `metric_name` (string) — Metric name (e.g. "accuracy", "response_time_ms")
- `value` (number) — Current value
- `context` (string, optional) — Context for this data point

**Output:** `{ metric_id, trend ("up"/"down"/"stable"), rolling_average, data_points }`

### `get_performance_report`

Generate a comprehensive performance summary.

**Input:**
- `agent_id` (string) — Agent to report on
- `time_range_days` (number, default 7) — Report period

**Output:**
- `total_decisions`, `success_rate`
- `top_failure_modes` — Ranked failure categories
- `improvement_trend` — "improving", "declining", "stable", or "insufficient_data"
- `metrics_summary` — All tracked metrics with trends
- `goals_progress` — Active goals with progress

### `set_goal`

Set an improvement goal for a specific metric.

**Input:**
- `agent_id` (string) — Agent setting the goal
- `goal_name` (string) — Human-readable goal name
- `metric_name` (string) — Metric to track (must match `track_metric` calls)
- `target_value` (number) — Target to reach
- `deadline_days` (number) — Days to achieve

**Output:** `{ goal_id, baseline_value, required_improvement }`

### `check_goals`

Check progress against active improvement goals.

**Input:**
- `agent_id` (string) — Agent to check

**Output:** Array of goals with:
- `goal_name`, `target`, `current`, `progress_percent`
- `on_track` — Whether pace is sufficient to meet deadline
- `days_remaining`, `status`

Goals auto-complete when the target is reached.

## How It Works

1. **Log decisions** before executing them — capture your reasoning and confidence
2. **Log outcomes** after execution — record what actually happened
3. **Analyze patterns** periodically — find failure modes and calibration issues
4. **Get suggestions** before similar tasks — learn from your history
5. **Track metrics** continuously — monitor trends in key performance indicators
6. **Set goals** for improvement — create accountability with deadlines
7. **Check goals** regularly — stay on track

## Data Persistence

All data is stored as JSON files in `REFLEXION_DATA_DIR`:
- `decisions.json` — Decision and outcome records
- `metrics.json` — Metric time series
- `goals.json` — Improvement goals

Data loads from disk on startup and saves after every write operation.

## Development

```bash
npm test          # Run tests
npm run dev       # Watch mode
npm start         # Start server
```

## License

MIT
