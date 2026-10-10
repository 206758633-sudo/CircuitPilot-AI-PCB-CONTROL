import assert from 'node:assert/strict';
import test from 'node:test';
import { clearEventsForTest, listEvents, logger, redact } from '../logger.mjs';

test('redact removes secret fields and secret-like values recursively', () => {
  const result = redact({ authorization: 'Bearer abcdefghijk', nested: { apiKey: 'sk-1234567890abcdef', text: 'x-api-key: hidden-value' } });
  assert.equal(result.authorization, '[REDACTED]');
  assert.equal(result.nested.apiKey, '[REDACTED]');
  assert.equal(result.nested.text, '[REDACTED]');
});

test('runtime event store is timestamped and returns only redacted data', () => {
  clearEventsForTest();
  logger.info('Test', 'event', { token: 'secret-value', safe: 'visible' });
  const [event] = listEvents();
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(event.data.token, '[REDACTED]');
  assert.equal(event.data.safe, 'visible');
});

