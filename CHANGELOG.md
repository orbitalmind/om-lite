# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2025-02-01

### Added

- Initial release
- Core clause storage with SQLite + FTS5
- SPO (Subject-Predicate-Object) triple structure
- Confidence decay system with configurable rates
- Bi-temporal tracking (valid_from/valid_to + recorded_at)
- Conflict detection and resolution
  - Strategies: newest_wins, highest_confidence, merge_history, manual
  - Configurable auto-resolve threshold
- Deduplication before save
  - Exact SPO matching
  - Fuzzy matching with Jaccard similarity
  - Actions: reinforce, skip, merge
- Source attribution tracking
  - Session, agent, query, tool, URL fields
- Knowledge pack system
  - YAML-based pack format
  - Built-in travel-core pack
  - Region and skill filtering
- Skill integration
  - Capability ingestion
  - Preference binding
  - Performance tracking
- CLI tool (`om-lite`)
  - Memory operations (list, search, show)
  - Pack management (install, update, remove)
  - Conflict resolution
  - Statistics and decay
- Full TypeScript support with type declarations
- OpenClaw plugin integration

### Dependencies

- better-sqlite3 for database
- commander for CLI
- yaml for pack parsing
- date-fns for date manipulation

[Unreleased]: https://github.com/orbitalmind/om-lite/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/orbitalmind/om-lite/releases/tag/v0.1.0
