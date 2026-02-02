/**
 * Skill Bindings - Connect skills with memory preferences
 * Manages skill capability claims and preference bindings
 */

import { v7 as uuidv7 } from 'uuid';
import type { DatabaseManager } from '../core/database.js';
import type { ClauseStore } from '../core/clauses.js';
import type {
  Clause,
  ClauseInput,
  SkillMetadata,
  SkillCapability,
  SkillParameter,
  SkillPreferenceBinding,
} from '../core/types.js';

interface BindingRow {
  id: string;
  skill_id: string;
  parameter_name: string;
  clause_id: string;
  bound_at: string;
}

export class SkillBindings {
  private db: DatabaseManager;
  private clauseStore: ClauseStore;

  constructor(db: DatabaseManager, clauseStore: ClauseStore) {
    this.db = db;
    this.clauseStore = clauseStore;
  }

  /**
   * Handle skill installation - ingest capability claims
   */
  async onSkillInstall(
    skillId: string,
    metadata: SkillMetadata
  ): Promise<{ claimsCreated: number; bindings: SkillPreferenceBinding[] }> {
    let claimsCreated = 0;
    const bindings: SkillPreferenceBinding[] = [];

    // Create source for skill claims
    const sourceId = await this.clauseStore.createSource({
      type: 'manual',
      content: JSON.stringify(metadata),
      channel: `skill:${skillId}`,
      metadata: {
        skill_id: skillId,
        skill_version: metadata.version,
      },
    });

    // Create capability claims
    if (metadata.capabilities) {
      for (const capability of metadata.capabilities) {
        const clause = await this.createCapabilityClaim(
          skillId,
          metadata.version,
          capability,
          sourceId
        );
        if (clause) {
          claimsCreated++;
        }
      }
    }

    // Auto-bind preferences
    if (metadata.parameters) {
      const autoBindings = await this.autoBindPreferences(skillId);
      bindings.push(...autoBindings);
    }

    return { claimsCreated, bindings };
  }

  /**
   * Handle skill uninstallation - remove capability claims
   */
  async onSkillUninstall(skillId: string): Promise<void> {
    // Get all capability clauses for this skill
    const capabilities = this.db.all<{ clause_id: string }>(
      'SELECT clause_id FROM skill_capabilities WHERE skill_id = ?',
      [skillId]
    );

    // Invalidate the clauses
    for (const cap of capabilities) {
      await this.clauseStore.invalidate(cap.clause_id, `skill_uninstalled:${skillId}`);
    }

    // Remove from skill_capabilities table
    this.db.run('DELETE FROM skill_capabilities WHERE skill_id = ?', [skillId]);

    // Remove preference bindings
    this.db.run('DELETE FROM skill_preference_bindings WHERE skill_id = ?', [skillId]);
  }

  /**
   * Get capability claims for a skill
   */
  async getCapabilities(skillId: string): Promise<Clause[]> {
    const rows = this.db.all<{ clause_id: string }>(
      'SELECT clause_id FROM skill_capabilities WHERE skill_id = ?',
      [skillId]
    );

    const clauses: Clause[] = [];
    for (const row of rows) {
      const clause = await this.clauseStore.get(row.clause_id);
      if (clause && clause.valid_to === null) {
        clauses.push(clause);
      }
    }

    return clauses;
  }

  /**
   * Auto-bind preferences to skill parameters based on matching predicates
   */
  async autoBindPreferences(skillId: string): Promise<SkillPreferenceBinding[]> {
    const bindings: SkillPreferenceBinding[] = [];

    // Get skill parameters from stored metadata
    const skillCaps = this.db.all<{ clause_id: string }>(
      'SELECT clause_id FROM skill_capabilities WHERE skill_id = ? LIMIT 1',
      [skillId]
    );

    if (skillCaps.length === 0) {
      return bindings;
    }

    // Get the skill's metadata from the first capability clause
    const firstClause = await this.clauseStore.get(skillCaps[0].clause_id);
    if (!firstClause) {
      return bindings;
    }

    const skillMetadata = firstClause.metadata as { parameters?: SkillParameter[] };
    const parameters = skillMetadata?.parameters ?? [];

    for (const param of parameters) {
      if (param.type !== 'preference') continue;

      // Try to find a matching preference clause
      const matchingClause = await this.findMatchingPreference(param);

      if (matchingClause) {
        const binding = await this.bindPreference(
          skillId,
          param.name,
          matchingClause.id
        );
        if (binding) {
          bindings.push(binding);
        }
      }
    }

    return bindings;
  }

  /**
   * Manually bind a preference to a skill parameter
   */
  async bindPreference(
    skillId: string,
    parameterName: string,
    clauseId: string
  ): Promise<SkillPreferenceBinding | null> {
    // Verify clause exists and is valid
    const clause = await this.clauseStore.get(clauseId);
    if (!clause || clause.valid_to !== null) {
      return null;
    }

    const id = uuidv7();
    const now = new Date().toISOString();

    // Upsert binding
    this.db.run(
      `INSERT OR REPLACE INTO skill_preference_bindings (id, skill_id, parameter_name, clause_id, bound_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, skillId, parameterName, clauseId, now]
    );

    return {
      id,
      skill_id: skillId,
      parameter_name: parameterName,
      clause_id: clauseId,
      bound_at: now,
    };
  }

  /**
   * Unbind a preference from a skill parameter
   */
  async unbindPreference(skillId: string, parameterName: string): Promise<void> {
    this.db.run(
      'DELETE FROM skill_preference_bindings WHERE skill_id = ? AND parameter_name = ?',
      [skillId, parameterName]
    );
  }

  /**
   * Get all preference bindings for a skill
   */
  async getBindings(skillId: string): Promise<SkillPreferenceBinding[]> {
    const rows = this.db.all<BindingRow>(
      'SELECT * FROM skill_preference_bindings WHERE skill_id = ?',
      [skillId]
    );

    return rows.map((row) => ({
      id: row.id,
      skill_id: row.skill_id,
      parameter_name: row.parameter_name,
      clause_id: row.clause_id,
      bound_at: row.bound_at,
    }));
  }

  /**
   * Get preferences for skill execution (resolved values)
   */
  async getPreferencesForExecution(
    skillId: string
  ): Promise<Record<string, string>> {
    const bindings = await this.getBindings(skillId);
    const preferences: Record<string, string> = {};

    for (const binding of bindings) {
      const clause = await this.clauseStore.get(binding.clause_id);

      // Only include valid, high-confidence clauses
      if (clause && clause.valid_to === null && clause.confidence > 0.5) {
        preferences[binding.parameter_name] = clause.object;
      }
    }

    return preferences;
  }

  /**
   * Get all skills that have memory bindings
   */
  async getSkillsWithBindings(): Promise<string[]> {
    const rows = this.db.all<{ skill_id: string }>(
      'SELECT DISTINCT skill_id FROM skill_preference_bindings'
    );
    return rows.map((r) => r.skill_id);
  }

  /**
   * Get skills that can perform a specific action
   */
  async getSkillsForCapability(predicate: string, object?: string): Promise<string[]> {
    let sql = `
      SELECT DISTINCT sc.skill_id
      FROM skill_capabilities sc
      JOIN clauses c ON sc.clause_id = c.id
      WHERE c.predicate = ?
        AND c.valid_to IS NULL
        AND c.confidence > 0.5
    `;
    const params: unknown[] = [predicate];

    if (object) {
      sql += ' AND c.object = ?';
      params.push(object);
    }

    const rows = this.db.all<{ skill_id: string }>(sql, params);
    return rows.map((r) => r.skill_id);
  }

  // ========== Private Methods ==========

  /**
   * Create a capability claim for a skill
   */
  private async createCapabilityClaim(
    skillId: string,
    skillVersion: string,
    capability: SkillCapability,
    sourceId: string
  ): Promise<Clause | null> {
    const input: ClauseInput & { source_id: string; extraction_method: string } = {
      type: 'skill',
      subject: `skill:${skillId}`,
      predicate: capability.predicate,
      object: capability.object,
      natural_form: `${skillId} skill ${capability.predicate.replace(/_/g, ' ')} ${capability.object}`,
      confidence: capability.confidence,
      decay_rate: 0.0002, // Skills decay very slowly
      tags: [`skill:${skillId}`],
      metadata: {
        skill_id: skillId,
        skill_version: skillVersion,
        capability_type: capability.predicate,
      },
      source_id: sourceId,
      extraction_method: 'skill_registration',
    };

    const result = await this.clauseStore.processNewClause(input);

    if (result.clause) {
      // Record in skill_capabilities table
      this.db.run(
        `INSERT OR REPLACE INTO skill_capabilities (skill_id, skill_version, clause_id, capability_type)
         VALUES (?, ?, ?, ?)`,
        [skillId, skillVersion, result.clause.id, capability.predicate]
      );
      return result.clause;
    }

    return null;
  }

  /**
   * Find a preference clause that matches a skill parameter
   */
  private async findMatchingPreference(
    param: SkillParameter
  ): Promise<Clause | null> {
    // Map parameter names to likely predicates
    const predicateMap: Record<string, string[]> = {
      preferred_airline: ['prefers_airline', 'likes_airline', 'preferred_airline'],
      seat_preference: ['prefers_seat_type', 'seat_preference', 'prefers_seat'],
      preferred_language: ['prefers_language', 'preferred_language', 'speaks_language'],
      timezone: ['timezone', 'in_timezone', 'preferred_timezone'],
      currency: ['preferred_currency', 'uses_currency', 'currency'],
    };

    const predicatesToTry = predicateMap[param.name] ?? [
      param.name,
      `prefers_${param.name}`,
      `preferred_${param.name}`,
    ];

    for (const predicate of predicatesToTry) {
      const clauses = await this.clauseStore.search('', {
        types: ['preference'],
        minConfidence: 0.5,
        limit: 1,
      });

      // Look through clauses for matching predicate
      for (const clause of clauses) {
        if (clause.predicate === predicate && clause.subject === 'user') {
          return clause;
        }
      }
    }

    // Also try a text search
    const searchResults = await this.clauseStore.search(param.name, {
      types: ['preference'],
      minConfidence: 0.5,
      limit: 5,
    });

    if (searchResults.length > 0) {
      return searchResults[0];
    }

    return null;
  }
}
