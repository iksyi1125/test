import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, findPrice, normalizeModel, buildPricing } from '../src/pricing.js';

test('normalizeModel strips provider prefixes and vertex suffix', () => {
  assert.equal(normalizeModel('us.anthropic.claude-opus-5'), 'claude-opus-5');
  assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
  assert.equal(normalizeModel('  Claude-Sonnet-5 '), 'claude-sonnet-5');
});

test('findPrice matches families', () => {
  assert.equal(findPrice('claude-fable-5-1').id, 'claude-fable-5-1');
  assert.equal(findPrice('claude-mythos-5').id, 'claude-fable-5');
  assert.equal(findPrice('claude-opus-4-8').id, 'claude-opus-5');
  assert.equal(findPrice('claude-opus-4-1-20250805').id, 'claude-opus-4');
  assert.equal(findPrice('claude-sonnet-4-6').id, 'claude-sonnet-4');
  assert.equal(findPrice('claude-haiku-4-5-20251001').id, 'claude-haiku-4-5');
  assert.equal(findPrice('claude-3-5-haiku-20241022').id, 'claude-haiku-3-5');
  assert.equal(findPrice('gpt-9'), null);
});

test('costOf computes per-million pricing with cache tiers', () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  assert.equal(costOf(u, 'claude-opus-5'), 5);
  assert.equal(costOf({ ...u, input: 0, output: 1_000_000 }, 'claude-sonnet-5'), 10);
  assert.equal(costOf({ ...u, input: 0, cacheRead: 1_000_000 }, 'claude-fable-5-1'), 0.25);
  assert.equal(costOf({ ...u, input: 0, cacheWrite1h: 1_000_000 }, 'claude-opus-5'), 10);
  assert.equal(costOf({ ...u, input: 0, cacheWrite5m: 1_000_000 }, 'claude-opus-5'), 6.25);
  assert.equal(costOf(u, 'claude-unknown'), null);
});

test('buildPricing overrides take precedence and fill cache defaults', () => {
  const p = buildPricing({ 'claude-opus-5': { input: 1, output: 2 } });
  const u = { input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0 };
  assert.equal(costOf(u, 'claude-opus-5', p), 1 + 0.1);
});
