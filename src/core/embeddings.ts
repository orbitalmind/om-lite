/**
 * Embeddings module - Vector embeddings for semantic search
 * Supports multiple providers: OpenAI, Anthropic, local models
 * Uses sqlite-vec for vector storage and similarity search
 */

import type { DatabaseManager } from './database.js';

// ========== Types ==========

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingConfig {
  provider: 'openai' | 'anthropic' | 'local' | 'none';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
}

interface EmbeddingRow {
  clause_id: string;
  embedding: Buffer;
  model: string;
  created_at: string;
}

// ========== Embedding Providers ==========

/**
 * OpenAI Embedding Provider
 */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai';
  dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string = 'text-embedding-3-small', baseUrl: string = 'https://api.openai.com/v1') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    // text-embedding-3-small: 1536, text-embedding-3-large: 3072, ada-002: 1536
    this.dimensions = model.includes('large') ? 3072 : 1536;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embeddings API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

/**
 * Anthropic/Voyage Embedding Provider (via Voyage AI)
 */
class VoyageEmbeddingProvider implements EmbeddingProvider {
  name = 'voyage';
  dimensions = 1024;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'voyage-2') {
    this.apiKey = apiKey;
    this.model = model;
    // voyage-2: 1024, voyage-large-2: 1536
    this.dimensions = model.includes('large') ? 1536 : 1024;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage embeddings API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map((d) => d.embedding);
  }
}

/**
 * Local embedding provider using simple TF-IDF-like approach
 * Free, no API key required, runs entirely locally
 */
class LocalEmbeddingProvider implements EmbeddingProvider {
  name = 'local';
  dimensions = 384; // Smaller dimension for local embeddings

  async embed(text: string): Promise<number[]> {
    return this.computeEmbedding(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.computeEmbedding(text));
  }

  private computeEmbedding(text: string): number[] {
    const tokens = this.tokenize(text);
    const embedding = new Array(this.dimensions).fill(0);

    // Simple bag-of-words with hash-based dimensionality reduction
    for (const token of tokens) {
      const hash = this.hashToken(token);
      const idx = Math.abs(hash) % this.dimensions;
      embedding[idx] += 1;
    }

    // Add bigrams for context
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = `${tokens[i]}_${tokens[i + 1]}`;
      const hash = this.hashToken(bigram);
      const idx = Math.abs(hash) % this.dimensions;
      embedding[idx] += 0.5;
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  private hashToken(token: string): number {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      const char = token.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }
}

/**
 * Null provider that returns empty embeddings (disables semantic search)
 */
class NullEmbeddingProvider implements EmbeddingProvider {
  name = 'none';
  dimensions = 0;

  async embed(_text: string): Promise<number[]> {
    return [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

// ========== Embedding Manager ==========

export class EmbeddingManager {
  private db: DatabaseManager;
  private provider: EmbeddingProvider;
  private sqliteVecAvailable = false;

  constructor(db: DatabaseManager, config: EmbeddingConfig = { provider: 'none' }) {
    this.db = db;
    this.provider = this.createProvider(config);
  }

  /**
   * Initialize the embedding system
   */
  async init(): Promise<void> {
    // Check if sqlite-vec is available
    await this.checkSqliteVec();

    // Create embedding table if using vector search
    if (this.sqliteVecAvailable && this.provider.dimensions > 0) {
      await this.createVectorTable();
    }
  }

  /**
   * Check if sqlite-vec extension is available and load it
   */
  private async checkSqliteVec(): Promise<void> {
    try {
      const db = this.db.getDb();

      // Try to dynamically import and load sqlite-vec
      try {
        const sqliteVec = await import('sqlite-vec');
        sqliteVec.load(db);
      } catch {
        // sqlite-vec package not installed
        this.sqliteVecAvailable = false;
        console.warn('sqlite-vec not available, using fallback embedding storage');
        return;
      }

      // Check if vec0 virtual table type exists
      const result = this.db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_clauses'"
      );

      if (result) {
        this.sqliteVecAvailable = true;
        return;
      }

      // Try to create a test vector table
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_clauses USING vec0(
            clause_id TEXT PRIMARY KEY,
            embedding FLOAT[${this.provider.dimensions}]
          )
        `);
        this.sqliteVecAvailable = true;
      } catch {
        // sqlite-vec extension failed to load properly
        this.sqliteVecAvailable = false;
        console.warn('sqlite-vec not available, using fallback embedding storage');
      }
    } catch {
      this.sqliteVecAvailable = false;
    }
  }

  /**
   * Create vector table for semantic search
   */
  private async createVectorTable(): Promise<void> {
    if (!this.sqliteVecAvailable) return;

    const db = this.db.getDb();

    // Create vec0 virtual table for vector similarity search
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_clauses USING vec0(
        clause_id TEXT PRIMARY KEY,
        embedding FLOAT[${this.provider.dimensions}]
      )
    `);
  }

  /**
   * Create embedding provider based on config
   */
  private createProvider(config: EmbeddingConfig): EmbeddingProvider {
    switch (config.provider) {
      case 'openai': {
        const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
        if (!apiKey) {
          console.warn('OpenAI API key not configured, falling back to local embeddings');
          return new LocalEmbeddingProvider();
        }
        return new OpenAIEmbeddingProvider(
          apiKey,
          config.model ?? 'text-embedding-3-small',
          config.baseUrl
        );
      }

      case 'anthropic': {
        const apiKey = config.apiKey ?? process.env.VOYAGE_API_KEY;
        if (!apiKey) {
          console.warn('Voyage API key not configured, falling back to local embeddings');
          return new LocalEmbeddingProvider();
        }
        return new VoyageEmbeddingProvider(apiKey, config.model ?? 'voyage-2');
      }

      case 'local':
        return new LocalEmbeddingProvider();

      case 'none':
      default:
        return new NullEmbeddingProvider();
    }
  }

  /**
   * Get the current provider
   */
  getProvider(): EmbeddingProvider {
    return this.provider;
  }

  /**
   * Check if semantic search is available
   */
  isSemanticSearchAvailable(): boolean {
    return this.provider.dimensions > 0;
  }

  /**
   * Generate and store embedding for a clause
   */
  async embedClause(clauseId: string, text: string): Promise<void> {
    if (this.provider.dimensions === 0) return;

    const embedding = await this.provider.embed(text);
    await this.storeEmbedding(clauseId, embedding);
  }

  /**
   * Generate and store embeddings for multiple clauses
   */
  async embedClausesBatch(
    clauses: Array<{ id: string; text: string }>
  ): Promise<void> {
    if (this.provider.dimensions === 0 || clauses.length === 0) return;

    const texts = clauses.map((c) => c.text);
    const embeddings = await this.provider.embedBatch(texts);

    for (let i = 0; i < clauses.length; i++) {
      await this.storeEmbedding(clauses[i].id, embeddings[i]);
    }
  }

  /**
   * Store embedding in database
   */
  private async storeEmbedding(clauseId: string, embedding: number[]): Promise<void> {
    if (this.sqliteVecAvailable) {
      // Use sqlite-vec for vector storage
      const embeddingJson = JSON.stringify(embedding);
      this.db.run(
        `INSERT OR REPLACE INTO vec_clauses (clause_id, embedding) VALUES (?, ?)`,
        [clauseId, embeddingJson]
      );
    } else {
      // Fallback to BLOB storage in clause_embeddings table
      const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);
      this.db.run(
        `INSERT OR REPLACE INTO clause_embeddings (clause_id, embedding, model, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
        [clauseId, embeddingBuffer, this.provider.name]
      );
    }
  }

  /**
   * Get embedding for a clause
   */
  async getEmbedding(clauseId: string): Promise<number[] | null> {
    if (this.sqliteVecAvailable) {
      const row = this.db.get<{ embedding: string }>(
        'SELECT embedding FROM vec_clauses WHERE clause_id = ?',
        [clauseId]
      );
      return row ? JSON.parse(row.embedding) : null;
    } else {
      const row = this.db.get<EmbeddingRow>(
        'SELECT embedding FROM clause_embeddings WHERE clause_id = ?',
        [clauseId]
      );
      if (!row) return null;

      const floatArray = new Float32Array(row.embedding.buffer);
      return Array.from(floatArray);
    }
  }

  /**
   * Find similar clauses using vector similarity
   */
  async findSimilar(
    query: string,
    options: {
      limit?: number;
      minSimilarity?: number;
      excludeIds?: string[];
    } = {}
  ): Promise<Array<{ clauseId: string; similarity: number }>> {
    if (this.provider.dimensions === 0) return [];

    const { limit = 20, minSimilarity = 0.5, excludeIds = [] } = options;

    // Get query embedding
    const queryEmbedding = await this.provider.embed(query);

    if (this.sqliteVecAvailable) {
      // Use sqlite-vec for fast similarity search
      const queryJson = JSON.stringify(queryEmbedding);

      let sql = `
        SELECT clause_id, distance
        FROM vec_clauses
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `;

      const rows = this.db.all<{ clause_id: string; distance: number }>(
        sql,
        [queryJson, limit * 2] // Get more than needed to filter
      );

      return rows
        .filter((r) => !excludeIds.includes(r.clause_id))
        .map((r) => ({
          clauseId: r.clause_id,
          // Convert distance to similarity (cosine distance to similarity)
          similarity: 1 - r.distance,
        }))
        .filter((r) => r.similarity >= minSimilarity)
        .slice(0, limit);
    } else {
      // Fallback: load all embeddings and compute similarity in JS
      const rows = this.db.all<EmbeddingRow>(
        'SELECT clause_id, embedding FROM clause_embeddings'
      );

      const similarities: Array<{ clauseId: string; similarity: number }> = [];

      for (const row of rows) {
        if (excludeIds.includes(row.clause_id)) continue;

        const embedding = new Float32Array(row.embedding.buffer);
        const similarity = this.cosineSimilarity(queryEmbedding, Array.from(embedding));

        if (similarity >= minSimilarity) {
          similarities.push({
            clauseId: row.clause_id,
            similarity,
          });
        }
      }

      return similarities
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    }
  }

  /**
   * Compute cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Delete embedding for a clause
   */
  async deleteEmbedding(clauseId: string): Promise<void> {
    if (this.sqliteVecAvailable) {
      this.db.run('DELETE FROM vec_clauses WHERE clause_id = ?', [clauseId]);
    }
    this.db.run('DELETE FROM clause_embeddings WHERE clause_id = ?', [clauseId]);
  }

  /**
   * Get embedding statistics
   */
  async getStats(): Promise<{
    totalEmbeddings: number;
    provider: string;
    dimensions: number;
    sqliteVecAvailable: boolean;
  }> {
    let totalEmbeddings = 0;

    if (this.sqliteVecAvailable) {
      const row = this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM vec_clauses'
      );
      totalEmbeddings = row?.count ?? 0;
    } else {
      const row = this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM clause_embeddings'
      );
      totalEmbeddings = row?.count ?? 0;
    }

    return {
      totalEmbeddings,
      provider: this.provider.name,
      dimensions: this.provider.dimensions,
      sqliteVecAvailable: this.sqliteVecAvailable,
    };
  }

  /**
   * Rebuild all embeddings (useful when changing providers)
   */
  async rebuildEmbeddings(
    getClauses: () => Promise<Array<{ id: string; natural_form: string }>>
  ): Promise<{ processed: number; errors: number }> {
    const clauses = await getClauses();
    let processed = 0;
    let errors = 0;

    // Clear existing embeddings
    if (this.sqliteVecAvailable) {
      this.db.run('DELETE FROM vec_clauses');
    }
    this.db.run('DELETE FROM clause_embeddings');

    // Process in batches
    const batchSize = 100;
    for (let i = 0; i < clauses.length; i += batchSize) {
      const batch = clauses.slice(i, i + batchSize);

      try {
        await this.embedClausesBatch(
          batch.map((c) => ({ id: c.id, text: c.natural_form }))
        );
        processed += batch.length;
      } catch (error) {
        console.error('Error embedding batch:', error);
        errors += batch.length;
      }
    }

    return { processed, errors };
  }
}

// Export provider implementations for custom use
export {
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  LocalEmbeddingProvider,
  NullEmbeddingProvider,
};
