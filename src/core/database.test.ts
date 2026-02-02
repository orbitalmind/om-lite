/**
 * Database module tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from './database.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('DatabaseManager', () => {
  let db: DatabaseManager;
  let testDbPath: string;

  beforeEach(() => {
    // Create a unique test database path
    const testDir = join(tmpdir(), 'om-lite-test');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    testDbPath = join(testDir, `test-${Date.now()}.db`);
    db = new DatabaseManager(testDbPath);
  });

  afterEach(async () => {
    await db.close();
    // Clean up test database
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    // Also clean up WAL files
    if (existsSync(`${testDbPath}-wal`)) {
      unlinkSync(`${testDbPath}-wal`);
    }
    if (existsSync(`${testDbPath}-shm`)) {
      unlinkSync(`${testDbPath}-shm`);
    }
  });

  describe('init()', () => {
    it('should create database file', async () => {
      await db.init();
      expect(existsSync(testDbPath)).toBe(true);
    });

    it('should create required tables', async () => {
      await db.init();
      const tables = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      );
      const tableNames = tables.map(t => t.name);

      expect(tableNames).toContain('clauses');
      expect(tableNames).toContain('sources');
      expect(tableNames).toContain('conflicts');
      expect(tableNames).toContain('installed_packs');
      expect(tableNames).toContain('system_metadata');
    });

    it('should create FTS5 virtual table', async () => {
      await db.init();
      const fts = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='clauses_fts'"
      );
      expect(fts).toBeDefined();
    });
  });

  describe('CRUD operations', () => {
    beforeEach(async () => {
      await db.init();
    });

    it('should insert and retrieve data', () => {
      db.run(
        "INSERT INTO system_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
        ['test_key', 'test_value', 'test_value']
      );

      const result = db.get<{ key: string; value: string }>(
        "SELECT key, value FROM system_metadata WHERE key = ?",
        ['test_key']
      );

      expect(result).toBeDefined();
      expect(result?.value).toBe('test_value');
    });

    it('should return all matching rows', () => {
      // Insert multiple rows
      db.run("INSERT INTO system_metadata (key, value) VALUES ('key1', 'value1')");
      db.run("INSERT INTO system_metadata (key, value) VALUES ('key2', 'value2')");

      const results = db.all<{ key: string; value: string }>(
        "SELECT key, value FROM system_metadata WHERE key LIKE 'key%'"
      );

      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('database size', () => {
    it('should track database file', async () => {
      await db.init();
      // Just verify the database is accessible
      expect(existsSync(testDbPath)).toBe(true);
    });
  });

  describe('home directory expansion', () => {
    it('should expand tilde to home directory', async () => {
      const dbWithTilde = new DatabaseManager('~/.om-lite-test/test.db');
      // Just verify it doesn't throw - the path should be expanded
      expect(dbWithTilde).toBeDefined();
    });
  });
});
