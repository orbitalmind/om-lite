/**
 * Core types for OM-Lite
 */

// ========== Clause Types ==========

export type ClauseType =
  | 'fact'           // Objective information
  | 'preference'     // User likes/dislikes
  | 'habit'          // Recurring behaviors
  | 'skill'          // Agent capabilities
  | 'relationship'   // Connections between entities
  | 'intention'      // Goals, plans
  | 'context'        // Situational information
  | 'correction'     // User corrections
  | 'skill_success'  // Skill worked for task
  | 'skill_failure'  // Skill failed
  | 'skill_preference'; // User prefers skill

/**
 * Atomic unit of memory - a structured fact
 */
export interface Clause {
  id: string;
  
  // Content (SPO Triple)
  type: ClauseType;
  subject: string;
  predicate: string;
  object: string;
  natural_form: string;
  
  // Temporal validity
  valid_from: string;      // ISO 8601
  valid_to: string | null; // null = currently valid
  recorded_at: string;
  
  // Confidence & decay
  confidence: number;      // 0.0 - 1.0
  decay_rate: number;
  reinforcement_count: number;
  
  // Provenance
  source_id: string;
  extraction_method: string;
  
  // Usage tracking
  last_accessed: string;
  access_count: number;
  
  // Metadata
  tags: string[];
  metadata: Record<string, unknown>;
}

/**
 * Partial clause for creation
 */
export interface ClauseInput {
  type: ClauseType;
  subject: string;
  predicate: string;
  object: string;
  natural_form: string;
  confidence?: number;
  decay_rate?: number;
  valid_from?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ========== Source Types ==========

export type SourceType =
  | 'conversation'
  | 'log'
  | 'document'
  | 'manual'
  | 'knowledge_pack'
  | 'inferred'
  | 'web_search'
  | 'web_fetch'
  | 'auto_capture';

/**
 * Source of knowledge - links clauses to origin
 */
export interface Source {
  id: string;
  type: SourceType;
  channel?: string;
  file_path: string;
  content_hash: string;
  occurred_at: string;
  recorded_at: string;
  participant_count: number;
  message_count: number;
  metadata: Record<string, unknown>;
}

// ========== Conflict Types ==========

export type ConflictType = 'contradiction' | 'supersession' | 'ambiguity';
export type ConflictStatus = 'pending' | 'auto_resolved' | 'user_resolved' | 'ignored';

/**
 * Detected conflict between clauses
 */
export interface Conflict {
  id: string;
  clause_a_id: string;
  clause_b_id: string;
  conflict_type: ConflictType;
  description: string;
  status: ConflictStatus;
  resolution: string | null;
  resolved_at: string | null;
  detected_at: string;
}

// ========== Retrieval Types ==========

export interface RetrievalOptions {
  types?: ClauseType[];
  minConfidence?: number;
  includeExpired?: boolean;
  limit?: number;
  boostRecent?: boolean;
  semanticWeight?: number;
  keywordWeight?: number;
}

export interface RetrievalResult {
  clauses: ScoredClause[];
  totalMatches: number;
  retrievalMethod: 'semantic' | 'keyword' | 'hybrid';
}

export interface ScoredClause extends Clause {
  score: number;
}

export interface SearchOptions {
  types?: ClauseType[];
  minConfidence?: number;
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'confidence' | 'last_accessed' | 'recorded_at';
  orderDir?: 'asc' | 'desc';
}

// ========== Decay Types ==========

export interface DecayConfig {
  enabled: boolean;
  defaultRate: number;
  minConfidence: number;
}

export interface DecayReport {
  processed: number;
  decayed: number;
  archived: number;
  reinforced: number;
  timestamp: string;
}

// ========== Pack Types ==========

export interface PackMetadata {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  enhances_skills?: string[];
  regions?: string[];
  claim_files: string[];
  stats: {
    total_claims: number;
    by_type: Record<ClauseType, number>;
  };
  update_schedule?: string;
  last_updated: string;
  requires_packs?: string[];
  tags?: string[];
}

export interface PackLoadOptions {
  regions?: string[];
  skillFilter?: string[];
  confidenceFloor?: number;
  overwriteExisting?: boolean;
}

export interface PackLoadReport {
  packId: string;
  version: string;
  loaded: number;
  skipped: number;
  conflicts: number;
  timestamp: string;
}

export interface InstalledPack {
  pack_id: string;
  version: string;
  installed_at: string;
  claims_loaded: number;
  last_updated: string | null;
  metadata: PackMetadata;
}

// ========== Skill Types ==========

export interface SkillMetadata {
  name: string;
  version: string;
  description?: string;
  capabilities?: SkillCapability[];
  parameters?: SkillParameter[];
  recommends_packs?: string[];
}

export interface SkillCapability {
  predicate: string;
  object: string;
  confidence: number;
}

export interface SkillParameter {
  name: string;
  type: 'preference' | 'config' | 'secret';
  description?: string;
  default?: string;
}

export interface SkillPreferenceBinding {
  id: string;
  skill_id: string;
  parameter_name: string;
  clause_id: string;
  bound_at: string;
}

export interface SkillOutcome {
  success: boolean;
  taskCategory?: string;
  executionTimeMs?: number;
  errorType?: string;
  errorMessage?: string;
  usedClauseIds?: string[];
}

export interface SkillPerformance {
  skill_id: string;
  task_category: string;
  success_count: number;
  failure_count: number;
  avg_execution_time_ms: number;
  last_used: string;
}

// ========== Conflict Resolution Types ==========

export type ConflictResolutionStrategy =
  | 'newest_wins'      // Most recent clause supersedes older ones
  | 'highest_confidence' // Keep the one with higher confidence
  | 'merge_history'    // Keep newest active, archive old with link
  | 'manual';          // Require manual review

export interface ConflictResolutionConfig {
  strategy: ConflictResolutionStrategy;
  autoResolveThreshold: number;  // Confidence difference threshold for auto-resolve
  preserveHistory: boolean;       // Keep invalidated clauses linked
}

// ========== Deduplication Types ==========

export interface DeduplicationConfig {
  enabled: boolean;
  similarityThreshold: number;    // 0-1, default 0.85
  useContentHash: boolean;        // Check exact duplicates first
  useFuzzyMatch: boolean;         // Use FTS for near-duplicates
  onDuplicate: 'reinforce' | 'skip' | 'merge';
}

// ========== Source Attribution Types ==========

export interface SourceAttribution {
  sessionId?: string;
  agentId?: string;
  query?: string;
  tool?: string;
  url?: string;
  timestamp: string;
}

// ========== Config Types ==========

export interface OMLiteConfig {
  dbPath: string;
  embeddingModel: string;
  extractionModel: string;
  decay: DecayConfig;
  retrieval: {
    semanticWeight: number;
    keywordWeight: number;
    recencyWeight: number;
    defaultLimit: number;
  };
  conflictResolution: ConflictResolutionConfig;
  deduplication: DeduplicationConfig;
}

export interface MemoryStats {
  totalClauses: number;
  activeClauses: number;
  expiredClauses: number;
  avgConfidence: number;
  clausesByType: Record<ClauseType, number>;
  totalSources: number;
  pendingConflicts: number;
  installedPacks: number;
  dbSizeBytes: number;
  lastDecayRun: string | null;
  lastMemorySync: string | null;
}

// ========== Event Types ==========

export type OMLiteEvent =
  | { type: 'clause_created'; clause: Clause }
  | { type: 'clause_updated'; clause: Clause; changes: Partial<Clause> }
  | { type: 'clause_invalidated'; clauseId: string; reason: string }
  | { type: 'clause_reinforced'; clauseId: string; newConfidence: number }
  | { type: 'conflict_detected'; conflict: Conflict }
  | { type: 'conflict_resolved'; conflictId: string; resolution: string }
  | { type: 'pack_installed'; packId: string; claimsLoaded: number }
  | { type: 'pack_removed'; packId: string }
  | { type: 'decay_completed'; report: DecayReport }
  | { type: 'skill_bound'; skillId: string; bindings: SkillPreferenceBinding[] };

export type EventHandler = (event: OMLiteEvent) => void | Promise<void>;

// ========== Utility Types ==========

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export interface ProcessClauseResult {
  action: 'insert' | 'reinforced' | 'superseded' | 'conflict' | 'skipped';
  clause?: Clause;
  existingId?: string;
  invalidatedId?: string;
  conflict?: Conflict;
}
