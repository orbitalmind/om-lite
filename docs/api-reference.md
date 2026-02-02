# API Reference

Complete API documentation for OM-Lite.

## OMLite Class

Main entry point for all memory operations.

### Constructor

```typescript
import { OMLite } from 'om-lite';

const om = new OMLite(config?: Partial<OMLiteConfig>);
```

#### OMLiteConfig

```typescript
interface OMLiteConfig {
  dbPath: string;                    // Default: ~/.openclaw/memory/om-lite.db
  embeddingModel: string;            // Default: text-embedding-3-small
  extractionModel: string;           // Default: claude-sonnet-4-20250514

  decay: {
    enabled: boolean;                // Default: true
    defaultRate: number;             // Default: 0.001
    minConfidence: number;           // Default: 0.1
  };

  retrieval: {
    semanticWeight: number;          // Default: 0.6
    keywordWeight: number;           // Default: 0.3
    recencyWeight: number;           // Default: 0.1
    defaultLimit: number;            // Default: 20
  };

  conflictResolution: {
    strategy: ConflictResolutionStrategy;  // Default: 'merge_history'
    autoResolveThreshold: number;          // Default: 0.2
    preserveHistory: boolean;              // Default: true
  };

  deduplication: {
    enabled: boolean;                // Default: true
    similarityThreshold: number;     // Default: 0.85
    useContentHash: boolean;         // Default: true
    useFuzzyMatch: boolean;          // Default: true
    onDuplicate: 'reinforce' | 'skip' | 'merge';  // Default: 'reinforce'
  };
}
```

### Initialization

```typescript
await om.init(): Promise<void>
```

Initializes the database and ensures schema exists. Must be called before any operations.

### Core Operations

#### extract()

Extract clauses from content using LLM.

```typescript
await om.extract(
  content: string,
  options?: {
    sourceId?: string;
    context?: string;
  }
): Promise<{ clauses: Clause[]; conflicts: Conflict[] }>
```

**Example:**
```typescript
const result = await om.extract(
  "I moved to Denver last month. I prefer window seats.",
  { context: "User conversation about travel" }
);
console.log(result.clauses);  // Extracted clauses
console.log(result.conflicts); // Any detected conflicts
```

#### retrieve()

Retrieve relevant clauses for a query.

```typescript
await om.retrieve(
  query: string,
  options?: RetrievalOptions
): Promise<RetrievalResult>
```

**RetrievalOptions:**
```typescript
interface RetrievalOptions {
  types?: ClauseType[];         // Filter by clause type
  minConfidence?: number;       // Minimum confidence (0-1)
  includeExpired?: boolean;     // Include expired clauses
  limit?: number;               // Max results
  boostRecent?: boolean;        // Boost recently accessed
  semanticWeight?: number;      // Override semantic weight
  keywordWeight?: number;       // Override keyword weight
}
```

**Example:**
```typescript
const results = await om.retrieve('flight preferences', {
  types: ['preference', 'habit'],
  minConfidence: 0.5,
  limit: 10
});
```

#### getClause()

Get a specific clause by ID.

```typescript
await om.getClause(id: string): Promise<Clause | null>
```

#### searchClauses()

Search clauses with filters.

```typescript
await om.searchClauses(
  query: string,
  options?: SearchOptions
): Promise<Clause[]>
```

**SearchOptions:**
```typescript
interface SearchOptions {
  types?: ClauseType[];
  minConfidence?: number;
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'confidence' | 'last_accessed' | 'recorded_at';
  orderDir?: 'asc' | 'desc';
}
```

#### reinforceClause()

Increase clause confidence.

```typescript
await om.reinforceClause(
  id: string,
  amount?: number  // Default: 0.05
): Promise<void>
```

#### invalidateClause()

Mark a clause as no longer valid.

```typescript
await om.invalidateClause(
  id: string,
  reason?: string
): Promise<void>
```

### Decay Operations

#### runDecay()

Run confidence decay on all clauses.

```typescript
await om.runDecay(
  dryRun?: boolean  // Default: false
): Promise<DecayReport>
```

**DecayReport:**
```typescript
interface DecayReport {
  processed: number;
  decayed: number;
  archived: number;
  reinforced: number;
  timestamp: string;
}
```

### Conflict Resolution

Access via `om.conflicts`:

```typescript
// List pending conflicts
await om.conflicts.list(): Promise<Conflict[]>

// Resolve a specific conflict
await om.conflicts.resolve(
  conflictId: string,
  strategy?: ConflictResolutionStrategy
): Promise<void>

// Resolve all pending conflicts
await om.conflicts.resolveAll(
  strategy?: ConflictResolutionStrategy
): Promise<number>

// Update conflict resolution config
om.conflicts.setStrategy(
  config: Partial<ConflictResolutionConfig>
): void
```

**ConflictResolutionStrategy:**
```typescript
type ConflictResolutionStrategy =
  | 'newest_wins'        // Most recent wins
  | 'highest_confidence' // Highest confidence wins
  | 'merge_history'      // Keep newest, archive old
  | 'manual';            // Require manual review
```

### Deduplication

#### findDuplicate()

Check if a clause would be a duplicate.

```typescript
await om.findDuplicate(
  input: ClauseInput
): Promise<{ id: string; similarity: number } | null>
```

#### setDeduplicationConfig()

Update deduplication settings.

```typescript
om.setDeduplicationConfig(
  config: Partial<DeduplicationConfig>
): void
```

### Knowledge Packs

Access via `om.packs`:

```typescript
// List installed packs
await om.packs.list(): Promise<InstalledPack[]>

// List available packs
await om.packs.available(): Promise<PackMetadata[]>

// Install a pack
await om.packs.install(
  packId: string,
  options?: PackLoadOptions
): Promise<PackLoadReport>

// Update pack(s)
await om.packs.update(packId?: string): Promise<void>

// Remove a pack
await om.packs.remove(packId: string): Promise<void>

// Validate a pack
await om.packs.validate(packPath: string): Promise<ValidationResult>
```

**PackLoadOptions:**
```typescript
interface PackLoadOptions {
  regions?: string[];           // Filter by region
  skillFilter?: string[];       // Only claims for these skills
  confidenceFloor?: number;     // Minimum confidence to load
  overwriteExisting?: boolean;  // Overwrite existing claims
}
```

### Skill Integration

Access via `om.skills`:

```typescript
// Register skill installation
await om.skills.onInstall(
  skillId: string,
  metadata: SkillMetadata
): Promise<void>

// Handle skill uninstall
await om.skills.onUninstall(skillId: string): Promise<void>

// Get skill capabilities
await om.skills.getCapabilities(skillId: string): Promise<SkillCapability[]>

// Auto-bind preferences to skill
await om.skills.bindPreferences(skillId: string): Promise<SkillPreferenceBinding[]>

// Get preferences for execution
await om.skills.getPreferencesForExecution(
  skillId: string
): Promise<Record<string, string>>

// Record skill outcome
await om.skills.recordOutcome(
  skillId: string,
  outcome: SkillOutcome
): Promise<void>

// Select best skill for task
await om.skills.selectBest(
  task: string,
  candidates: string[]
): Promise<{ skillId: string; score: number }>

// Get performance stats
await om.skills.getPerformance(
  skillId?: string
): Promise<SkillPerformance[]>
```

### Memory Export

#### generateMemoryMd()

Generate MEMORY.md content.

```typescript
await om.generateMemoryMd(): Promise<string>
```

### Statistics

#### getStats()

Get memory statistics.

```typescript
await om.getStats(): Promise<MemoryStats>
```

**MemoryStats:**
```typescript
interface MemoryStats {
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
```

### Cleanup

#### close()

Close database connection.

```typescript
await om.close(): Promise<void>
```

---

## Types

### Clause

```typescript
interface Clause {
  id: string;

  // Content (SPO Triple)
  type: ClauseType;
  subject: string;
  predicate: string;
  object: string;
  natural_form: string;

  // Temporal validity
  valid_from: string;       // ISO 8601
  valid_to: string | null;  // null = currently valid
  recorded_at: string;

  // Confidence & decay
  confidence: number;       // 0.0 - 1.0
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
```

### ClauseType

```typescript
type ClauseType =
  | 'fact'           // Objective information
  | 'preference'     // User likes/dislikes
  | 'habit'          // Recurring behaviors
  | 'skill'          // Agent capabilities
  | 'relationship'   // Connections between entities
  | 'intention'      // Goals, plans
  | 'context'        // Situational information
  | 'correction'     // User corrections
  | 'skill_success'  // Skill worked
  | 'skill_failure'  // Skill failed
  | 'skill_preference'; // User prefers skill
```

### ClauseInput

```typescript
interface ClauseInput {
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
```

### Conflict

```typescript
interface Conflict {
  id: string;
  clause_a_id: string;
  clause_b_id: string;
  conflict_type: 'contradiction' | 'supersession' | 'ambiguity';
  description: string;
  status: 'pending' | 'auto_resolved' | 'user_resolved' | 'ignored';
  resolution: string | null;
  resolved_at: string | null;
  detected_at: string;
}
```

### Source

```typescript
interface Source {
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
```

### SourceType

```typescript
type SourceType =
  | 'conversation'
  | 'log'
  | 'document'
  | 'manual'
  | 'knowledge_pack'
  | 'inferred'
  | 'web_search'
  | 'web_fetch'
  | 'auto_capture';
```

### SourceAttribution

```typescript
interface SourceAttribution {
  sessionId?: string;
  agentId?: string;
  query?: string;
  tool?: string;
  url?: string;
  timestamp: string;
}
```

### SkillMetadata

```typescript
interface SkillMetadata {
  name: string;
  version: string;
  description?: string;
  capabilities?: SkillCapability[];
  parameters?: SkillParameter[];
  recommends_packs?: string[];
}
```

### SkillOutcome

```typescript
interface SkillOutcome {
  success: boolean;
  taskCategory?: string;
  executionTimeMs?: number;
  errorType?: string;
  errorMessage?: string;
  usedClauseIds?: string[];
}
```
