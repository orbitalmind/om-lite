/**
 * Backup module - Database backup and restore functionality
 * Supports scheduled backups with retention policies
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { DatabaseManager } from './database.js';

// ========== Types ==========

export interface BackupConfig {
  /** Directory to store backups */
  backupDir: string;
  /** Number of daily backups to keep */
  dailyRetention: number;
  /** Number of weekly backups to keep */
  weeklyRetention: number;
  /** Enable automatic backup scheduling */
  autoBackup: boolean;
  /** Backup interval in hours (for auto backup) */
  intervalHours: number;
}

export interface BackupInfo {
  path: string;
  filename: string;
  timestamp: Date;
  sizeBytes: number;
  type: 'daily' | 'weekly' | 'manual';
}

export interface BackupResult {
  success: boolean;
  path?: string;
  sizeBytes?: number;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  clausesRestored?: number;
  error?: string;
}

const DEFAULT_CONFIG: BackupConfig = {
  backupDir: '~/.om-lite/backups',
  dailyRetention: 7,
  weeklyRetention: 4,
  autoBackup: false,
  intervalHours: 24,
};

// ========== Backup Manager ==========

export class BackupManager {
  private db: DatabaseManager;
  private config: BackupConfig;
  private backupDir: string;
  private autoBackupTimer: NodeJS.Timeout | null = null;

  constructor(db: DatabaseManager, config: Partial<BackupConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.backupDir = this.config.backupDir.replace(/^~/, homedir());
  }

  /**
   * Initialize backup system
   */
  async init(): Promise<void> {
    // Ensure backup directory exists
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }

    // Start auto backup if enabled
    if (this.config.autoBackup) {
      this.startAutoBackup();
    }
  }

  /**
   * Create a backup of the database
   */
  async backup(options: {
    type?: 'daily' | 'weekly' | 'manual';
    customPath?: string;
  } = {}): Promise<BackupResult> {
    const { type = 'manual', customPath } = options;

    try {
      // Generate backup filename
      const timestamp = new Date();
      const dateStr = timestamp.toISOString().split('T')[0];
      const timeStr = timestamp.toISOString().split('T')[1].replace(/:/g, '-').split('.')[0];
      const filename = `om-lite_${type}_${dateStr}_${timeStr}.db`;

      const backupPath = customPath ?? join(this.backupDir, filename);

      // Ensure directory exists
      const dir = dirname(backupPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Perform backup using SQLite's backup API
      await this.db.backup(backupPath);

      // Get backup size
      const stats = statSync(backupPath);

      // Update last backup metadata
      this.db.setMetadata('last_backup', timestamp.toISOString());
      this.db.setMetadata('last_backup_path', backupPath);

      // Apply retention policy
      await this.applyRetentionPolicy();

      return {
        success: true,
        path: backupPath,
        sizeBytes: stats.size,
      };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Restore from a backup file
   */
  async restore(backupPath: string): Promise<RestoreResult> {
    const resolvedPath = backupPath.replace(/^~/, homedir());

    // Validate backup file exists
    if (!existsSync(resolvedPath)) {
      return {
        success: false,
        error: `Backup file not found: ${resolvedPath}`,
      };
    }

    try {
      // Get current database path
      const dbPath = this.db.getMetadata('db_path') ?? this.db['dbPath'];

      // Close current database connection
      await this.db.close();

      // Create a backup of current state before restore
      const currentBackupPath = dbPath + '.pre-restore';
      if (existsSync(dbPath)) {
        copyFileSync(dbPath, currentBackupPath);
      }

      // Copy backup to database location
      copyFileSync(resolvedPath, dbPath);

      // Reinitialize database
      await this.db.init();

      // Count restored clauses
      const countResult = this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM clauses'
      );

      // Update metadata
      this.db.setMetadata('last_restore', new Date().toISOString());
      this.db.setMetadata('restored_from', resolvedPath);

      return {
        success: true,
        clausesRestored: countResult?.count ?? 0,
      };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * List available backups
   */
  async listBackups(): Promise<BackupInfo[]> {
    if (!existsSync(this.backupDir)) {
      return [];
    }

    const files = readdirSync(this.backupDir);
    const backups: BackupInfo[] = [];

    for (const file of files) {
      if (!file.startsWith('om-lite_') || !file.endsWith('.db')) {
        continue;
      }

      const filePath = join(this.backupDir, file);
      const stats = statSync(filePath);

      // Parse backup type and timestamp from filename
      // Format: om-lite_{type}_{date}_{time}.db
      const match = file.match(/om-lite_(daily|weekly|manual)_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.db/);

      let type: 'daily' | 'weekly' | 'manual' = 'manual';
      let timestamp = stats.mtime;

      if (match) {
        type = match[1] as 'daily' | 'weekly' | 'manual';
        const dateStr = match[2];
        const timeStr = match[3].replace(/-/g, ':');
        timestamp = new Date(`${dateStr}T${timeStr}Z`);
      }

      backups.push({
        path: filePath,
        filename: file,
        timestamp,
        sizeBytes: stats.size,
        type,
      });
    }

    // Sort by timestamp, newest first
    return backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get the most recent backup
   */
  async getLatestBackup(): Promise<BackupInfo | null> {
    const backups = await this.listBackups();
    return backups.length > 0 ? backups[0] : null;
  }

  /**
   * Delete a specific backup
   */
  async deleteBackup(backupPath: string): Promise<boolean> {
    const resolvedPath = backupPath.replace(/^~/, homedir());

    if (!existsSync(resolvedPath)) {
      return false;
    }

    try {
      unlinkSync(resolvedPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply retention policy - delete old backups
   */
  private async applyRetentionPolicy(): Promise<void> {
    const backups = await this.listBackups();

    // Separate by type
    const dailyBackups = backups.filter((b) => b.type === 'daily');
    const weeklyBackups = backups.filter((b) => b.type === 'weekly');
    // Note: Manual backups are not automatically deleted (no retention policy)

    // Keep only the most recent N daily backups
    for (const backup of dailyBackups.slice(this.config.dailyRetention)) {
      await this.deleteBackup(backup.path);
    }

    // Keep only the most recent N weekly backups
    for (const backup of weeklyBackups.slice(this.config.weeklyRetention)) {
      await this.deleteBackup(backup.path);
    }

    // Manual backups are not automatically deleted
    // But we could add a manual retention policy if needed
  }

  /**
   * Start automatic backup scheduling
   */
  startAutoBackup(): void {
    if (this.autoBackupTimer) {
      clearInterval(this.autoBackupTimer);
    }

    const intervalMs = this.config.intervalHours * 60 * 60 * 1000;

    this.autoBackupTimer = setInterval(async () => {
      const now = new Date();
      const dayOfWeek = now.getDay();

      // Weekly backup on Sundays, daily otherwise
      const type = dayOfWeek === 0 ? 'weekly' : 'daily';

      await this.backup({ type });
    }, intervalMs);

    // Perform initial backup
    this.backup({ type: 'daily' }).catch(console.error);
  }

  /**
   * Stop automatic backup scheduling
   */
  stopAutoBackup(): void {
    if (this.autoBackupTimer) {
      clearInterval(this.autoBackupTimer);
      this.autoBackupTimer = null;
    }
  }

  /**
   * Check if a backup is needed based on last backup time
   */
  async shouldBackup(): Promise<boolean> {
    const lastBackup = this.db.getMetadata('last_backup');

    if (!lastBackup) {
      return true;
    }

    const lastBackupTime = new Date(lastBackup).getTime();
    const now = Date.now();
    const hoursSinceBackup = (now - lastBackupTime) / (1000 * 60 * 60);

    return hoursSinceBackup >= this.config.intervalHours;
  }

  /**
   * Get backup statistics
   */
  async getStats(): Promise<{
    totalBackups: number;
    totalSizeBytes: number;
    oldestBackup: Date | null;
    newestBackup: Date | null;
    lastBackup: string | null;
    byType: Record<string, number>;
  }> {
    const backups = await this.listBackups();

    const byType: Record<string, number> = {
      daily: 0,
      weekly: 0,
      manual: 0,
    };

    let totalSizeBytes = 0;

    for (const backup of backups) {
      totalSizeBytes += backup.sizeBytes;
      byType[backup.type]++;
    }

    return {
      totalBackups: backups.length,
      totalSizeBytes,
      oldestBackup: backups.length > 0 ? backups[backups.length - 1].timestamp : null,
      newestBackup: backups.length > 0 ? backups[0].timestamp : null,
      lastBackup: this.db.getMetadata('last_backup'),
      byType,
    };
  }

  /**
   * Validate a backup file
   */
  async validateBackup(backupPath: string): Promise<{
    valid: boolean;
    clauseCount?: number;
    schemaVersion?: string;
    error?: string;
  }> {
    const resolvedPath = backupPath.replace(/^~/, homedir());

    if (!existsSync(resolvedPath)) {
      return { valid: false, error: 'File not found' };
    }

    try {
      // Open the backup database read-only
      const Database = (await import('better-sqlite3')).default;
      const backupDb = new Database(resolvedPath, { readonly: true });

      // Check for required tables
      const tables = backupDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;

      const requiredTables = ['clauses', 'sources', 'conflicts'];
      const missingTables = requiredTables.filter(
        (t) => !tables.some((row) => row.name === t)
      );

      if (missingTables.length > 0) {
        backupDb.close();
        return {
          valid: false,
          error: `Missing required tables: ${missingTables.join(', ')}`,
        };
      }

      // Count clauses
      const countResult = backupDb
        .prepare('SELECT COUNT(*) as count FROM clauses')
        .get() as { count: number };

      // Get schema version
      const versionResult = backupDb
        .prepare("SELECT value FROM system_metadata WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;

      backupDb.close();

      return {
        valid: true,
        clauseCount: countResult.count,
        schemaVersion: versionResult?.value ?? 'unknown',
      };
    } catch (error) {
      return {
        valid: false,
        error: `Failed to validate backup: ${error}`,
      };
    }
  }

  /**
   * Export backup configuration
   */
  getConfig(): BackupConfig {
    return { ...this.config };
  }

  /**
   * Update backup configuration
   */
  setConfig(config: Partial<BackupConfig>): void {
    this.config = { ...this.config, ...config };
    this.backupDir = this.config.backupDir.replace(/^~/, homedir());

    // Restart auto backup if settings changed
    if (this.autoBackupTimer && config.intervalHours !== undefined) {
      this.stopAutoBackup();
      if (this.config.autoBackup) {
        this.startAutoBackup();
      }
    }
  }

  /**
   * Clean up resources
   */
  async close(): Promise<void> {
    this.stopAutoBackup();
  }
}
