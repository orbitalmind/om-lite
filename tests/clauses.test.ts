import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OMLite } from '../src/index.js';
import { ClauseStore } from '../src/core/clauses.js';
import { Database } from '../src/core/database.js';
import { unlink } from 'fs/promises';
import { existsSync } from 'fs';

const TEST_DB = '/tmp/om-lite-test.db';

describe('ClauseStore', () => {
  let om: OMLite;
  let db: Database;
  let clauseStore: ClauseStore;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) {
      await unlink(TEST_DB);
    }
    om = new OMLite({ dbPath: TEST_DB });
    await om.init();

    // Access internal components for direct clause creation
    db = new Database(TEST_DB);
    await db.init();
    clauseStore = new ClauseStore(db);
  });

  afterEach(async () => {
    await om.close();
    await db.close();
    if (existsSync(TEST_DB)) {
      await unlink(TEST_DB);
    }
  });

  describe('basic operations', () => {
    it('should initialize with empty database', async () => {
      const stats = await om.getStats();
      expect(stats.totalClauses).toBe(0);
      expect(stats.activeClauses).toBe(0);
    });

    it('should create and retrieve clause', async () => {
      // Create clause directly (bypassing LLM extraction)
      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Denver',
        natural_form: 'User lives in Denver',
        confidence: 0.9,
      });

      expect(clause.id).toBeDefined();
      expect(clause.natural_form).toBe('User lives in Denver');

      const retrieved = await clauseStore.get(clause.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.subject).toBe('user');
    });
  });

  describe('search', () => {
    it('should search clauses by query', async () => {
      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'window seats',
        natural_form: 'User prefers window seats on flights',
        confidence: 0.85,
      });

      const results = await clauseStore.search('window seats');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].natural_form).toContain('window');
    });

    it('should filter by clause type', async () => {
      await clauseStore.create({
        type: 'fact',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Denver',
        natural_form: 'User lives in Denver',
      });

      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'coffee',
        natural_form: 'User likes coffee',
      });

      const preferences = await clauseStore.search('', {
        types: ['preference'],
      });

      expect(preferences.length).toBe(1);
      expect(preferences[0].type).toBe('preference');
    });
  });

  describe('confidence operations', () => {
    it('should reinforce clause confidence', async () => {
      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'tea',
        natural_form: 'User likes tea',
        confidence: 0.8,
      });

      const before = await clauseStore.get(clause.id);
      const initialConfidence = before!.confidence;

      await clauseStore.reinforce(clause.id, 0.1);

      const after = await clauseStore.get(clause.id);
      expect(after!.confidence).toBeGreaterThan(initialConfidence);
    });

    it('should invalidate clause', async () => {
      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Seattle',
        natural_form: 'User lives in Seattle',
      });

      await clauseStore.invalidate(clause.id, 'User moved');

      const invalidated = await clauseStore.get(clause.id);
      expect(invalidated!.valid_to).not.toBeNull();
    });
  });

  describe('deduplication', () => {
    it('should detect duplicate clauses', async () => {
      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'window seats',
        natural_form: 'User prefers window seats',
      });

      const duplicate = await clauseStore.findDuplicate({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'window seats',
        natural_form: 'User prefers window seats',
      });

      expect(duplicate).not.toBeNull();
      expect(duplicate!.similarity).toBeGreaterThan(0.8);
    });

    it('should detect similar clauses with fuzzy matching', async () => {
      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'coffee',
        natural_form: 'User likes drinking coffee in the morning',
      });

      const similar = await clauseStore.findDuplicate({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'coffee',
        natural_form: 'User enjoys coffee in the morning',
      });

      // Should find as similar due to overlapping tokens
      expect(similar).not.toBeNull();
    });
  });

  describe('statistics', () => {
    it('should return correct stats', async () => {
      await clauseStore.create({
        type: 'fact',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Denver',
        natural_form: 'User lives in Denver',
        confidence: 0.9,
      });

      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'morning meetings',
        natural_form: 'User prefers morning meetings',
        confidence: 0.8,
      });

      const stats = await clauseStore.getStats();
      expect(stats.totalClauses).toBe(2);
      expect(stats.activeClauses).toBe(2);
      expect(stats.avgConfidence).toBeGreaterThan(0);
    });
  });
});

describe('Conflict Resolution', () => {
  let db: Database;
  let clauseStore: ClauseStore;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) {
      await unlink(TEST_DB);
    }
    db = new Database(TEST_DB);
    await db.init();
    clauseStore = new ClauseStore(db);
  });

  afterEach(async () => {
    await db.close();
    if (existsSync(TEST_DB)) {
      await unlink(TEST_DB);
    }
  });

  it('should list pending conflicts', async () => {
    const conflicts = await clauseStore.getPendingConflicts();
    expect(Array.isArray(conflicts)).toBe(true);
  });

  it('should resolve all conflicts', async () => {
    const result = await clauseStore.resolveAllConflicts();
    expect(result).toHaveProperty('resolved');
    expect(typeof result.resolved).toBe('number');
  });
});
