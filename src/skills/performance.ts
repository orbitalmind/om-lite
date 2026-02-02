/**
 * Performance Tracker - Track and learn from skill execution outcomes
 * Enables skill selection based on historical performance
 */

import type { DatabaseManager } from '../core/database.js';
import type { ClauseStore } from '../core/clauses.js';
import type {
  Clause,
  ClauseInput,
  SkillOutcome,
  SkillPerformance,
} from '../core/types.js';

interface PerformanceRow {
  skill_id: string;
  task_category: string;
  success_count: number;
  failure_count: number;
  avg_execution_time_ms: number;
  last_used: string;
}

export class PerformanceTracker {
  private db: DatabaseManager;
  private clauseStore: ClauseStore;
  private tableInitialized = false;

  constructor(db: DatabaseManager, clauseStore: ClauseStore) {
    this.db = db;
    this.clauseStore = clauseStore;
  }

  /**
   * Ensure the skill_performance table exists (called lazily)
   */
  private ensureTable(): void {
    if (this.tableInitialized) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS skill_performance (
        skill_id TEXT NOT NULL,
        task_category TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        avg_execution_time_ms REAL NOT NULL DEFAULT 0,
        last_used TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (skill_id, task_category)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_skill_performance_skill ON skill_performance(skill_id)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_skill_performance_category ON skill_performance(task_category)
    `);

    this.tableInitialized = true;
  }

  /**
   * Record the outcome of a skill execution
   * Implements learning loop: reinforces on success, decays on failure
   */
  async recordOutcome(skillId: string, outcome: SkillOutcome): Promise<void> {
    this.ensureTable();
    const taskCategory = outcome.taskCategory ?? 'general';
    const now = new Date().toISOString();

    // Get current stats
    const current = this.db.get<PerformanceRow>(
      'SELECT * FROM skill_performance WHERE skill_id = ? AND task_category = ?',
      [skillId, taskCategory]
    );

    // Track consecutive failures for learning loop
    let consecutiveFailures = 0;

    if (current) {
      // Update existing record
      const newSuccessCount = current.success_count + (outcome.success ? 1 : 0);
      const newFailureCount = current.failure_count + (outcome.success ? 0 : 1);

      // Update average execution time
      let newAvgTime = current.avg_execution_time_ms;
      if (outcome.executionTimeMs !== undefined) {
        const totalCount = newSuccessCount + newFailureCount;
        const prevTotal = current.success_count + current.failure_count;
        newAvgTime =
          (current.avg_execution_time_ms * prevTotal + outcome.executionTimeMs) / totalCount;
      }

      // Calculate consecutive failures from metadata
      const metadata = this.getSkillMetadata(skillId, taskCategory);
      consecutiveFailures = outcome.success ? 0 : (metadata.consecutiveFailures ?? 0) + 1;

      this.db.run(
        `UPDATE skill_performance
         SET success_count = ?, failure_count = ?, avg_execution_time_ms = ?, last_used = ?
         WHERE skill_id = ? AND task_category = ?`,
        [newSuccessCount, newFailureCount, newAvgTime, now, skillId, taskCategory]
      );

      // Update consecutive failures in metadata
      this.setSkillMetadata(skillId, taskCategory, { consecutiveFailures });
    } else {
      // Insert new record
      consecutiveFailures = outcome.success ? 0 : 1;

      this.db.run(
        `INSERT INTO skill_performance (skill_id, task_category, success_count, failure_count, avg_execution_time_ms, last_used)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          skillId,
          taskCategory,
          outcome.success ? 1 : 0,
          outcome.success ? 0 : 1,
          outcome.executionTimeMs ?? 0,
          now,
        ]
      );

      this.setSkillMetadata(skillId, taskCategory, { consecutiveFailures });
    }

    // Create performance clause
    await this.createPerformanceClause(skillId, taskCategory, outcome);

    // ========== Learning Loop Integration ==========

    if (outcome.success && outcome.usedClauseIds) {
      // On success: reinforce used clauses
      for (const clauseId of outcome.usedClauseIds) {
        try {
          // Scale reinforcement by how successful this skill is overall
          const successRate = await this.getSuccessRate(skillId, taskCategory);
          const reinforceAmount = 0.02 + (successRate * 0.03); // 0.02-0.05 based on success rate
          await this.clauseStore.reinforce(clauseId, reinforceAmount);
        } catch {
          // Ignore if clause doesn't exist
        }
      }

      // Also boost skill capability clauses
      await this.reinforceSkillCapabilities(skillId, 0.01);
    } else if (!outcome.success) {
      // On failure: apply decay penalty to related clauses
      await this.applyFailurePenalty(skillId, taskCategory, outcome, consecutiveFailures);
    }
  }

  /**
   * Apply decay penalty on skill failure
   * Larger penalty for repeated consecutive failures
   */
  private async applyFailurePenalty(
    skillId: string,
    taskCategory: string,
    outcome: SkillOutcome,
    consecutiveFailures: number
  ): Promise<void> {
    // Calculate penalty based on consecutive failures (exponential backoff)
    const basePenalty = 0.02;
    const penalty = Math.min(0.1, basePenalty * Math.pow(1.5, consecutiveFailures - 1));

    // Apply penalty to used clauses (they may have contributed to failure)
    if (outcome.usedClauseIds) {
      for (const clauseId of outcome.usedClauseIds) {
        try {
          const clause = await this.clauseStore.get(clauseId);
          if (clause && clause.confidence > 0.3) {
            // Only decay if confidence is high enough
            const newConfidence = Math.max(0.1, clause.confidence - penalty);
            await this.clauseStore.update(clauseId, { confidence: newConfidence });
          }
        } catch {
          // Ignore if clause doesn't exist
        }
      }
    }

    // Decay skill preference clauses if failure is persistent
    if (consecutiveFailures >= 3) {
      await this.decaySkillPreferences(skillId, taskCategory, penalty * 1.5);
    }
  }

  /**
   * Reinforce skill capability clauses
   */
  private async reinforceSkillCapabilities(skillId: string, amount: number): Promise<void> {
    const capabilityClauses = this.db.all<{ clause_id: string }>(
      `SELECT clause_id FROM skill_capabilities WHERE skill_id = ?`,
      [skillId]
    );

    for (const cap of capabilityClauses) {
      try {
        await this.clauseStore.reinforce(cap.clause_id, amount);
      } catch {
        // Ignore if clause doesn't exist
      }
    }
  }

  /**
   * Decay skill preference clauses after repeated failures
   */
  private async decaySkillPreferences(
    skillId: string,
    taskCategory: string,
    amount: number
  ): Promise<void> {
    const prefClauses = this.db.all<{ id: string; confidence: number }>(
      `SELECT id, confidence FROM clauses
       WHERE type = 'skill_preference'
         AND subject = ?
         AND object = ?
         AND valid_to IS NULL`,
      [`skill:${skillId}`, taskCategory]
    );

    for (const pref of prefClauses) {
      const newConfidence = Math.max(0.1, pref.confidence - amount);
      await this.clauseStore.update(pref.id, { confidence: newConfidence });
    }
  }

  /**
   * Get skill-specific metadata
   */
  private getSkillMetadata(skillId: string, taskCategory: string): Record<string, number> {
    const row = this.db.get<{ value: string }>(
      `SELECT value FROM system_metadata WHERE key = ?`,
      [`skill_meta:${skillId}:${taskCategory}`]
    );
    return row ? JSON.parse(row.value) : {};
  }

  /**
   * Set skill-specific metadata
   */
  private setSkillMetadata(skillId: string, taskCategory: string, data: Record<string, number>): void {
    const existing = this.getSkillMetadata(skillId, taskCategory);
    const merged = { ...existing, ...data };
    this.db.run(
      `INSERT OR REPLACE INTO system_metadata (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      [`skill_meta:${skillId}:${taskCategory}`, JSON.stringify(merged)]
    );
  }

  /**
   * Select the best skill for a task from candidates
   */
  async selectBest(
    task: string,
    candidates: string[]
  ): Promise<string | null> {
    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    this.ensureTable();
    const taskCategory = await this.categorizeTask(task);
    const scores: Map<string, number> = new Map();

    for (const skillId of candidates) {
      let score = 0.5; // Base score

      // Get performance stats
      const perf = this.db.get<PerformanceRow>(
        'SELECT * FROM skill_performance WHERE skill_id = ? AND task_category = ?',
        [skillId, taskCategory]
      );

      if (perf) {
        const totalAttempts = perf.success_count + perf.failure_count;
        if (totalAttempts > 0) {
          const successRate = perf.success_count / totalAttempts;
          score += successRate * 0.3;

          // Recency boost
          const daysSinceUse = this.daysSince(perf.last_used);
          const recencyScore = Math.max(0, 1 - daysSinceUse / 30);
          score += recencyScore * 0.1;

          // Experience boost (more attempts = more reliable data)
          const experienceScore = Math.min(1, totalAttempts / 10);
          score += experienceScore * 0.1;
        }
      }

      // Check for success/failure clauses
      const successClauses = await this.getPerformanceClauses(skillId, 'skill_success', taskCategory);
      const failureClauses = await this.getPerformanceClauses(skillId, 'skill_failure', taskCategory);

      for (const clause of successClauses) {
        score += clause.confidence * 0.1;
      }

      for (const clause of failureClauses) {
        score -= clause.confidence * 0.05;
      }

      // Check for user preference
      const prefClauses = await this.getPerformanceClauses(skillId, 'skill_preference', taskCategory);
      for (const clause of prefClauses) {
        score += clause.confidence * 0.15;
      }

      scores.set(skillId, Math.max(0, Math.min(1, score)));
    }

    // Return highest scoring skill
    let bestSkill = candidates[0];
    let bestScore = scores.get(bestSkill) ?? 0;

    for (const [skillId, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestSkill = skillId;
      }
    }

    return bestSkill;
  }

  /**
   * Get performance stats for a skill or all skills
   */
  async getPerformance(skillId?: string): Promise<SkillPerformance[]> {
    this.ensureTable();
    let sql = 'SELECT * FROM skill_performance';
    const params: unknown[] = [];

    if (skillId) {
      sql += ' WHERE skill_id = ?';
      params.push(skillId);
    }

    sql += ' ORDER BY last_used DESC';

    const rows = this.db.all<PerformanceRow>(sql, params);

    return rows.map((row) => ({
      skill_id: row.skill_id,
      task_category: row.task_category,
      success_count: row.success_count,
      failure_count: row.failure_count,
      avg_execution_time_ms: row.avg_execution_time_ms,
      last_used: row.last_used,
    }));
  }

  /**
   * Get success rate for a skill in a category
   */
  async getSuccessRate(skillId: string, taskCategory?: string): Promise<number> {
    this.ensureTable();
    let sql = 'SELECT SUM(success_count) as successes, SUM(failure_count) as failures FROM skill_performance WHERE skill_id = ?';
    const params: unknown[] = [skillId];

    if (taskCategory) {
      sql += ' AND task_category = ?';
      params.push(taskCategory);
    }

    const row = this.db.get<{ successes: number; failures: number }>(sql, params);

    if (!row || (row.successes + row.failures) === 0) {
      return 0.5; // Default to 50% if no data
    }

    return row.successes / (row.successes + row.failures);
  }

  /**
   * Get top performing skills for a category
   */
  async getTopSkills(taskCategory: string, limit: number = 5): Promise<string[]> {
    this.ensureTable();
    const rows = this.db.all<{ skill_id: string; success_rate: number }>(
      `SELECT skill_id,
              CAST(success_count AS REAL) / (success_count + failure_count) as success_rate
       FROM skill_performance
       WHERE task_category = ?
         AND (success_count + failure_count) >= 3
       ORDER BY success_rate DESC
       LIMIT ?`,
      [taskCategory, limit]
    );

    return rows.map((r) => r.skill_id);
  }

  /**
   * Clear performance data for a skill
   */
  async clearPerformance(skillId: string): Promise<void> {
    this.ensureTable();
    this.db.run('DELETE FROM skill_performance WHERE skill_id = ?', [skillId]);

    // Also invalidate performance clauses
    const clauses = this.db.all<{ id: string }>(
      `SELECT id FROM clauses
       WHERE type IN ('skill_success', 'skill_failure', 'skill_preference')
         AND subject = ?
         AND valid_to IS NULL`,
      [`skill:${skillId}`]
    );

    for (const clause of clauses) {
      await this.clauseStore.invalidate(clause.id, 'performance_cleared');
    }
  }

  // ========== Private Methods ==========

  /**
   * Create a performance clause for a skill outcome
   */
  private async createPerformanceClause(
    skillId: string,
    taskCategory: string,
    outcome: SkillOutcome
  ): Promise<Clause | null> {
    const sourceId = await this.clauseStore.createSource({
      type: 'inferred',
      content: JSON.stringify(outcome),
      channel: `skill_execution:${skillId}`,
      metadata: {
        skill_id: skillId,
        task_category: taskCategory,
      },
    });

    const clauseType = outcome.success ? 'skill_success' : 'skill_failure';
    const predicate = outcome.success ? 'succeeds_at' : 'failed_at';
    const naturalForm = outcome.success
      ? `${skillId} skill successfully handles ${taskCategory} tasks`
      : `${skillId} skill failed at ${taskCategory}: ${outcome.errorMessage ?? 'unknown error'}`;

    const input: ClauseInput & { source_id: string; extraction_method: string } = {
      type: clauseType,
      subject: `skill:${skillId}`,
      predicate,
      object: taskCategory,
      natural_form: naturalForm,
      confidence: outcome.success ? 0.6 : 0.8, // Start moderate for success, higher for failures
      decay_rate: outcome.success ? 0.002 : 0.01, // Failures decay faster
      tags: [`skill:${skillId}`, `category:${taskCategory}`],
      metadata: {
        skill_id: skillId,
        task_category: taskCategory,
        execution_time_ms: outcome.executionTimeMs,
        error_type: outcome.errorType,
        error_message: outcome.errorMessage,
      },
      source_id: sourceId,
      extraction_method: 'performance_tracking',
    };

    const result = await this.clauseStore.processNewClause(input);
    return result.clause ?? null;
  }

  /**
   * Get performance-related clauses for a skill
   */
  private async getPerformanceClauses(
    skillId: string,
    clauseType: 'skill_success' | 'skill_failure' | 'skill_preference',
    taskCategory?: string
  ): Promise<Clause[]> {
    let sql = `
      SELECT * FROM clauses
      WHERE type = ?
        AND subject = ?
        AND valid_to IS NULL
        AND confidence > 0.3
    `;
    const params: unknown[] = [clauseType, `skill:${skillId}`];

    if (taskCategory) {
      sql += ' AND object = ?';
      params.push(taskCategory);
    }

    sql += ' ORDER BY confidence DESC LIMIT 10';

    const rows = this.db.all<{
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
    }>(sql, params);

    return rows.map((row) => ({
      id: row.id,
      type: row.type as 'skill_success' | 'skill_failure' | 'skill_preference',
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
    }));
  }

  /**
   * Categorize a task description into a category
   */
  private async categorizeTask(task: string): Promise<string> {
    const taskLower = task.toLowerCase();

    // Simple keyword-based categorization
    const categoryKeywords: Record<string, string[]> = {
      flight_booking: ['flight', 'fly', 'airline', 'airport', 'travel'],
      hotel_booking: ['hotel', 'accommodation', 'stay', 'lodging', 'airbnb'],
      calendar: ['schedule', 'meeting', 'calendar', 'appointment', 'event'],
      email: ['email', 'mail', 'send', 'reply', 'message'],
      search: ['search', 'find', 'look up', 'query', 'google'],
      file_management: ['file', 'folder', 'document', 'save', 'download'],
      code: ['code', 'programming', 'debug', 'compile', 'git'],
      shopping: ['buy', 'purchase', 'order', 'shop', 'cart'],
      reminder: ['remind', 'remember', 'todo', 'task', 'alert'],
    };

    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      for (const keyword of keywords) {
        if (taskLower.includes(keyword)) {
          return category;
        }
      }
    }

    return 'general';
  }

  /**
   * Calculate days since a date
   */
  private daysSince(dateStr: string): number {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}
