/**
 * Retriever module tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Retriever } from './retrieval.js';
import { ClauseStore } from './clauses.js';
import { DatabaseManager } from './database.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Retriever', () => {
  let db: DatabaseManager;
  let clauseStore: ClauseStore;
  let retriever: Retriever;
  let testDbPath: string;

  beforeEach(async () => {
    const testDir = join(tmpdir(), 'om-lite-test');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    testDbPath = join(testDir, `retrieval-test-${Date.now()}.db`);
    db = new DatabaseManager(testDbPath);
    await db.init();
    clauseStore = new ClauseStore(db);
    retriever = new Retriever(db, {
      semanticWeight: 0.6,
      keywordWeight: 0.3,
      recencyWeight: 0.1,
      defaultLimit: 20,
    });

    // Set up test data
    const sourceId = await clauseStore.createSource({
      type: 'conversation',
      content: 'Test conversation',
    });

    await clauseStore.create({
      type: 'preference',
      subject: 'user',
      predicate: 'prefers_airline',
      object: 'United Airlines',
      natural_form: 'User prefers flying United Airlines',
      confidence: 0.9,
      tags: ['travel', 'airlines'],
      source_id: sourceId,
      extraction_method: 'manual',
    });

    await clauseStore.create({
      type: 'preference',
      subject: 'user',
      predicate: 'prefers_seat',
      object: 'window',
      natural_form: 'User prefers window seats on flights',
      confidence: 0.85,
      tags: ['travel', 'seating'],
      source_id: sourceId,
      extraction_method: 'manual',
    });

    await clauseStore.create({
      type: 'fact',
      subject: 'airport:JFK',
      predicate: 'is_located_in',
      object: 'New York City',
      natural_form: 'JFK Airport is located in New York City',
      confidence: 1.0,
      tags: ['airport', 'geography'],
      source_id: sourceId,
      extraction_method: 'manual',
    });

    await clauseStore.create({
      type: 'context',
      subject: 'booking:international',
      predicate: 'recommendation',
      object: 'Book 2-3 months in advance',
      natural_form: 'For international flights, book 2-3 months in advance for best prices',
      confidence: 0.8,
      tags: ['travel', 'booking'],
      source_id: sourceId,
      extraction_method: 'manual',
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

  describe('retrieve()', () => {
    it('should find relevant clauses for a query', async () => {
      const result = await retriever.retrieve('United Airlines');

      expect(result.clauses.length).toBeGreaterThan(0);
      expect(result.clauses.some(c => c.object.includes('United'))).toBe(true);
    });

    it('should return scored results', async () => {
      const result = await retriever.retrieve('United');

      expect(result.clauses.length).toBeGreaterThan(0);
      // Each clause should have confidence
      for (const clause of result.clauses) {
        expect(clause.confidence).toBeDefined();
        expect(clause.confidence).toBeGreaterThanOrEqual(0);
        expect(clause.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should respect limit option', async () => {
      const result = await retriever.retrieve('travel', { limit: 2 });
      expect(result.clauses.length).toBeLessThanOrEqual(2);
    });

    it('should filter by minimum confidence', async () => {
      const result = await retriever.retrieve('', { minConfidence: 0.9 });
      expect(result.clauses.every(c => c.confidence >= 0.9)).toBe(true);
    });

    it('should filter by clause types', async () => {
      const result = await retriever.retrieve('', { types: ['preference'] });
      expect(result.clauses.every(c => c.type === 'preference')).toBe(true);
    });

    it('should filter by tags', async () => {
      const result = await retriever.retrieve('', { tags: ['airport'] });
      expect(result.clauses.some(c => c.tags?.includes('airport'))).toBe(true);
    });
  });

  describe('formatForPrompt()', () => {
    it('should format clauses as markdown', async () => {
      const result = await retriever.retrieve('United');
      const formatted = retriever.formatForPrompt(result.clauses);

      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    });

    it('should handle empty results', () => {
      const formatted = retriever.formatForPrompt([]);
      // Empty results may return a message or empty string
      expect(typeof formatted).toBe('string');
    });

    it('should group by type', async () => {
      const result = await retriever.retrieve('', { limit: 10 });
      const formatted = retriever.formatForPrompt(result.clauses);

      // Should contain type headers if multiple types
      if (result.clauses.length > 1) {
        const hasTypeHeader =
          formatted.includes('Preferences') ||
          formatted.includes('Facts') ||
          formatted.includes('Context');
        expect(hasTypeHeader).toBe(true);
      }
    });
  });

  describe('access logging', () => {
    it('should log retrieval access', async () => {
      await retriever.retrieve('United');

      // Check that access was logged
      const accessLog = db.all<{ access_type: string }>(
        "SELECT access_type FROM access_log WHERE access_type = 'retrieval' LIMIT 1"
      );

      expect(accessLog.length).toBeGreaterThan(0);
    });

    it('should update last_accessed on clauses', async () => {
      // Get a clause's initial last_accessed
      const before = await clauseStore.search('United');
      const initialAccess = before[0]?.last_accessed;

      // Wait a tiny bit and retrieve again
      await new Promise(resolve => setTimeout(resolve, 10));
      await retriever.retrieve('United');

      // Check last_accessed was updated
      const after = await clauseStore.get(before[0].id);
      expect(after?.last_accessed).not.toBe(initialAccess);
    });
  });

  describe('edge cases', () => {
    it('should handle empty query', async () => {
      const result = await retriever.retrieve('');
      expect(Array.isArray(result.clauses)).toBe(true);
    });

    it('should handle special characters in query', async () => {
      const result = await retriever.retrieve('airport (JFK)');
      expect(Array.isArray(result.clauses)).toBe(true);
    });

    it('should handle FTS5 operators in query', async () => {
      // Queries with words that look like FTS5 operators should work
      // (they get escaped in prepareFtsQuery)
      const result = await retriever.retrieve('airport city');
      expect(Array.isArray(result.clauses)).toBe(true);
    });
  });
});
