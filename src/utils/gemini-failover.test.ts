import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldFailover,
  buildGeminiContents,
  extractCandidateText,
  generateThreadTitle,
  validateModel,
  validateThinkingLevel,
  getModelDisplayName,
  getThinkingDisplayName,
  buildGenerationConfig,
  PRIMARY_DEFAULT_MODEL,
  ADVANCED_PRIMARY_MODEL,
  FALLBACK_MODEL
} from './gemini-failover.ts';

test('shouldFailover returns true on 429 rate limit', () => {
  assert.equal(shouldFailover(429, true), true);
});

test('shouldFailover returns true on 5xx server errors', () => {
  assert.equal(shouldFailover(500, true), true);
  assert.equal(shouldFailover(502, true), true);
  assert.equal(shouldFailover(503, true), true);
  assert.equal(shouldFailover(504, true), true);
});

test('shouldFailover returns true on network/curl failures', () => {
  assert.equal(shouldFailover(0, false), true);
});

test('shouldFailover returns false on 200 OK', () => {
  assert.equal(shouldFailover(200, true), false);
});

test('validateModel correctly validates allowlisted models and falls back to default', () => {
  assert.equal(validateModel('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(validateModel('gemini-3.6-flash'), 'gemini-3.6-flash');
  // Unsupported or arbitrary model defaults safely to PRIMARY_DEFAULT_MODEL
  assert.equal(validateModel('gpt-4'), PRIMARY_DEFAULT_MODEL);
  assert.equal(validateModel('random-model'), PRIMARY_DEFAULT_MODEL);
  assert.equal(validateModel(undefined), PRIMARY_DEFAULT_MODEL);
  assert.equal(validateModel(''), PRIMARY_DEFAULT_MODEL);
});

test('validateThinkingLevel maps Standard to minimal and Extended to high', () => {
  // The current UI sends legacy "medium" for Standard; normalize it to minimal.
  assert.equal(validateThinkingLevel('medium'), 'minimal');
  assert.equal(validateThinkingLevel('minimal'), 'minimal');
  assert.equal(validateThinkingLevel('high'), 'high');
  // Unknown or missing values use the fast Standard configuration.
  assert.equal(validateThinkingLevel('extreme'), 'minimal');
  assert.equal(validateThinkingLevel(undefined), 'minimal');
});

test('getModelDisplayName maps internal IDs to exact DRSSS AI branding', () => {
  assert.equal(getModelDisplayName('gemini-3.5-flash-lite'), 'DRSSS 3.5 Flash Lite');
  assert.equal(getModelDisplayName('gemini-3.6-flash'), 'DRSSS 3.6 Flash');
  assert.equal(getModelDisplayName('gemini-3.1-flash-lite'), 'DRSSS 3.1 Flash Lite');
  // Unknown defaults to DRSSS 3.5 Flash Lite
  assert.equal(getModelDisplayName('unknown'), 'DRSSS 3.5 Flash Lite');
});

test('getThinkingDisplayName maps medium and high to Standard and Extended', () => {
  assert.equal(getThinkingDisplayName('medium'), 'Standard');
  assert.equal(getThinkingDisplayName('high'), 'Extended');
});

test('buildGenerationConfig outputs fast Standard and deep Extended levels', () => {
  const stdConfig = buildGenerationConfig('minimal');
  assert.equal(stdConfig.thinkingConfig.thinkingLevel, 'minimal');

  const extConfig = buildGenerationConfig('high');
  assert.equal(extConfig.thinkingConfig.thinkingLevel, 'high');
});

test('buildGeminiContents formats history and message correctly', () => {
  const history = [
    { role: 'user' as const, content: 'Hello' },
    { role: 'assistant' as const, content: 'Hi there!' }
  ];
  const result = buildGeminiContents(history, 'Tell me about C++');

  assert.equal(result.length, 3);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].parts[0].text, 'Hello');
  assert.equal(result[1].role, 'model'); // Assistant converted to model
  assert.equal(result[1].parts[0].text, 'Hi there!');
  assert.equal(result[2].role, 'user');
  assert.equal(result[2].parts[0].text, 'Tell me about C++');
});

test('extractCandidateText extracts text properly from valid response', () => {
  const mockResponse = {
    candidates: [
      {
        content: {
          parts: [{ text: 'This is the generated answer.' }],
          role: 'model'
        },
        finishReason: 'STOP'
      }
    ]
  };

  const { text, error } = extractCandidateText(mockResponse);
  assert.equal(text, 'This is the generated answer.');
  assert.equal(error, undefined);
});

test('extractCandidateText handles error response', () => {
  const mockError = {
    error: {
      code: 429,
      message: 'Resource has been exhausted (e.g. check quota).'
    }
  };

  const { text, error } = extractCandidateText(mockError);
  assert.equal(text, '');
  assert.match(error || '', /quota/i);
});

test('generateThreadTitle truncates long prompt cleanly', () => {
  const shortPrompt = 'How does Docker work?';
  assert.equal(generateThreadTitle(shortPrompt), 'How does Docker work?');

  const longPrompt = 'Can you please explain in extreme detail how the Linux kernel schedules threads and manages memory pages?';
  const truncated = generateThreadTitle(longPrompt, 30);
  assert.equal(truncated.length, 33); // 30 chars + '...'
  assert.ok(truncated.endsWith('...'));
});
