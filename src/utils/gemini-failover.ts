/**
 * Core utility functions for DRSSS AI dual-model failover,
 * model routing, thinking configuration, payload construction,
 * and response parsing.
 * Shared between backend logic and test runners.
 */

export const PRIMARY_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const ADVANCED_PRIMARY_MODEL = 'gemini-3.6-flash';
export const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

export const VALID_PRIMARY_MODELS = [
  PRIMARY_DEFAULT_MODEL,
  ADVANCED_PRIMARY_MODEL
] as const;

export type PrimaryModelId = typeof VALID_PRIMARY_MODELS[number];

export const VALID_THINKING_LEVELS = ['minimal', 'high'] as const;
export type ThinkingLevel = typeof VALID_THINKING_LEVELS[number];

export interface ChatMessage {
  role: 'user' | 'assistant' | 'model';
  content?: string;
  parts?: Array<{ text: string }>;
  model_used?: string;
  thinking_level?: string;
  fallback_used?: boolean;
  timestamp?: string;
}

export interface GeminiContentItem {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

/**
 * Validates requested model ID against explicit allowlist
 */
export function validateModel(requested?: string): string {
  if (!requested || typeof requested !== 'string') {
    return PRIMARY_DEFAULT_MODEL;
  }
  const normalized = requested.trim().toLowerCase();
  if (VALID_PRIMARY_MODELS.includes(normalized as PrimaryModelId)) {
    return normalized;
  }
  return PRIMARY_DEFAULT_MODEL;
}

/**
 * Validates thinking level against supported levels
 */
export function validateThinkingLevel(requested?: string): ThinkingLevel {
  // Backward-compatible mapping: the UI's "Standard" option historically sends
  // "medium". Use Gemini's minimal thinking level for quicker everyday replies.
  // The UI's "Extended" option still maps to high.
  if (typeof requested === 'string' && requested.trim().toLowerCase() === 'high') {
    return 'high';
  }
  return 'minimal';
}

/**
 * Maps internal API model IDs to user-facing DRSSS-branded names.
 * Never exposes raw provider branding to users.
 */
export function getModelDisplayName(modelId: string): string {
  switch (modelId) {
    case 'gemini-3.6-flash':
      return 'DRSSS 3.6 Flash';
    case 'gemini-3.1-flash-lite':
      return 'DRSSS 3.1 Flash Lite';
    case 'gemini-3.5-flash-lite':
    default:
      return 'DRSSS 3.5 Flash Lite';
  }
}

/**
 * Maps thinking level to human-readable label
 */
export function getThinkingDisplayName(level: string): string {
  if (level === 'high') return 'Extended';
  return 'Standard';
}

/**
 * Builds generationConfig object including thinkingConfig
 */
export function buildGenerationConfig(thinkingLevel: ThinkingLevel = 'minimal') {
  return {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 4096,
    thinkingConfig: {
      thinkingLevel
    }
  };
}

/**
 * Checks whether an HTTP status code or network result requires model failover
 */
export function shouldFailover(statusCode: number, isNetworkSuccess: boolean): boolean {
  if (!isNetworkSuccess) return true;
  if (statusCode === 429) return true; // Rate limit / Quota exceeded
  if (statusCode >= 500 && statusCode <= 599) return true; // Server errors (500, 502, 503, 504)
  if (statusCode === 404) return true; // Model not found in this region
  return false;
}

/**
 * Formats multi-turn chat history and the current user message into Gemini REST contents
 */
export function buildGeminiContents(
  history: ChatMessage[],
  newMessage: string
): GeminiContentItem[] {
  const contents: GeminiContentItem[] = [];

  if (Array.isArray(history)) {
    for (const item of history) {
      const role = (item.role === 'assistant' || item.role === 'model') ? 'model' : 'user';
      let text = '';
      if (item.parts && Array.isArray(item.parts) && item.parts.length > 0) {
        text = item.parts.map(p => p.text).join('\n');
      } else if (item.content) {
        text = item.content;
      }

      if (text.trim().length > 0) {
        contents.push({
          role,
          parts: [{ text }]
        });
      }
    }
  }

  if (newMessage && newMessage.trim().length > 0) {
    contents.push({
      role: 'user',
      parts: [{ text: newMessage.trim() }]
    });
  }

  return contents;
}

/**
 * Extracts candidate text reply from raw Gemini API JSON response
 */
export function extractCandidateText(apiResponse: any): { text: string; error?: string } {
  if (!apiResponse) {
    return { text: '', error: 'Empty API response' };
  }

  if (apiResponse.error) {
    return {
      text: '',
      error: apiResponse.error.message || 'Unknown API error'
    };
  }

  if (Array.isArray(apiResponse.candidates) && apiResponse.candidates.length > 0) {
    const candidate = apiResponse.candidates[0];
    if (candidate.content && Array.isArray(candidate.content.parts)) {
      const text = candidate.content.parts
        .map((p: any) => (p && typeof p.text === 'string' ? p.text : ''))
        .join('');
      if (text.length > 0) {
        return { text };
      }
    }
  }

  return { text: '', error: 'No text content found in candidates' };
}

/**
 * Generates a clean thread title from the initial user prompt
 */
export function generateThreadTitle(prompt: string, maxLength: number = 36): string {
  if (!prompt || typeof prompt !== 'string') return 'New conversation';
  const cleaned = prompt.replace(/[\r\n\t]+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength) + '...';
}
