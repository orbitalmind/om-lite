/**
 * Tests for newly implemented features
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClauseStore } from '../src/core/clauses.js';
import { Retriever } from '../src/core/retrieval.js';
import { DatabaseManager } from '../src/core/database.js';
import { Scheduler } from '../src/core/scheduler.js';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('New Features', () => {
  let db: DatabaseManager;
  let clauseStore: ClauseStore;
  let retriever: Retriever;
  let testDbPath: string;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), 'om-lite-features-test');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    testDbPath = join(testDir, `features-test-${Date.now()}.db`);
    db = new DatabaseManager(testDbPath);
    await db.init();
    clauseStore = new ClauseStore(db);
    retriever = new Retriever(db);
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

  describe('Full Export', () => {
    it('should generate full export with all clauses', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      await clauseStore.create({
        type: 'fact',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Denver',
        natural_form: 'User lives in Denver',
        source_id: sourceId,
        extraction_method: 'test',
      });

      const fullExport = await clauseStore.generateFullExport();

      expect(fullExport).toContain('Complete Memory Export');
      expect(fullExport).toContain('User lives in Denver');
      expect(fullExport).toContain('| Type | fact |');
    });

    it('should export as JSON', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'dark mode',
        natural_form: 'User prefers dark mode',
        source_id: sourceId,
        extraction_method: 'test',
      });

      const jsonExport = await clauseStore.exportAsJson();
      const parsed = JSON.parse(jsonExport);

      expect(parsed.version).toBe('1.0');
      expect(parsed.total_clauses).toBe(1);
      expect(parsed.clauses[0].natural_form).toBe('User prefers dark mode');
    });
  });

  describe('Access Logging', () => {
    it('should log clause access', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'test',
        predicate: 'is',
        object: 'working',
        natural_form: 'Test is working',
        source_id: sourceId,
        extraction_method: 'test',
      });

      const accessId = clauseStore.logClauseAccess(clause.id, 'retrieval', 'test query');
      expect(accessId).toBeDefined();

      const history = clauseStore.getAccessHistory(clause.id);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].access_type).toBe('retrieval');
    });

    it('should mark access as useful', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'test',
        predicate: 'is',
        object: 'working',
        natural_form: 'Test is working',
        source_id: sourceId,
        extraction_method: 'test',
      });

      const accessId = clauseStore.logClauseAccess(clause.id, 'retrieval', 'test query');
      clauseStore.markAccessUseful(accessId, true);

      const history = clauseStore.getAccessHistory(clause.id);
      expect(history[0].was_useful).toBe(1);
    });

    it('should track unhelpful clauses', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      const clause = await clauseStore.create({
        type: 'fact',
        subject: 'test',
        predicate: 'is',
        object: 'unhelpful',
        natural_form: 'Unhelpful clause',
        source_id: sourceId,
        extraction_method: 'test',
      });

      // Log several unhelpful accesses
      for (let i = 0; i < 3; i++) {
        const accessId = clauseStore.logClauseAccess(clause.id, 'retrieval', `query ${i}`);
        clauseStore.markAccessUseful(accessId, false);
      }

      const unhelpful = clauseStore.getUnhelpfulClauses();
      expect(unhelpful.length).toBeGreaterThan(0);
      expect(unhelpful[0].clause_id).toBe(clause.id);
      expect(unhelpful[0].unhelpful_count).toBe(3);
    });
  });

  describe('Retrieve For Task', () => {
    it('should retrieve relevant memory for a task', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'manual',
        content: 'Test',
      });

      // Create some test clauses
      await clauseStore.create({
        type: 'preference',
        subject: 'user',
        predicate: 'prefers',
        object: 'window seat',
        natural_form: 'User prefers window seats',
        source_id: sourceId,
        extraction_method: 'test',
      });

      await clauseStore.create({
        type: 'fact',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Denver',
        natural_form: 'User lives in Denver',
        source_id: sourceId,
        extraction_method: 'test',
      });

      const result = await retriever.retrieveForTask({
        description: 'Book a flight',
        context: 'user needs to travel',
      });

      expect(result.clauses).toBeDefined();
      expect(result.preferences).toBeDefined();
      expect(result.facts).toBeDefined();
      expect(result.formatted).toBeDefined();
    });
  });

  describe('Scheduler', () => {
    it('should create scheduler with default config', () => {
      const scheduler = new Scheduler();
      const stats = scheduler.getStats();

      expect(stats.isRunning).toBe(false);
      expect(stats.jobs).toHaveLength(0);
    });

    it('should start and stop scheduler', () => {
      const scheduler = new Scheduler({
        decayEnabled: false,
        backupEnabled: false,
        retentionEnabled: false,
      });

      scheduler.start();
      expect(scheduler.getStats().isRunning).toBe(true);

      scheduler.stop();
      expect(scheduler.getStats().isRunning).toBe(false);
    });
  });

  describe('Source Archiving', () => {
    let archiveDir: string;

    beforeEach(() => {
      archiveDir = join(testDir, 'archive');
      if (!existsSync(archiveDir)) {
        mkdirSync(archiveDir, { recursive: true });
      }
    });

    afterEach(() => {
      if (existsSync(archiveDir)) {
        rmSync(archiveDir, { recursive: true, force: true });
      }
    });

    it('should archive source to file', async () => {
      const sourceId = await clauseStore.createSource({
        type: 'conversation',
        content: 'Test conversation',
      });

      const content = { messages: ['Hello', 'World'] };
      const filePath = await clauseStore.archiveSourceToFile(sourceId, content, {
        subdir: archiveDir,
      });

      expect(existsSync(filePath)).toBe(true);
    });
  });
});
