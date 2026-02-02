# Contributing to OM-Lite

First off, thank you for considering contributing to OM-Lite! 🎉

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Knowledge Pack Guidelines](#knowledge-pack-guidelines)
- [Style Guide](#style-guide)

---

## Code of Conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/). Be respectful, inclusive, and constructive.

---

## How Can I Contribute?

### 🐛 Reporting Bugs

1. Check [existing issues](https://github.com/orbitalmind/om-lite/issues) first
2. Use the bug report template
3. Include:
   - OM-Lite version (`om-lite --version`)
   - OpenClaw version
   - OS and Node.js version
   - Steps to reproduce
   - Expected vs actual behavior
   - Relevant logs

### 💡 Suggesting Features

1. Check if already proposed in Issues or Discussions
2. Use the feature request template
3. Explain the use case clearly
4. Consider how it fits with existing architecture

### 🌍 Creating Knowledge Packs

This is one of the most valuable contributions! See [Knowledge Pack Guidelines](#knowledge-pack-guidelines) below.

### 📖 Improving Documentation

- Fix typos and unclear explanations
- Add examples and use cases
- Translate to other languages
- Create tutorials

### 🧪 Adding Tests

- Unit tests for core functions
- Integration tests for OpenClaw
- Edge case coverage

---

## Development Setup

### Prerequisites

- Node.js >= 22
- npm or pnpm
- SQLite 3
- OpenClaw (for integration testing)

### Setup

```bash
# Clone the repo
git clone https://github.com/orbitalmind/om-lite.git
cd om-lite

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run with watch mode
npm run dev
```

### Project Structure

```
om-lite/
├── src/
│   ├── index.ts           # Main exports
│   ├── core/
│   │   ├── database.ts    # SQLite operations
│   │   ├── clauses.ts     # Clause CRUD
│   │   ├── extraction.ts  # LLM extraction
│   │   ├── retrieval.ts   # Search & retrieval
│   │   └── decay.ts       # Confidence decay
│   ├── packs/
│   │   ├── loader.ts      # Pack loading
│   │   └── registry.ts    # Pack registry
│   ├── skills/
│   │   ├── bindings.ts    # Preference bindings
│   │   └── performance.ts # Performance tracking
│   └── cli/
│       └── index.ts       # CLI commands
├── packs/                 # Built-in knowledge packs
├── docs/                  # Documentation
├── tests/                 # Test files
└── examples/              # Usage examples
```

### Running Locally with OpenClaw

```bash
# Link for local development
npm link

# In your OpenClaw directory
npm link om-lite

# Or use directly
node ./dist/cli/index.js --help
```

---

## Pull Request Process

### Before Submitting

1. **Fork** the repo and create a branch from `main`
2. **Follow** the style guide
3. **Add tests** for new functionality
4. **Update documentation** if needed
5. **Run** `npm test` and ensure all pass
6. **Run** `npm run lint` and fix any issues

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation
- `pack/pack-name` - New knowledge pack

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add travel-airports knowledge pack
fix: correct decay calculation for reinforced clauses
docs: add skill integration guide
test: add retrieval edge cases
```

### PR Description

Use the PR template. Include:

- What changed and why
- How to test
- Screenshots if UI changes
- Breaking changes if any

### Review Process

1. Automated checks must pass
2. At least one maintainer review
3. Address feedback constructively
4. Squash and merge when approved

---

## Knowledge Pack Guidelines

Creating knowledge packs is one of the best ways to contribute! Here's how to make great ones.

### Pack Structure

```
packs/my-pack/
├── PACK.yaml          # Metadata (required)
├── README.md          # Documentation (required)
├── *.claims           # Claim files (at least one)
└── CHANGELOG.md       # Version history (recommended)
```

### PACK.yaml Requirements

```yaml
name: my-pack-name              # Lowercase, hyphens only
version: 1.0.0                  # Semver
description: Brief description  # <100 chars
author: your-github-username
license: CC-BY-4.0              # Or MIT, CC0

# Optional but recommended
enhances_skills:
  - skill-name

regions:
  - global                      # Or specific regions

claim_files:
  - facts.claims
  - relationships.claims

stats:
  total_claims: 123
  by_type:
    fact: 100
    relationship: 23
```

### Claim Quality Guidelines

#### ✅ Good Claims

```yaml
# Specific and verifiable
- type: fact
  subject: airport:JFK
  predicate: iata_code
  object: JFK
  natural_form: JFK Airport has IATA code JFK
  confidence: 1.0

# Useful for agent tasks
- type: context
  subject: airline:southwest
  predicate: baggage_policy
  object: "2 free checked bags up to 50 lbs each"
  natural_form: Southwest allows 2 free checked bags up to 50 lbs
  confidence: 0.95
  metadata:
    as_of: 2026-01
```

#### ❌ Avoid

```yaml
# Too vague
- type: fact
  subject: airports
  predicate: exist
  object: many places
  natural_form: There are airports in many places

# Opinion presented as fact
- type: fact
  subject: airline:spirit
  predicate: quality
  object: bad
  natural_form: Spirit Airlines is bad

# Outdated without dating
- type: fact
  subject: company:x
  predicate: ceo
  object: Some Person
  # Missing as_of date - will become stale
```

### Confidence Guidelines

| Confidence | Use For |
|------------|---------|
| 1.0 | Definitional facts (IATA codes, country capitals) |
| 0.95 | Highly stable facts (airline alliances, airport locations) |
| 0.85-0.9 | Generally stable (policies, typical times) |
| 0.7-0.8 | Variable/regional (prices, availability) |
| < 0.7 | Avoid - too uncertain for packs |

### Testing Your Pack

```bash
# Validate pack structure
om-lite packs validate ./packs/my-pack

# Load in test mode
om-lite packs install ./packs/my-pack --dry-run

# Check for duplicates with existing packs
om-lite packs check-conflicts ./packs/my-pack
```

### Submitting a Pack

1. Create pack in `packs/` directory
2. Run validation
3. Add to `packs/README.md` index
4. Submit PR with `pack/pack-name` branch

---

## Style Guide

### TypeScript

- Use TypeScript strict mode
- Prefer `interface` over `type` for objects
- Use meaningful variable names
- Add JSDoc comments for public APIs

```typescript
/**
 * Retrieves clauses matching the query
 * @param query - Natural language query
 * @param options - Retrieval options
 * @returns Matching clauses with scores
 */
async function retrieve(
  query: string, 
  options?: RetrievalOptions
): Promise<RetrievalResult> {
  // Implementation
}
```

### SQL

- Use uppercase for SQL keywords
- Use snake_case for column names
- Add indexes for frequently queried columns

```sql
SELECT c.id, c.natural_form, c.confidence
FROM clauses c
WHERE c.valid_to IS NULL
  AND c.confidence >= 0.5
ORDER BY c.last_accessed DESC
LIMIT 20;
```

### YAML (Claims)

- 2-space indentation
- Quote strings with special characters
- Use lowercase for type values

---

## Questions?

- **Discussions**: [GitHub Discussions](https://github.com/orbitalmind/om-lite/discussions)
- **Issues**: [GitHub Issues](https://github.com/orbitalmind/om-lite/issues)

---

Thank you for contributing!
