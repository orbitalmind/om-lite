/**
 * Scheduler module - Automated task scheduling for OM-Lite
 * Handles scheduled decay, backup, and retention jobs
 */

import type { DecayRunner } from './decay.js';
import type { BackupManager } from './backup.js';
import type { ClauseStore } from './clauses.js';

export interface SchedulerConfig {
  /** Enable decay scheduling */
  decayEnabled: boolean;
  /** Decay interval in hours (default: 24) */
  decayIntervalHours: number;
  /** Hour of day to run decay (0-23, default: 3 for 3 AM) */
  decayHour: number;

  /** Enable backup scheduling */
  backupEnabled: boolean;
  /** Backup interval in hours (default: 24) */
  backupIntervalHours: number;

  /** Enable retention enforcement */
  retentionEnabled: boolean;
  /** Retention check interval in hours (default: 24) */
  retentionIntervalHours: number;
  /** Days to retain source files */
  retentionDays: number;
}

export interface ScheduledJob {
  id: string;
  name: string;
  lastRun: Date | null;
  nextRun: Date;
  intervalMs: number;
  enabled: boolean;
}

export interface SchedulerStats {
  jobs: ScheduledJob[];
  isRunning: boolean;
  uptime: number;
}

/**
 * OM-Lite Scheduler - manages automated maintenance tasks
 */
export class Scheduler {
  private config: SchedulerConfig;
  private decayRunner?: DecayRunner;
  private backupManager?: BackupManager;
  private clauseStore?: ClauseStore;

  private decayTimer?: ReturnType<typeof setInterval>;
  private backupTimer?: ReturnType<typeof setInterval>;
  private retentionTimer?: ReturnType<typeof setInterval>;

  private jobs: Map<string, ScheduledJob> = new Map();
  private isRunning = false;
  private startTime?: Date;

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = {
      decayEnabled: config.decayEnabled ?? true,
      decayIntervalHours: config.decayIntervalHours ?? 24,
      decayHour: config.decayHour ?? 3,
      backupEnabled: config.backupEnabled ?? true,
      backupIntervalHours: config.backupIntervalHours ?? 24,
      retentionEnabled: config.retentionEnabled ?? true,
      retentionIntervalHours: config.retentionIntervalHours ?? 24,
      retentionDays: config.retentionDays ?? 90,
    };
  }

  /**
   * Set the decay runner
   */
  setDecayRunner(runner: DecayRunner): void {
    this.decayRunner = runner;
  }

  /**
   * Set the backup manager
   */
  setBackupManager(manager: BackupManager): void {
    this.backupManager = manager;
  }

  /**
   * Set the clause store (for retention)
   */
  setClauseStore(store: ClauseStore): void {
    this.clauseStore = store;
  }

  /**
   * Start all scheduled jobs
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.startTime = new Date();

    // Schedule decay job
    if (this.config.decayEnabled && this.decayRunner) {
      const intervalMs = this.config.decayIntervalHours * 60 * 60 * 1000;
      const nextRun = this.calculateNextRun(this.config.decayHour);

      this.jobs.set('decay', {
        id: 'decay',
        name: 'Confidence Decay',
        lastRun: null,
        nextRun,
        intervalMs,
        enabled: true,
      });

      // Calculate delay until first run
      const delayMs = nextRun.getTime() - Date.now();

      // Schedule first run
      setTimeout(() => {
        this.runDecayJob();
        // Then run at regular intervals
        this.decayTimer = setInterval(() => this.runDecayJob(), intervalMs);
      }, Math.max(0, delayMs));
    }

    // Schedule backup job
    if (this.config.backupEnabled && this.backupManager) {
      const intervalMs = this.config.backupIntervalHours * 60 * 60 * 1000;
      const nextRun = new Date(Date.now() + intervalMs);

      this.jobs.set('backup', {
        id: 'backup',
        name: 'Database Backup',
        lastRun: null,
        nextRun,
        intervalMs,
        enabled: true,
      });

      this.backupTimer = setInterval(() => this.runBackupJob(), intervalMs);
    }

    // Schedule retention job
    if (this.config.retentionEnabled && this.clauseStore) {
      const intervalMs = this.config.retentionIntervalHours * 60 * 60 * 1000;
      const nextRun = new Date(Date.now() + intervalMs);

      this.jobs.set('retention', {
        id: 'retention',
        name: 'Source Retention',
        lastRun: null,
        nextRun,
        intervalMs,
        enabled: true,
      });

      this.retentionTimer = setInterval(() => this.runRetentionJob(), intervalMs);
    }
  }

  /**
   * Stop all scheduled jobs
   */
  stop(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = undefined;
    }

    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = undefined;
    }

    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
    }

    this.isRunning = false;
    this.jobs.clear();
  }

  /**
   * Run decay job immediately
   */
  async runDecayJob(): Promise<void> {
    if (!this.decayRunner) return;

    try {
      const report = await this.decayRunner.run();
      this.updateJobStatus('decay', true);
      console.log(
        `[Scheduler] Decay completed: ${report.decayed} decayed, ${report.archived} archived`
      );
    } catch (error) {
      console.error('[Scheduler] Decay job failed:', error);
    }
  }

  /**
   * Run backup job immediately
   */
  async runBackupJob(): Promise<void> {
    if (!this.backupManager) return;

    try {
      const result = await this.backupManager.backup({ type: 'daily' });
      this.updateJobStatus('backup', true);
      console.log(`[Scheduler] Backup completed: ${result.path}`);
    } catch (error) {
      console.error('[Scheduler] Backup job failed:', error);
    }
  }

  /**
   * Run retention job immediately
   */
  async runRetentionJob(): Promise<void> {
    if (!this.clauseStore) return;

    try {
      const result = await this.clauseStore.enforceRetention(this.config.retentionDays);
      this.updateJobStatus('retention', true);
      console.log(`[Scheduler] Retention completed: ${result.deleted} sources archived`);
    } catch (error) {
      console.error('[Scheduler] Retention job failed:', error);
    }
  }

  /**
   * Get scheduler statistics
   */
  getStats(): SchedulerStats {
    const uptimeMs = this.startTime ? Date.now() - this.startTime.getTime() : 0;

    return {
      jobs: [...this.jobs.values()],
      isRunning: this.isRunning,
      uptime: uptimeMs,
    };
  }

  /**
   * Calculate next run time for a job at specific hour
   */
  private calculateNextRun(targetHour: number): Date {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(targetHour, 0, 0, 0);

    // If target hour has passed today, schedule for tomorrow
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }

    return nextRun;
  }

  /**
   * Update job status after execution
   */
  private updateJobStatus(jobId: string, _success: boolean): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const now = new Date();
    job.lastRun = now;
    job.nextRun = new Date(now.getTime() + job.intervalMs);
  }
}

/**
 * Create cron-like schedule string for external schedulers
 */
export function generateCronSchedule(config: SchedulerConfig): {
  decay: string;
  backup: string;
  retention: string;
} {
  return {
    decay: `0 ${config.decayHour} */${Math.max(1, Math.floor(config.decayIntervalHours / 24))} * *`,
    backup: `0 ${(config.decayHour + 2) % 24} */${Math.max(1, Math.floor(config.backupIntervalHours / 24))} * *`,
    retention: `0 ${(config.decayHour + 4) % 24} * * 0`, // Weekly on Sunday
  };
}
