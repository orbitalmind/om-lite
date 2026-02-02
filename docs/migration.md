# Migration Guide

Guide for migrating to OM-Lite from other memory systems.

## From MEMORY.md

### Overview

MEMORY.md is a simple flat-file memory format. Migrating to OM-Lite provides:

- Structured, queryable storage
- Confidence decay
- Conflict detection
- Provenance tracking

### Migration Steps

#### 1. Export MEMORY.md Content

```bash
# Backup your existing MEMORY.md
cp ~/.openclaw/MEMORY.md ~/.openclaw/MEMORY.md.backup
```

#### 2. Initialize OM-Lite

```bash
om-lite init
```

#### 3. Import MEMORY.md

```bash
# Automatic import (parses and extracts clauses)
om-lite memory import ~/.openclaw/MEMORY.md

# Or with options
om-lite memory import ~/.openclaw/MEMORY.md \
  --confidence 0.8 \
  --source-type manual
```

#### 4. Review Imported Clauses

```bash
om-lite memory list
om-lite stats
```

#### 5. Regenerate MEMORY.md

OM-Lite can generate a new MEMORY.md from structured data:

```bash
om-lite sync
```

### Format Mapping

| MEMORY.md | OM-Lite |
|-----------|---------|
| `- User likes coffee` | `type: preference, subject: user, predicate: likes, object: coffee` |
| `- Lives in Denver` | `type: fact, subject: user, predicate: lives_in, object: Denver` |
| `- Prefers morning meetings` | `type: preference, subject: user, predicate: prefers, object: morning meetings` |

### Handling Ambiguity

MEMORY.md entries may be ambiguous:

```markdown
- User likes Python and JavaScript
```

OM-Lite splits this into separate clauses:

```yaml
- type: preference
  subject: user
  predicate: likes
  object: Python
  natural_form: User likes Python

- type: preference
  subject: user
  predicate: likes
  object: JavaScript
  natural_form: User likes JavaScript
```

---

## From Custom Database

### JSON Export/Import

#### Export Format

```json
{
  "version": "1.0",
  "exported_at": "2025-01-15T10:00:00Z",
  "clauses": [
    {
      "type": "fact",
      "subject": "user",
      "predicate": "lives_in",
      "object": "Denver",
      "natural_form": "User lives in Denver",
      "confidence": 0.95,
      "tags": ["location", "personal"],
      "metadata": {
        "source": "conversation-123"
      }
    }
  ]
}
```

#### Import Command

```bash
om-lite memory import export.json --format json
```

#### Programmatic Import

```typescript
import { OMLite } from 'om-lite';
import data from './export.json';

const om = new OMLite();
await om.init();

for (const clause of data.clauses) {
  await om.clauseStore.create({
    type: clause.type,
    subject: clause.subject,
    predicate: clause.predicate,
    object: clause.object,
    natural_form: clause.natural_form,
    confidence: clause.confidence,
    tags: clause.tags,
    metadata: clause.metadata,
  });
}
```

---

## Version Upgrades

### 0.x to 1.0

When upgrading from pre-1.0 versions:

#### Database Schema Migration

```bash
# Backup first
cp ~/.openclaw/memory/om-lite.db ~/.openclaw/memory/om-lite.db.backup

# Run migration
om-lite migrate --to 1.0
```

#### Breaking Changes

| 0.x | 1.0 | Migration |
|-----|-----|-----------|
| `om.search()` | `om.retrieve()` | Rename method calls |
| `clause.source` | `clause.source_id` | Field renamed |
| `decay.rate` | `decay.defaultRate` | Config renamed |

### Configuration Migration

Old config (0.x):
```yaml
memory:
  om_lite:
    decay_rate: 0.001
```

New config (1.0):
```yaml
memory:
  om_lite:
    decay:
      enabled: true
      defaultRate: 0.001
      minConfidence: 0.1
```

---

## Data Backup & Restore

### Backup

```bash
# Full database backup
om-lite backup
# Creates: ~/.openclaw/memory/backups/om-lite-YYYY-MM-DD.db

# Export as JSON
om-lite memory export --format json > backup.json

# Export as Markdown
om-lite memory export --format md > backup.md
```

### Restore

```bash
# From database backup
cp ~/.openclaw/memory/backups/om-lite-2025-01-15.db \
   ~/.openclaw/memory/om-lite.db

# From JSON export
om-lite memory import backup.json --format json --overwrite
```

---

## Troubleshooting

### Duplicate Clauses After Import

```bash
# Enable strict deduplication
om-lite config set deduplication.similarityThreshold 0.95

# Re-import with deduplication
om-lite memory import data.json --dedupe
```

### Confidence Too Low

```bash
# Boost all imported clauses
om-lite memory boost --source imported --amount 0.1
```

### Missing Provenance

```bash
# Add source attribution to orphan clauses
om-lite memory fix-sources --default-source "migration-2025-01"
```

### Schema Mismatch

```bash
# Force schema update
om-lite migrate --force

# Or reinitialize (warning: data loss)
rm ~/.openclaw/memory/om-lite.db
om-lite init
```
