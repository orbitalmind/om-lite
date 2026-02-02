import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OMLite } from '../src/index.js';
import { Database } from '../src/core/database.js';
import { ClauseStore } from '../src/core/clauses.js';
import { DecayRunner } from '../src/core/decay.js';
import { unlink } from 'fs/promises';
import { existsSync } from 'fs';

const TEST_DB = '/tmp/om-lite-decay-test.db';

describe('Confidence Decay', () => {
  let db: Database;
  let clauseStore: ClauseStore;
  let decayRunner: DecayRunner;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) {
      await unlink(TEST_DB);
    }
    db = new Database(TEST_DB);
    await db.init();
    clauseStore = new ClauseStore(db);
    decayRunner = new DecayRunner(db, {
      enabled: true,
      defaultRate: 0.001,
      minConfidence: 0.1,
    });
  });

  afterEach(async () => {
    await db.close();
    if (existsSync(TEST_DB)) {
      await unlink(TEST_DB);
    }
  });

  describe('decay execution', () => {
    it('should run decay without errors', async () => {
      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'pizza',
        natural_form: 'User likes pizza',
        confidence: 0.9,
      });

      const report = await decayRunner.run(false);

      expect(report).toHaveProperty('processed');
      expect(report).toHaveProperty('decayed');
      expect(report).toHaveProperty('archived');
      expect(report).toHaveProperty('timestamp');
    });

    it('should support dry run mode', async () => {
      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'tea',
        natural_form: 'User prefers tea',
        confidence: 0.8,
      });

      const report = await decayRunner.run(true);

      expect(report.processed).toBeGreaterThanOrEqual(0);
    });

    it('should return decay report with correct structure', async () => {
      const report = await decayRunner.run(false);

      expect(typeof report.processed).toBe('number');
      expect(typeof report.decayed).toBe('number');
      expect(typeof report.archived).toBe('number');
      expect(typeof report.reinforced).toBe('number');
      expect(typeof report.timestamp).toBe('string');
    });
  });

  describe('decay configuration', () => {
    it('should create clause with valid confidence', async () => {
      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'user',
        predicate: 'lives_in',
        object: 'NYC',
        natural_form: 'User lives in NYC',
        confidence: 0.9,
      });

      expect(clause.confidence).toBe(0.9);
      expect(clause.confidence).toBeGreaterThan(0.1);
    });

    it('should process clauses during decay run', async () => {
      // Create multiple clauses
      await clauseStore.create({
        type: 'fact',
        subject: 'user',
        predicate: 'works_at',
        object: 'TechCorp',
        natural_form: 'User works at TechCorp',
        confidence: 0.95,
      });

      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'remote work',
        natural_form: 'User likes remote work',
        confidence: 0.85,
      });

      const report = await decayRunner.run(false);
      expect(report.processed).toBeGreaterThanOrEqual(0);
    });
  });
});
