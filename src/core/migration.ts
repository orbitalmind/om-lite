/**
 * Migration module - Import from existing memory formats
 * Supports migration from MEMORY.md files
 */

import { readFileSync, existsSync } from 'fs';
import type { ClauseInput, ClauseType } from './types.js';

// ========== Types ==========

export interface MigrationOptions {
  /** Apply confidence reduction for migrated items (default: 0.8) */
  confidenceMultiplier?: number;
  /** Filter to specific types during migration */
  types?: ClauseType[];
  /** Mark migration source in metadata */
  markAsImported?: boolean;
  /** Dry run - don't actually import */
  dryRun?: boolean;
}

export interface MigrationResult {
  source: string;
  format: 'memory_md' | 'json';
  totalParsed: number;
  imported: number;
  skipped: number;
  errors: string[];
  clauses: ClauseInput[];
}

interface ParsedSection {
  type: ClauseType;
  items: string[];
}

// ========== MEMORY.md Parser ==========

/**
 * Type mapping from common MEMORY.md section headers
 */
const SECTION_TYPE_MAP: Record<string, ClauseType> = {
  // Standard types
  'facts': 'fact',
  'fact': 'fact',
  'preferences': 'preference',
  'preference': 'preference',
  'habits': 'habit',
  'habit': 'habit',
  'skills': 'skill',
  'skill': 'skill',
  'relationships': 'relationship',
  'relationship': 'relationship',
  'intentions': 'intention',
  'intention': 'intention',
  'goals': 'intention',
  'plans': 'intention',
  'contexts': 'context',
  'context': 'context',
  'corrections': 'correction',
  'correction': 'correction',

  // Common variations
  'about': 'fact',
  'personal': 'fact',
  'profile': 'fact',
  'info': 'fact',
  'information': 'fact',
  'likes': 'preference',
  'dislikes': 'preference',
  'prefers': 'preference',
  'routines': 'habit',
  'routine': 'habit',
  'behaviors': 'habit',
  'contacts': 'relationship',
  'people': 'relationship',
  'family': 'relationship',
  'friends': 'relationship',
  'work': 'fact',
  'location': 'fact',
  'address': 'fact',
  'notes': 'context',
  'misc': 'context',
  'other': 'context',
};

/**
 * Parse MEMORY.md content into sections
 */
function parseMemoryMdSections(content: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const lines = content.split('\n');

  let currentSection: ParsedSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for section headers (## or #)
    const headerMatch = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (headerMatch) {
      const headerText = headerMatch[1].toLowerCase().replace(/[^a-z]/g, '');
      const clauseType = SECTION_TYPE_MAP[headerText];

      if (clauseType) {
        if (currentSection && currentSection.items.length > 0) {
          sections.push(currentSection);
        }
        currentSection = { type: clauseType, items: [] };
      }
      continue;
    }

    // Check for list items (- or *)
    const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (listMatch && currentSection) {
      const item = listMatch[1].trim();
      if (item.length > 0) {
        currentSection.items.push(item);
      }
      continue;
    }

    // Check for numbered items (1. 2. etc)
    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch && currentSection) {
      const item = numberedMatch[1].trim();
      if (item.length > 0) {
        currentSection.items.push(item);
      }
    }
  }

  // Don't forget the last section
  if (currentSection && currentSection.items.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Extract subject-predicate-object from natural language
 * Uses heuristics for common patterns
 */
function extractSPO(text: string, type: ClauseType): {
  subject: string;
  predicate: string;
  object: string;
} {
  // Default values
  let subject = 'user';
  let predicate = 'has_attribute';
  let object = text;

  // Pattern: "User/I [verb] [object]"
  const userVerbMatch = text.match(/^(?:user|i)\s+(\w+(?:\s+\w+)?)\s+(.+)$/i);
  if (userVerbMatch) {
    subject = 'user';
    predicate = userVerbMatch[1].toLowerCase().replace(/\s+/g, '_');
    object = userVerbMatch[2];
    return { subject, predicate, object };
  }

  // Pattern: "[Subject] is/are [object]"
  const isMatch = text.match(/^(.+?)\s+(?:is|are)\s+(.+)$/i);
  if (isMatch) {
    subject = isMatch[1].trim();
    predicate = 'is';
    object = isMatch[2].trim();
    return { subject, predicate, object };
  }

  // Pattern: "[Subject] has [object]"
  const hasMatch = text.match(/^(.+?)\s+has\s+(.+)$/i);
  if (hasMatch) {
    subject = hasMatch[1].trim();
    predicate = 'has';
    object = hasMatch[2].trim();
    return { subject, predicate, object };
  }

  // Pattern for preferences: "Prefers/Likes/Dislikes [object]"
  if (type === 'preference') {
    const prefMatch = text.match(/^(?:prefers?|likes?|dislikes?|loves?|hates?|wants?)\s+(.+)$/i);
    if (prefMatch) {
      predicate = text.split(/\s+/)[0].toLowerCase();
      object = prefMatch[1];
      return { subject, predicate, object };
    }
  }

  // Pattern for habits: "Usually/Always/Often [action]"
  if (type === 'habit') {
    const habitMatch = text.match(/^(?:usually|always|often|regularly|typically|every\s+\w+)\s+(.+)$/i);
    if (habitMatch) {
      predicate = 'usually_does';
      object = habitMatch[1];
      return { subject, predicate, object };
    }
  }

  // Pattern for relationships: "[Name] is [relation]"
  if (type === 'relationship') {
    const relMatch = text.match(/^(.+?)\s+(?:is\s+(?:my|the|a)\s+)?(.+)$/i);
    if (relMatch) {
      subject = relMatch[1].trim();
      predicate = 'is_related_as';
      object = relMatch[2].trim();
      return { subject, predicate, object };
    }
  }

  // Type-based defaults
  switch (type) {
    case 'fact':
      predicate = 'has_fact';
      break;
    case 'preference':
      predicate = 'prefers';
      break;
    case 'habit':
      predicate = 'has_habit';
      break;
    case 'skill':
      subject = 'agent';
      predicate = 'can_do';
      break;
    case 'relationship':
      predicate = 'knows';
      break;
    case 'intention':
      predicate = 'wants_to';
      break;
    case 'context':
      predicate = 'current_context';
      break;
    case 'correction':
      predicate = 'corrects';
      break;
  }

  return { subject, predicate, object };
}

/**
 * Convert parsed sections to clause inputs
 */
function sectionsToClauseInputs(
  sections: ParsedSection[],
  options: MigrationOptions
): ClauseInput[] {
  const {
    confidenceMultiplier = 0.8,
    types,
    markAsImported = true
  } = options;

  const clauses: ClauseInput[] = [];
  const now = new Date().toISOString().split('T')[0];

  for (const section of sections) {
    // Skip if type filter is specified and doesn't match
    if (types && types.length > 0 && !types.includes(section.type)) {
      continue;
    }

    for (const item of section.items) {
      const { subject, predicate, object } = extractSPO(item, section.type);

      const clause: ClauseInput = {
        type: section.type,
        subject,
        predicate,
        object,
        natural_form: item,
        confidence: 0.7 * confidenceMultiplier, // Base confidence * multiplier
        valid_from: now,
        tags: markAsImported ? ['imported', 'memory_md'] : [],
        metadata: markAsImported ? {
          imported_from: 'memory_md',
          imported_at: new Date().toISOString(),
        } : {},
      };

      clauses.push(clause);
    }
  }

  return clauses;
}

// ========== Public API ==========

/**
 * Migrate from MEMORY.md file
 */
export function migrateFromMemoryMd(
  filePath: string,
  options: MigrationOptions = {}
): MigrationResult {
  const result: MigrationResult = {
    source: filePath,
    format: 'memory_md',
    totalParsed: 0,
    imported: 0,
    skipped: 0,
    errors: [],
    clauses: [],
  };

  // Check if file exists
  if (!existsSync(filePath)) {
    result.errors.push(`File not found: ${filePath}`);
    return result;
  }

  // Read file content
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    result.errors.push(`Failed to read file: ${error}`);
    return result;
  }

  // Parse sections
  const sections = parseMemoryMdSections(content);
  result.totalParsed = sections.reduce((sum, s) => sum + s.items.length, 0);

  // Convert to clause inputs
  const clauses = sectionsToClauseInputs(sections, options);
  result.clauses = clauses;
  result.imported = clauses.length;
  result.skipped = result.totalParsed - result.imported;

  return result;
}

/**
 * Migrate from MEMORY.md content string
 */
export function migrateFromMemoryMdContent(
  content: string,
  options: MigrationOptions = {}
): MigrationResult {
  const result: MigrationResult = {
    source: 'string',
    format: 'memory_md',
    totalParsed: 0,
    imported: 0,
    skipped: 0,
    errors: [],
    clauses: [],
  };

  // Parse sections
  const sections = parseMemoryMdSections(content);
  result.totalParsed = sections.reduce((sum, s) => sum + s.items.length, 0);

  // Convert to clause inputs
  const clauses = sectionsToClauseInputs(sections, options);
  result.clauses = clauses;
  result.imported = clauses.length;
  result.skipped = result.totalParsed - result.imported;

  return result;
}

/**
 * Migrate from JSON export
 */
export function migrateFromJson(
  filePath: string,
  options: MigrationOptions = {}
): MigrationResult {
  const result: MigrationResult = {
    source: filePath,
    format: 'json',
    totalParsed: 0,
    imported: 0,
    skipped: 0,
    errors: [],
    clauses: [],
  };

  const { confidenceMultiplier = 0.8, types, markAsImported = true } = options;

  // Check if file exists
  if (!existsSync(filePath)) {
    result.errors.push(`File not found: ${filePath}`);
    return result;
  }

  // Read and parse JSON
  let data: unknown[];
  try {
    const content = readFileSync(filePath, 'utf-8');
    data = JSON.parse(content);

    if (!Array.isArray(data)) {
      result.errors.push('JSON file must contain an array');
      return result;
    }
  } catch (error) {
    result.errors.push(`Failed to parse JSON: ${error}`);
    return result;
  }

  result.totalParsed = data.length;

  // Process each item
  for (const item of data) {
    if (typeof item !== 'object' || item === null) {
      result.skipped++;
      continue;
    }

    const obj = item as Record<string, unknown>;

    // Validate required fields
    if (!obj.type || !obj.subject || !obj.predicate || !obj.object || !obj.natural_form) {
      result.skipped++;
      result.errors.push(`Missing required fields in item: ${JSON.stringify(obj).slice(0, 100)}`);
      continue;
    }

    // Check type filter
    const clauseType = obj.type as ClauseType;
    if (types && types.length > 0 && !types.includes(clauseType)) {
      result.skipped++;
      continue;
    }

    // Build clause input
    const clause: ClauseInput = {
      type: clauseType,
      subject: String(obj.subject),
      predicate: String(obj.predicate),
      object: String(obj.object),
      natural_form: String(obj.natural_form),
      confidence: (typeof obj.confidence === 'number' ? obj.confidence : 0.7) * confidenceMultiplier,
      valid_from: typeof obj.valid_from === 'string' ? obj.valid_from : new Date().toISOString().split('T')[0],
      tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : [],
      metadata: typeof obj.metadata === 'object' && obj.metadata !== null ? obj.metadata as Record<string, unknown> : {},
    };

    // Add import markers
    if (markAsImported) {
      clause.tags = [...(clause.tags ?? []), 'imported', 'json'];
      clause.metadata = {
        ...(clause.metadata ?? {}),
        imported_from: 'json',
        imported_at: new Date().toISOString(),
      };
    }

    result.clauses.push(clause);
    result.imported++;
  }

  return result;
}

/**
 * Detect the format of a memory file
 */
export function detectFormat(filePath: string): 'memory_md' | 'json' | 'unknown' {
  if (!existsSync(filePath)) {
    return 'unknown';
  }

  // Check extension
  if (filePath.endsWith('.json')) {
    return 'json';
  }
  if (filePath.endsWith('.md') || filePath.endsWith('.markdown')) {
    return 'memory_md';
  }

  // Try to detect from content
  try {
    const content = readFileSync(filePath, 'utf-8').trim();

    // Check if it's JSON
    if (content.startsWith('[') || content.startsWith('{')) {
      try {
        JSON.parse(content);
        return 'json';
      } catch {
        // Not valid JSON
      }
    }

    // Check if it looks like markdown
    if (content.includes('#') || content.includes('- ') || content.includes('* ')) {
      return 'memory_md';
    }
  } catch {
    // Ignore read errors
  }

  return 'unknown';
}

/**
 * Auto-detect and migrate from a file
 */
export function migrateFromFile(
  filePath: string,
  options: MigrationOptions = {}
): MigrationResult {
  const format = detectFormat(filePath);

  switch (format) {
    case 'memory_md':
      return migrateFromMemoryMd(filePath, options);
    case 'json':
      return migrateFromJson(filePath, options);
    default:
      return {
        source: filePath,
        format: 'memory_md',
        totalParsed: 0,
        imported: 0,
        skipped: 0,
        errors: [`Unknown file format: ${filePath}`],
        clauses: [],
      };
  }
}
