/**
 * OM-Lite: Orbital Mind Lite
 * Structured, decay-aware external memory for OpenClaw agents
 *
 * @packageDocumentation
 */

export * from './core/types.js';
export * from './core/database.js';
export * from './core/clauses.js';
export * from './core/extraction.js';
export * from './core/retrieval.js';
export * from './core/decay.js';
export * from './core/embeddings.js';
export * from './core/sanitization.js';
export * from './core/migration.js';
export * from './core/backup.js';
export * from './packs/loader.js';
export * from './packs/registry.js';
export * from './skills/bindings.js';
export * from './skills/performance.js';
export * from './core/scheduler.js';

import { Database } from './core/database.js';
import { ClauseStore } from './core/clauses.js';
import { Extractor } from './core/extraction.js';
import { Retriever } from './core/retrieval.js';
import { DecayRunner } from './core/decay.js';
import { EmbeddingManager, type EmbeddingConfig } from './core/embeddings.js';
import { BackupManager, type BackupConfig } from './core/backup.js';
import { PackLoader } from './packs/loader.js';
import { PackRegistry } from './packs/registry.js';
import { SkillBindings } from './skills/bindings.js';
import { PerformanceTracker } from './skills/performance.js';
import type {
  OMLiteConfig,
  MemoryStats,
  ConflictResolutionConfig,
  DeduplicationConfig,
  ConflictResolutionStrategy,
  DecayReport,
  ClauseType,
} from './core/types.js';

// Extended configuration type
export interface OMLiteFullConfig extends OMLiteConfig {
  embedding?: EmbeddingConfig;
  backup?: Partial<BackupConfig>;
  remoteRegistryUrl?: string;
  useLLMQueryRewriting?: boolean;
}

/**
 * Main OM-Lite class - entry point for all memory operations
 */
export class OMLite {
  private db: Database;
  private clauseStore: ClauseStore;
  private extractor: Extractor;
  private retriever: Retriever;
  private decayRunner: DecayRunner;
  private embeddingManager: EmbeddingManager;
  private backupManager: BackupManager;
  private packLoader: PackLoader;
  private packRegistry: PackRegistry;
  private skillBindings: SkillBindings;
  private performanceTracker: PerformanceTracker;

  public readonly config: OMLiteFullConfig;

  constructor(config: Partial<OMLiteFullConfig> = {}) {
    this.config = {
      dbPath: config.dbPath ?? '~/.openclaw/memory/om-lite.db',
      embeddingModel: config.embeddingModel ?? 'text-embedding-3-small',
      extractionModel: config.extractionModel ?? 'claude-sonnet-4-20250514',
      decay: {
        enabled: config.decay?.enabled ?? true,
        defaultRate: config.decay?.defaultRate ?? 0.001,
        minConfidence: config.decay?.minConfidence ?? 0.1,
      },
      retrieval: {
        semanticWeight: config.retrieval?.semanticWeight ?? 0.6,
        keywordWeight: config.retrieval?.keywordWeight ?? 0.3,
        recencyWeight: config.retrieval?.recencyWeight ?? 0.1,
        defaultLimit: config.retrieval?.defaultLimit ?? 20,
      },
      conflictResolution: {
        strategy: config.conflictResolution?.strategy ?? 'merge_history',
        autoResolveThreshold: config.conflictResolution?.autoResolveThreshold ?? 0.2,
        preserveHistory: config.conflictResolution?.preserveHistory ?? true,
      },
      deduplication: {
        enabled: config.deduplication?.enabled ?? true,
        similarityThreshold: config.deduplication?.similarityThreshold ?? 0.85,
        useContentHash: config.deduplication?.useContentHash ?? true,
        useFuzzyMatch: config.deduplication?.useFuzzyMatch ?? true,
        onDuplicate: config.deduplication?.onDuplicate ?? 'reinforce',
      },
      embedding: config.embedding ?? { provider: 'local' },
      backup: config.backup,
      remoteRegistryUrl: config.remoteRegistryUrl,
      useLLMQueryRewriting: config.useLLMQueryRewriting ?? false,
    };

    // Initialize components
    this.db = new Database(this.config.dbPath);
    this.clauseStore = new ClauseStore(
      this.db,
      this.config.conflictResolution,
      this.config.deduplication
    );
    this.extractor = new Extractor(this.config.extractionModel);
    this.embeddingManager = new EmbeddingManager(this.db, this.config.embedding);
    this.retriever = new Retriever(
      this.db,
      {
        ...this.config.retrieval,
        useLLMQueryRewriting: this.config.useLLMQueryRewriting,
      },
      this.embeddingManager
    );
    this.decayRunner = new DecayRunner(this.db, this.config.decay);
    this.backupManager = new BackupManager(this.db, this.config.backup);
    this.packLoader = new PackLoader(this.db, this.clauseStore);
    this.packRegistry = new PackRegistry(this.db, this.config.remoteRegistryUrl);
    this.skillBindings = new SkillBindings(this.db, this.clauseStore);
    this.performanceTracker = new PerformanceTracker(this.db, this.clauseStore);
  }

  /**
   * Initialize the database and ensure schema exists
   */
  async init(): Promise<void> {
    await this.db.init();
    await this.embeddingManager.init();
    await this.backupManager.init();
  }

  /**
   * Extract clauses from content and store them
   */
  async extract(
    content: string,
    options: { sourceId?: string; context?: string } = {}
  ): Promise<{ clauses: Clause[]; conflicts: Conflict[] }> {
    const sourceId =
      options.sourceId ??
      (await this.clauseStore.createSource({
        type: 'conversation',
        content,
      }));

    const extracted = await this.extractor.extract(content, {
      sourceId,
      context: options.context,
    });

    const results = {
      clauses: [] as Clause[],
      conflicts: [] as Conflict[],
    };

    for (const clause of extracted.clauses) {
      const result = await this.clauseStore.processNewClause(clause);

      // Generate embedding for new clauses
      if (result.action === 'insert' || result.action === 'superseded') {
        results.clauses.push(result.clause!);

        // Create embedding for semantic search
        if (this.embeddingManager.isSemanticSearchAvailable()) {
          await this.embeddingManager.embedClause(result.clause!.id, result.clause!.natural_form);
        }
      }
      if (result.conflict) {
        results.conflicts.push(result.conflict);
      }
    }

    return results;
  }

  /**
   * Retrieve relevant clauses for a query
   */
  async retrieve(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult> {
    return this.retriever.retrieve(query, options);
  }

  /**
   * Progressive retrieval - multi-stage search for complex queries
   */
  async progressiveRetrieve(
    query: string,
    options: RetrievalOptions & { maxStages?: number } = {}
  ): Promise<RetrievalResult> {
    return this.retriever.progressiveRetrieve(query, options);
  }

  /**
   * Get a specific clause by ID
   */
  async getClause(id: string): Promise<Clause | null> {
    return this.clauseStore.get(id);
  }

  /**
   * Search clauses with filters
   */
  async searchClauses(query: string, options: SearchOptions = {}): Promise<Clause[]> {
    return this.clauseStore.search(query, options);
  }

  /**
   * Reinforce a clause (increase confidence)
   */
  async reinforceClause(id: string, amount: number = 0.05): Promise<void> {
    await this.clauseStore.reinforce(id, amount);
  }

  /**
   * Invalidate a clause (mark as no longer valid)
   */
  async invalidateClause(id: string, reason?: string): Promise<void> {
    await this.clauseStore.invalidate(id, reason);
  }

  /**
   * Run confidence decay on all clauses
   */
  async runDecay(dryRun: boolean = false): Promise<DecayReport> {
    return this.decayRunner.run(dryRun);
  }

  /**
   * Generate MEMORY.md content
   */
  async generateMemoryMd(): Promise<string> {
    return this.clauseStore.generateMemoryMd();
  }

  /**
   * Generate full export (MEMORY_FULL.md style)
   */
  async generateFullExport(): Promise<string> {
    return this.clauseStore.generateFullExport();
  }

  /**
   * Export as JSON
   */
  async exportAsJson(options: { includeExpired?: boolean } = {}): Promise<string> {
    return this.clauseStore.exportAsJson(options);
  }

  /**
   * Retrieve memory for a specific task
   */
  async retrieveForTask(task: {
    description: string;
    skillId?: string;
    requiredTypes?: ClauseType[];
    context?: string;
  }) {
    return this.retriever.retrieveForTask(task);
  }

  /**
   * Enforce source retention policy
   */
  async enforceRetention(retentionDays: number = 90) {
    return this.clauseStore.enforceRetention(retentionDays);
  }

  /**
   * Archive source content to filesystem
   */
  async archiveSource(sourceId: string, content: string | object, options?: { subdir?: string }) {
    return this.clauseStore.archiveSourceToFile(sourceId, content, options);
  }

  /**
   * Log clause access (for tracking usefulness)
   */
  logAccess(clauseId: string, accessType: 'retrieval' | 'injection' | 'reinforcement', context: string) {
    return this.clauseStore.logClauseAccess(clauseId, accessType, context);
  }

  /**
   * Mark access as useful or not (feedback for learning)
   */
  markAccessUseful(accessId: string, wasUseful: boolean, correctionId?: string) {
    return this.clauseStore.markAccessUseful(accessId, wasUseful, correctionId);
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<MemoryStats> {
    const baseStats = await this.clauseStore.getStats();
    return baseStats;
  }

  // ========== Embedding Operations ==========

  /**
   * Embedding operations
   */
  get embeddings() {
    return {
      isAvailable: () => this.embeddingManager.isSemanticSearchAvailable(),
      embed: (clauseId: string, text: string) => this.embeddingManager.embedClause(clauseId, text),
      embedBatch: (clauses: Array<{ id: string; text: string }>) =>
        this.embeddingManager.embedClausesBatch(clauses),
      findSimilar: (query: string, options?: { limit?: number; minSimilarity?: number }) =>
        this.embeddingManager.findSimilar(query, options),
      getStats: () => this.embeddingManager.getStats(),
      rebuild: () =>
        this.embeddingManager.rebuildEmbeddings(async () => {
          const clauses = await this.clauseStore.search('', { limit: 100000 });
          return clauses.map((c) => ({ id: c.id, natural_form: c.natural_form }));
        }),
    };
  }

  // ========== Backup Operations ==========

  /**
   * Backup operations
   */
  get backup() {
    return {
      create: (options?: { type?: 'daily' | 'weekly' | 'manual'; customPath?: string }) =>
        this.backupManager.backup(options),
      restore: (backupPath: string) => this.backupManager.restore(backupPath),
      list: () => this.backupManager.listBackups(),
      validate: (backupPath: string) => this.backupManager.validateBackup(backupPath),
      getLatest: () => this.backupManager.getLatestBackup(),
      getStats: () => this.backupManager.getStats(),
    };
  }

  // ========== Conflict Resolution ==========

  /**
   * Conflict resolution operations
   */
  get conflicts() {
    return {
      list: () => this.clauseStore.getPendingConflicts(),
      resolve: (conflictId: string, strategy?: ConflictResolutionStrategy) =>
        this.clauseStore.resolveConflict(conflictId, strategy),
      resolveAll: (strategy?: ConflictResolutionStrategy) =>
        this.clauseStore.resolveAllConflicts(strategy),
      setStrategy: (config: Partial<ConflictResolutionConfig>) =>
        this.clauseStore.setConflictConfig(config),
    };
  }

  // ========== Deduplication ==========

  /**
   * Check for duplicate clause
   */
  async findDuplicate(input: ClauseInput) {
    return this.clauseStore.findDuplicate(input);
  }

  /**
   * Update deduplication config
   */
  setDeduplicationConfig(config: Partial<DeduplicationConfig>): void {
    this.clauseStore.setDeduplicationConfig(config);
  }

  // ========== Knowledge Packs ==========

  /**
   * Knowledge pack operations
   */
  get packs() {
    return {
      list: () => this.packLoader.listInstalled(),
      available: () => this.packLoader.listAvailable(),
      install: (packId: string, options?: PackLoadOptions) =>
        this.packLoader.install(packId, options),
      update: (packId?: string) => this.packLoader.update(packId),
      remove: (packId: string) => this.packLoader.remove(packId),
      validate: (packPath: string) => this.packLoader.validate(packPath),
      // Remote registry operations
      searchRemote: (query: string) => this.packRegistry.searchRemote(query),
      listRemote: () => this.packRegistry.listAvailableRemote(),
      checkUpdates: () => this.packRegistry.checkForUpdates(),
      downloadRemote: (packId: string) => this.packRegistry.downloadPack(packId),
    };
  }

  // ========== Skill Integration ==========

  /**
   * Skill integration operations
   */
  get skills() {
    return {
      onInstall: (skillId: string, metadata: SkillMetadata) =>
        this.skillBindings.onSkillInstall(skillId, metadata),
      onUninstall: (skillId: string) => this.skillBindings.onSkillUninstall(skillId),
      getCapabilities: (skillId: string) => this.skillBindings.getCapabilities(skillId),
      bindPreferences: (skillId: string) => this.skillBindings.autoBindPreferences(skillId),
      getPreferencesForExecution: (skillId: string) =>
        this.skillBindings.getPreferencesForExecution(skillId),
      recordOutcome: (skillId: string, outcome: SkillOutcome) =>
        this.performanceTracker.recordOutcome(skillId, outcome),
      selectBest: (task: string, candidates: string[]) =>
        this.performanceTracker.selectBest(task, candidates),
      getPerformance: (skillId?: string) => this.performanceTracker.getPerformance(skillId),
    };
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.backupManager.close();
    await this.db.close();
  }
}

// Re-export types for convenience
import type {
  Clause,
  ClauseInput,
  Conflict,
  Source,
  RetrievalOptions,
  RetrievalResult,
  SearchOptions,
  PackLoadOptions,
  SkillMetadata,
  SkillOutcome,
  SourceAttribution,
} from './core/types.js';

export type { RemotePackInfo } from './packs/registry.js';

export type {
  Clause,
  ClauseInput,
  ClauseType,
  Conflict,
  Source,
  RetrievalOptions,
  RetrievalResult,
  SearchOptions,
  DecayReport,
  PackLoadOptions,
  SkillMetadata,
  SkillOutcome,
  OMLiteConfig,
  MemoryStats,
  ConflictResolutionConfig,
  ConflictResolutionStrategy,
  DeduplicationConfig,
  SourceAttribution,
  EmbeddingConfig,
  BackupConfig,
};
