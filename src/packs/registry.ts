/**
 * Pack Registry - Track and discover knowledge packs
 * Manages pack metadata, dependencies, and recommendations
 * Supports remote registry for pack discovery and download
 */

import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { pipeline } from 'stream/promises';
import type { DatabaseManager } from '../core/database.js';
import type { PackMetadata, InstalledPack } from '../core/types.js';

interface PackDependency {
  packId: string;
  required: boolean;
  minVersion?: string;
}

interface PackRecommendation {
  packId: string;
  reason: string;
  relevanceScore: number;
}

export interface RemotePackInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  downloadUrl: string;
  checksum?: string;
  tags?: string[];
  regions?: string[];
  enhances_skills?: string[];
  stats?: {
    total_claims: number;
    downloads?: number;
  };
  updated_at: string;
}

interface RegistryIndex {
  version: string;
  updated_at: string;
  packs: RemotePackInfo[];
}

export class PackRegistry {
  private db: DatabaseManager;
  private remoteRegistryUrl?: string;
  private cacheDir: string;
  private registryCache: RegistryIndex | null = null;
  private cacheTimestamp: number = 0;
  private cacheTTLMs: number = 3600000; // 1 hour

  constructor(db: DatabaseManager, remoteRegistryUrl?: string) {
    this.db = db;
    this.remoteRegistryUrl = remoteRegistryUrl ?? process.env.OM_LITE_REGISTRY_URL;
    this.cacheDir = join(homedir(), '.om-lite', 'cache', 'registry');

    // Ensure cache directory exists
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Get the configured remote registry URL
   */
  getRemoteRegistryUrl(): string | undefined {
    return this.remoteRegistryUrl;
  }

  /**
   * Set remote registry URL
   */
  setRemoteRegistryUrl(url: string): void {
    this.remoteRegistryUrl = url;
    this.registryCache = null; // Clear cache when URL changes
  }

  /**
   * Get pack metadata from database or remote registry
   */
  async getPackInfo(packId: string): Promise<PackMetadata | null> {
    // Check installed packs first
    const installed = this.db.get<{ metadata: string }>(
      'SELECT metadata FROM installed_packs WHERE pack_id = ?',
      [packId]
    );

    if (installed) {
      try {
        return JSON.parse(installed.metadata) as PackMetadata;
      } catch {
        return null;
      }
    }

    // Try remote registry if available
    if (this.remoteRegistryUrl) {
      const remotePack = await this.getRemotePackInfo(packId);
      if (remotePack) {
        return this.remoteToPackMetadata(remotePack);
      }
    }

    return null;
  }

  /**
   * List available packs from remote registry
   */
  async listAvailableRemote(): Promise<RemotePackInfo[]> {
    if (!this.remoteRegistryUrl) {
      return [];
    }

    const index = await this.fetchRegistryIndex();
    return index?.packs ?? [];
  }

  /**
   * Search remote packs
   */
  async searchRemote(query: string): Promise<RemotePackInfo[]> {
    const packs = await this.listAvailableRemote();
    const queryLower = query.toLowerCase();

    return packs.filter((pack) => {
      return (
        pack.name.toLowerCase().includes(queryLower) ||
        pack.description?.toLowerCase().includes(queryLower) ||
        pack.tags?.some((t) => t.toLowerCase().includes(queryLower)) ||
        pack.id.toLowerCase().includes(queryLower)
      );
    });
  }

  /**
   * Get specific pack info from remote registry
   */
  async getRemotePackInfo(packId: string): Promise<RemotePackInfo | null> {
    const packs = await this.listAvailableRemote();
    return packs.find((p) => p.id === packId) ?? null;
  }

  /**
   * Download a pack from remote registry
   */
  async downloadPack(packId: string, destDir?: string): Promise<string> {
    const packInfo = await this.getRemotePackInfo(packId);

    if (!packInfo) {
      throw new Error(`Pack not found in registry: ${packId}`);
    }

    const targetDir = destDir ?? join(this.cacheDir, 'packs', packId);

    // Ensure target directory exists
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Download pack archive
    const archivePath = join(targetDir, `${packId}.tar.gz`);

    try {
      const response = await fetch(packInfo.downloadUrl);

      if (!response.ok) {
        throw new Error(`Failed to download pack: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Empty response body');
      }

      // Write to file
      const fileStream = createWriteStream(archivePath);
      await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);

      // Extract the pack (simplified - assumes tar.gz)
      await this.extractPack(archivePath, targetDir);

      return targetDir;
    } catch (error) {
      throw new Error(`Failed to download pack ${packId}: ${error}`);
    }
  }

  /**
   * Check for pack updates
   */
  async checkForUpdates(): Promise<Array<{
    packId: string;
    installedVersion: string;
    availableVersion: string;
  }>> {
    const installed = this.db.all<{
      pack_id: string;
      version: string;
    }>('SELECT pack_id, version FROM installed_packs');

    const updates: Array<{
      packId: string;
      installedVersion: string;
      availableVersion: string;
    }> = [];

    for (const pack of installed) {
      const remotePack = await this.getRemotePackInfo(pack.pack_id);

      if (remotePack && this.isNewerVersion(remotePack.version, pack.version)) {
        updates.push({
          packId: pack.pack_id,
          installedVersion: pack.version,
          availableVersion: remotePack.version,
        });
      }
    }

    return updates;
  }

  /**
   * Fetch and cache the registry index
   */
  private async fetchRegistryIndex(): Promise<RegistryIndex | null> {
    if (!this.remoteRegistryUrl) {
      return null;
    }

    // Check cache
    const now = Date.now();
    if (this.registryCache && now - this.cacheTimestamp < this.cacheTTLMs) {
      return this.registryCache;
    }

    try {
      const indexUrl = `${this.remoteRegistryUrl}/index.json`;
      const response = await fetch(indexUrl);

      if (!response.ok) {
        console.warn(`Failed to fetch registry index: ${response.status}`);
        return this.registryCache; // Return stale cache on failure
      }

      const index = (await response.json()) as RegistryIndex;

      // Update cache
      this.registryCache = index;
      this.cacheTimestamp = now;

      // Save to disk cache
      const cachePath = join(this.cacheDir, 'index.json');
      writeFileSync(cachePath, JSON.stringify(index, null, 2));

      return index;
    } catch (error) {
      console.warn('Failed to fetch registry index:', error);

      // Try loading from disk cache
      const cachePath = join(this.cacheDir, 'index.json');
      if (existsSync(cachePath)) {
        try {
          const cached = require(cachePath);
          this.registryCache = cached;
          return cached;
        } catch {
          // Ignore cache read errors
        }
      }

      return null;
    }
  }

  /**
   * Convert remote pack info to PackMetadata
   */
  private remoteToPackMetadata(remote: RemotePackInfo): PackMetadata {
    return {
      name: remote.name,
      version: remote.version,
      description: remote.description,
      author: remote.author,
      license: 'unknown',
      enhances_skills: remote.enhances_skills,
      regions: remote.regions,
      claim_files: [], // Will be populated after download
      stats: {
        total_claims: remote.stats?.total_claims ?? 0,
        by_type: {} as Record<string, number>,
      },
      last_updated: remote.updated_at,
      tags: remote.tags,
    };
  }

  /**
   * Compare semantic versions (returns true if v1 > v2)
   */
  private isNewerVersion(v1: string, v2: string): boolean {
    const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
    const parts1 = parse(v1);
    const parts2 = parse(v2);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const a = parts1[i] ?? 0;
      const b = parts2[i] ?? 0;

      if (a > b) return true;
      if (a < b) return false;
    }

    return false;
  }

  /**
   * Extract a pack archive
   */
  private async extractPack(archivePath: string, destDir: string): Promise<void> {
    // Use tar to extract (requires tar command to be available)
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      await execAsync(`tar -xzf "${archivePath}" -C "${destDir}"`);
    } catch (error) {
      // Fallback: try unzipping (for .zip files)
      try {
        await execAsync(`unzip -o "${archivePath}" -d "${destDir}"`);
      } catch {
        throw new Error(`Failed to extract pack: ${error}`);
      }
    }
  }

  /**
   * Check if a pack is installed
   */
  async isInstalled(packId: string): Promise<boolean> {
    const row = this.db.get<{ pack_id: string }>(
      'SELECT pack_id FROM installed_packs WHERE pack_id = ?',
      [packId]
    );
    return row !== undefined;
  }

  /**
   * Get pack dependencies
   */
  async getDependencies(packId: string): Promise<PackDependency[]> {
    const metadata = await this.getPackInfo(packId);
    if (!metadata || !metadata.requires_packs) {
      return [];
    }

    return metadata.requires_packs.map((reqPack) => ({
      packId: reqPack,
      required: true,
    }));
  }

  /**
   * Check if all dependencies for a pack are satisfied
   */
  async checkDependencies(packId: string): Promise<{
    satisfied: boolean;
    missing: string[];
  }> {
    const deps = await this.getDependencies(packId);
    const missing: string[] = [];

    for (const dep of deps) {
      if (dep.required) {
        const installed = await this.isInstalled(dep.packId);
        if (!installed) {
          missing.push(dep.packId);
        }
      }
    }

    return {
      satisfied: missing.length === 0,
      missing,
    };
  }

  /**
   * Get recommended packs for a skill
   */
  async getRecommendationsForSkill(skillId: string): Promise<PackRecommendation[]> {
    // Query installed packs that enhance this skill
    const rows = this.db.all<{ pack_id: string; metadata: string }>(
      'SELECT pack_id, metadata FROM installed_packs'
    );

    const recommendations: PackRecommendation[] = [];

    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata) as PackMetadata;
        if (metadata.enhances_skills?.includes(skillId)) {
          recommendations.push({
            packId: row.pack_id,
            reason: `Enhances ${skillId} skill`,
            relevanceScore: 0.8,
          });
        }
      } catch {
        // Skip invalid metadata
      }
    }

    return recommendations;
  }

  /**
   * Get packs by tag
   */
  async getPacksByTag(tag: string): Promise<string[]> {
    const rows = this.db.all<{ pack_id: string; metadata: string }>(
      'SELECT pack_id, metadata FROM installed_packs'
    );

    const matchingPacks: string[] = [];

    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata) as PackMetadata;
        if (metadata.tags?.includes(tag)) {
          matchingPacks.push(row.pack_id);
        }
      } catch {
        // Skip invalid metadata
      }
    }

    return matchingPacks;
  }

  /**
   * Get all packs for a region
   */
  async getPacksByRegion(region: string): Promise<string[]> {
    const rows = this.db.all<{ pack_id: string; metadata: string }>(
      'SELECT pack_id, metadata FROM installed_packs'
    );

    const matchingPacks: string[] = [];

    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata) as PackMetadata;
        if (metadata.regions?.includes(region) || metadata.regions?.includes('global')) {
          matchingPacks.push(row.pack_id);
        }
      } catch {
        // Skip invalid metadata
      }
    }

    return matchingPacks;
  }

  /**
   * Get statistics about installed packs
   */
  async getStats(): Promise<{
    totalInstalled: number;
    totalClaims: number;
    packsByCategory: Record<string, number>;
  }> {
    const rows = this.db.all<{
      pack_id: string;
      claims_loaded: number;
      metadata: string;
    }>('SELECT pack_id, claims_loaded, metadata FROM installed_packs');

    const packsByCategory: Record<string, number> = {};
    let totalClaims = 0;

    for (const row of rows) {
      totalClaims += row.claims_loaded;

      try {
        const metadata = JSON.parse(row.metadata) as PackMetadata;
        for (const tag of metadata.tags ?? []) {
          packsByCategory[tag] = (packsByCategory[tag] ?? 0) + 1;
        }
      } catch {
        // Skip invalid metadata
      }
    }

    return {
      totalInstalled: rows.length,
      totalClaims,
      packsByCategory,
    };
  }

  /**
   * Search packs by query (searches name, description, tags)
   */
  async searchPacks(query: string): Promise<InstalledPack[]> {
    const queryLower = query.toLowerCase();
    const rows = this.db.all<{
      pack_id: string;
      version: string;
      installed_at: string;
      claims_loaded: number;
      last_updated: string | null;
      metadata: string;
    }>('SELECT * FROM installed_packs');

    const matches: InstalledPack[] = [];

    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata) as PackMetadata;

        const matchesQuery =
          metadata.name.toLowerCase().includes(queryLower) ||
          metadata.description?.toLowerCase().includes(queryLower) ||
          metadata.tags?.some((t) => t.toLowerCase().includes(queryLower));

        if (matchesQuery) {
          matches.push({
            pack_id: row.pack_id,
            version: row.version,
            installed_at: row.installed_at,
            claims_loaded: row.claims_loaded,
            last_updated: row.last_updated,
            metadata,
          });
        }
      } catch {
        // Skip packs with invalid metadata
      }
    }

    return matches;
  }
}
