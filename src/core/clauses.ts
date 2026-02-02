/**
 * Clause Store - Core CRUD operations for memory clauses
 * Handles clause creation, search, deduplication, and conflict detection
 */

import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DatabaseManager } from './database.js';
import type {
  Clause,
  ClauseInput,
  ClauseType,
  SourceType,
  Conflict,
  SearchOptions,
  MemoryStats,
  ProcessClauseResult,
  ConflictResolutionConfig,
  ConflictResolutionStrategy,
  DeduplicationConfig,
  SourceAttribution,
} from './types.js';

// Predicates that can only have one active value at a time
const SINGLETON_PREDICATES = [
  'lives_in',
  'works_at',
  'email_address',
  'phone_number',
  'uses_for_notes',
  'preferred_language',
  'timezone',
  'full_name',
  'is_located_in',
  'home_address',
  'primary_calendar',
];

// Predicates that can have multiple values
const MULTI_VALUE_PREDICATES = [
  'likes',
  'dislikes',
  'interested_in',
  'skilled_at',
  'knows',
  'speaks_language',
  'has_hobby',
  'member_of',
  'integrates_with',
  'can_perform',
];

// Default decay rates by clause type
const DEFAULT_DECAY_RATES: Record<ClauseType, number> = {
  fact: 0.0005,
  preference: 0.002,
  habit: 0.001,
  skill: 0.0002,
  relationship: 0.001,
  intention: 0.01,
  context: 0.05,
  correction: 0.001,
  skill_success: 0.002,
  skill_failure: 0.01,
  skill_preference: 0.002,
};

interface SourceInput {
  type: SourceType;
  content: string;
  channel?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
  // Source attribution fields
  attribution?: SourceAttribution;
}

interface ClauseRow {
  id: string;
  type: string;
  subject: string;
  predicate: string;
  object: string;
  natural_form: string;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  confidence: number;
  decay_rate: number;
  reinforcement_count: number;
  source_id: string;
  extraction_method: string;
  last_accessed: string;
  access_count: number;
  tags: string;
  metadata: string;
}

// Default configurations
const DEFAULT_CONFLICT_CONFIG: ConflictResolutionConfig = {
  strategy: 'merge_history',
  autoResolveThreshold: 0.2,
  preserveHistory: true,
};

const DEFAULT_DEDUP_CONFIG: DeduplicationConfig = {
  enabled: true,
  similarityThreshold: 0.85,
  useContentHash: true,
  useFuzzyMatch: true,
  onDuplicate: 'reinforce',
};

export class ClauseStore {
  private db: DatabaseManager;
  private conflictConfig: ConflictResolutionConfig;
  private dedupConfig: DeduplicationConfig;

  constructor(
    db: DatabaseManager,
    conflictConfig?: Partial<ConflictResolutionConfig>,
    dedupConfig?: Partial<DeduplicationConfig>
  ) {
    this.db = db;
    this.conflictConfig = { ...DEFAULT_CONFLICT_CONFIG, ...conflictConfig };
    this.dedupConfig = { ...DEFAULT_DEDUP_CONFIG, ...dedupConfig };
  }

  /**
   * Update conflict resolution config
   */
  setConflictConfig(config: Partial<ConflictResolutionConfig>): void {
    this.conflictConfig = { ...this.conflictConfig, ...config };
  }

  /**
   * Update deduplication config
   */
  setDeduplicationConfig(config: Partial<DeduplicationConfig>): void {
    this.dedupConfig = { ...this.dedupConfig, ...config };
  }

  /**
   * Create a new clause
   */
  async create(input: ClauseInput): Promise<Clause> {
    const id = uuidv7();
    const now = new Date().toISOString();
    const decayRate = input.decay_rate ?? DEFAULT_DECAY_RATES[input.type] ?? 0.001;

    const clause: Clause = {
      id,
      type: input.type,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      natural_form: input.natural_form,
      valid_from: input.valid_from ?? now,
      valid_to: null,
      recorded_at: now,
      confidence: input.confidence ?? 0.8,
      decay_rate: decayRate,
      reinforcement_count: 0,
      source_id: (input as ClauseInput & { source_id?: string }).source_id ?? 'manual',
      extraction_method: (input as ClauseInput & { extraction_method?: string }).extraction_method ?? 'manual',
      last_accessed: now,
      access_count: 0,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    };

    this.db.run(
      `INSERT INTO clauses (
        id, type, subject, predicate, object, natural_form,
        valid_from, valid_to, recorded_at, confidence, decay_rate,
        reinforcement_count, source_id, extraction_method,
        last_accessed, access_count, tags, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clause.id,
        clause.type,
        clause.subject,
        clause.predicate,
        clause.object,
        clause.natural_form,
        clause.valid_from,
        clause.valid_to,
        clause.recorded_at,
        clause.confidence,
        clause.decay_rate,
        clause.reinforcement_count,
        clause.source_id,
        clause.extraction_method,
        clause.last_accessed,
        clause.access_count,
        JSON.stringify(clause.tags),
        JSON.stringify(clause.metadata),
      ]
    );

    // Update extraction counter
    const current = parseInt(this.db.getMetadata('total_clauses_extracted') ?? '0', 10);
    this.db.setMetadata('total_clauses_extracted', String(current + 1));

    return clause;
  }

  /**
   * Get a clause by ID
   */
  async get(id: string): Promise<Clause | null> {
    const row = this.db.get<ClauseRow>(
      'SELECT * FROM clauses WHERE id = ?',
      [id]
    );

    if (!row) return null;

    // Update access tracking
    this.db.run(
      `UPDATE clauses SET last_accessed = datetime('now'), access_count = access_count + 1 WHERE id = ?`,
      [id]
    );

    return this.rowToClause(row);
  }

  /**
   * Search clauses using FTS5 full-text search
   */
  async search(query: string, options: SearchOptions = {}): Promise<Clause[]> {
    const {
      types,
      minConfidence = 0,
      includeExpired = false,
      limit = 20,
      offset = 0,
      orderBy = 'confidence',
      orderDir = 'desc',
    } = options;

    let sql: string;
    const params: unknown[] = [];

    if (query && query.trim()) {
      // FTS search
      sql = `
        SELECT c.*, bm25(clauses_fts) as score
        FROM clauses c
        JOIN clauses_fts ON c.rowid = clauses_fts.rowid
        WHERE clauses_fts MATCH ?
      `;
      // Escape special FTS5 characters and operators
      // Replace hyphens with spaces, remove quotes/parens, then wrap in quotes for literal search
      const escapedQuery = query.replace(/[-'"()]/g, ' ').trim();
      params.push(`"${escapedQuery}"`);
    } else {
      // No query - return all
      sql = 'SELECT *, 1.0 as score FROM clauses c WHERE 1=1';
    }

    if (!includeExpired) {
      sql += ' AND c.valid_to IS NULL';
    }

    if (minConfidence > 0) {
      sql += ' AND c.confidence >= ?';
      params.push(minConfidence);
    }

    if (types && types.length > 0) {
      sql += ` AND c.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    // Order by
    const direction = orderDir === 'asc' ? 'ASC' : 'DESC';

    // When searching with FTS, order by score; otherwise use the specified orderBy
    if (query && query.trim()) {
      sql += ` ORDER BY score ${direction}`;
    } else {
      const validOrderBy: Array<typeof orderBy> = ['confidence', 'last_accessed', 'recorded_at'];
      const orderField = validOrderBy.includes(orderBy) ? orderBy : 'confidence';
      sql += ` ORDER BY c.${orderField} ${direction}`;
    }

    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.all<ClauseRow>(sql, params);
    return rows.map((row) => this.rowToClause(row));
  }

  /**
   * Update a clause
   */
  async update(id: string, updates: Partial<Clause>): Promise<Clause | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const allowedFields = [
      'confidence',
      'decay_rate',
      'tags',
      'metadata',
      'natural_form',
    ];

    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const field of allowedFields) {
      if (field in updates) {
        setClauses.push(`${field} = ?`);
        const value = (updates as Record<string, unknown>)[field];
        if (field === 'tags' || field === 'metadata') {
          params.push(JSON.stringify(value));
        } else {
          params.push(value);
        }
      }
    }

    if (setClauses.length === 0) {
      return existing;
    }

    params.push(id);
    this.db.run(
      `UPDATE clauses SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );

    return this.get(id);
  }

  /**
   * Invalidate a clause (mark as no longer valid)
   */
  async invalidate(id: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();

    this.db.run(
      `UPDATE clauses
       SET valid_to = ?,
           metadata = json_set(metadata, '$.invalidation_reason', ?)
       WHERE id = ?`,
      [now, reason ?? 'invalidated', id]
    );
  }

  /**
   * Reinforce a clause (increase confidence)
   */
  async reinforce(id: string, amount: number = 0.05): Promise<void> {
    const clause = await this.get(id);
    if (!clause) return;

    const newConfidence = Math.min(1.0, clause.confidence + amount);

    this.db.run(
      `UPDATE clauses
       SET confidence = ?,
           reinforcement_count = reinforcement_count + 1,
           last_accessed = datetime('now'),
           access_count = access_count + 1
       WHERE id = ?`,
      [newConfidence, id]
    );

    // Log the reinforcement
    this.logDecay(id, clause.confidence, newConfidence, 'reinforcement');
    this.logAccess(id, 'reinforcement', 'successful_use');
  }

  /**
   * Process a new clause with deduplication and conflict detection
   */
  async processNewClause(
    input: ClauseInput & { source_id: string }
  ): Promise<ProcessClauseResult> {
    // Find potentially conflicting clauses
    const existing = this.db.all<ClauseRow>(
      `SELECT * FROM clauses
       WHERE subject = ?
         AND predicate = ?
         AND valid_to IS NULL
         AND confidence > 0.3`,
      [input.subject, input.predicate]
    );

    if (existing.length === 0) {
      // No conflict, insert directly
      const clause = await this.create(input);
      return { action: 'insert', clause };
    }

    for (const oldRow of existing) {
      const old = this.rowToClause(oldRow);
      const relation = this.analyzeRelation(old, input);

      switch (relation) {
        case 'identical':
          // Reinforce existing clause
          await this.reinforce(old.id);
          return { action: 'reinforced', existingId: old.id };

        case 'supersession':
          // New clause replaces old
          await this.invalidate(old.id, 'superseded');
          const clause = await this.create(input);
          return { action: 'superseded', clause, invalidatedId: old.id };

        case 'contradiction':
          // Conflicting information - log and create both
          const newClause = await this.create(input);
          const conflict = await this.createConflict(old, newClause);
          return { action: 'conflict', clause: newClause, conflict };

        case 'coexistent':
          // Both can be true
          const coexistClause = await this.create(input);
          return { action: 'insert', clause: coexistClause };
      }
    }

    // Default: insert as new
    const clause = await this.create(input);
    return { action: 'insert', clause };
  }

  /**
   * Create a source record and archive content with full attribution
   */
  async createSource(input: SourceInput): Promise<string> {
    const id = uuidv7();
    const now = new Date().toISOString();
    const contentHash = createHash('sha256').update(input.content).digest('hex');

    // Check for duplicate source
    const existingSource = this.db.get<{ id: string }>(
      'SELECT id FROM sources WHERE content_hash = ?',
      [contentHash]
    );

    if (existingSource) {
      return existingSource.id;
    }

    // Archive content to filesystem
    const archivePath = this.archiveContent(input.type, id, input.content);

    // Count messages if it's a conversation
    let messageCount = 0;
    if (input.type === 'conversation') {
      try {
        const parsed = JSON.parse(input.content);
        messageCount = Array.isArray(parsed) ? parsed.length : 1;
      } catch {
        messageCount = input.content.split('\n').filter((l) => l.trim()).length;
      }
    }

    // Build metadata with source attribution
    const metadata: Record<string, unknown> = {
      ...input.metadata,
    };

    // Add attribution fields if provided
    if (input.attribution) {
      metadata.attribution = {
        sessionId: input.attribution.sessionId,
        agentId: input.attribution.agentId,
        query: input.attribution.query,
        tool: input.attribution.tool,
        url: input.attribution.url,
        timestamp: input.attribution.timestamp ?? now,
      };
    }

    this.db.run(
      `INSERT INTO sources (
        id, type, channel, file_path, content_hash,
        occurred_at, recorded_at, participant_count, message_count, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.type,
        input.channel ?? null,
        archivePath,
        contentHash,
        input.occurredAt ?? now,
        now,
        1,
        messageCount,
        JSON.stringify(metadata),
      ]
    );

    return id;
  }

  /**
   * Generate MEMORY.md content from high-confidence active clauses
   */
  async generateMemoryMd(): Promise<string> {
    const clauses = this.db.all<ClauseRow>(
      `SELECT * FROM clauses
       WHERE valid_to IS NULL
         AND confidence >= 0.5
       ORDER BY type, confidence DESC, last_accessed DESC`
    );

    const grouped: Record<string, Clause[]> = {};
    for (const row of clauses) {
      const clause = this.rowToClause(row);
      if (!grouped[clause.type]) {
        grouped[clause.type] = [];
      }
      grouped[clause.type].push(clause);
    }

    const now = new Date().toISOString();
    let md = `# Memory
*Auto-generated by OM-Lite. Do not edit directly.*
*Last updated: ${now}*

`;

    const sections: Record<ClauseType, string> = {
      fact: '## Facts',
      preference: '## Preferences',
      habit: '## Habits',
      skill: '## Skills',
      relationship: '## Relationships',
      intention: '## Intentions',
      context: '## Current Context',
      correction: '## Recent Corrections',
      skill_success: '## Skill Successes',
      skill_failure: '## Skill Failures',
      skill_preference: '## Skill Preferences',
    };

    for (const [type, title] of Object.entries(sections)) {
      const items = grouped[type];
      if (!items?.length) continue;

      md += `${title}\n\n`;

      for (const clause of items.slice(0, 15)) {
        const confidence = Math.round(clause.confidence * 100);
        const age = this.daysSince(clause.recorded_at);
        md += `- ${clause.natural_form} _(${confidence}% confidence, ${age}d ago)_\n`;
      }

      md += '\n';
    }

    return md;
  }

  /**
   * Generate complete MEMORY_FULL.md export with all clauses (including expired)
   * Includes detailed metadata for each clause
   */
  async generateFullExport(): Promise<string> {
    const clauses = this.db.all<ClauseRow & { channel?: string; source_date?: string }>(
      `SELECT c.*, s.channel, s.occurred_at as source_date
       FROM clauses c
       LEFT JOIN sources s ON c.source_id = s.id
       ORDER BY c.recorded_at DESC`
    );

    const now = new Date().toISOString();
    let md = `# Complete Memory Export
*Generated: ${now}*
*Total clauses: ${clauses.length}*

`;

    for (const row of clauses) {
      const clause = this.rowToClause(row);
      const status = clause.valid_to ? '❌ EXPIRED' : '✅ ACTIVE';

      md += `---
### ${clause.natural_form}

| Property | Value |
|----------|-------|
| ID | \`${clause.id}\` |
| Status | ${status} |
| Type | ${clause.type} |
| Subject | ${clause.subject} |
| Predicate | ${clause.predicate} |
| Object | ${clause.object} |
| Confidence | ${(clause.confidence * 100).toFixed(1)}% |
| Valid From | ${clause.valid_from} |
| Valid To | ${clause.valid_to ?? 'current'} |
| Recorded At | ${clause.recorded_at} |
| Source | ${row.channel ?? 'unknown'} @ ${row.source_date ?? 'unknown'} |
| Accesses | ${clause.access_count} |
| Last Accessed | ${clause.last_accessed} |
| Reinforcements | ${clause.reinforcement_count} |
| Decay Rate | ${clause.decay_rate} |
| Tags | ${clause.tags.join(', ') || 'none'} |

`;
    }

    return md;
  }

  /**
   * Export clauses as JSON
   */
  async exportAsJson(options: { includeExpired?: boolean } = {}): Promise<string> {
    const sql = options.includeExpired
      ? 'SELECT * FROM clauses ORDER BY recorded_at DESC'
      : 'SELECT * FROM clauses WHERE valid_to IS NULL ORDER BY recorded_at DESC';

    const rows = this.db.all<ClauseRow>(sql);
    const clauses = rows.map((row) => this.rowToClause(row));

    return JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        version: '1.0',
        total_clauses: clauses.length,
        clauses,
      },
      null,
      2
    );
  }

  /**
   * Archive source content to filesystem
   */
  async archiveSourceToFile(
    sourceId: string,
    content: string | object,
    options: { subdir?: string } = {}
  ): Promise<string> {
    const baseDir = join(homedir(), '.openclaw', 'memory', 'sources');
    const subdir = options.subdir ?? 'documents';
    const targetDir = join(baseDir, subdir);

    // Ensure directory exists
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Generate filename with date prefix
    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}_${sourceId}.json`;
    const filePath = join(targetDir, filename);

    // Write content
    const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    writeFileSync(filePath, data, 'utf-8');

    // Update source record with file path
    this.db.run('UPDATE sources SET file_path = ? WHERE id = ?', [filePath, sourceId]);

    return filePath;
  }

  /**
   * Enforce source retention policy - delete old source files
   */
  async enforceRetention(retentionDays: number = 90): Promise<{ deleted: number; errors: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const oldSources = this.db.all<{ id: string; file_path: string }>(
      `SELECT id, file_path FROM sources
       WHERE occurred_at < ?
         AND file_path IS NOT NULL
         AND file_path != ''
         AND file_path != '[archived]'`,
      [cutoff.toISOString()]
    );

    let deleted = 0;
    let errors = 0;

    for (const source of oldSources) {
      try {
        // Delete file if it exists
        if (existsSync(source.file_path)) {
          const { unlinkSync } = await import('fs');
          unlinkSync(source.file_path);
        }

        // Mark as archived in database
        this.db.run(
          `UPDATE sources
           SET file_path = '[archived]',
               metadata = json_set(COALESCE(metadata, '{}'), '$.archived_at', ?)
           WHERE id = ?`,
          [new Date().toISOString(), source.id]
        );

        deleted++;
      } catch (error) {
        console.warn(`Failed to archive source ${source.id}:`, error);
        errors++;
      }
    }

    return { deleted, errors };
  }

  /**
   * Log clause access (public method)
   */
  logClauseAccess(
    clauseId: string,
    accessType: 'retrieval' | 'injection' | 'reinforcement',
    context: string
  ): string {
    const id = uuidv7();
    this.db.run(
      `INSERT INTO access_log (id, clause_id, access_type, context)
       VALUES (?, ?, ?, ?)`,
      [id, clauseId, accessType, context]
    );
    return id;
  }

  /**
   * Mark an access as useful or not (feedback for learning)
   */
  markAccessUseful(accessId: string, wasUseful: boolean, correctionId?: string): void {
    this.db.run(
      `UPDATE access_log
       SET was_useful = ?, correction_id = ?
       WHERE id = ?`,
      [wasUseful ? 1 : 0, correctionId ?? null, accessId]
    );
  }

  /**
   * Get access history for a clause
   */
  getAccessHistory(
    clauseId: string,
    options: { limit?: number } = {}
  ): Array<{
    id: string;
    accessed_at: string;
    access_type: string;
    context: string;
    was_useful: boolean | null;
  }> {
    const limit = options.limit ?? 100;
    return this.db.all(
      `SELECT id, accessed_at, access_type, context, was_useful
       FROM access_log
       WHERE clause_id = ?
       ORDER BY accessed_at DESC
       LIMIT ?`,
      [clauseId, limit]
    );
  }

  /**
   * Get clauses that were marked as not useful
   */
  getUnhelpfulClauses(): Array<{ clause_id: string; unhelpful_count: number }> {
    return this.db.all(
      `SELECT clause_id, COUNT(*) as unhelpful_count
       FROM access_log
       WHERE was_useful = 0
       GROUP BY clause_id
       ORDER BY unhelpful_count DESC`
    );
  }

  // ========== Conflict Resolution ==========

  /**
   * Get all pending conflicts
   */
  async getPendingConflicts(): Promise<Conflict[]> {
    const rows = this.db.all<{
      id: string;
      clause_a_id: string;
      clause_b_id: string;
      conflict_type: string;
      description: string;
      status: string;
      resolution: string | null;
      resolved_at: string | null;
      detected_at: string;
    }>("SELECT * FROM conflicts WHERE status = 'pending' ORDER BY detected_at DESC");

    return rows.map(row => ({
      id: row.id,
      clause_a_id: row.clause_a_id,
      clause_b_id: row.clause_b_id,
      conflict_type: row.conflict_type as 'contradiction' | 'supersession' | 'ambiguity',
      description: row.description,
      status: row.status as 'pending' | 'auto_resolved' | 'user_resolved' | 'ignored',
      resolution: row.resolution,
      resolved_at: row.resolved_at,
      detected_at: row.detected_at,
    }));
  }

  /**
   * Resolve a single conflict using configured strategy
   */
  async resolveConflict(
    conflictId: string,
    strategy?: ConflictResolutionStrategy
  ): Promise<{ resolved: boolean; action: string; keptClauseId?: string }> {
    const useStrategy = strategy ?? this.conflictConfig.strategy;

    const conflict = this.db.get<{
      id: string;
      clause_a_id: string;
      clause_b_id: string;
      conflict_type: string;
      status: string;
    }>('SELECT * FROM conflicts WHERE id = ?', [conflictId]);

    if (!conflict || conflict.status !== 'pending') {
      return { resolved: false, action: 'not_found_or_already_resolved' };
    }

    const clauseA = await this.get(conflict.clause_a_id);
    const clauseB = await this.get(conflict.clause_b_id);

    if (!clauseA || !clauseB) {
      // One clause was deleted, auto-resolve
      this.db.run(
        `UPDATE conflicts SET status = 'auto_resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?`,
        ['clause_deleted', conflictId]
      );
      return { resolved: true, action: 'clause_deleted', keptClauseId: clauseA?.id ?? clauseB?.id };
    }

    let keptClause: Clause;
    let invalidatedClause: Clause;
    let resolution: string;

    switch (useStrategy) {
      case 'newest_wins':
        if (new Date(clauseA.recorded_at) > new Date(clauseB.recorded_at)) {
          keptClause = clauseA;
          invalidatedClause = clauseB;
        } else {
          keptClause = clauseB;
          invalidatedClause = clauseA;
        }
        resolution = 'newest_wins: kept ' + keptClause.id;
        break;

      case 'highest_confidence':
        if (clauseA.confidence >= clauseB.confidence) {
          keptClause = clauseA;
          invalidatedClause = clauseB;
        } else {
          keptClause = clauseB;
          invalidatedClause = clauseA;
        }
        resolution = 'highest_confidence: kept ' + keptClause.id;
        break;

      case 'merge_history':
      default:
        // Keep newer, archive older with link
        if (new Date(clauseA.recorded_at) > new Date(clauseB.recorded_at)) {
          keptClause = clauseA;
          invalidatedClause = clauseB;
        } else {
          keptClause = clauseB;
          invalidatedClause = clauseA;
        }
        resolution = 'merge_history: kept ' + keptClause.id + ', archived ' + invalidatedClause.id;
        break;

      case 'manual':
        return { resolved: false, action: 'requires_manual_resolution' };
    }

    // Invalidate the losing clause
    await this.invalidate(invalidatedClause.id, `superseded_by:${keptClause.id}`);

    // Link them in metadata if preserving history
    if (this.conflictConfig.preserveHistory) {
      const metadata = keptClause.metadata || {};
      metadata.supersedes = metadata.supersedes || [];
      (metadata.supersedes as string[]).push(invalidatedClause.id);
      await this.update(keptClause.id, { metadata });
    }

    // Mark conflict as resolved
    this.db.run(
      `UPDATE conflicts SET status = 'auto_resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?`,
      [resolution, conflictId]
    );

    return { resolved: true, action: resolution, keptClauseId: keptClause.id };
  }

  /**
   * Resolve all pending conflicts using configured strategy
   */
  async resolveAllConflicts(
    strategy?: ConflictResolutionStrategy
  ): Promise<{ resolved: number; skipped: number; errors: number }> {
    const conflicts = await this.getPendingConflicts();
    let resolved = 0;
    let skipped = 0;
    let errors = 0;

    for (const conflict of conflicts) {
      try {
        const result = await this.resolveConflict(conflict.id, strategy);
        if (result.resolved) {
          resolved++;
        } else {
          skipped++;
        }
      } catch {
        errors++;
      }
    }

    return { resolved, skipped, errors };
  }

  // ========== Deduplication ==========

  /**
   * Calculate text similarity using Jaccard index
   */
  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    if (wordsA.size === 0 && wordsB.size === 0) return 1;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  /**
   * Find duplicate or similar existing clause
   */
  async findDuplicate(
    input: ClauseInput
  ): Promise<{ found: boolean; clause?: Clause; similarity: number; matchType: 'exact' | 'hash' | 'fuzzy' | 'none' }> {
    if (!this.dedupConfig.enabled) {
      return { found: false, similarity: 0, matchType: 'none' };
    }

    // 1. Check exact SPO match (hash-based deduplication)
    if (this.dedupConfig.useContentHash) {
      const existing = this.db.all<ClauseRow>(
        `SELECT * FROM clauses WHERE valid_to IS NULL AND subject = ? AND predicate = ? AND object = ?`,
        [input.subject, input.predicate, input.object]
      );

      if (existing.length > 0) {
        return { found: true, clause: this.rowToClause(existing[0]), similarity: 1.0, matchType: 'exact' };
      }
    }

    // 2. Check fuzzy match using FTS + similarity
    if (this.dedupConfig.useFuzzyMatch) {
      // Find clauses with same subject+predicate
      const candidates = this.db.all<ClauseRow>(
        `SELECT * FROM clauses WHERE valid_to IS NULL AND subject = ? AND predicate = ? AND confidence > 0.3`,
        [input.subject, input.predicate]
      );

      for (const row of candidates) {
        const clause = this.rowToClause(row);
        const similarity = this.calculateSimilarity(clause.natural_form, input.natural_form);

        if (similarity >= this.dedupConfig.similarityThreshold) {
          return { found: true, clause, similarity, matchType: 'fuzzy' };
        }
      }

      // Also check natural_form similarity across all clauses
      const ftsResults = this.db.all<ClauseRow>(
        `SELECT c.* FROM clauses c
         JOIN clauses_fts ON c.rowid = clauses_fts.rowid
         WHERE clauses_fts MATCH ? AND c.valid_to IS NULL
         LIMIT 5`,
        [input.natural_form.replace(/['"()]/g, ' ').trim().split(/\s+/).slice(0, 5).join(' ')]
      );

      for (const row of ftsResults) {
        const clause = this.rowToClause(row);
        const similarity = this.calculateSimilarity(clause.natural_form, input.natural_form);

        if (similarity >= this.dedupConfig.similarityThreshold) {
          return { found: true, clause, similarity, matchType: 'fuzzy' };
        }
      }
    }

    return { found: false, similarity: 0, matchType: 'none' };
  }

  /**
   * Process clause with deduplication check
   */
  async processWithDeduplication(
    input: ClauseInput & { source_id: string }
  ): Promise<ProcessClauseResult> {
    // Check for duplicates first
    const dupCheck = await this.findDuplicate(input);

    if (dupCheck.found && dupCheck.clause) {
      switch (this.dedupConfig.onDuplicate) {
        case 'reinforce':
          await this.reinforce(dupCheck.clause.id, 0.05);
          return {
            action: 'reinforced',
            existingId: dupCheck.clause.id,
            clause: dupCheck.clause
          };

        case 'skip':
          return {
            action: 'skipped',
            existingId: dupCheck.clause.id
          };

        case 'merge':
          // Merge metadata and reinforce
          const mergedMetadata = {
            ...dupCheck.clause.metadata,
            ...input.metadata,
            merge_count: ((dupCheck.clause.metadata?.merge_count as number) || 0) + 1,
          };
          await this.update(dupCheck.clause.id, { metadata: mergedMetadata });
          await this.reinforce(dupCheck.clause.id, 0.03);
          return {
            action: 'reinforced',
            existingId: dupCheck.clause.id,
            clause: dupCheck.clause
          };
      }
    }

    // No duplicate, process normally
    return this.processNewClause(input);
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<MemoryStats> {
    const totalRow = this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM clauses'
    );
    const activeRow = this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM clauses WHERE valid_to IS NULL'
    );
    const expiredRow = this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM clauses WHERE valid_to IS NOT NULL'
    );
    const avgConfRow = this.db.get<{ avg: number }>(
      'SELECT AVG(confidence) as avg FROM clauses WHERE valid_to IS NULL'
    );
    const sourcesRow = this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM sources'
    );
    const conflictsRow = this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM conflicts WHERE status = 'pending'"
    );
    const packsRow = this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM installed_packs'
    );

    // Get counts by type
    const byTypeRows = this.db.all<{ type: string; count: number }>(
      `SELECT type, COUNT(*) as count FROM clauses WHERE valid_to IS NULL GROUP BY type`
    );

    const clausesByType: Record<ClauseType, number> = {
      fact: 0,
      preference: 0,
      habit: 0,
      skill: 0,
      relationship: 0,
      intention: 0,
      context: 0,
      correction: 0,
      skill_success: 0,
      skill_failure: 0,
      skill_preference: 0,
    };

    for (const row of byTypeRows) {
      clausesByType[row.type as ClauseType] = row.count;
    }

    return {
      totalClauses: totalRow?.count ?? 0,
      activeClauses: activeRow?.count ?? 0,
      expiredClauses: expiredRow?.count ?? 0,
      avgConfidence: avgConfRow?.avg ?? 0,
      clausesByType,
      totalSources: sourcesRow?.count ?? 0,
      pendingConflicts: conflictsRow?.count ?? 0,
      installedPacks: packsRow?.count ?? 0,
      dbSizeBytes: this.db.getSize(),
      lastDecayRun: this.db.getMetadata('last_decay_run'),
      lastMemorySync: this.db.getMetadata('last_memory_sync'),
    };
  }

  // ========== Private Methods ==========

  private rowToClause(row: ClauseRow): Clause {
    return {
      id: row.id,
      type: row.type as ClauseType,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      natural_form: row.natural_form,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      recorded_at: row.recorded_at,
      confidence: row.confidence,
      decay_rate: row.decay_rate,
      reinforcement_count: row.reinforcement_count,
      source_id: row.source_id,
      extraction_method: row.extraction_method,
      last_accessed: row.last_accessed,
      access_count: row.access_count,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private analyzeRelation(
    old: Clause,
    input: ClauseInput
  ): 'identical' | 'supersession' | 'contradiction' | 'coexistent' {
    // Same object = reinforcement
    if (old.object.toLowerCase() === input.object.toLowerCase()) {
      return 'identical';
    }

    // Singleton predicates (can only have one value)
    if (SINGLETON_PREDICATES.includes(old.predicate)) {
      return 'supersession';
    }

    // Multi-value predicates (can have many)
    if (MULTI_VALUE_PREDICATES.includes(old.predicate)) {
      return 'coexistent';
    }

    // Default: potential contradiction
    return 'contradiction';
  }

  private async createConflict(
    clauseA: Clause,
    clauseB: Clause
  ): Promise<Conflict> {
    const id = uuidv7();
    const now = new Date().toISOString();

    const conflict: Conflict = {
      id,
      clause_a_id: clauseA.id,
      clause_b_id: clauseB.id,
      conflict_type: 'contradiction',
      description: `Conflicting values for ${clauseA.subject}.${clauseA.predicate}: "${clauseA.object}" vs "${clauseB.object}"`,
      status: 'pending',
      resolution: null,
      resolved_at: null,
      detected_at: now,
    };

    this.db.run(
      `INSERT INTO conflicts (
        id, clause_a_id, clause_b_id, conflict_type, description,
        status, resolution, resolved_at, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conflict.id,
        conflict.clause_a_id,
        conflict.clause_b_id,
        conflict.conflict_type,
        conflict.description,
        conflict.status,
        conflict.resolution,
        conflict.resolved_at,
        conflict.detected_at,
      ]
    );

    // Update conflict counter
    const current = parseInt(
      this.db.getMetadata('total_conflicts_detected') ?? '0',
      10
    );
    this.db.setMetadata('total_conflicts_detected', String(current + 1));

    return conflict;
  }

  private archiveContent(type: SourceType, id: string, content: string): string {
    const baseDir = join(homedir(), '.openclaw', 'memory', 'sources');
    const typeDir = join(baseDir, `${type}s`);

    if (!existsSync(typeDir)) {
      mkdirSync(typeDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${timestamp}_${id.slice(0, 8)}.json`;
    const filePath = join(typeDir, filename);

    writeFileSync(filePath, JSON.stringify({ content, archived_at: new Date().toISOString() }, null, 2));

    return filePath;
  }

  private logDecay(
    clauseId: string,
    previousConfidence: number,
    newConfidence: number,
    reason: string
  ): void {
    const id = uuidv7();
    this.db.run(
      `INSERT INTO decay_log (id, clause_id, previous_confidence, new_confidence, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [id, clauseId, previousConfidence, newConfidence, reason]
    );
  }

  private logAccess(
    clauseId: string,
    accessType: 'retrieval' | 'injection' | 'reinforcement',
    context: string
  ): void {
    const id = uuidv7();
    this.db.run(
      `INSERT INTO access_log (id, clause_id, access_type, context)
       VALUES (?, ?, ?, ?)`,
      [id, clauseId, accessType, context]
    );
  }

  private daysSince(dateStr: string): number {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}
