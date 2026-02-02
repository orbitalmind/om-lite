/**
 * PackLoader module tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PackLoader } from '../src/packs/loader.js';
import { ClauseStore } from '../src/core/clauses.js';
import { DatabaseManager } from '../src/core/database.js';
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('PackLoader', () => {
  let db: DatabaseManager;
  let clauseStore: ClauseStore;
  let loader: PackLoader;
  let testDbPath: string;
  let testPacksDir: string;

  // Create a test pack
  const createTestPack = (packId: string, claims: any[]) => {
    const packDir = join(testPacksDir, packId);
    mkdirSync(packDir, { recursive: true });

    // Create PACK.yaml
    const packYaml = `
name: ${packId}
version: "1.0.0"
description: Test pack
author: test
license: MIT
claim_files:
  - claims.yaml
regions:
  - global
enhances_skills:
  - test-skill
tags:
  - test
last_updated: "2025-01-15"
stats:
  total_claims: ${claims.length}
  by_type: {}
`;
    writeFileSync(join(packDir, 'PACK.yaml'), packYaml);

    // Create claims.yaml
    const claimsYaml = `
claims:
${claims.map((c) => `  - type: ${c.type}
    subject: "${c.subject}"
    predicate: "${c.predicate}"
    object: "${c.object}"
    natural_form: "${c.natural_form}"
    confidence: ${c.confidence ?? 0.9}
`).join('')}
`;
    writeFileSync(join(packDir, 'claims.yaml'), claimsYaml);

    return packDir;
  };

  beforeEach(async () => {
    const testDir = join(tmpdir(), 'om-lite-test');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    testDbPath = join(testDir, `loader-test-${Date.now()}.db`);
    testPacksDir = join(testDir, `packs-${Date.now()}`);
    mkdirSync(testPacksDir, { recursive: true });

    db = new DatabaseManager(testDbPath);
    await db.init();
    clauseStore = new ClauseStore(db);
    loader = new PackLoader(db, clauseStore, testPacksDir);
  });

  afterEach(async () => {
    await db.close();

    // Clean up test files
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(`${testDbPath}-wal`)) {
      unlinkSync(`${testDbPath}-wal`);
    }
    if (existsSync(`${testDbPath}-shm`)) {
      unlinkSync(`${testDbPath}-shm`);
    }
    if (existsSync(testPacksDir)) {
      rmSync(testPacksDir, { recursive: true, force: true });
    }
  });

  describe('listAvailable()', () => {
    it('should list available packs', async () => {
      createTestPack('test-pack', [
        {
          type: 'fact',
          subject: 'user',
          predicate: 'knows',
          object: 'something',
          natural_form: 'User knows something',
        },
      ]);

      const packs = await loader.listAvailable();
      expect(packs.length).toBeGreaterThanOrEqual(1);
      expect(packs[0].name).toBe('test-pack');
    });

    it('should return empty array for empty packs directory', async () => {
      const packs = await loader.listAvailable();
      expect(packs).toHaveLength(0);
    });
  });

  describe('listInstalled()', () => {
    it('should return empty array when no packs installed', async () => {
      const installed = await loader.listInstalled();
      expect(installed).toHaveLength(0);
    });

    it('should return installed packs', async () => {
      createTestPack('my-pack', [
        {
          type: 'fact',
          subject: 'test',
          predicate: 'is',
          object: 'working',
          natural_form: 'Test is working',
        },
      ]);

      await loader.install('my-pack');

      const installed = await loader.listInstalled();
      expect(installed).toHaveLength(1);
      expect(installed[0].pack_id).toBe('my-pack');
    });
  });

  describe('install()', () => {
    it('should install a pack and load claims', async () => {
      createTestPack('install-test', [
        {
          type: 'fact',
          subject: 'LAX',
          predicate: 'located_in',
          object: 'Los Angeles',
          natural_form: 'LAX airport is located in Los Angeles, California',
        },
        {
          type: 'preference',
          subject: 'user',
          predicate: 'prefers_airline',
          object: 'United',
          natural_form: 'User prefers to fly United Airlines',
        },
      ]);

      const report = await loader.install('install-test');

      expect(report.packId).toBe('install-test');
      expect(report.loaded).toBe(2);
      expect(report.version).toBe('1.0.0');
    });

    it('should throw error for non-existent pack', async () => {
      await expect(loader.install('non-existent')).rejects.toThrow();
    });

    it('should throw error for already installed pack', async () => {
      createTestPack('dupe-test', [
        {
          type: 'fact',
          subject: 'test',
          predicate: 'is',
          object: 'test',
          natural_form: 'Test',
        },
      ]);

      await loader.install('dupe-test');

      await expect(loader.install('dupe-test')).rejects.toThrow('already installed');
    });

    it('should allow overwriting existing pack', async () => {
      createTestPack('overwrite-test', [
        {
          type: 'fact',
          subject: 'test',
          predicate: 'is',
          object: 'original',
          natural_form: 'Original',
        },
      ]);

      await loader.install('overwrite-test');

      // Reinstall with overwrite
      const report = await loader.install('overwrite-test', { overwriteExisting: true });
      expect(report.loaded).toBe(1);
    });

    it('should filter by regions', async () => {
      // Create pack with regional claims
      const packDir = join(testPacksDir, 'regional-pack');
      mkdirSync(packDir, { recursive: true });

      writeFileSync(
        join(packDir, 'PACK.yaml'),
        `
name: regional-pack
version: "1.0.0"
description: Regional test pack
author: test
license: MIT
claim_files:
  - claims.yaml
regions:
  - global
last_updated: "2025-01-15"
`
      );

      writeFileSync(
        join(packDir, 'claims.yaml'),
        `
claims:
  - type: fact
    subject: airline
    predicate: serves
    object: region_a
    natural_form: Airline serves Region A
    regions:
      - region_a
  - type: fact
    subject: airline
    predicate: serves
    object: region_b
    natural_form: Airline serves Region B
    regions:
      - region_b
  - type: fact
    subject: airline
    predicate: serves
    object: global
    natural_form: Airline serves globally
    regions:
      - global
`
      );

      const report = await loader.install('regional-pack', { regions: ['region_a'] });

      // Should load region_a and global claims
      expect(report.loaded).toBeGreaterThanOrEqual(1);
    });

    it('should respect confidence floor', async () => {
      createTestPack('confidence-test', [
        {
          type: 'fact',
          subject: 'high',
          predicate: 'conf',
          object: 'value',
          natural_form: 'High confidence',
          confidence: 0.9,
        },
        {
          type: 'fact',
          subject: 'low',
          predicate: 'conf',
          object: 'value',
          natural_form: 'Low confidence',
          confidence: 0.3,
        },
      ]);

      const report = await loader.install('confidence-test', { confidenceFloor: 0.5 });

      expect(report.loaded).toBe(1);
      expect(report.skipped).toBe(1);
    });
  });

  describe('update()', () => {
    it('should update installed packs', async () => {
      createTestPack('update-test', [
        {
          type: 'fact',
          subject: 'test',
          predicate: 'is',
          object: 'working',
          natural_form: 'Test is working',
        },
      ]);

      await loader.install('update-test');

      const reports = await loader.update('update-test');

      expect(reports).toHaveLength(1);
      expect(reports[0].packId).toBe('update-test');
    });

    it('should update all packs when no packId specified', async () => {
      createTestPack('pack-a', [
        { type: 'fact', subject: 'a', predicate: 'is', object: 'a', natural_form: 'A' },
      ]);
      createTestPack('pack-b', [
        { type: 'fact', subject: 'b', predicate: 'is', object: 'b', natural_form: 'B' },
      ]);

      await loader.install('pack-a');
      await loader.install('pack-b');

      const reports = await loader.update();

      expect(reports).toHaveLength(2);
    });
  });

  describe('remove()', () => {
    it('should remove installed pack', async () => {
      createTestPack('remove-test', [
        {
          type: 'fact',
          subject: 'test',
          predicate: 'is',
          object: 'test',
          natural_form: 'Test',
        },
      ]);

      await loader.install('remove-test');
      await loader.remove('remove-test');

      const installed = await loader.listInstalled();
      expect(installed.find((p) => p.pack_id === 'remove-test')).toBeUndefined();
    });
  });

  describe('validate()', () => {
    it('should validate correct pack structure', async () => {
      createTestPack('valid-pack', [
        {
          type: 'fact',
          subject: 'test',
          predicate: 'is',
          object: 'valid',
          natural_form: 'Test is valid',
        },
      ]);

      const result = await loader.validate(join(testPacksDir, 'valid-pack'));

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing PACK.yaml', async () => {
      const packDir = join(testPacksDir, 'no-yaml');
      mkdirSync(packDir, { recursive: true });

      const result = await loader.validate(packDir);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing PACK.yaml');
    });

    it('should detect missing claim files', async () => {
      const packDir = join(testPacksDir, 'missing-claims');
      mkdirSync(packDir, { recursive: true });

      writeFileSync(
        join(packDir, 'PACK.yaml'),
        `
name: missing-claims
version: "1.0.0"
claim_files:
  - does-not-exist.yaml
last_updated: "2025-01-15"
`
      );

      const result = await loader.validate(packDir);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('not found'))).toBe(true);
    });

    it('should warn about missing required fields', async () => {
      const packDir = join(testPacksDir, 'incomplete');
      mkdirSync(packDir, { recursive: true });

      writeFileSync(join(packDir, 'PACK.yaml'), `version: "1.0.0"\nclaim_files: []`);

      const result = await loader.validate(packDir);

      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
    });
  });
});
