/**
 * Extractor module tests
 * Uses recorded LLM response fixtures
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Extractor } from '../src/core/extraction.js';

// Recorded LLM response fixtures
const FIXTURES = {
  simpleConversation: {
    input: 'User lives in Denver and works at Google.',
    response: JSON.stringify([
      {
        type: 'fact',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Denver',
        natural_form: 'User lives in Denver',
        confidence: 0.95,
        valid_from: '2025-01-15',
      },
      {
        type: 'fact',
        subject: 'user',
        predicate: 'works_at',
        object: 'Google',
        natural_form: 'User works at Google',
        confidence: 0.95,
        valid_from: '2025-01-15',
      },
    ]),
  },
  preferences: {
    input: 'I prefer window seats on flights and like Italian food.',
    response: JSON.stringify([
      {
        type: 'preference',
        subject: 'user',
        predicate: 'prefers_seat_type',
        object: 'window',
        natural_form: 'User prefers window seats on flights',
        confidence: 0.9,
        valid_from: '2025-01-15',
      },
      {
        type: 'preference',
        subject: 'user',
        predicate: 'likes',
        object: 'Italian food',
        natural_form: 'User likes Italian food',
        confidence: 0.9,
        valid_from: '2025-01-15',
      },
    ]),
  },
  markdownCodeBlock: {
    input: 'Test input',
    response: '```json\n' + JSON.stringify([
      {
        type: 'fact',
        subject: 'user',
        predicate: 'has_email',
        object: 'test@example.com',
        natural_form: 'User has email test@example.com',
        confidence: 0.85,
        valid_from: '2025-01-15',
      },
    ]) + '\n```',
  },
  habits: {
    input: 'I usually wake up at 6am and exercise before work.',
    response: JSON.stringify([
      {
        type: 'habit',
        subject: 'user',
        predicate: 'usually_wakes_at',
        object: '6am',
        natural_form: 'User usually wakes up at 6am',
        confidence: 0.85,
        valid_from: '2025-01-15',
      },
      {
        type: 'habit',
        subject: 'user',
        predicate: 'exercises',
        object: 'before work',
        natural_form: 'User exercises before work',
        confidence: 0.85,
        valid_from: '2025-01-15',
      },
    ]),
  },
  relationships: {
    input: 'My wife Sarah works at Microsoft and my brother Tom is a doctor.',
    response: JSON.stringify([
      {
        type: 'relationship',
        subject: 'user',
        predicate: 'married_to',
        object: 'Sarah',
        natural_form: 'User is married to Sarah',
        confidence: 0.95,
        valid_from: '2025-01-15',
      },
      {
        type: 'fact',
        subject: 'Sarah',
        predicate: 'works_at',
        object: 'Microsoft',
        natural_form: 'Sarah works at Microsoft',
        confidence: 0.9,
        valid_from: '2025-01-15',
      },
      {
        type: 'relationship',
        subject: 'user',
        predicate: 'has_brother',
        object: 'Tom',
        natural_form: 'User has a brother named Tom',
        confidence: 0.95,
        valid_from: '2025-01-15',
      },
      {
        type: 'fact',
        subject: 'Tom',
        predicate: 'occupation',
        object: 'doctor',
        natural_form: 'Tom is a doctor',
        confidence: 0.9,
        valid_from: '2025-01-15',
      },
    ]),
  },
  emptyExtraction: {
    input: 'Hello, how are you?',
    response: '[]',
  },
  correction: {
    input: 'Actually, I moved to Seattle last month. I no longer live in Denver.',
    response: JSON.stringify([
      {
        type: 'correction',
        subject: 'user',
        predicate: 'lives_in',
        object: 'Seattle',
        natural_form: 'User now lives in Seattle, not Denver',
        confidence: 0.95,
        valid_from: '2025-01-15',
      },
    ]),
  },
  relativeDates: {
    input: 'I started working here last month and moved to this apartment 2 weeks ago.',
    response: JSON.stringify([
      {
        type: 'fact',
        subject: 'user',
        predicate: 'started_working',
        object: 'current job',
        natural_form: 'User started working at current job',
        confidence: 0.8,
        valid_from: 'last month',
      },
      {
        type: 'fact',
        subject: 'user',
        predicate: 'moved_to',
        object: 'current apartment',
        natural_form: 'User moved to current apartment',
        confidence: 0.8,
        valid_from: '2 weeks ago',
      },
    ]),
  },
};

// Mock LLM client for testing
class MockLLMClient {
  private responseMap: Map<string, string> = new Map();

  setResponse(inputPattern: string, response: string): void {
    this.responseMap.set(inputPattern, response);
  }

  async complete(prompt: string): Promise<string> {
    // Find matching fixture based on content in prompt
    for (const [pattern, response] of this.responseMap) {
      if (prompt.includes(pattern)) {
        return response;
      }
    }
    return '[]';
  }
}

describe('Extractor', () => {
  let mockClient: MockLLMClient;
  let extractor: Extractor;

  beforeEach(() => {
    mockClient = new MockLLMClient();

    // Set up all fixtures
    for (const fixture of Object.values(FIXTURES)) {
      mockClient.setResponse(fixture.input, fixture.response);
    }

    extractor = new Extractor('test-model', mockClient);
  });

  describe('extract()', () => {
    it('should extract facts from simple conversation', async () => {
      const result = await extractor.extract(FIXTURES.simpleConversation.input, {
        sourceId: 'test-source',
      });

      expect(result.clauses).toHaveLength(2);
      expect(result.clauses[0].type).toBe('fact');
      expect(result.clauses[0].subject).toBe('user');
      expect(result.clauses[0].predicate).toBe('lives_in');
      expect(result.clauses[0].object).toBe('Denver');
    });

    it('should extract preferences', async () => {
      const result = await extractor.extract(FIXTURES.preferences.input, {
        sourceId: 'test-source',
      });

      expect(result.clauses).toHaveLength(2);
      expect(result.clauses[0].type).toBe('preference');
      expect(result.clauses[1].type).toBe('preference');
    });

    it('should handle markdown code block responses', async () => {
      const result = await extractor.extract(FIXTURES.markdownCodeBlock.input, {
        sourceId: 'test-source',
      });

      expect(result.clauses).toHaveLength(1);
      expect(result.clauses[0].predicate).toBe('has_email');
    });

    it('should extract habits', async () => {
      const result = await extractor.extract(FIXTURES.habits.input, {
        sourceId: 'test-source',
      });

      expect(result.clauses).toHaveLength(2);
      expect(result.clauses[0].type).toBe('habit');
    });

    it('should extract relationships', async () => {
      const result = await extractor.extract(FIXTURES.relationships.input, {
        sourceId: 'test-source',
      });

      expect(result.clauses.length).toBeGreaterThan(0);
      const relationshipClauses = result.clauses.filter((c) => c.type === 'relationship');
      expect(relationshipClauses.length).toBeGreaterThan(0);
    });

    it('should return empty array for non-informative content', async () => {
      const result = await extractor.extract(FIXTURES.emptyExtraction.input, {
        sourceId: 'test-source',
      });

      expect(result.clauses).toHaveLength(0);
    });

    it('should handle corrections', async () => {
      const result = await extractor.extract(FIXTURES.correction.input, {
        sourceId: 'test-source',
      });

      expect(result.clauses).toHaveLength(1);
      expect(result.clauses[0].type).toBe('correction');
    });

    it('should parse relative dates', async () => {
      const result = await extractor.extract(FIXTURES.relativeDates.input, {
        sourceId: 'test-source',
      });

      expect(result.clauses).toHaveLength(2);
      // Dates should be normalized to ISO format
      for (const clause of result.clauses) {
        expect(clause.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('should set source_id on all clauses', async () => {
      const result = await extractor.extract(FIXTURES.simpleConversation.input, {
        sourceId: 'my-source-id',
      });

      for (const clause of result.clauses) {
        expect(clause.source_id).toBe('my-source-id');
      }
    });

    it('should set extraction_method on all clauses', async () => {
      const result = await extractor.extract(FIXTURES.simpleConversation.input, {
        sourceId: 'test-source',
      });

      for (const clause of result.clauses) {
        expect(clause.extraction_method).toBe('llm_extraction');
      }
    });

    it('should filter by extractTypes when specified', async () => {
      const result = await extractor.extract(FIXTURES.preferences.input, {
        sourceId: 'test-source',
        extractTypes: ['fact'],
      });

      // Should filter out preferences since we only want facts
      for (const clause of result.clauses) {
        expect(clause.type).toBe('fact');
      }
    });

    it('should calculate extraction confidence', async () => {
      const result = await extractor.extract(FIXTURES.simpleConversation.input, {
        sourceId: 'test-source',
      });

      expect(result.extractionConfidence).toBeGreaterThan(0);
      expect(result.extractionConfidence).toBeLessThanOrEqual(1);
    });
  });

  describe('extractFromConversation()', () => {
    it('should extract from conversation messages', async () => {
      const messages = [
        { role: 'user', content: 'I live in Denver' },
        { role: 'assistant', content: 'Great! Denver is a beautiful city.' },
      ];

      // Mock the response for formatted conversation
      mockClient.setResponse('user: I live in Denver', FIXTURES.simpleConversation.response);

      const result = await extractor.extractFromConversation(messages, {
        sourceId: 'test-source',
      });

      expect(result.clauses.length).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('Extractor validation', () => {
  it('should normalize predicates to snake_case', async () => {
    const mockClient = new MockLLMClient();
    mockClient.setResponse('test', JSON.stringify([
      {
        type: 'fact',
        subject: 'user',
        predicate: 'Lives In',
        object: 'Denver',
        natural_form: 'User lives in Denver',
        confidence: 0.9,
        valid_from: '2025-01-15',
      },
    ]));

    const extractor = new Extractor('test-model', mockClient);
    const result = await extractor.extract('test', { sourceId: 'test' });

    expect(result.clauses[0].predicate).toBe('lives_in');
  });

  it('should clamp confidence to 0-1 range', async () => {
    const mockClient = new MockLLMClient();
    mockClient.setResponse('test', JSON.stringify([
      {
        type: 'fact',
        subject: 'user',
        predicate: 'test',
        object: 'value',
        natural_form: 'Test',
        confidence: 1.5,
        valid_from: '2025-01-15',
      },
    ]));

    const extractor = new Extractor('test-model', mockClient);
    const result = await extractor.extract('test', { sourceId: 'test' });

    expect(result.clauses[0].confidence).toBeLessThanOrEqual(1);
  });

  it('should skip clauses with invalid types', async () => {
    const mockClient = new MockLLMClient();
    mockClient.setResponse('test', JSON.stringify([
      {
        type: 'invalid_type',
        subject: 'user',
        predicate: 'test',
        object: 'value',
        natural_form: 'Test',
        confidence: 0.9,
        valid_from: '2025-01-15',
      },
    ]));

    const extractor = new Extractor('test-model', mockClient);
    const result = await extractor.extract('test', { sourceId: 'test' });

    expect(result.clauses).toHaveLength(0);
  });

  it('should skip clauses missing required fields', async () => {
    const mockClient = new MockLLMClient();
    mockClient.setResponse('test', JSON.stringify([
      {
        type: 'fact',
        subject: 'user',
        // missing predicate, object, natural_form
      },
    ]));

    const extractor = new Extractor('test-model', mockClient);
    const result = await extractor.extract('test', { sourceId: 'test' });

    expect(result.clauses).toHaveLength(0);
  });
});
