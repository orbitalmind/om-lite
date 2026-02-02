/**
 * Retrieval module - Hybrid search for memory retrieval
 * Combines FTS5 keyword search with semantic search via embeddings
 */

import { v7 as uuidv7 } from 'uuid';
import type { DatabaseManager } from './database.js';
import type { EmbeddingManager } from './embeddings.js';
import type {
  Clause,
  ClauseType,
  RetrievalOptions,
  RetrievalResult,
  ScoredClause,
} from './types.js';
import { formatClausesForPrompt } from './sanitization.js';

interface RetrievalConfig {
  semanticWeight: number;
  keywordWeight: number;
  recencyWeight: number;
  defaultLimit: number;
  useLLMQueryRewriting: boolean;
}

interface ClauseRow {
  id: string;
  type: string;
  subject: string;
  predicate: string;
  object: string;
  natural_form: string;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  confidence: number;
  decay_rate: number;
  reinforcement_count: number;
  source_id: string;
  extraction_method: string;
  last_accessed: string;
  access_count: number;
  tags: string;
  metadata: string;
  score?: number;
}

// LLM client interface for query rewriting
interface LLMClient {
  complete(prompt: string): Promise<string>;
}

export class Retriever {
  private db: DatabaseManager;
  private config: RetrievalConfig;
  private embeddingManager?: EmbeddingManager;
  private llmClient?: LLMClient;

  constructor(
    db: DatabaseManager,
    config: Partial<RetrievalConfig> = {},
    embeddingManager?: EmbeddingManager,
    llmClient?: LLMClient
  ) {
    this.db = db;
    this.config = {
      semanticWeight: config.semanticWeight ?? 0.6,
      keywordWeight: config.keywordWeight ?? 0.3,
      recencyWeight: config.recencyWeight ?? 0.1,
      defaultLimit: config.defaultLimit ?? 20,
      useLLMQueryRewriting: config.useLLMQueryRewriting ?? false,
    };
    this.embeddingManager = embeddingManager;
    this.llmClient = llmClient;
  }

  /**
   * Set embedding manager (for lazy initialization)
   */
  setEmbeddingManager(manager: EmbeddingManager): void {
    this.embeddingManager = manager;
  }

  /**
   * Set LLM client for query rewriting
   */
  setLLMClient(client: LLMClient): void {
    this.llmClient = client;
  }

  /**
   * Check if semantic search is available
   */
  isSemanticSearchAvailable(): boolean {
    return this.embeddingManager?.isSemanticSearchAvailable() ?? false;
  }

  /**
   * Retrieve relevant clauses for a query using hybrid search
   */
  async retrieve(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult> {
    const {
      types,
      minConfidence = 0.5,
      includeExpired = false,
      limit = this.config.defaultLimit,
      boostRecent = false,
      semanticWeight = this.config.semanticWeight,
      keywordWeight = this.config.keywordWeight,
    } = options;

    // Determine if we can use semantic search
    const canUseSemanticSearch = this.isSemanticSearchAvailable() && semanticWeight > 0;

    // Perform keyword search via FTS5
    const keywordResults = await this.keywordSearch(query, {
      types,
      minConfidence,
      includeExpired,
      limit: limit * 2, // Get extra results for merging
    });

    // Perform semantic search if available
    let semanticResults: Array<{ clauseId: string; similarity: number }> = [];
    if (canUseSemanticSearch && query.trim()) {
      semanticResults = await this.embeddingManager!.findSimilar(query, {
        limit: limit * 2,
        minSimilarity: 0.3,
      });
    }

    // Calculate actual weights based on availability
    const actualSemanticWeight = canUseSemanticSearch ? semanticWeight : 0;
    const actualKeywordWeight = canUseSemanticSearch
      ? keywordWeight
      : keywordWeight + semanticWeight; // Transfer semantic weight to keyword if unavailable

    // Merge and score results
    const scoredClauses = await this.mergeAndScore(
      keywordResults,
      semanticResults,
      query,
      {
        semanticWeight: actualSemanticWeight,
        keywordWeight: actualKeywordWeight,
        recencyWeight: boostRecent ? this.config.recencyWeight : 0,
      }
    );

    // Take top N results
    const topResults = scoredClauses.slice(0, limit);

    // Log access for retrieved clauses
    for (const clause of topResults) {
      await this.logAccess(clause.id, 'retrieval', query);
    }

    return {
      clauses: topResults,
      totalMatches: Math.max(keywordResults.length, semanticResults.length),
      retrievalMethod: canUseSemanticSearch ? 'hybrid' : 'keyword',
    };
  }

  /**
   * Progressive retrieval - multi-stage search
   * Stage 1: Direct query match
   * Stage 2: Entity extraction and search
   * Stage 3: Relationship expansion
   */
  async progressiveRetrieve(
    query: string,
    options: RetrievalOptions & { maxStages?: number } = {}
  ): Promise<RetrievalResult> {
    const { maxStages = 3, limit = this.config.defaultLimit } = options;
    const allClauses: Map<string, ScoredClause> = new Map();
    let retrievalMethod: 'semantic' | 'keyword' | 'hybrid' = 'keyword';

    // Stage 1: Direct query
    const stage1 = await this.retrieve(query, { ...options, limit: Math.ceil(limit * 0.6) });
    for (const clause of stage1.clauses) {
      allClauses.set(clause.id, clause);
    }
    if (stage1.retrievalMethod === 'hybrid') retrievalMethod = 'hybrid';

    if (maxStages < 2 || allClauses.size >= limit) {
      return this.buildResult(allClauses, limit, retrievalMethod);
    }

    // Stage 2: Entity extraction and search
    // Use LLM-based extraction if available, otherwise use rule-based
    const entities = this.config.useLLMQueryRewriting && this.llmClient
      ? await this.extractEntitiesWithLLM(query)
      : this.extractEntities(query);
    for (const entity of entities) {
      const stage2 = await this.retrieve(entity, {
        ...options,
        limit: Math.ceil(limit * 0.3),
      });
      for (const clause of stage2.clauses) {
        if (!allClauses.has(clause.id)) {
          // Apply a small penalty for indirect matches
          allClauses.set(clause.id, { ...clause, score: clause.score * 0.8 });
        }
      }
      if (stage2.retrievalMethod === 'hybrid') retrievalMethod = 'hybrid';
    }

    if (maxStages < 3 || allClauses.size >= limit) {
      return this.buildResult(allClauses, limit, retrievalMethod);
    }

    // Stage 3: Relationship expansion - find related clauses
    const subjects = new Set<string>();
    for (const clause of allClauses.values()) {
      subjects.add(clause.subject);
    }

    for (const subject of subjects) {
      const relatedClauses = this.db.all<ClauseRow>(
        `SELECT * FROM clauses
         WHERE subject = ? AND valid_to IS NULL AND confidence > 0.5
         LIMIT 5`,
        [subject]
      );

      for (const row of relatedClauses) {
        if (!allClauses.has(row.id)) {
          const clause = this.rowToClause(row);
          allClauses.set(row.id, { ...clause, score: 0.3 }); // Lower score for expansion
        }
      }
    }

    return this.buildResult(allClauses, limit, retrievalMethod);
  }

  /**
   * Keyword search using FTS5
   */
  private async keywordSearch(
    query: string,
    options: {
      types?: ClauseType[];
      minConfidence: number;
      includeExpired: boolean;
      limit: number;
    }
  ): Promise<ClauseRow[]> {
    const { types, minConfidence, includeExpired, limit } = options;

    if (!query || !query.trim()) {
      // No query - return top clauses by confidence
      let sql = `
        SELECT *, 1.0 as score FROM clauses c
        WHERE c.confidence >= ?
      `;
      const params: unknown[] = [minConfidence];

      if (!includeExpired) {
        sql += ' AND c.valid_to IS NULL';
      }

      if (types && types.length > 0) {
        sql += ` AND c.type IN (${types.map(() => '?').join(',')})`;
        params.push(...types);
      }

      sql += ' ORDER BY c.confidence DESC, c.last_accessed DESC LIMIT ?';
      params.push(limit);

      return this.db.all<ClauseRow>(sql, params);
    }

    // Escape special FTS5 characters and prepare query
    const escapedQuery = this.prepareFtsQuery(query);

    let sql = `
      SELECT c.*, bm25(clauses_fts) as score
      FROM clauses c
      JOIN clauses_fts ON c.rowid = clauses_fts.rowid
      WHERE clauses_fts MATCH ?
        AND c.confidence >= ?
    `;
    const params: unknown[] = [escapedQuery, minConfidence];

    if (!includeExpired) {
      sql += ' AND c.valid_to IS NULL';
    }

    if (types && types.length > 0) {
      sql += ` AND c.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ' ORDER BY score LIMIT ?';
    params.push(limit);

    return this.db.all<ClauseRow>(sql, params);
  }

  /**
   * Prepare a query string for FTS5
   */
  private prepareFtsQuery(query: string): string {
    // Remove special FTS5 characters
    let clean = query.replace(/['"(){}[\]:*^~]/g, ' ');

    // Normalize whitespace
    clean = clean.replace(/\s+/g, ' ').trim();

    // Split into words and create OR query for flexibility
    const words = clean.split(' ').filter((w) => w.length > 1);

    if (words.length === 0) {
      return '*'; // Match everything
    }

    if (words.length === 1) {
      return words[0] + '*'; // Prefix match for single word
    }

    // For multiple words, try exact phrase first, then OR of words
    return words.join(' OR ');
  }

  /**
   * Merge keyword and semantic results with scoring
   */
  private async mergeAndScore(
    keywordResults: ClauseRow[],
    semanticResults: Array<{ clauseId: string; similarity: number }>,
    query: string,
    weights: {
      semanticWeight: number;
      keywordWeight: number;
      recencyWeight: number;
    }
  ): Promise<ScoredClause[]> {
    const now = Date.now();
    const clauseScores: Map<string, { clause: Clause; keywordScore: number; semanticScore: number }> = new Map();

    // Process keyword results
    for (const row of keywordResults) {
      const clause = this.rowToClause(row);
      const ftsScore = row.score ?? 0;
      // BM25 returns negative values (more negative = better match)
      const normalizedFtsScore = Math.max(0, 1 + ftsScore / 10);

      clauseScores.set(clause.id, {
        clause,
        keywordScore: normalizedFtsScore,
        semanticScore: 0,
      });
    }

    // Process semantic results
    for (const result of semanticResults) {
      const existing = clauseScores.get(result.clauseId);
      if (existing) {
        existing.semanticScore = result.similarity;
      } else {
        // Fetch clause from database
        const row = this.db.get<ClauseRow>(
          'SELECT * FROM clauses WHERE id = ?',
          [result.clauseId]
        );
        if (row) {
          clauseScores.set(result.clauseId, {
            clause: this.rowToClause(row),
            keywordScore: 0,
            semanticScore: result.similarity,
          });
        }
      }
    }

    // Calculate final scores
    const queryLower = query.toLowerCase();
    const queryWords = new Set(queryLower.split(/\s+/).filter((w) => w.length > 2));

    const scoredClauses: ScoredClause[] = [];

    for (const { clause, keywordScore, semanticScore } of clauseScores.values()) {
      let score = 0;

      // Semantic score contribution
      score += semanticScore * weights.semanticWeight;

      // Keyword score contribution
      score += keywordScore * weights.keywordWeight;

      // Confidence contributes to score
      score += clause.confidence * 0.2;

      // Recency boost
      if (weights.recencyWeight > 0) {
        const lastAccess = new Date(clause.last_accessed).getTime();
        const daysSinceAccess = (now - lastAccess) / (1000 * 60 * 60 * 24);
        const recencyScore = Math.max(0, 1 - daysSinceAccess / 30); // Decay over 30 days
        score += recencyScore * weights.recencyWeight;
      }

      // Exact match bonus
      const naturalLower = clause.natural_form.toLowerCase();
      for (const word of queryWords) {
        if (naturalLower.includes(word)) {
          score += 0.05;
        }
      }

      // Subject/predicate match bonus
      if (queryLower.includes(clause.subject.toLowerCase())) {
        score += 0.05;
      }
      if (queryLower.includes(clause.predicate.replace(/_/g, ' ').toLowerCase())) {
        score += 0.05;
      }

      scoredClauses.push({
        ...clause,
        score: Math.min(1, score), // Cap at 1.0
      });
    }

    return scoredClauses.sort((a, b) => b.score - a.score);
  }

  /**
   * Convert database row to Clause object
   */
  private rowToClause(row: ClauseRow): Clause {
    return {
      id: row.id,
      type: row.type as ClauseType,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      natural_form: row.natural_form,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      recorded_at: row.recorded_at,
      confidence: row.confidence,
      decay_rate: row.decay_rate,
      reinforcement_count: row.reinforcement_count,
      source_id: row.source_id,
      extraction_method: row.extraction_method,
      last_accessed: row.last_accessed,
      access_count: row.access_count,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  /**
   * Log access for a clause
   */
  private async logAccess(
    clauseId: string,
    accessType: 'retrieval' | 'injection' | 'reinforcement',
    context: string
  ): Promise<void> {
    const id = uuidv7();

    // Update clause access tracking
    this.db.run(
      `UPDATE clauses
       SET last_accessed = datetime('now'),
           access_count = access_count + 1
       WHERE id = ?`,
      [clauseId]
    );

    // Log to access_log table
    this.db.run(
      `INSERT INTO access_log (id, clause_id, access_type, context)
       VALUES (?, ?, ?, ?)`,
      [id, clauseId, accessType, context.slice(0, 500)] // Truncate context
    );
  }

  /**
   * Format retrieved clauses for prompt injection (with sanitization)
   */
  formatForPrompt(clauses: ScoredClause[], options?: { maxLength?: number }): string {
    return formatClausesForPrompt(
      clauses.map((c) => ({ type: c.type, natural_form: c.natural_form })),
      { maxTotalLength: options?.maxLength ?? 4000 }
    );
  }

  /**
   * Rewrite query for better retrieval
   * Uses LLM if available, falls back to rule-based expansion
   */
  async rewriteQuery(
    query: string,
    conversationHistory: string[] = []
  ): Promise<string> {
    // Try LLM-based rewriting if available and enabled
    if (this.config.useLLMQueryRewriting && this.llmClient) {
      try {
        return await this.llmQueryRewrite(query, conversationHistory);
      } catch (error) {
        console.warn('LLM query rewriting failed, using fallback:', error);
      }
    }

    // Fallback to rule-based expansion
    return this.ruleBasedQueryRewrite(query, conversationHistory);
  }

  /**
   * LLM-based query rewriting
   */
  private async llmQueryRewrite(
    query: string,
    conversationHistory: string[]
  ): Promise<string> {
    const context = conversationHistory.slice(-5).join('\n');

    const prompt = `Given this user query and recent conversation context, rewrite the query to be more specific and searchable for a memory system.

Recent context:
${context || 'No recent context'}

Original query: ${query}

Instructions:
1. Resolve pronouns (it, this, that, they) to specific nouns from context
2. Expand abbreviations
3. Add relevant synonyms
4. Keep the rewritten query concise (under 50 words)
5. Output ONLY the rewritten query, nothing else

Rewritten query:`;

    const response = await this.llmClient!.complete(prompt);
    return response.trim() || query;
  }

  /**
   * Rule-based query rewriting (fallback)
   */
  private ruleBasedQueryRewrite(
    query: string,
    conversationHistory: string[]
  ): string {
    let expanded = query;

    // Resolve common pronouns using recent context
    const lastMessages = conversationHistory.slice(-3).join(' ').toLowerCase();

    // Simple pronoun resolution
    if (query.match(/\b(it|this|that)\b/i) && !query.match(/\b(it|this|that)\s+(is|was|has|will)\b/i)) {
      // Try to find a noun from recent context
      const nouns = lastMessages.match(/\b(flight|booking|hotel|restaurant|meeting|email|task|project|document|file|report|appointment|schedule|event|ticket|reservation)\b/gi);
      if (nouns && nouns.length > 0) {
        const lastNoun = nouns[nouns.length - 1];
        expanded = query.replace(/\b(it|this|that)\b/i, lastNoun);
      }
    }

    // Expand abbreviations
    const abbreviations: Record<string, string> = {
      'pref': 'preference',
      'prefs': 'preferences',
      'info': 'information',
      'tmrw': 'tomorrow',
      'asap': 'as soon as possible',
      'appt': 'appointment',
      'mtg': 'meeting',
      'msg': 'message',
      'addr': 'address',
      'loc': 'location',
      'fav': 'favorite',
      'freq': 'frequently',
      'usu': 'usually',
    };

    for (const [abbr, full] of Object.entries(abbreviations)) {
      expanded = expanded.replace(new RegExp(`\\b${abbr}\\b`, 'gi'), full);
    }

    // Handle temporal references
    const now = new Date();
    expanded = expanded
      .replace(/\btoday\b/gi, now.toLocaleDateString())
      .replace(/\bthis week\b/gi, `week of ${now.toLocaleDateString()}`)
      .replace(/\bthis month\b/gi, now.toLocaleString('default', { month: 'long', year: 'numeric' }));

    // Add synonyms for common terms
    const synonyms: Record<string, string[]> = {
      'likes': ['prefers', 'enjoys', 'loves'],
      'dislikes': ['avoids', 'hates'],
      'lives': ['resides', 'located'],
      'works': ['employed', 'job'],
    };

    for (const [term, syns] of Object.entries(synonyms)) {
      if (expanded.toLowerCase().includes(term)) {
        // Add first synonym as alternative
        expanded += ` OR ${syns[0]}`;
        break; // Only add one expansion to keep query reasonable
      }
    }

    return expanded;
  }

  /**
   * Extract entities from query for progressive retrieval
   */
  private extractEntities(query: string): string[] {
    const entities: string[] = [];

    // Extract quoted strings
    const quoted = query.match(/"([^"]+)"/g);
    if (quoted) {
      entities.push(...quoted.map((q) => q.replace(/"/g, '')));
    }

    // Extract capitalized words (likely proper nouns)
    const properNouns = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);
    if (properNouns) {
      entities.push(...properNouns);
    }

    // Extract @mentions
    const mentions = query.match(/@\w+/g);
    if (mentions) {
      entities.push(...mentions.map((m) => m.slice(1)));
    }

    // Extract numbers that might be significant (dates, amounts)
    const numbers = query.match(/\b\d{4}\b|\$[\d,]+|\d+%/g);
    if (numbers) {
      entities.push(...numbers);
    }

    // Extract common entity patterns
    const patterns = [
      /(?:flight|hotel|booking|reservation)\s+(?:to|for|at)\s+(\w+)/gi,
      /(?:meeting|call|appointment)\s+with\s+(\w+)/gi,
      /(?:project|task|work)\s+(?:on|for)\s+(\w+)/gi,
    ];

    for (const pattern of patterns) {
      const matches = query.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          entities.push(match[1]);
        }
      }
    }

    return [...new Set(entities)]; // Deduplicate
  }

  /**
   * Extract entities using LLM for better accuracy (when available)
   */
  private async extractEntitiesWithLLM(query: string): Promise<string[]> {
    if (!this.llmClient) {
      return this.extractEntities(query);
    }

    try {
      const prompt = `Extract named entities (people, places, organizations, dates, products) from this text. Return as JSON array of strings.

Text: "${query}"

Return only the JSON array, no explanation:`;

      const response = await this.llmClient.complete(prompt);
      const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
      const entities = JSON.parse(cleaned);

      if (Array.isArray(entities)) {
        return entities.filter((e): e is string => typeof e === 'string');
      }
    } catch {
      // Fall back to rule-based extraction
    }

    return this.extractEntities(query);
  }

  /**
   * Retrieve memory for a specific task context
   * Optimized for task execution with skill-aware retrieval
   */
  async retrieveForTask(
    task: {
      description: string;
      skillId?: string;
      requiredTypes?: ClauseType[];
      context?: string;
    }
  ): Promise<{
    clauses: ScoredClause[];
    preferences: ScoredClause[];
    facts: ScoredClause[];
    skills: ScoredClause[];
    formatted: string;
  }> {
    const allClauses: Map<string, ScoredClause> = new Map();

    // Build search query from task description and context
    const searchQuery = task.context
      ? `${task.description} ${task.context}`
      : task.description;

    // Stage 1: Direct retrieval for task
    const direct = await this.progressiveRetrieve(searchQuery, {
      limit: 15,
      minConfidence: 0.5,
      types: task.requiredTypes,
    });

    for (const clause of direct.clauses) {
      allClauses.set(clause.id, clause);
    }

    // Stage 2: Get user preferences (always relevant)
    const preferences = await this.retrieve('', {
      types: ['preference'],
      limit: 10,
      minConfidence: 0.6,
    });

    for (const clause of preferences.clauses) {
      if (!allClauses.has(clause.id)) {
        allClauses.set(clause.id, { ...clause, score: clause.score * 0.9 });
      }
    }

    // Stage 3: Get relevant facts about user
    const userFacts = await this.retrieve('user', {
      types: ['fact'],
      limit: 10,
      minConfidence: 0.6,
    });

    for (const clause of userFacts.clauses) {
      if (!allClauses.has(clause.id)) {
        allClauses.set(clause.id, { ...clause, score: clause.score * 0.8 });
      }
    }

    // Stage 4: If skill specified, get skill-specific info
    if (task.skillId) {
      const skillClauses = this.db.all<ClauseRow>(
        `SELECT * FROM clauses
         WHERE valid_to IS NULL
           AND confidence > 0.5
           AND (
             (type IN ('skill', 'skill_success', 'skill_preference') AND subject = ?)
             OR (tags LIKE ?)
           )
         ORDER BY confidence DESC
         LIMIT 10`,
        [task.skillId, `%skill:${task.skillId}%`]
      );

      for (const row of skillClauses) {
        if (!allClauses.has(row.id)) {
          const clause = this.rowToClause(row);
          allClauses.set(row.id, { ...clause, score: 0.7 });
        }
      }
    }

    // Categorize results
    const result = {
      clauses: [] as ScoredClause[],
      preferences: [] as ScoredClause[],
      facts: [] as ScoredClause[],
      skills: [] as ScoredClause[],
      formatted: '',
    };

    for (const clause of allClauses.values()) {
      result.clauses.push(clause);
      switch (clause.type) {
        case 'preference':
          result.preferences.push(clause);
          break;
        case 'fact':
          result.facts.push(clause);
          break;
        case 'skill':
        case 'skill_success':
        case 'skill_failure':
        case 'skill_preference':
          result.skills.push(clause);
          break;
      }
    }

    // Sort all arrays by score
    result.clauses.sort((a, b) => b.score - a.score);
    result.preferences.sort((a, b) => b.score - a.score);
    result.facts.sort((a, b) => b.score - a.score);
    result.skills.sort((a, b) => b.score - a.score);

    // Format for prompt injection
    result.formatted = formatClausesForPrompt(result.clauses.slice(0, 20));

    return result;
  }

  /**
   * Build result from merged clauses
   */
  private buildResult(
    clauses: Map<string, ScoredClause>,
    limit: number,
    method: 'semantic' | 'keyword' | 'hybrid'
  ): RetrievalResult {
    const sorted = [...clauses.values()].sort((a, b) => b.score - a.score);

    return {
      clauses: sorted.slice(0, limit),
      totalMatches: clauses.size,
      retrievalMethod: method,
    };
  }
}
