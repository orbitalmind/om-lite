# 🧠 Orbital Mind Lite (OM-Lite)

**Structured, decay-aware external memory for OpenClaw agents**

[![npm version](https://img.shields.io/npm/v/om-lite.svg)](https://www.npmjs.com/package/om-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Compatible](https://img.shields.io/badge/OpenClaw-Compatible-blue.svg)](https://github.com/orbitalmind/om-lite)

---

## 🎯 What is OM-Lite?

OM-Lite is an external memory system designed for personal AI agents like OpenClaw. It transforms the simple MEMORY.md approach into a structured, intelligent memory layer that:

- **Forgets gracefully** — Confidence decay removes stale information automatically
- **Tracks provenance** — Full source attribution with session, agent, query, and URL
- **Resolves conflicts** — Configurable strategies for contradicting information
- **Prevents duplicates** — Exact and fuzzy matching with reinforcement
- **Learns from skills** — Performance tracking improves over time
- **Supports knowledge packs** — Pre-built domain knowledge accelerates usefulness

```
┌─────────────────────────────────────────────────────────────┐
│                     Before: MEMORY.md                        │
├─────────────────────────────────────────────────────────────┤
│ - User likes coffee                                         │
│ - User lives in Seattle ← outdated?                         │
│ - User lives in Denver  ← which is current?                 │
│ - Book flight to Tokyo  ← still relevant?                   │
└─────────────────────────────────────────────────────────────┘

                            ↓ OM-Lite ↓

┌─────────────────────────────────────────────────────────────┐
│                   After: Structured Memory                   │
├─────────────────────────────────────────────────────────────┤
│ ✓ User likes coffee (92% confidence, reinforced 5x)         │
│ ✗ User lives in Seattle (expired: 2025-12-01)               │
│ ✓ User lives in Denver (95% confidence, current)            │
│ ✓ User prefers window seats (bound to: flight-booking)      │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quick Start

### Installation

```bash
# Install via npm
npm install -g om-lite

# Or add to your OpenClaw workspace
openclaw extensions add om-lite
```

### Basic Usage

```bash
# Initialize OM-Lite in your OpenClaw directory
om-lite init

# Install a knowledge pack
om-lite packs install travel-core

# View your memory
om-lite memory list

# Search memory
om-lite memory search "user preferences"

# Check memory stats
om-lite stats
```

### Programmatic Usage

```typescript
import { OMLite } from 'om-lite';

const memory = new OMLite({
  dbPath: '~/.openclaw/memory/om-lite.db',
  embeddingModel: 'text-embedding-3-small'
});

// Extract claims from conversation
await memory.extract(
  'I moved to Denver last month. I prefer window seats.',
  { sourceId: 'conversation-123' }
);

// Retrieve relevant memory
const results = await memory.retrieve('flight booking preferences');
console.log(results.clauses);
// [
//   { natural_form: "User lives in Denver", confidence: 0.95 },
//   { natural_form: "User prefers window seats", confidence: 0.90 }
// ]

// Get preferences for a skill
const prefs = await memory.skills.getPreferencesForExecution('flight-booking');
console.log(prefs);
// { seat_preference: "window", preferred_airline: "United" }
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OpenClaw Gateway                                 │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         OM-Lite Memory Layer                             │
│                                                                         │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│   │   Extract   │  │    Store    │  │   Retrieve  │  │    Decay    │   │
│   │   Clauses   │  │   Clauses   │  │   Clauses   │  │    Runner   │   │
│   └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘   │
│                                                                         │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                    │
│   │  Knowledge  │  │    Skill    │  │ Performance │                    │
│   │    Packs    │  │  Bindings   │  │  Learning   │                    │
│   └─────────────┘  └─────────────┘  └─────────────┘                    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     SQLite Database (om-lite.db)                         │
│                                                                         │
│   clauses │ sources │ embeddings │ conflicts │ skill_bindings │ packs   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Clause** | Atomic unit of memory (subject-predicate-object triple) |
| **Confidence** | 0-1 score that decays over time unless reinforced |
| **Provenance** | Link to source conversation/document |
| **Bi-temporal** | Tracks when facts were true AND when we learned them |
| **Knowledge Pack** | Pre-built collection of domain claims |

---

## 📦 Knowledge Packs

Knowledge Packs provide pre-built domain knowledge that accelerates your agent's usefulness.

### Available Packs

| Pack | Claims | Description |
|------|--------|-------------|
| [`travel-core`](./packs/travel-core) | ~850 | Airports, airlines, booking tips |
| [`finance-basics`](./packs/finance-basics) | ~400 | Tax rules, account types, budgeting |
| [`smart-home-core`](./packs/smart-home-core) | ~500 | Protocols, devices, automations |
| [`geography-core`](./packs/geography-core) | ~2,000 | Countries, cities, timezones |
| [`cooking-basics`](./packs/cooking-basics) | ~1,000 | Ingredients, techniques, substitutions |

### Installing Packs

```bash
# Install a single pack
om-lite packs install travel-core

# Install multiple packs
om-lite packs install travel-core finance-basics

# Install with region filter
om-lite packs install travel-airports --regions north-america,europe

# List installed packs
om-lite packs list

# Update all packs
om-lite packs update --all
```

### Creating Custom Packs

See [Creating Knowledge Packs](./docs/creating-packs.md) for a complete guide.

```yaml
# my-pack/PACK.yaml
name: my-custom-pack
version: 1.0.0
description: My domain-specific knowledge
author: your-name

claim_files:
  - facts.claims
  - relationships.claims
```

```yaml
# my-pack/facts.claims
claims:
  - type: fact
    subject: my_domain
    predicate: has_property
    object: some_value
    natural_form: My domain has some property
    confidence: 0.9
```

---

## 🔗 Skill Integration

OM-Lite automatically integrates with OpenClaw Skills to provide personalized execution.

### How It Works

1. **Skills declare capabilities** in their SKILL.md
2. **OM-Lite ingests** these as structured claims
3. **User preferences** are bound to skill parameters
4. **Execution injects** relevant memory automatically

### Example: Flight Booking

```markdown
<!-- SKILL.md -->
---
name: flight-booking
parameters:
  - name: seat_preference
    type: preference
  - name: preferred_airline
    type: preference
---
```

```typescript
// OM-Lite automatically:
// 1. Detects "User prefers window seats" clause
// 2. Binds it to flight-booking.seat_preference
// 3. Injects into skill context at runtime

// You can also manually bind:
await memory.skills.bindPreference('flight-booking', 'seat_preference', 'clause-uuid');
```

### Performance Learning

OM-Lite tracks skill outcomes to improve selection:

```typescript
// After skill execution
await memory.skills.recordOutcome('flight-booking', {
  success: true,
  taskCategory: 'domestic_flight',
  executionTimeMs: 3500
});

// Later, for skill selection
const bestSkill = await memory.skills.selectBest(
  'book a flight to NYC',
  ['flight-booking', 'travel-agent', 'kayak-direct']
);
```

---

## 🔄 Conflict Resolution

When new information contradicts existing memory, OM-Lite detects and resolves conflicts automatically or flags them for manual review.

### Conflict Types

| Type | Description |
|------|-------------|
| `contradiction` | New clause directly contradicts existing (e.g., "lives in Denver" vs "lives in Seattle") |
| `supersession` | New information replaces old (e.g., updated preference) |
| `ambiguity` | Multiple clauses could apply to the same context |

### Resolution Strategies

| Strategy | Description |
|----------|-------------|
| `merge_history` | **Default** - Keep newest active, archive old with link |
| `newest_wins` | Most recent clause supersedes older ones |
| `highest_confidence` | Keep the clause with higher confidence score |
| `manual` | Require explicit user review for all conflicts |

### Configuration

```typescript
const memory = new OMLite({
  conflictResolution: {
    strategy: 'merge_history',      // Default strategy
    autoResolveThreshold: 0.2,      // Auto-resolve if confidence diff > 20%
    preserveHistory: true,          // Keep invalidated clauses linked
  }
});
```

### Programmatic API

```typescript
// List pending conflicts
const conflicts = await memory.conflicts.list();

// Resolve a specific conflict
await memory.conflicts.resolve('conflict-id', 'newest_wins');

// Resolve all pending conflicts with default strategy
await memory.conflicts.resolveAll();

// Change strategy at runtime
memory.conflicts.setStrategy({ strategy: 'highest_confidence' });
```

### CLI Commands

```bash
# List pending conflicts
om-lite conflicts list

# Resolve a specific conflict
om-lite conflicts resolve <conflict-id> --strategy newest_wins

# Resolve all conflicts
om-lite conflicts resolve --all

# View current config
om-lite conflicts config

# Change strategy
om-lite conflicts config --strategy merge_history
```

---

## 🔍 Deduplication

OM-Lite prevents duplicate clauses from cluttering memory using exact and fuzzy matching.

### How It Works

1. **Exact Match**: Checks if subject+predicate+object already exists
2. **Fuzzy Match**: Uses Jaccard similarity on natural_form tokens
3. **On Duplicate**: Either reinforce existing clause, skip, or merge

### Configuration

```typescript
const memory = new OMLite({
  deduplication: {
    enabled: true,
    similarityThreshold: 0.85,    // 85% similarity = duplicate
    useContentHash: true,         // Check exact SPO matches first
    useFuzzyMatch: true,          // Use token-based similarity
    onDuplicate: 'reinforce',     // Options: 'reinforce' | 'skip' | 'merge'
  }
});
```

### Duplicate Actions

| Action | Behavior |
|--------|----------|
| `reinforce` | **Default** - Boost confidence of existing clause |
| `skip` | Silently discard the duplicate |
| `merge` | Combine metadata from both clauses |

### Programmatic API

```typescript
// Check if a clause would be a duplicate
const duplicate = await memory.findDuplicate({
  type: 'preference',
  subject: 'user',
  predicate: 'prefers',
  object: 'window seats',
  natural_form: 'User prefers window seats'
});

if (duplicate) {
  console.log(`Found duplicate: ${duplicate.id} (${duplicate.similarity}% similar)`);
}

// Update deduplication config at runtime
memory.setDeduplicationConfig({
  similarityThreshold: 0.90,  // More strict matching
  onDuplicate: 'skip'
});
```

---

## 📍 Source Attribution

Every clause in OM-Lite tracks its provenance with detailed attribution fields.

### Attribution Fields

| Field | Description |
|-------|-------------|
| `sessionId` | OpenClaw conversation/session identifier |
| `agentId` | Agent that captured the information |
| `query` | Original query that triggered capture |
| `tool` | Tool that provided the data (e.g., `web_search`, `web_fetch`) |
| `url` | Source URL for web-originated data |
| `timestamp` | ISO 8601 timestamp of capture |

### Usage

```typescript
// Attribution is automatically tracked during extraction
await memory.extract(content, {
  sourceId: 'session-123',
  context: JSON.stringify({
    sessionId: 'conv-abc123',
    agentId: 'openclaw-main',
    query: 'weather in Tokyo',
    tool: 'web_search',
    url: 'https://weather.example.com/tokyo'
  })
});
```

### Querying by Source

```typescript
// Find clauses from a specific session
const clauses = await memory.searchClauses('', {
  types: ['fact'],
  // Attribution is stored in source metadata
});

// Get full source details
const clause = await memory.getClause('clause-id');
const source = await memory.db.getSource(clause.source_id);
console.log(source.metadata);
// { sessionId: 'conv-abc123', agentId: 'openclaw-main', ... }
```

---

## ⏰ Confidence Decay

Memory items decay over time unless reinforced by usage.

### How Decay Works

```
new_confidence = old_confidence × (1 - decay_rate × time_factor)

where:
  time_factor = days_since_last_access / 30
  effective_decay = base_rate / (1 + log(reinforcement_count + 1))
```

### Decay Rates by Type

| Clause Type | Default Rate | Half-life (unused) |
|-------------|--------------|-------------------|
| fact | 0.0005 | ~4 years |
| preference | 0.002 | ~1 year |
| habit | 0.001 | ~2 years |
| skill | 0.0002 | ~10 years |
| intention | 0.01 | ~2 months |
| context | 0.05 | ~2 weeks |

### Manual Decay Control

```bash
# Run decay manually
om-lite decay --run

# Preview what would decay
om-lite decay --dry-run

# Adjust decay rate for a clause
om-lite memory set-decay <clause-id> 0.001
```

---

## 🛠️ CLI Reference

```bash
om-lite <command> [options]

Commands:
  init                    Initialize OM-Lite in current directory

  # Memory operations
  memory list             List all active clauses
  memory search <query>   Search memory with query
  memory show <id>        Show clause details
  memory export           Export all memory as JSON/Markdown
  memory import <file>    Import memory from backup

  # Knowledge packs
  packs list              List installed packs
  packs available         List available packs
  packs install <pack>    Install a knowledge pack
  packs update [pack]     Update pack(s)
  packs remove <pack>     Remove a pack

  # Skills
  skills list             List skills with memory bindings
  skills bind <skill>     Auto-bind preferences to skill
  skills unbind <skill>   Remove preference bindings
  skills performance      Show skill performance stats

  # Conflict resolution
  conflicts list          List pending conflicts
  conflicts resolve <id>  Resolve a specific conflict
  conflicts resolve --all Resolve all pending conflicts
  conflicts config        View conflict resolution config
  conflicts config --strategy <strategy>  Set resolution strategy

  # Maintenance
  decay --run             Run confidence decay
  decay --dry-run         Preview decay changes
  sync                    Regenerate MEMORY.md
  backup                  Create database backup
  stats                   Show memory statistics

  # Configuration
  config show             Show current configuration
  config set <key> <val>  Set configuration value

Options:
  --db <path>             Database path (default: ~/.openclaw/memory/om-lite.db)
  --verbose               Verbose output
  --json                  Output as JSON
  --help                  Show help
```

---

## ⚙️ Configuration

Add to your OpenClaw `config.yaml`:

```yaml
# ~/.openclaw/config.yaml
memory:
  om_lite:
    enabled: true
    db_path: "~/.openclaw/memory/om-lite.db"

    extraction:
      enabled: true
      model: "claude-sonnet-4-20250514"

    decay:
      enabled: true
      schedule: "0 3 * * *"  # 3 AM daily
      min_confidence: 0.1

    sync:
      enabled: true
      min_confidence: 0.5

    retrieval:
      embedding_model: "text-embedding-3-small"
      semantic_weight: 0.6
      keyword_weight: 0.3

    # Conflict resolution settings
    conflict_resolution:
      strategy: "merge_history"     # newest_wins | highest_confidence | merge_history | manual
      auto_resolve_threshold: 0.2   # Auto-resolve if confidence diff > this
      preserve_history: true        # Keep invalidated clauses for audit trail

    # Deduplication settings
    deduplication:
      enabled: true
      similarity_threshold: 0.85    # 85% similar = duplicate
      use_content_hash: true        # Check exact SPO matches
      use_fuzzy_match: true         # Token-based similarity
      on_duplicate: "reinforce"     # reinforce | skip | merge
```

### Full Configuration Reference

```typescript
import { OMLite } from 'om-lite';

const memory = new OMLite({
  // Database location
  dbPath: '~/.openclaw/memory/om-lite.db',

  // LLM models
  embeddingModel: 'text-embedding-3-small',
  extractionModel: 'claude-sonnet-4-20250514',

  // Decay settings
  decay: {
    enabled: true,
    defaultRate: 0.001,
    minConfidence: 0.1,
  },

  // Retrieval settings
  retrieval: {
    semanticWeight: 0.6,
    keywordWeight: 0.3,
    recencyWeight: 0.1,
    defaultLimit: 20,
  },

  // Conflict resolution
  conflictResolution: {
    strategy: 'merge_history',
    autoResolveThreshold: 0.2,
    preserveHistory: true,
  },

  // Deduplication
  deduplication: {
    enabled: true,
    similarityThreshold: 0.85,
    useContentHash: true,
    useFuzzyMatch: true,
    onDuplicate: 'reinforce',
  },
});
```

---

## 📊 Comparison

| Feature | MEMORY.md | memU | OM-Lite |
|---------|-----------|------|---------|
| Storage | Flat file | 3-tier | SQLite + FTS |
| Structure | Freeform | Categories | SPO Clauses |
| Decay | ❌ | ❌ | ✅ Configurable |
| Provenance | ❌ | Partial | ✅ Full attribution |
| Bi-temporal | ❌ | ❌ | ✅ |
| Conflict detection | ❌ | LLM-based | ✅ Structural |
| Conflict resolution | ❌ | ❌ | ✅ 4 strategies |
| Deduplication | ❌ | ❌ | ✅ Exact + fuzzy |
| Source attribution | ❌ | ❌ | ✅ Session/agent/URL |
| Skill integration | ❌ | ❌ | ✅ |
| Knowledge packs | ❌ | ❌ | ✅ |
| Performance learning | ❌ | ❌ | ✅ |
| Deployment | Zero | Medium | Low (SQLite) |

---

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

### Quick Contribution Ideas

- 🌍 **Create knowledge packs** for new domains
- 🐛 **Report bugs** via GitHub Issues
- 📖 **Improve documentation**
- 🧪 **Add tests** for edge cases
- 🌐 **Translate** to other languages

### Development Setup

```bash
git clone https://github.com/orbitalmind/om-lite.git
cd om-lite
npm install
npm run build
npm test
```

---

## 📄 License

MIT License - see [LICENSE](./LICENSE) for details.

---

## 🙏 Acknowledgments

- **OpenClaw Community** for inspiration and feedback
- **Orbital Mind** project for the full enterprise specification

---

## 📚 Documentation

- [Creating Knowledge Packs](./docs/creating-packs.md)
- [Skill Integration Guide](./docs/skill-integration.md)
- [API Reference](./docs/api-reference.md)
- [Migration Guide](./docs/migration.md)

---

<p align="center">
  <b>Built by Orbital Mind for the OpenClaw community</b>
  <br>
  <a href="https://github.com/orbitalmind/om-lite">GitHub</a> •
  <a href="https://github.com/orbitalmind/om-lite/issues">Issues</a> •
  <a href="https://github.com/orbitalmind/om-lite/discussions">Discussions</a>
</p>
