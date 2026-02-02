/**
 * DecayRunner module tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DecayRunner } from './decay.js';
import { ClauseStore } from './clauses.js';
import { DatabaseManager } from './database.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('DecayRunner', () => {
  let db: DatabaseManager;
  let clauseStore: ClauseStore;
  let decayRunner: DecayRunner;
  let testDbPath: string;

  beforeEach(async () => {
    const testDir = join(tmpdir(), 'om-lite-test');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    testDbPath = join(testDir, `decay-test-${Date.now()}.db`);
    db = new DatabaseManager(testDbPath);
    await db.init();
    clauseStore = new ClauseStore(db);
    decayRunner = new DecayRunner(db, {
      enabled: true,
      defaultRate: 0.01,
      minConfidence: 0.1,
    });
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

  describe('run()', () => {
    it('should return a decay report', async () => {
      const report = await decayRunner.run();

      // Check for actual property names in DecayReport
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('processed');
      expect(report).toHaveProperty('decayed');
      expect(report).toHaveProperty('archived');
    });

    it('should process clauses in dry run mode without changes', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'pizza',
        natural_form: 'User likes pizza',
        confidence: 0.8,
        decay_rate: 0.1,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      // Run in dry run mode
      const report = await decayRunner.run(true);

      // Verify clause confidence wasn't changed
      const unchanged = await clauseStore.get(clause.id);
      expect(unchanged?.confidence).toBe(0.8);
    });

    it('should not decay recently accessed clauses', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      // Create a clause (will have current last_accessed time)
      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'test',
        predicate: 'is',
        object: 'new',
        natural_form: 'Test is new',
        confidence: 0.9,
        decay_rate: 0.01,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      const report = await decayRunner.run();

      // Recently created clause should have minimal or no decay
      const afterDecay = await clauseStore.get(clause.id);
      expect(afterDecay?.confidence).toBeCloseTo(0.9, 1);
    });
  });

  describe('getDecayHistory()', () => {
    it('should return decay history for a clause', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'tea',
        natural_form: 'User prefers tea',
        confidence: 0.7,
        decay_rate: 0.01,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      // Reinforce to create history
      await decayRunner.reinforce(clause.id, 0.05);

      const history = await decayRunner.getDecayHistory(clause.id);
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('adjustConfidence()', () => {
    it('should manually adjust clause confidence', async () => {
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
        decay_rate: 0.01,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      await decayRunner.adjustConfidence(clause.id, 0.3, 'test_adjustment');

      const updated = await clauseStore.get(clause.id);
      expect(updated?.confidence).toBe(0.3);
    });
  });

  describe('getStats()', () => {
    it('should return decay statistics', async () => {
      const stats = await decayRunner.getStats();

      // Check for actual stats properties
      expect(stats).toHaveProperty('totalDecayEvents');
      expect(stats).toHaveProperty('totalArchived');
      expect(stats).toHaveProperty('avgDecayRate');
      expect(stats).toHaveProperty('mostDecayed');
    });
  });

  describe('reinforcement', () => {
    it('should increase clause confidence on reinforcement', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'hiking',
        natural_form: 'User likes hiking',
        confidence: 0.8,
        decay_rate: 0.01,
        source_id: sourceId,
        extraction_method: 'manual',
      });

      const originalConfidence = clause.confidence;

      // Reinforce using DecayRunner's method
      await decayRunner.reinforce(clause.id, 0.05);

      const reinforced = await clauseStore.get(clause.id);
      expect(reinforced?.confidence).toBeGreaterThan(originalConfidence);
      expect(reinforced?.reinforcement_count).toBe(1);
    });
  });
});
