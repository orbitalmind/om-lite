/**
 * Knowledge Pack Loader - Load and manage knowledge packs
 * Parses PACK.yaml and .claims files, loads claims into OM-Lite
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import type { DatabaseManager } from '../core/database.js';
import type { ClauseStore } from '../core/clauses.js';
import type {
  PackMetadata,
  PackLoadOptions,
  PackLoadReport,
  InstalledPack,
  ClauseType,
  ClauseInput,
} from '../core/types.js';

interface ClaimEntry {
  type: ClauseType;
  subject: string;
  predicate: string;
  object: string;
  natural_form: string;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  regions?: string[];
}

interface ClaimsFile {
  claims: ClaimEntry[];
}

interface PackYaml {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  enhances_skills?: string[];
  regions?: string[];
  claim_files: string[];
  stats?: {
    total_claims: number;
    by_type: Record<string, number>;
  };
  update_schedule?: string;
  last_updated: string;
  requires_packs?: string[];
  tags?: string[];
}

export class PackLoader {
  private db: DatabaseManager;
  private clauseStore: ClauseStore;
  private packsDir: string;

  constructor(db: DatabaseManager, clauseStore: ClauseStore, packsDir?: string) {
    this.db = db;
    this.clauseStore = clauseStore;

    // Default packs directory is relative to this package
    if (packsDir) {
      this.packsDir = packsDir;
    } else {
      // Find the packs directory relative to the package
      const currentDir = dirname(fileURLToPath(import.meta.url));
      // Go up to package root and into packs
      this.packsDir = resolve(currentDir, '..', '..', 'packs');
    }
  }

  /**
   * List installed packs from database
   */
  async listInstalled(): Promise<InstalledPack[]> {
    const rows = this.db.all<{
      pack_id: string;
      version: string;
      installed_at: string;
      claims_loaded: number;
      last_updated: string | null;
      metadata: string;
    }>('SELECT * FROM installed_packs ORDER BY installed_at DESC');

    return rows.map((row) => ({
      pack_id: row.pack_id,
      version: row.version,
      installed_at: row.installed_at,
      claims_loaded: row.claims_loaded,
      last_updated: row.last_updated,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  /**
   * List available packs in the packs directory
   */
  async listAvailable(): Promise<PackMetadata[]> {
    const packs: PackMetadata[] = [];

    if (!existsSync(this.packsDir)) {
      return packs;
    }

    const entries = readdirSync(this.packsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const packPath = join(this.packsDir, entry.name);
      const packYamlPath = join(packPath, 'PACK.yaml');

      if (existsSync(packYamlPath)) {
        try {
          const metadata = await this.loadPackMetadata(packPath);
          packs.push(metadata);
        } catch (error) {
          console.warn(`Failed to load pack metadata for ${entry.name}:`, error);
        }
      }
    }

    return packs;
  }

  /**
   * Install a knowledge pack
   */
  async install(
    packId: string,
    options: PackLoadOptions = {}
  ): Promise<PackLoadReport> {
    const {
      regions,
      skillFilter,
      confidenceFloor = 0.5,
      overwriteExisting = false,
    } = options;

    // Find pack directory
    const packPath = join(this.packsDir, packId);

    if (!existsSync(packPath)) {
      throw new Error(`Pack not found: ${packId}`);
    }

    // Load pack metadata
    const metadata = await this.loadPackMetadata(packPath);

    // Check skill filter - if specified, only install if pack enhances those skills
    if (skillFilter && skillFilter.length > 0) {
      const enhancedSkills = metadata.enhances_skills ?? [];
      const hasMatchingSkill = skillFilter.some(skill => enhancedSkills.includes(skill));
      if (!hasMatchingSkill) {
        throw new Error(`Pack ${packId} does not enhance any of the specified skills: ${skillFilter.join(', ')}`);
      }
    }

    // Check if already installed
    const existing = this.db.get<{ pack_id: string }>(
      'SELECT pack_id FROM installed_packs WHERE pack_id = ?',
      [packId]
    );

    if (existing && !overwriteExisting) {
      throw new Error(`Pack already installed: ${packId}. Use overwriteExisting option to update.`);
    }

    // If overwriting, remove existing claims first
    if (existing && overwriteExisting) {
      await this.remove(packId);
    }

    // Create source for this pack
    const sourceId = await this.clauseStore.createSource({
      type: 'knowledge_pack',
      content: JSON.stringify(metadata),
      channel: `pack:${packId}`,
      metadata: {
        pack_id: packId,
        pack_version: metadata.version,
      },
    });

    const report: PackLoadReport = {
      packId,
      version: metadata.version,
      loaded: 0,
      skipped: 0,
      conflicts: 0,
      timestamp: new Date().toISOString(),
    };

    // Load each claims file
    for (const claimFile of metadata.claim_files) {
      const claimFilePath = join(packPath, claimFile);

      if (!existsSync(claimFilePath)) {
        console.warn(`Claims file not found: ${claimFilePath}`);
        continue;
      }

      const claims = await this.loadClaimsFile(claimFilePath);

      for (const claim of claims) {
        // Apply region filter
        if (regions && regions.length > 0) {
          const claimRegions = claim.regions ?? metadata.regions ?? ['global'];
          const hasMatch = claimRegions.some(
            (r) => regions.includes(r) || r === 'global'
          );
          if (!hasMatch) {
            report.skipped++;
            continue;
          }
        }

        // Apply confidence floor
        const confidence = claim.confidence ?? 0.9;
        if (confidence < confidenceFloor) {
          report.skipped++;
          continue;
        }

        // Convert to ClauseInput
        const clauseInput: ClauseInput & { source_id: string; extraction_method: string } = {
          type: claim.type,
          subject: claim.subject,
          predicate: claim.predicate,
          object: claim.object,
          natural_form: claim.natural_form,
          confidence,
          decay_rate: 0.0001, // Pack claims decay very slowly
          tags: [...(claim.tags ?? []), `pack:${packId}`],
          metadata: {
            ...claim.metadata,
            pack_id: packId,
            pack_version: metadata.version,
          },
          source_id: sourceId,
          extraction_method: 'knowledge_pack',
        };

        // Process the clause
        try {
          const result = await this.clauseStore.processNewClause(clauseInput);
          if (result.action === 'insert' || result.action === 'superseded') {
            report.loaded++;
          } else if (result.action === 'conflict') {
            report.conflicts++;
          } else {
            report.skipped++;
          }
        } catch (error) {
          console.warn(`Failed to load claim:`, error);
          report.skipped++;
        }
      }
    }

    // Record installation
    this.db.run(
      `INSERT OR REPLACE INTO installed_packs (pack_id, version, installed_at, claims_loaded, last_updated, metadata)
       VALUES (?, ?, datetime('now'), ?, NULL, ?)`,
      [packId, metadata.version, report.loaded, JSON.stringify(metadata)]
    );

    return report;
  }

  /**
   * Update an installed pack
   */
  async update(packId?: string): Promise<PackLoadReport[]> {
    const reports: PackLoadReport[] = [];
    const installed = await this.listInstalled();
    const toUpdate = packId
      ? installed.filter((p) => p.pack_id === packId)
      : installed;

    for (const pack of toUpdate) {
      try {
        const report = await this.install(pack.pack_id, { overwriteExisting: true });
        reports.push(report);
      } catch (error) {
        console.error(`Failed to update pack ${pack.pack_id}:`, error);
      }
    }

    return reports;
  }

  /**
   * Remove an installed pack
   */
  async remove(packId: string): Promise<void> {
    // Delete all clauses from this pack
    this.db.run(
      `DELETE FROM clauses WHERE tags LIKE ?`,
      [`%"pack:${packId}"%`]
    );

    // Remove from installed packs
    this.db.run('DELETE FROM installed_packs WHERE pack_id = ?', [packId]);
  }

  /**
   * Validate a pack structure
   */
  async validate(packPath: string): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check PACK.yaml exists
    const packYamlPath = join(packPath, 'PACK.yaml');
    if (!existsSync(packYamlPath)) {
      errors.push('Missing PACK.yaml');
      return { valid: false, errors, warnings };
    }

    // Parse PACK.yaml
    let packYaml: PackYaml;
    try {
      const content = readFileSync(packYamlPath, 'utf-8');
      packYaml = YAML.parse(content) as PackYaml;
    } catch (error) {
      errors.push(`Invalid PACK.yaml: ${error}`);
      return { valid: false, errors, warnings };
    }

    // Validate required fields
    if (!packYaml.name) errors.push('Missing required field: name');
    if (!packYaml.version) errors.push('Missing required field: version');
    if (!packYaml.claim_files || packYaml.claim_files.length === 0) {
      errors.push('Missing required field: claim_files');
    }

    // Validate claim files exist
    let totalClaims = 0;
    for (const claimFile of packYaml.claim_files ?? []) {
      const claimFilePath = join(packPath, claimFile);
      if (!existsSync(claimFilePath)) {
        errors.push(`Claims file not found: ${claimFile}`);
      } else {
        // Try to parse claims file
        try {
          const claims = await this.loadClaimsFile(claimFilePath);
          totalClaims += claims.length;

          // Validate each claim
          for (const claim of claims) {
            if (!claim.type) warnings.push(`Claim missing type: ${claim.natural_form?.slice(0, 50)}`);
            if (!claim.subject) warnings.push(`Claim missing subject: ${claim.natural_form?.slice(0, 50)}`);
            if (!claim.predicate) warnings.push(`Claim missing predicate: ${claim.natural_form?.slice(0, 50)}`);
            if (!claim.object) warnings.push(`Claim missing object: ${claim.natural_form?.slice(0, 50)}`);
            if (!claim.natural_form) warnings.push(`Claim missing natural_form`);
          }
        } catch (error) {
          errors.push(`Invalid claims file ${claimFile}: ${error}`);
        }
      }
    }

    // Check stats match
    if (packYaml.stats?.total_claims && packYaml.stats.total_claims !== totalClaims) {
      warnings.push(
        `Stats mismatch: PACK.yaml says ${packYaml.stats.total_claims} claims, found ${totalClaims}`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ========== Private Methods ==========

  /**
   * Load pack metadata from PACK.yaml
   */
  private async loadPackMetadata(packPath: string): Promise<PackMetadata> {
    const packYamlPath = join(packPath, 'PACK.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const packYaml = YAML.parse(content) as PackYaml;

    return {
      name: packYaml.name,
      version: packYaml.version,
      description: packYaml.description ?? '',
      author: packYaml.author ?? 'unknown',
      license: packYaml.license ?? 'unknown',
      enhances_skills: packYaml.enhances_skills,
      regions: packYaml.regions,
      claim_files: packYaml.claim_files,
      stats: packYaml.stats ?? {
        total_claims: 0,
        by_type: {} as Record<ClauseType, number>,
      },
      update_schedule: packYaml.update_schedule,
      last_updated: packYaml.last_updated,
      requires_packs: packYaml.requires_packs,
      tags: packYaml.tags,
    };
  }

  /**
   * Load claims from a .claims file
   */
  private async loadClaimsFile(filePath: string): Promise<ClaimEntry[]> {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = YAML.parse(content) as ClaimsFile;

    if (!parsed || !parsed.claims || !Array.isArray(parsed.claims)) {
      return [];
    }

    return parsed.claims.filter(
      (claim): claim is ClaimEntry =>
        claim !== null &&
        typeof claim === 'object' &&
        typeof claim.type === 'string' &&
        typeof claim.subject === 'string' &&
        typeof claim.predicate === 'string' &&
        typeof claim.object === 'string' &&
        typeof claim.natural_form === 'string'
    );
  }
}
