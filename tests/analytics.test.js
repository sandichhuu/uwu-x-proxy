import test from 'node:test';
import assert from 'node:assert/strict';
import { analytics } from '../src/api/analytics.js';
const now = Date.parse('2026-06-12T12:30:00Z');
test('analytics aggregates all retained requests, not just the recent 50', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ at: '2026-06-12T12:00:00Z', model: i % 2 ? 'claude' : 'gpt', status: i < 10 ? 500 : 200, tokens: 5 }));
  rows.push({ kind: 'audit', at: '2026-06-12T12:00:00Z' });
  const data = analytics(rows, '24h', now);
  assert.equal(data.requests, 60); assert.equal(data.recent.length, 50);
  assert.equal(data.errors, 10); assert.equal(data.tokens, 300);
  assert.equal(data.series.length, 24); assert.equal(data.series.at(-1).requests, 60);
  assert.equal(data.series.at(-1).errors, 10);
  assert.deepEqual(data.distribution.map(m => m.requests), [30, 30]);
});
test('analytics handles empty data and falls back from invalid ranges', () => {
  const data = analytics([], 'invalid', now);
  assert.equal(data.range, '24h'); assert.equal(data.series.length, 24);
  assert.ok(data.series.every(p => p.requests === 0)); assert.deepEqual(data.distribution, []);
});
test('chart ranges exclude old, future and invalid timestamps; totals stay all-time', () => {
  const rows = ['2026-06-01T12:00:00Z', '2026-06-06T00:00:00Z', '2026-06-12T13:00:00Z', 'invalid'].map(at => ({ at, status: 200 }));
  const week = analytics(rows, '7d', now);
  assert.equal(week.series.length, 7); assert.equal(week.requests, 4);
  assert.equal(week.series[0].requests, 1); assert.deepEqual(week.distribution, [{ model: 'Unknown', requests: 1 }]);
  assert.equal(analytics(rows, '24h', now).distribution.length, 0);
});

test('analytics rejects prototype property names as ranges', () => {
  for (const range of ['constructor', 'toString', '__proto__']) assert.equal(analytics([], range, now).series.length, 24);
});
