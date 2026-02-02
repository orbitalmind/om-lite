/**
 * Database module for OM-Lite
 * SQLite-based storage with FTS5 full-text search
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';

const SCHEMA = `
-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Clauses: Core memory units
CREATE TABLE IF NOT EXISTS clauses (
    id TEXT PRIMARY KEY,
    
    -- Content
    type TEXT NOT NULL CHECK (type IN (
        'fact', 'preference', 'habit', 'skill', 
        'relationship', 'intention', 'context', 'correction',
        'skill_success', 'skill_failure', 'skill_preference'
    )),
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    natural_form TEXT NOT NULL,
    
    -- Temporal (ISO 8601 strings)
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Confidence
    confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
    decay_rate REAL NOT NULL DEFAULT 0.001 CHECK (decay_rate >= 0),
    reinforcement_count INTEGER NOT NULL DEFAULT 0,
    
    -- Provenance
    source_id TEXT NOT NULL,
    extraction_method TEXT NOT NULL DEFAULT 'llm_extraction',
    
    -- Usage
    last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER NOT NULL DEFAULT 0,
    
    -- Metadata
    tags TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_clauses_type ON clauses(type);
CREATE INDEX IF NOT EXISTS idx_clauses_subject ON clauses(subject);
CREATE INDEX IF NOT EXISTS idx_clauses_predicate ON clauses(predicate);
CREATE INDEX IF NOT EXISTS idx_clauses_confidence ON clauses(confidence);
CREATE INDEX IF NOT EXISTS idx_clauses_valid_to ON clauses(valid_to);
CREATE INDEX IF NOT EXISTS idx_clauses_last_accessed ON clauses(last_accessed);
CREATE INDEX IF NOT EXISTS idx_clauses_source ON clauses(source_id);

-- Full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS clauses_fts USING fts5(
    natural_form,
    subject,
    predicate,
    object,
    content='clauses',
    content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS clauses_ai AFTER INSERT ON clauses BEGIN
    INSERT INTO clauses_fts(rowid, natural_form, subject, predicate, object)
    VALUES (new.rowid, new.natural_form, new.subject, new.predicate, new.object);
END;

CREATE TRIGGER IF NOT EXISTS clauses_ad AFTER DELETE ON clauses BEGIN
    INSERT INTO clauses_fts(clauses_fts, rowid, natural_form, subject, predicate, object)
    VALUES ('delete', old.rowid, old.natural_form, old.subject, old.predicate, old.object);
END;

CREATE TRIGGER IF NOT EXISTS clauses_au AFTER UPDATE ON clauses BEGIN
    INSERT INTO clauses_fts(clauses_fts, rowid, natural_form, subject, predicate, object)
    VALUES ('delete', old.rowid, old.natural_form, old.subject, old.predicate, old.object);
    INSERT INTO clauses_fts(rowid, natural_form, subject, predicate, object)
    VALUES (new.rowid, new.natural_form, new.subject, new.predicate, new.object);
END;

-- Sources: Raw content archive references
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    
    type TEXT NOT NULL CHECK (type IN (
        'conversation', 'log', 'document', 'manual', 'knowledge_pack', 'inferred'
    )),
    channel TEXT,
    
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    participant_count INTEGER DEFAULT 1,
    message_count INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);
CREATE INDEX IF NOT EXISTS idx_sources_occurred_at ON sources(occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_hash ON sources(content_hash);

-- Embeddings: For semantic search
CREATE TABLE IF NOT EXISTS clause_embeddings (
    clause_id TEXT PRIMARY KEY REFERENCES clauses(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Conflicts: Detected contradictions
CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    
    clause_a_id TEXT NOT NULL REFERENCES clauses(id),
    clause_b_id TEXT NOT NULL REFERENCES clauses(id),
    
    conflict_type TEXT NOT NULL CHECK (conflict_type IN (
        'contradiction', 'supersession', 'ambiguity'
    )),
    description TEXT NOT NULL,
    
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'auto_resolved', 'user_resolved', 'ignored'
    )),
    resolution TEXT,
    resolved_at TEXT,
    
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);

-- Access log: Usage tracking
CREATE TABLE IF NOT EXISTS access_log (
    id TEXT PRIMARY KEY,
    clause_id TEXT NOT NULL REFERENCES clauses(id) ON DELETE CASCADE,
    
    accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_type TEXT NOT NULL CHECK (access_type IN (
        'retrieval', 'injection', 'reinforcement'
    )),
    context TEXT,
    
    was_useful INTEGER,
    correction_id TEXT REFERENCES clauses(id)
);

CREATE INDEX IF NOT EXISTS idx_access_log_clause ON access_log(clause_id);
CREATE INDEX IF NOT EXISTS idx_access_log_accessed ON access_log(accessed_at);

-- Decay log: Track confidence changes
CREATE TABLE IF NOT EXISTS decay_log (
    id TEXT PRIMARY KEY,
    clause_id TEXT NOT NULL REFERENCES clauses(id) ON DELETE CASCADE,
    
    previous_confidence REAL NOT NULL,
    new_confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Knowledge packs
CREATE TABLE IF NOT EXISTS installed_packs (
    pack_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    claims_loaded INTEGER NOT NULL,
    last_updated TEXT,
    metadata TEXT DEFAULT '{}'
);

-- Skill capability claims
CREATE TABLE IF NOT EXISTS skill_capabilities (
    skill_id TEXT NOT NULL,
    skill_version TEXT NOT NULL,
    clause_id TEXT NOT NULL REFERENCES clauses(id) ON DELETE CASCADE,
    capability_type TEXT NOT NULL,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    PRIMARY KEY (skill_id, clause_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_capabilities_skill ON skill_capabilities(skill_id);

-- Skill preference bindings
CREATE TABLE IF NOT EXISTS skill_preference_bindings (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    parameter_name TEXT NOT NULL,
    clause_id TEXT NOT NULL REFERENCES clauses(id),
    bound_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    UNIQUE (skill_id, parameter_name)
);

-- System metadata
CREATE TABLE IF NOT EXISTS system_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initialize defaults if not exist
INSERT OR IGNORE INTO system_metadata (key, value) VALUES
    ('schema_version', '1'),
    ('last_decay_run', NULL),
    ('last_memory_sync', NULL),
    ('total_clauses_extracted', '0'),
    ('total_conflicts_detected', '0');
`;

export class DatabaseManager {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    // Expand ~ to home directory
    this.dbPath = dbPath.replace(/^~/, homedir());
  }

  /**
   * Initialize database and create schema
   */
  async init(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(this.dbPath);
    
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    
    // Run schema
    this.db.exec(SCHEMA);
  }

  /**
   * Get the database instance
   */
  getDb(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db;
  }

  /**
   * Run a query and return all results
   */
  all<T = unknown>(sql: string, params: unknown[] = []): T[] {
    return this.getDb().prepare(sql).all(...params) as T[];
  }

  /**
   * Run a query and return first result
   */
  get<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
    return this.getDb().prepare(sql).get(...params) as T | undefined;
  }

  /**
   * Run a query without returning results
   */
  run(sql: string, params: unknown[] = []): Database.RunResult {
    return this.getDb().prepare(sql).run(...params);
  }

  /**
   * Run multiple statements in a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.getDb().transaction(fn)();
  }

  /**
   * Get database file size in bytes
   */
  getSize(): number {
    const stats = this.get<{ page_count: number; page_size: number }>(
      "SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()"
    );
    return (stats?.page_count ?? 0) * (stats?.page_size ?? 0);
  }

  /**
   * Get system metadata value
   */
  getMetadata(key: string): string | null {
    const row = this.get<{ value: string }>(
      'SELECT value FROM system_metadata WHERE key = ?',
      [key]
    );
    return row?.value ?? null;
  }

  /**
   * Set system metadata value
   */
  setMetadata(key: string, value: string): void {
    this.run(
      `INSERT OR REPLACE INTO system_metadata (key, value, updated_at) 
       VALUES (?, ?, datetime('now'))`,
      [key, value]
    );
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Backup database to file
   */
  async backup(destPath: string): Promise<void> {
    const dest = destPath.replace(/^~/, homedir());
    const destDir = dirname(dest);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    
    await this.getDb().backup(dest);
  }
}

// Export as Database for compatibility
export { DatabaseManager as Database };
