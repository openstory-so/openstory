import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'ai', 'prompt-validation']);
// Security: Prompt injection protection patterns
// These patterns detect injection attempts for logging/alerting only.
// sanitizeScriptContent performs safe, line-scoped replacements and unwraps
// markdown code fences (users sometimes paste scripts inside ```...```).
export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /forget\s+(all\s+)?previous\s+instructions?/gi,
  /you\s+are\s+now\s+/gi,
  /act\s+as\s+a\s+/gi,
  /pretend\s+to\s+be\s+/gi,
  /roleplay\s+as\s+/gi,
  /output\s+(your|the)\s+(system\s+)?prompt/gi,
  /what\s+(is\s+)?your\s+(system\s+)?prompt/gi,
  /reveal\s+(your|the)\s+(system\s+)?prompt/gi,
  /show\s+(me\s+)?(your|the)\s+(system\s+)?prompt/gi,
];

// Security: Sanitize user input to prevent prompt injection.
// IMPORTANT: All replacements are line-scoped (.*) not string-scoped ([\s\S]*$)
// to avoid destroying screenplay content after a false-positive match.
// Screenplays legitimately contain phrases like "act as if", "system:", "pretend to be calm".
export const sanitizeScriptContent = (input: string): string => {
  let sanitized = input;

  // Unwrap triple-backtick fences — users sometimes paste screenplays inside
  // markdown code blocks. Keep the inner content so the injection-pattern
  // replacements below still scan it. See issue #455.
  sanitized = sanitized.replace(
    /```(?:[a-zA-Z0-9_-]*)?\n?([\s\S]*?)\n?```/g,
    '$1'
  );

  // Handle explicit injection attempts (line-scoped: .* not [\s\S]*$)
  sanitized = sanitized.replace(
    /ignore\s+(all\s+)?previous\s+instructions?.*/gi,
    '[character dismisses something]'
  );
  sanitized = sanitized.replace(
    /forget\s+(all\s+)?previous\s+instructions?.*/gi,
    '[character dismisses something]'
  );

  // Handle prompt extraction attempts (line-scoped)
  sanitized = sanitized.replace(
    /output\s+(your|the)\s+(system\s+)?prompt.*/gi,
    '[technical discussion]'
  );
  sanitized = sanitized.replace(
    /what\s+(is\s+)?your\s+(system\s+)?prompt.*/gi,
    '[technical discussion]'
  );
  sanitized = sanitized.replace(
    /reveal\s+(your|the)\s+(system\s+)?prompt.*/gi,
    '[technical discussion]'
  );
  sanitized = sanitized.replace(
    /show\s+(me\s+)?(your|the)\s+(system\s+)?prompt.*/gi,
    '[technical discussion]'
  );

  return sanitized.trim();
};

export const checkForInjectionAttempts = (script: string): boolean => {
  const containsSuspiciousContent = INJECTION_PATTERNS.some((pattern) =>
    pattern.test(script)
  );

  if (containsSuspiciousContent) {
    logger.warn('Script enhancement: Potential injection attempt detected', {
      timestamp: new Date().toISOString(),
      scriptLength: script.length,
      suspiciousPatterns: INJECTION_PATTERNS.filter((pattern) =>
        pattern.test(script)
      ).map((pattern) => pattern.source),
    });
  }
  return containsSuspiciousContent;
};

// Security: Validate that AI response follows expected format
// Throws an error if the response is not valid
export const validateAIResponse = (response: string): void => {
  // Check for potential injection attempts in AI response
  const suspiciousPatterns = [
    /system\s*prompt/gi,
    /previous\s+instructions/gi,
    /ignore.*instructions/gi,
    /I\s+am\s+an?\s+AI/gi,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(response)) {
      throw new Error('AI response contains potentially injected content');
    }
  }

  // Ensure response is within reasonable length
  if (response.length > 15000) {
    throw new Error('AI response exceeds maximum safe length');
  }
};
