/**
 * Extraction module - LLM-based clause extraction from natural language
 * Converts conversations and documents into structured clauses
 */

import type { ClauseInput, ClauseType } from './types.js';

// Extraction prompt template based on spec Section 7.1
const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the following content and extract structured facts.

For each distinct piece of information, output a JSON object with:
- type: one of [fact, preference, habit, skill, relationship, intention, context, correction]
- subject: who/what this is about (usually "user" or "agent")
- predicate: the relationship or property (use snake_case, e.g., "lives_in", "prefers", "likes")
- object: the value or target
- natural_form: a complete sentence expressing this
- confidence: 0.0-1.0 based on how certain the information is
- valid_from: ISO date when this became true (estimate if not explicit, use today's date if unknown)

Type descriptions:
- fact: Objective information about the world (addresses, names, dates)
- preference: User likes/dislikes/prefers something
- habit: Recurring behaviors or routines
- skill: Agent capabilities or learned abilities
- relationship: Connections between entities (people, organizations)
- intention: Goals, plans, aspirations, wants
- context: Situational information (current location, activity)
- correction: Explicit user corrections of previous information

Predicate guidelines:
- Use descriptive snake_case predicates: lives_in, works_at, prefers, likes, dislikes, uses_for_notes
- For preferences: prefers_X, likes, dislikes, favorite_X
- For facts: lives_in, works_at, email_address, phone_number
- For relationships: knows, reports_to, married_to, friend_of
- For habits: usually_does, routine_includes, habit_of

Rules:
1. Extract ONLY information explicitly stated or strongly implied
2. Prefer specific over vague (e.g., "Denver" not "a city")
3. Separate compound facts into multiple clauses
4. Mark corrections with type="correction" and describe what they correct
5. Estimate valid_from based on context clues ("last month", "since 2020", etc.)
6. If timing is unclear, use today's date for valid_from
7. Set confidence based on certainty: explicit statements = 0.9-1.0, implied = 0.6-0.8, uncertain = 0.4-0.6
8. Do NOT extract obvious/trivial information
9. Focus on information that would be useful for a personal assistant to remember

Content to analyze:
"""
{content}
"""

Context (if any):
"""
{context}
"""

Current date: {current_date}

Output a JSON array of extracted clauses. If no meaningful information can be extracted, output an empty array [].
Example output format:
[
  {
    "type": "fact",
    "subject": "user",
    "predicate": "lives_in",
    "object": "Denver",
    "natural_form": "User lives in Denver",
    "confidence": 0.95,
    "valid_from": "2025-12-01"
  }
]

JSON array:`;

interface ExtractedClause {
  type: ClauseType;
  subject: string;
  predicate: string;
  object: string;
  natural_form: string;
  confidence: number;
  valid_from: string;
  tags?: string[];
}

interface ExtractionOptions {
  sourceId: string;
  context?: string;
  extractTypes?: ClauseType[];
}

interface ExtractionResult {
  clauses: (ClauseInput & { source_id: string; extraction_method: string })[];
  rawResponse?: string;
  extractionConfidence: number;
}

// Simple LLM client interface - users can provide their own implementation
interface LLMClient {
  complete(prompt: string): Promise<string>;
}

// Default stub LLM client that explains how to configure
class StubLLMClient implements LLMClient {
  async complete(_prompt: string): Promise<string> {
    console.warn(
      'OM-Lite: No LLM client configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable, ' +
        'or provide a custom LLM client to the Extractor constructor.'
    );
    return '[]';
  }
}

// OpenAI-compatible LLM client
class OpenAIClient implements LLMClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string = 'gpt-4o-mini', baseUrl: string = 'https://api.openai.com/v1') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async complete(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a memory extraction system. Output only valid JSON arrays.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? '[]';
  }
}

// Anthropic Claude client
class AnthropicClient implements LLMClient {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-20250514') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
        system: 'You are a memory extraction system. Output only valid JSON arrays.',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const textContent = data.content.find((c) => c.type === 'text');
    return textContent?.text ?? '[]';
  }
}

export class Extractor {
  private llmClient: LLMClient;
  private model: string;

  constructor(model?: string, llmClient?: LLMClient) {
    this.model = model ?? 'claude-sonnet-4-20250514';

    if (llmClient) {
      this.llmClient = llmClient;
    } else {
      // Auto-detect available API keys
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const openaiKey = process.env.OPENAI_API_KEY;

      if (anthropicKey) {
        this.llmClient = new AnthropicClient(anthropicKey, this.model);
      } else if (openaiKey) {
        // Map model names if using OpenAI
        const openaiModel = this.model.startsWith('claude') ? 'gpt-4o-mini' : this.model;
        this.llmClient = new OpenAIClient(openaiKey, openaiModel);
      } else {
        this.llmClient = new StubLLMClient();
      }
    }
  }

  /**
   * Extract clauses from content using LLM
   */
  async extract(content: string, options: ExtractionOptions): Promise<ExtractionResult> {
    const { sourceId, context = '', extractTypes } = options;
    const currentDate = new Date().toISOString().split('T')[0];

    // Build prompt
    const prompt = EXTRACTION_PROMPT.replace('{content}', content)
      .replace('{context}', context)
      .replace('{current_date}', currentDate);

    // Call LLM
    let rawResponse: string;
    try {
      rawResponse = await this.llmClient.complete(prompt);
    } catch (error) {
      console.error('LLM extraction failed:', error);
      return {
        clauses: [],
        rawResponse: String(error),
        extractionConfidence: 0,
      };
    }

    // Parse response
    const extracted = this.parseResponse(rawResponse);

    // Filter by type if specified
    let filtered = extracted;
    if (extractTypes && extractTypes.length > 0) {
      filtered = extracted.filter((c) => extractTypes.includes(c.type));
    }

    // Convert to ClauseInput format
    const clauses = filtered.map((c) => ({
      type: c.type,
      subject: c.subject,
      predicate: c.predicate,
      object: c.object,
      natural_form: c.natural_form,
      confidence: c.confidence,
      valid_from: c.valid_from,
      tags: c.tags,
      source_id: sourceId,
      extraction_method: 'llm_extraction',
    }));

    // Calculate overall extraction confidence
    const avgConfidence =
      clauses.length > 0
        ? clauses.reduce((sum, c) => sum + c.confidence, 0) / clauses.length
        : 0;

    return {
      clauses,
      rawResponse,
      extractionConfidence: avgConfidence,
    };
  }

  /**
   * Extract clauses from a conversation (array of messages)
   */
  async extractFromConversation(
    messages: Array<{ role: string; content: string }>,
    options: ExtractionOptions
  ): Promise<ExtractionResult> {
    // Format conversation
    const content = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n\n');

    return this.extract(content, options);
  }

  /**
   * Parse LLM response into structured clauses
   */
  private parseResponse(response: string): ExtractedClause[] {
    // Try to extract JSON from the response
    let jsonStr = response.trim();

    // Handle markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Find JSON array in response
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonStr = arrayMatch[0];
    }

    try {
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) {
        console.warn('LLM response is not an array:', jsonStr.slice(0, 200));
        return [];
      }

      // Validate and clean each clause
      return parsed
        .map((item) => this.validateClause(item))
        .filter((c): c is ExtractedClause => c !== null);
    } catch (error) {
      console.warn('Failed to parse LLM response as JSON:', error);
      console.warn('Response preview:', jsonStr.slice(0, 500));
      return [];
    }
  }

  /**
   * Validate and normalize a single extracted clause
   */
  private validateClause(item: unknown): ExtractedClause | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const obj = item as Record<string, unknown>;

    // Required fields
    const type = obj.type as ClauseType;
    const subject = obj.subject as string;
    const predicate = obj.predicate as string;
    const object_ = obj.object as string;
    const naturalForm = obj.natural_form as string;

    if (!type || !subject || !predicate || !object_ || !naturalForm) {
      console.warn('Missing required fields in clause:', obj);
      return null;
    }

    // Validate type
    const validTypes: ClauseType[] = [
      'fact',
      'preference',
      'habit',
      'skill',
      'relationship',
      'intention',
      'context',
      'correction',
    ];

    if (!validTypes.includes(type)) {
      console.warn('Invalid clause type:', type);
      return null;
    }

    // Normalize confidence
    let confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.8;
    confidence = Math.max(0, Math.min(1, confidence));

    // Normalize valid_from
    let validFrom = obj.valid_from as string;
    if (!validFrom || typeof validFrom !== 'string') {
      validFrom = new Date().toISOString().split('T')[0];
    } else {
      // Try to parse and normalize the date
      try {
        const date = new Date(validFrom);
        if (isNaN(date.getTime())) {
          validFrom = this.parseRelativeDate(validFrom);
        } else {
          validFrom = date.toISOString().split('T')[0];
        }
      } catch {
        validFrom = new Date().toISOString().split('T')[0];
      }
    }

    // Normalize tags
    const tags = Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is string => typeof t === 'string')
      : [];

    return {
      type,
      subject: String(subject).trim(),
      predicate: String(predicate).trim().toLowerCase().replace(/\s+/g, '_'),
      object: String(object_).trim(),
      natural_form: String(naturalForm).trim(),
      confidence,
      valid_from: validFrom,
      tags,
    };
  }

  /**
   * Parse relative date expressions like "last month", "yesterday"
   */
  private parseRelativeDate(expr: string): string {
    const now = new Date();
    const lower = expr.toLowerCase().trim();

    if (lower === 'today' || lower === 'now') {
      return now.toISOString().split('T')[0];
    }

    if (lower === 'yesterday') {
      now.setDate(now.getDate() - 1);
      return now.toISOString().split('T')[0];
    }

    // "last week"
    if (lower.includes('last week')) {
      now.setDate(now.getDate() - 7);
      return now.toISOString().split('T')[0];
    }

    // "last month"
    if (lower.includes('last month')) {
      now.setMonth(now.getMonth() - 1);
      return now.toISOString().split('T')[0];
    }

    // "X days ago"
    const daysAgoMatch = lower.match(/(\d+)\s*days?\s*ago/);
    if (daysAgoMatch) {
      now.setDate(now.getDate() - parseInt(daysAgoMatch[1], 10));
      return now.toISOString().split('T')[0];
    }

    // "X weeks ago"
    const weeksAgoMatch = lower.match(/(\d+)\s*weeks?\s*ago/);
    if (weeksAgoMatch) {
      now.setDate(now.getDate() - parseInt(weeksAgoMatch[1], 10) * 7);
      return now.toISOString().split('T')[0];
    }

    // "X months ago"
    const monthsAgoMatch = lower.match(/(\d+)\s*months?\s*ago/);
    if (monthsAgoMatch) {
      now.setMonth(now.getMonth() - parseInt(monthsAgoMatch[1], 10));
      return now.toISOString().split('T')[0];
    }

    // "since YYYY" or "in YYYY"
    const yearMatch = lower.match(/(since|in|from)\s*(\d{4})/);
    if (yearMatch) {
      return `${yearMatch[2]}-01-01`;
    }

    // Default to today
    return new Date().toISOString().split('T')[0];
  }
}
