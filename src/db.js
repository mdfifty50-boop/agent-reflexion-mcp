/**
 * SQLite database layer for agent-reflexion-mcp.
 * DB location: ~/.agent-reflexion-mcp/reflexion.db (overridable via REFLEXION_DATA_DIR env var)
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let _db = null;

export function getDb() {
  if (_db) return _db;

  const DATA_DIR = process.env.REFLEXION_DATA_DIR || join(homedir(), '.agent-reflexion-mcp');
  const DB_PATH = join(DATA_DIR, 'reflexion.db');

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT    NOT NULL,
      session_id   TEXT    NOT NULL DEFAULT '',
      input_json   TEXT    NOT NULL DEFAULT '{}',
      analysis_json TEXT   NOT NULL DEFAULT '{}',
      lessons_json TEXT    NOT NULL DEFAULT '[]',
      created_at   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patterns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT    NOT NULL,
      pattern      TEXT    NOT NULL,
      frequency    INTEGER NOT NULL DEFAULT 1,
      last_seen    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      decision_id     TEXT    PRIMARY KEY,
      agent_id        TEXT    NOT NULL,
      task_type       TEXT    NOT NULL,
      decision        TEXT    NOT NULL,
      reasoning       TEXT    NOT NULL,
      expected_outcome TEXT   NOT NULL,
      confidence      REAL    NOT NULL,
      tags_json       TEXT    NOT NULL DEFAULT '[]',
      timestamp       TEXT    NOT NULL,
      outcome         TEXT,
      status          TEXT,
      quality_score   REAL,
      lessons_learned TEXT,
      resolved        INTEGER NOT NULL DEFAULT 0,
      resolved_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS metrics (
      metric_id    TEXT    PRIMARY KEY,
      agent_id     TEXT    NOT NULL,
      metric_name  TEXT    NOT NULL,
      value        REAL    NOT NULL,
      context      TEXT,
      timestamp    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goals (
      goal_id        TEXT    PRIMARY KEY,
      agent_id       TEXT    NOT NULL,
      goal_name      TEXT    NOT NULL,
      metric_name    TEXT    NOT NULL,
      target_value   REAL    NOT NULL,
      baseline_value REAL    NOT NULL,
      deadline_days  INTEGER NOT NULL,
      created_at     TEXT    NOT NULL,
      deadline_at    TEXT    NOT NULL,
      status         TEXT    NOT NULL DEFAULT 'active',
      completed_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_metrics_agent ON metrics(agent_id, metric_name);
    CREATE INDEX IF NOT EXISTS idx_goals_agent ON goals(agent_id);
    CREATE INDEX IF NOT EXISTS idx_reflections_agent ON reflections(agent_id);
    CREATE INDEX IF NOT EXISTS idx_patterns_agent ON patterns(agent_id);
  `);

  return _db;
}

export function _resetDb() {
  const db = getDb();
  db.exec('DELETE FROM decisions; DELETE FROM metrics; DELETE FROM goals; DELETE FROM reflections; DELETE FROM patterns;');
}

export function _closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
