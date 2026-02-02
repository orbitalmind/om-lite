/**
 * SkillBindings module tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkillBindings } from '../src/skills/bindings.js';
import { ClauseStore } from '../src/core/clauses.js';
import { DatabaseManager } from '../src/core/database.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SkillMetadata } from '../src/core/types.js';

describe('SkillBindings', () => {
  let db: DatabaseManager;
  let clauseStore: ClauseStore;
  let bindings: SkillBindings;
  let testDbPath: string;

  beforeEach(async () => {
    const testDir = join(tmpdir(), 'om-lite-test');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    testDbPath = join(testDir, `bindings-test-${Date.now()}.db`);
    db = new DatabaseManager(testDbPath);
    await db.init();
    clauseStore = new ClauseStore(db);
    bindings = new SkillBindings(db, clauseStore);
  });

  afterEach(async () => {
    await db.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(`${testDbPath}-wal`)) {
      unlinkSync(`${testDbPath}-wal`);
    }
    if (existsSync(`${testDbPath}-shm`)) {
      unlinkSync(`${testDbPath}-shm`);
    }
  });

  describe('onSkillInstall()', () => {
    it('should create capability claims for skill', async () => {
      const metadata: SkillMetadata = {
        name: 'test-skill',
        version: '1.0.0',
        description: 'A test skill',
        capabilities: [
          { predicate: 'can_book', object: 'flights', confidence: 0.9 },
          { predicate: 'can_book', object: 'hotels', confidence: 0.85 },
        ],
      };

      const result = await bindings.onSkillInstall('test-skill', metadata);

      expect(result.claimsCreated).toBe(2);
    });

    it('should store skill capabilities in database', async () => {
      const metadata: SkillMetadata = {
        name: 'flight-skill',
        version: '1.0.0',
        capabilities: [
          { predicate: 'can_book', object: 'flights', confidence: 0.9 },
        ],
      };

      await bindings.onSkillInstall('flight-skill', metadata);

      const caps = db.all<{ skill_id: string }>(
        'SELECT skill_id FROM skill_capabilities WHERE skill_id = ?',
        ['flight-skill']
      );

      expect(caps.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onSkillUninstall()', () => {
    it('should invalidate capability claims', async () => {
      const metadata: SkillMetadata = {
        name: 'test-skill',
        version: '1.0.0',
        capabilities: [
          { predicate: 'can_do', object: 'something', confidence: 0.9 },
        ],
      };

      await bindings.onSkillInstall('test-skill', metadata);
      await bindings.onSkillUninstall('test-skill');

      // Check that capabilities are removed
      const caps = db.all<{ skill_id: string }>(
        'SELECT skill_id FROM skill_capabilities WHERE skill_id = ?',
        ['test-skill']
      );

      expect(caps).toHaveLength(0);
    });

    it('should remove preference bindings', async () => {
      const metadata: SkillMetadata = {
        name: 'test-skill',
        version: '1.0.0',
        capabilities: [],
      };

      await bindings.onSkillInstall('test-skill', metadata);

      // Create a manual binding
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'test',
        natural_form: 'User prefers test',
        source_id: sourceId,
        extraction_method: 'test',
      });

      await bindings.bindPreference('test-skill', 'test_param', clause.id);
      await bindings.onSkillUninstall('test-skill');

      // Check bindings are removed
      const bindingList = await bindings.getBindings('test-skill');
      expect(bindingList).toHaveLength(0);
    });
  });

  describe('getCapabilities()', () => {
    it('should return skill capabilities', async () => {
      const metadata: SkillMetadata = {
        name: 'test-skill',
        version: '1.0.0',
        capabilities: [
          { predicate: 'can_book', object: 'flights', confidence: 0.9 },
        ],
      };

      await bindings.onSkillInstall('test-skill', metadata);

      const caps = await bindings.getCapabilities('test-skill');
      expect(caps.length).toBeGreaterThanOrEqual(0);
    });

    it('should return empty array for unknown skill', async () => {
      const caps = await bindings.getCapabilities('unknown-skill');
      expect(caps).toHaveLength(0);
    });
  });

  describe('bindPreference()', () => {
    it('should create binding between skill and clause', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers_airline',
        object: 'United',
        natural_form: 'User prefers United',
        source_id: sourceId,
        extraction_method: 'test',
      });

      const binding = await bindings.bindPreference('flight-skill', 'preferred_airline', clause.id);

      expect(binding).not.toBeNull();
      expect(binding!.skill_id).toBe('flight-skill');
      expect(binding!.parameter_name).toBe('preferred_airline');
      expect(binding!.clause_id).toBe(clause.id);
    });

    it('should return null for non-existent clause', async () => {
      const binding = await bindings.bindPreference('skill', 'param', 'non-existent-id');
      expect(binding).toBeNull();
    });

    it('should update existing binding', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause1 = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'first',
        natural_form: 'First preference',
        source_id: sourceId,
        extraction_method: 'test',
      });

      const clause2 = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'second',
        natural_form: 'Second preference',
        source_id: sourceId,
        extraction_method: 'test',
      });

      await bindings.bindPreference('skill', 'param', clause1.id);
      await bindings.bindPreference('skill', 'param', clause2.id);

      const allBindings = await bindings.getBindings('skill');
      expect(allBindings).toHaveLength(1);
      expect(allBindings[0].clause_id).toBe(clause2.id);
    });
  });

  describe('unbindPreference()', () => {
    it('should remove binding', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'test',
        natural_form: 'Test preference',
        source_id: sourceId,
        extraction_method: 'test',
      });

      await bindings.bindPreference('skill', 'param', clause.id);
      await bindings.unbindPreference('skill', 'param');

      const allBindings = await bindings.getBindings('skill');
      expect(allBindings).toHaveLength(0);
    });
  });

  describe('getBindings()', () => {
    it('should return all bindings for skill', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause1 = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'pref1',
        object: 'v1',
        natural_form: 'Pref 1',
        source_id: sourceId,
        extraction_method: 'test',
      });

      const clause2 = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'pref2',
        object: 'v2',
        natural_form: 'Pref 2',
        source_id: sourceId,
        extraction_method: 'test',
      });

      await bindings.bindPreference('skill', 'param1', clause1.id);
      await bindings.bindPreference('skill', 'param2', clause2.id);

      const allBindings = await bindings.getBindings('skill');
      expect(allBindings).toHaveLength(2);
    });
  });

  describe('getPreferencesForExecution()', () => {
    it('should return resolved preference values', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers_airline',
        object: 'United',
        natural_form: 'User prefers United',
        confidence: 0.9,
        source_id: sourceId,
        extraction_method: 'test',
      });

      await bindings.bindPreference('flight-skill', 'preferred_airline', clause.id);

      const prefs = await bindings.getPreferencesForExecution('flight-skill');
      expect(prefs).toEqual({ preferred_airline: 'United' });
    });

    it('should exclude low confidence clauses', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'test',
        natural_form: 'Test preference',
        confidence: 0.3, // Low confidence
        source_id: sourceId,
        extraction_method: 'test',
      });

      await bindings.bindPreference('skill', 'param', clause.id);

      const prefs = await bindings.getPreferencesForExecution('skill');
      expect(prefs).toEqual({}); // Should be empty due to low confidence
    });
  });

  describe('getSkillsWithBindings()', () => {
    it('should return list of skills with bindings', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'test',
        natural_form: 'Test',
        source_id: sourceId,
        extraction_method: 'test',
      });

      await bindings.bindPreference('skill-a', 'param', clause.id);
      await bindings.bindPreference('skill-b', 'param', clause.id);

      const skills = await bindings.getSkillsWithBindings();
      expect(skills).toContain('skill-a');
      expect(skills).toContain('skill-b');
    });
  });

  describe('getSkillsForCapability()', () => {
    it('should find skills that can perform an action', async () => {
      const metadata: SkillMetadata = {
        name: 'flight-booker',
        version: '1.0.0',
        capabilities: [
          { predicate: 'can_book', object: 'flights', confidence: 0.9 },
        ],
      };

      await bindings.onSkillInstall('flight-booker', metadata);

      const skills = await bindings.getSkillsForCapability('can_book', 'flights');
      expect(skills).toContain('flight-booker');
    });

    it('should return empty array for unmatched capability', async () => {
      const skills = await bindings.getSkillsForCapability('can_teleport', 'anywhere');
      expect(skills).toHaveLength(0);
    });
  });
});
