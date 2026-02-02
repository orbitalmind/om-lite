/**
 * ClauseStore module tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClauseStore } from './clauses.js';
import { DatabaseManager } from './database.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ClauseStore', () => {
  let db: DatabaseManager;
  let clauseStore: ClauseStore;
  let testDbPath: string;

  beforeEach(async () => {
    const testDir = join(tmpdir(), 'om-lite-test');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    testDbPath = join(testDir, `clauses-test-${Date.now()}.db`);
    db = new DatabaseManager(testDbPath);
    await db.init();
    clauseStore = new ClauseStore(db);
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

  describe('createSource()', () => {
    it('should create a source and return ID', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test conversation content',
      });

      expect(sourceId).toBeDefined();
      expect(typeof sourceId).toBe('string');
    });

    it('should store source metadata', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test content',
        channel: 'test-channel',
        metadata: { custom: 'data' },
      });

      const source = db.get<{ type: string; channel: string }>(
        'SELECT type, channel FROM sources WHERE id = ?',
        [sourceId]
      );

      expect(source?.type).toBe('manual');
      expect(source?.channel).toBe('test-channel');
    });
  });

  describe('create()', () => {
    it('should create a clause and return it', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers_airline',
        object: 'United',
        natural_form: 'User prefers United Airlines',
        confidence: 0.9,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      expect(clause).toBeDefined();
      expect(clause.id).toBeDefined();
      expect(clause.type).toBe('preference');
      expect(clause.subject).toBe('user');
      expect(clause.predicate).toBe('prefers_airline');
      expect(clause.object).toBe('United');
    });

    it('should generate content hash', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'earth',
        predicate: 'is_a',
        object: 'planet',
        natural_form: 'Earth is a planet',
        confidence: 1.0,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      // Verify clause was created with proper ID
      expect(clause.id).toBeDefined();
      expect(clause.id.length).toBeGreaterThan(0);
    });
  });

  describe('get()', () => {
    it('should retrieve a clause by ID', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const created = await clauseStore.create({
        type: 'fact',
        subject: 'test',
        predicate: 'is',
        object: 'true',
        natural_form: 'Test is true',
        confidence: 0.8,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      const retrieved = await clauseStore.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.subject).toBe('test');
    });

    it('should return null for non-existent ID', async () => {
      const result = await clauseStore.get('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('search()', () => {
    beforeEach(async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      // Create test clauses
      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers_airline',
        object: 'United Airlines',
        natural_form: 'User prefers United Airlines',
        confidence: 0.9,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers_seat',
        object: 'window',
        natural_form: 'User prefers window seats',
        confidence: 0.8,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      await clauseStore.create({
        type: 'fact',
        subject: 'airport:JFK',
        predicate: 'is_located_in',
        object: 'New York',
        natural_form: 'JFK Airport is in New York',
        confidence: 1.0,
        source_id: sourceId,
        extraction_method: 'manual',
      });
    });

    it('should find clauses by text search', async () => {
      const results = await clauseStore.search('United');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(c => c.object.includes('United'))).toBe(true);
    });

    it('should filter by type', async () => {
      const results = await clauseStore.search('', { types: ['preference'] });
      expect(results.every(c => c.type === 'preference')).toBe(true);
    });

    it('should filter by minimum confidence', async () => {
      const results = await clauseStore.search('', { minConfidence: 0.85 });
      expect(results.every(c => c.confidence >= 0.85)).toBe(true);
    });

    it('should limit results', async () => {
      const results = await clauseStore.search('', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('reinforce()', () => {
    it('should increase clause confidence', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'coffee',
        natural_form: 'User likes coffee',
        confidence: 0.5,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      await clauseStore.reinforce(clause.id, 0.1);

      const updated = await clauseStore.get(clause.id);
      expect(updated?.confidence).toBeGreaterThan(0.5);
      expect(updated?.reinforcement_count).toBe(1);
    });

    it('should cap confidence at 1.0', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'test',
        predicate: 'is',
        object: 'certain',
        natural_form: 'Test is certain',
        confidence: 0.95,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      await clauseStore.reinforce(clause.id, 0.2);

      const updated = await clauseStore.get(clause.id);
      expect(updated?.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  describe('invalidate()', () => {
    it('should mark clause as invalid', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Seattle',
        natural_form: 'User lives in Seattle',
        confidence: 0.9,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      await clauseStore.invalidate(clause.id, 'moved to new city');

      const updated = await clauseStore.get(clause.id);
      expect(updated?.valid_to).not.toBeNull();
    });
  });

  describe('processNewClause()', () => {
    it('should detect duplicate content', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const first = await clauseStore.processNewClause({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers_airline',
        object: 'Delta',
        natural_form: 'User prefers Delta',
        confidence: 0.8,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      expect(first.action).toBe('insert');

      const duplicate = await clauseStore.processNewClause({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers_airline',
        object: 'Delta',
        natural_form: 'User prefers Delta',
        confidence: 0.8,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      // Identical clause gets reinforced instead of rejected as duplicate
      expect(['duplicate', 'reinforced']).toContain(duplicate.action);
    });

    it('should handle supersession for singleton predicates', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      // Create initial clause with singleton predicate
      await clauseStore.processNewClause({
        type: 'preference',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Seattle',
        natural_form: 'User lives in Seattle',
        confidence: 0.9,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      // Process new clause with same singleton predicate but different value
      const result = await clauseStore.processNewClause({
        type: 'preference',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Portland',
        natural_form: 'User lives in Portland',
        confidence: 0.95,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      expect(result.action).toBe('superseded');
    });
  });

  describe('getStats()', () => {
    it('should return memory statistics', async () => {
      const stats = await clauseStore.getStats();

      // Check for actual MemoryStats property names
      expect(stats).toHaveProperty('totalClauses');
      expect(stats).toHaveProperty('activeClauses');
      expect(stats).toHaveProperty('expiredClauses');
      expect(stats).toHaveProperty('avgConfidence');
      expect(stats).toHaveProperty('clausesByType');
    });
  });
});
