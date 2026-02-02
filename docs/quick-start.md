# Quick Start Guide

Get OM-Lite running in under 5 minutes.

## Prerequisites

- Node.js 22 or later
- OpenClaw installed (optional but recommended)

## Installation

```bash
npm install -g om-lite
```

## Initialize

```bash
# In your OpenClaw directory (or any directory)
om-lite init
```

This creates the SQLite database at `~/.openclaw/memory/om-lite.db`.

## Install a Knowledge Pack

```bash
# Install the travel knowledge pack
om-lite packs install travel-core

# Verify installation
om-lite packs list
```

## Add Your First Memory

```bash
# From the command line
om-lite memory add "I prefer window seats on flights"

# Or programmatically
```

```typescript
import { OMLite } from 'om-lite';

const om = new OMLite();
await om.init();

await om.extract("I moved to Denver. I prefer morning flights.", {
  sourceId: 'manual-entry'
});
```

## Search Your Memory

```bash
om-lite memory search "flight preferences"
```

## View Statistics

```bash
om-lite stats
```

## Generate MEMORY.md

```bash
om-lite sync
```

This creates/updates `~/.openclaw/MEMORY.md` with your high-confidence memories.

## Next Steps

1. [Install more knowledge packs](./creating-packs.md)
2. [Integrate with OpenClaw Skills](./skill-integration.md)

## Troubleshooting

### Database locked error

Make sure only one OpenClaw instance is running, or use WAL mode (default).

### Pack not found

Check available packs:
```bash
om-lite packs available
```

### Memory not persisting

Verify database path:
```bash
om-lite config show
```

## Getting Help

- [GitHub Issues](https://github.com/orbitalmind/om-lite/issues)
- [GitHub Discussions](https://github.com/orbitalmind/om-lite/discussions)
