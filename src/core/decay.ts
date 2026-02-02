/**
 * Decay module - Confidence decay system for memory maintenance
 * Implements time-based decay with reinforcement-based resistance
 */

import { v7 as uuidv7 } from 'uuid';
import type { DatabaseManager } from './database.js';
import type { DecayConfig, DecayReport } from './types.js';

interface ClauseRow {
  id: string;
  type: string;
  confidence: number;
  decay_rate: number;
  reinforcement_count: number;
  last_accessed: string;
  valid_to: string | null;
}

export class DecayRunner {
  private db: DatabaseManager;
  private config: DecayConfig;

  constructor(db: DatabaseManager, config: Partial<DecayConfig> = {}) {
    this.db = db;
    this.config = {
      enabled: config.enabled ?? true,
      defaultRate: config.defaultRate ?? 0.001,
      minConfidence: config.minConfidence ?? 0.1,
    };
  }

  /**
   * Run confidence decay on all active clauses
   *
   * Decay formula:
   *   new_confidence = old_confidence * (1 - decay_rate * time_factor)
   *
   * where:
   *   time_factor = days_since_last_access / 30
   *   effective_decay_rate = base_decay_rate / (1 + log(reinforcement_count + 1))
   *
   * Clauses that are frequently accessed and reinforced decay slower.
   */
  async run(dryRun: boolean = false): Promise<DecayReport> {
    if (!this.config.enabled && !dryRun) {
      return {
        processed: 0,
        decayed: 0,
        archived: 0,
        reinforced: 0,
        timestamp: new Date().toISOString(),
      };
    }

    const report: DecayReport = {
      processed: 0,
      decayed: 0,
      archived: 0,
      reinforced: 0,
      timestamp: new Date().toISOString(),
    };

    // Get all active clauses
    const clauses = this.db.all<ClauseRow>(
      `SELECT id, type, confidence, decay_rate, reinforcement_count, last_accessed, valid_to
       FROM clauses
       WHERE valid_to IS NULL
         AND confidence > ?`,
      [this.config.minConfidence]
    );

    const now = Date.now();

    for (const clause of clauses) {
      report.processed++;

      // Calculate time factor
      const lastAccess = new Date(clause.last_accessed).getTime();
      const daysSinceAccess = Math.max(0, (now - lastAccess) / (1000 * 60 * 60 * 24));
      const timeFactor = daysSinceAccess / 30;

      // Calculate effective decay rate (reduced by reinforcement)
      const effectiveDecayRate =
        clause.decay_rate / (1 + Math.log(clause.reinforcement_count + 1));

      // Calculate new confidence
      const decayAmount = clause.confidence * effectiveDecayRate * timeFactor;
      const newConfidence = Math.max(0, clause.confidence - decayAmount);

      // Decide action based on new confidence
      if (newConfidence < this.config.minConfidence) {
        // Archive clause (set valid_to)
        if (!dryRun) {
          await this.archiveClause(clause.id, newConfidence);
        }
        report.archived++;
      } else if (newConfidence < clause.confidence - 0.001) {
        // Apply decay (only if meaningful change)
        if (!dryRun) {
          await this.applyDecay(clause.id, clause.confidence, newConfidence);
        }
        report.decayed++;
      }
    }

    // Update last decay run timestamp
    if (!dryRun) {
      this.db.setMetadata('last_decay_run', new Date().toISOString());
    }

    return report;
  }

  /**
   * Reinforce a clause (increase confidence due to successful use)
   */
  async reinforce(clauseId: string, amount: number = 0.05): Promise<number> {
    const clause = this.db.get<ClauseRow>(
      'SELECT * FROM clauses WHERE id = ?',
      [clauseId]
    );

    if (!clause) {
      throw new Error(`Clause not found: ${clauseId}`);
    }

    const newConfidence = Math.min(1.0, clause.confidence + amount);

    this.db.run(
      `UPDATE clauses
       SET confidence = ?,
           reinforcement_count = reinforcement_count + 1,
           last_accessed = datetime('now'),
           access_count = access_count + 1
       WHERE id = ?`,
      [newConfidence, clauseId]
    );

    // Log the reinforcement
    this.logDecay(clauseId, clause.confidence, newConfidence, 'reinforcement');

    return newConfidence;
  }

  /**
   * Manually adjust confidence for a clause
   */
  async adjustConfidence(
    clauseId: string,
    newConfidence: number,
    reason: string = 'manual_adjustment'
  ): Promise<void> {
    const clause = this.db.get<ClauseRow>(
      'SELECT * FROM clauses WHERE id = ?',
      [clauseId]
    );

    if (!clause) {
      throw new Error(`Clause not found: ${clauseId}`);
    }

    // Clamp confidence to valid range
    const clamped = Math.max(0, Math.min(1, newConfidence));

    this.db.run(
      'UPDATE clauses SET confidence = ? WHERE id = ?',
      [clamped, clauseId]
    );

    this.logDecay(clauseId, clause.confidence, clamped, reason);

    // Archive if below threshold
    if (clamped < this.config.minConfidence) {
      await this.archiveClause(clauseId, clamped);
    }
  }

  /**
   * Get decay history for a clause
   */
  async getDecayHistory(clauseId: string): Promise<
    Array<{
      previousConfidence: number;
      newConfidence: number;
      reason: string;
      occurredAt: string;
    }>
  > {
    const rows = this.db.all<{
      previous_confidence: number;
      new_confidence: number;
      reason: string;
      occurred_at: string;
    }>(
      `SELECT previous_confidence, new_confidence, reason, occurred_at
       FROM decay_log
       WHERE clause_id = ?
       ORDER BY occurred_at DESC
       LIMIT 100`,
      [clauseId]
    );

    return rows.map((row) => ({
      previousConfidence: row.previous_confidence,
      newConfidence: row.new_confidence,
      reason: row.reason,
      occurredAt: row.occurred_at,
    }));
  }

  /**
   * Get decay statistics
   */
  async getStats(): Promise<{
    totalDecayEvents: number;
    totalArchived: number;
    avgDecayRate: number;
    mostDecayed: Array<{ clauseId: string; totalDecay: number }>;
  }> {
    const totalDecayRow = this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM decay_log WHERE reason = 'scheduled_decay'`
    );

    const totalArchivedRow = this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM clauses WHERE valid_to IS NOT NULL`
    );

    const avgDecayRateRow = this.db.get<{ avg: number }>(
      `SELECT AVG(decay_rate) as avg FROM clauses WHERE valid_to IS NULL`
    );

    const mostDecayed = this.db.all<{ clause_id: string; total_decay: number }>(
      `SELECT clause_id, SUM(previous_confidence - new_confidence) as total_decay
       FROM decay_log
       WHERE reason = 'scheduled_decay'
       GROUP BY clause_id
       ORDER BY total_decay DESC
       LIMIT 10`
    );

    return {
      totalDecayEvents: totalDecayRow?.count ?? 0,
      totalArchived: totalArchivedRow?.count ?? 0,
      avgDecayRate: avgDecayRateRow?.avg ?? 0,
      mostDecayed: mostDecayed.map((row) => ({
        clauseId: row.clause_id,
        totalDecay: row.total_decay,
      })),
    };
  }

  /**
   * Estimate when a clause will reach min confidence
   */
  estimateExpirationDays(clause: {
    confidence: number;
    decayRate: number;
    reinforcementCount: number;
  }): number | null {
    if (clause.confidence <= this.config.minConfidence) {
      return 0;
    }

    const effectiveRate =
      clause.decayRate / (1 + Math.log(clause.reinforcementCount + 1));

    if (effectiveRate <= 0) {
      return null; // Will never decay
    }

    // Solve for days: minConfidence = confidence * (1 - rate * days/30)
    // days = 30 * (confidence - minConfidence) / (confidence * rate)
    const days =
      (30 * (clause.confidence - this.config.minConfidence)) /
      (clause.confidence * effectiveRate);

    return Math.ceil(days);
  }

  // ========== Private Methods ==========

  /**
   * Archive a clause (mark as no longer valid)
   */
  private async archiveClause(
    clauseId: string,
    finalConfidence: number
  ): Promise<void> {
    this.db.run(
      `UPDATE clauses
       SET valid_to = datetime('now'),
           confidence = ?,
           metadata = json_set(metadata, '$.archived_reason', 'confidence_decay')
       WHERE id = ?`,
      [finalConfidence, clauseId]
    );

    // Get old confidence for logging
    const clause = this.db.get<{ confidence: number }>(
      'SELECT confidence FROM clauses WHERE id = ?',
      [clauseId]
    );

    if (clause) {
      this.logDecay(
        clauseId,
        clause.confidence,
        finalConfidence,
        'archived_decay'
      );
    }
  }

  /**
   * Apply decay to a clause
   */
  private async applyDecay(
    clauseId: string,
    oldConfidence: number,
    newConfidence: number
  ): Promise<void> {
    this.db.run(
      'UPDATE clauses SET confidence = ? WHERE id = ?',
      [newConfidence, clauseId]
    );

    this.logDecay(clauseId, oldConfidence, newConfidence, 'scheduled_decay');
  }

  /**
   * Log a decay event
   */
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
}
