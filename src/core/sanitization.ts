/**
 * Sanitization module - Prompt injection defense
 * Sanitizes clause content before injection into LLM prompts
 */

export interface SanitizationOptions {
  maxLength?: number;           // Maximum length per clause (default: 500)
  stripXmlTags?: boolean;       // Remove XML-like tags (default: true)
  stripSystemMarkers?: boolean; // Remove [INST], <<SYS>> etc (default: true)
  escapeSpecialChars?: boolean; // Escape special characters (default: true)
  removeUrls?: boolean;         // Remove URLs (default: false)
  removeCodeBlocks?: boolean;   // Remove code blocks (default: false)
}

const DEFAULT_OPTIONS: Required<SanitizationOptions> = {
  maxLength: 500,
  stripXmlTags: true,
  stripSystemMarkers: true,
  escapeSpecialChars: true,
  removeUrls: false,
  removeCodeBlocks: false,
};

// Patterns for potentially dangerous content
const PATTERNS = {
  // System/instruction markers used in various LLM prompts
  systemMarkers: [
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    /<<SYS>>/gi,
    /<\/SYS>>/gi,
    /<<SYSTEM>>/gi,
    /<\/SYSTEM>>/gi,
    /\[SYSTEM\]/gi,
    /\[\/SYSTEM\]/gi,
    /<\|im_start\|>/gi,
    /<\|im_end\|>/gi,
    /<\|endoftext\|>/gi,
    /<\|assistant\|>/gi,
    /<\|user\|>/gi,
    /<\|system\|>/gi,
    /###\s*(System|User|Assistant|Human|AI):/gi,
    /\n(Human|Assistant|System|User|AI):\s*/gi,
  ],

  // XML-like tags that could be used for injection
  xmlTags: [
    /<\/?(?:system|user|assistant|human|ai|instruction|prompt|context|memory|tool|function|result|output|input|query|response|message)[^>]*>/gi,
    /<\/?(?:thinking|scratchpad|internal|hidden|private|secret|admin|root|sudo)[^>]*>/gi,
  ],

  // Common injection attempts
  injectionPatterns: [
    /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    /forget\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    /override\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    /you\s+are\s+now\s+(a|an|the)\s+/gi,
    /pretend\s+(you\s+are|to\s+be)\s+/gi,
    /act\s+as\s+(a|an|if)\s+/gi,
    /new\s+instructions?:/gi,
    /system\s+prompt:/gi,
    /jailbreak/gi,
    /DAN\s+mode/gi,
  ],

  // URLs (optional removal)
  urls: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi,

  // Code blocks (optional removal)
  codeBlocks: /```[\s\S]*?```/g,
};

/**
 * Sanitize text for safe injection into LLM prompts
 */
export function sanitizeForPrompt(
  text: string,
  options: SanitizationOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let sanitized = text;

  // Remove system markers
  if (opts.stripSystemMarkers) {
    for (const pattern of PATTERNS.systemMarkers) {
      sanitized = sanitized.replace(pattern, ' ');
    }
  }

  // Remove XML-like tags
  if (opts.stripXmlTags) {
    for (const pattern of PATTERNS.xmlTags) {
      sanitized = sanitized.replace(pattern, ' ');
    }
  }

  // Remove common injection patterns
  for (const pattern of PATTERNS.injectionPatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  // Remove URLs if requested
  if (opts.removeUrls) {
    sanitized = sanitized.replace(PATTERNS.urls, '[URL]');
  }

  // Remove code blocks if requested
  if (opts.removeCodeBlocks) {
    sanitized = sanitized.replace(PATTERNS.codeBlocks, '[CODE]');
  }

  // Escape special characters used in prompt formatting
  if (opts.escapeSpecialChars) {
    sanitized = escapeSpecialChars(sanitized);
  }

  // Normalize whitespace
  sanitized = sanitized
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  // Apply length limit
  if (opts.maxLength && sanitized.length > opts.maxLength) {
    sanitized = sanitized.slice(0, opts.maxLength - 3) + '...';
  }

  return sanitized;
}

/**
 * Escape special characters that could interfere with prompt formatting
 */
function escapeSpecialChars(text: string): string {
  return text
    // Escape backslashes first
    .replace(/\\/g, '\\\\')
    // Escape curly braces (used in template strings)
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    // Escape angle brackets (but not completely - just neutralize tags)
    .replace(/<([/!?])/g, '< $1')
    .replace(/([^\\])>/g, '$1 >')
    // Escape pipe characters (used in some prompt formats)
    .replace(/\|/g, '\\|');
}

/**
 * Sanitize a batch of clauses for prompt injection
 */
export function sanitizeClausesForPrompt(
  clauses: Array<{ natural_form: string; [key: string]: unknown }>,
  options: SanitizationOptions = {}
): Array<{ natural_form: string; [key: string]: unknown }> {
  return clauses.map((clause) => ({
    ...clause,
    natural_form: sanitizeForPrompt(clause.natural_form, options),
  }));
}

/**
 * Check if text contains potential injection attempts
 */
export function containsInjectionAttempt(text: string): {
  detected: boolean;
  patterns: string[];
} {
  const detected: string[] = [];

  // Check system markers
  for (const pattern of PATTERNS.systemMarkers) {
    if (pattern.test(text)) {
      detected.push(pattern.source);
      pattern.lastIndex = 0; // Reset regex state
    }
  }

  // Check XML tags
  for (const pattern of PATTERNS.xmlTags) {
    if (pattern.test(text)) {
      detected.push(pattern.source);
      pattern.lastIndex = 0;
    }
  }

  // Check injection patterns
  for (const pattern of PATTERNS.injectionPatterns) {
    if (pattern.test(text)) {
      detected.push(pattern.source);
      pattern.lastIndex = 0;
    }
  }

  return {
    detected: detected.length > 0,
    patterns: detected,
  };
}

/**
 * Validate that sanitized text is safe for prompt injection
 */
export function validateSanitizedText(text: string): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Check for remaining system markers
  const injectionCheck = containsInjectionAttempt(text);
  if (injectionCheck.detected) {
    issues.push(`Contains potential injection patterns: ${injectionCheck.patterns.join(', ')}`);
  }

  // Check for unescaped special sequences
  if (text.includes('<|') || text.includes('|>')) {
    issues.push('Contains unescaped special token markers');
  }

  // Check for suspicious repeated characters
  if (/(.)\1{20,}/.test(text)) {
    issues.push('Contains suspicious repeated characters');
  }

  // Check for base64-encoded content (potential obfuscation)
  const base64Pattern = /^[A-Za-z0-9+/]{50,}={0,2}$/;
  const words = text.split(/\s+/);
  for (const word of words) {
    if (base64Pattern.test(word)) {
      issues.push('Contains potential base64-encoded content');
      break;
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Create a safe wrapper for clause content
 * Wraps content in a way that makes it clear it's user data
 */
export function wrapAsUserData(text: string, label: string = 'Memory'): string {
  const sanitized = sanitizeForPrompt(text);
  return `[${label}]: ${sanitized}`;
}

/**
 * Format multiple clauses safely for prompt injection
 */
export function formatClausesForPrompt(
  clauses: Array<{ type: string; natural_form: string }>,
  options: SanitizationOptions & {
    groupByType?: boolean;
    maxTotalLength?: number;
  } = {}
): string {
  const { groupByType = true, maxTotalLength = 4000, ...sanitizeOpts } = options;

  if (clauses.length === 0) {
    return 'No relevant memory found.';
  }

  // Sanitize all clauses
  const sanitized = clauses.map((c) => ({
    type: c.type,
    natural_form: sanitizeForPrompt(c.natural_form, sanitizeOpts),
  }));

  let output = '';

  if (groupByType) {
    // Group by type
    const grouped: Record<string, string[]> = {};
    for (const clause of sanitized) {
      if (!grouped[clause.type]) {
        grouped[clause.type] = [];
      }
      grouped[clause.type].push(clause.natural_form);
    }

    const typeOrder = [
      'fact',
      'preference',
      'habit',
      'skill',
      'relationship',
      'intention',
      'context',
      'correction',
    ];

    for (const type of typeOrder) {
      const items = grouped[type];
      if (!items || items.length === 0) continue;

      const title = type.charAt(0).toUpperCase() + type.slice(1) + 's';
      output += `## ${title}\n`;

      for (const item of items) {
        output += `- ${item}\n`;
      }
      output += '\n';

      // Check total length
      if (output.length >= maxTotalLength) {
        output = output.slice(0, maxTotalLength - 50) + '\n\n[...truncated]';
        break;
      }
    }
  } else {
    // Simple list
    for (const clause of sanitized) {
      const line = `- [${clause.type}] ${clause.natural_form}\n`;

      if (output.length + line.length >= maxTotalLength) {
        output += '\n[...truncated]';
        break;
      }

      output += line;
    }
  }

  return output.trim();
}

/**
 * Strip all potentially dangerous content aggressively
 * Use this for untrusted input
 */
export function stripDangerousContent(text: string): string {
  let stripped = text;

  // Remove all XML-like tags
  stripped = stripped.replace(/<[^>]+>/g, ' ');

  // Remove all system markers
  for (const pattern of PATTERNS.systemMarkers) {
    stripped = stripped.replace(pattern, ' ');
  }

  // Remove all injection patterns
  for (const pattern of PATTERNS.injectionPatterns) {
    stripped = stripped.replace(pattern, ' ');
  }

  // Remove URLs
  stripped = stripped.replace(PATTERNS.urls, ' ');

  // Remove code blocks
  stripped = stripped.replace(PATTERNS.codeBlocks, ' ');

  // Remove any remaining special sequences
  stripped = stripped
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ');

  // Normalize whitespace
  stripped = stripped
    .replace(/\s+/g, ' ')
    .trim();

  return stripped;
}
