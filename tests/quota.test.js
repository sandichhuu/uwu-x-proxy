import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculateQuotaPercent, quotaBreakdown, familyQuota, familyQuotaAll, familySummary, codexQuota, resetCountdown, countdownFromSec } from '../public/model-dict.js';
import { getAccountRemainingQuota } from '../src/core/models.js';

// Regression: the account badge once preferred any Claude entry, reporting
// 100% while every Gemini variant sat at 0. The account figure must be the
// bottleneck across all known models.
test('google account percent is the minimum across all models', () => {
  const quota = {
    'gemini-3.8-flash-medium': { remainingFraction: 0, resetTime: '2026-09-12T22:47:43Z' },
    'gemini-3.8-flash-low': { remainingFraction: 0.28, resetTime: '2026-09-12T22:47:43Z' },
    'claude-sonnet-4-6': { remainingFraction: 0.999, resetTime: '2026-09-13T13:11:05Z' }
  };
  assert.equal(calculateQuotaPercent({ provider: 'google', quota }), 0);

  const fresh = {
    'gemini-3.8-flash-medium': { remainingFraction: 1, resetTime: 'x' },
    'claude-sonnet-4-6': { remainingFraction: 1, resetTime: 'x' }
  };
  assert.equal(calculateQuotaPercent({ provider: 'google', quota: fresh }), 100);

  const partial = {
    'gemini-3.8-flash-medium': { remainingFraction: null },
    'claude-sonnet-4-6': { remainingFraction: 0.5, resetTime: 'x' }
  };
  assert.equal(calculateQuotaPercent({ provider: 'google', quota: partial }), 50);
});

test('quotaBreakdown lists per-model percentages for tooltips', () => {
  const details = quotaBreakdown({ provider: 'google', quota: {
    'gemini-3.8-flash-medium': { remainingFraction: 0, resetTime: 'x' },
    'claude-sonnet-4-6': { remainingFraction: 0.999, resetTime: 'x' }
  } });
  assert.match(details, /gemini-3\.8-flash-medium 0%/);
  assert.match(details, /claude-sonnet-4-6 100%/);
  assert.equal(quotaBreakdown({ provider: 'google', quota: { remainingFraction: 0.5 } }), null);
  assert.equal(quotaBreakdown({ provider: 'google', quota: {} }), null);
});

test('smart-routing fallback scores the most exhausted model', () => {
  const account = { provider: 'google', quota: {
    'gemini-3.8-flash-medium': { remainingFraction: 0, resetTime: 'x' },
    'claude-sonnet-4-6': { remainingFraction: 1, resetTime: 'x' }
  } };
  assert.equal(getAccountRemainingQuota(account, 'gemini-3.8-flash-medium'), 0);
  assert.equal(getAccountRemainingQuota(account, 'claude-sonnet-4-6'), 100);
  assert.equal(getAccountRemainingQuota(account, 'unknown-model'), 0);
});

test('familyQuota aggregates weekly bottleneck per model family', () => {
  const accounts = [{ provider: 'google', quota: {
    'gemini-3.8-flash-medium': { remainingFraction: 0, resetTime: '2026-09-12T22:47:43Z' },
    'gemini-3.8-flash-low': { remainingFraction: 0.28, resetTime: '2026-09-12T22:47:43Z' },
    'claude-sonnet-4-6': { remainingFraction: 0.999, resetTime: '2026-09-13T13:11:05Z' }
  } }];
  assert.deepEqual(familyQuota(accounts, 'gemini'), { weekly: 0, weeklyReset: '2026-09-12T22:47:43Z' });
  assert.deepEqual(familyQuota(accounts, 'claude'), { weekly: 100, weeklyReset: '2026-09-13T13:11:05Z' });
  assert.deepEqual(familyQuota([], 'gemini'), { weekly: null, weeklyReset: null });
  assert.deepEqual(familyQuota([{ provider: 'google', quota: {} }], 'gemini'), { weekly: null, weeklyReset: null });
});

test('codexQuota reads real five-hour and weekly windows', () => {
  const q = codexQuota([{ provider: 'openai', quota: { rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 83, reset_after_seconds: 11927 },
    secondary_window: { used_percent: 27, reset_after_seconds: 577869 }
  } } }]);
  assert.deepEqual(q.fiveHour, { pct: 17, resetAfterSec: 11927 });
  assert.deepEqual(q.weekly, { pct: 73, resetAfterSec: 577869 });

  const capped = codexQuota([{ provider: 'openai', quota: { rate_limit: { limit_reached: true, primary_window: { used_percent: 10 } } } }]);
  assert.equal(capped.fiveHour.pct, 0);
  assert.deepEqual(codexQuota([]), { fiveHour: null, weekly: null, usableFiveHour: 0, usableWeekly: 0, total: 0 });
});

test('familyQuotaAll headlines the best account, not the worst', () => {
  // Real case: two exhausted accounts hid a healthy 72% one behind a 0%.
  const mk = frac => ({ provider: 'google', quota: { 'gemini-3.8-flash-medium': { remainingFraction: frac, resetTime: '2026-09-12T22:47:43Z' } } });
  const all = familyQuotaAll([mk(0), mk(0.72), mk(0)], 'gemini');
  assert.deepEqual(all, { weekly: 72, weeklyReset: '2026-09-12T22:47:43Z', usable: 1, total: 3 });
  assert.deepEqual(familyQuotaAll([mk(0), { provider: 'google', quota: {} }], 'gemini'), { weekly: 0, weeklyReset: '2026-09-12T22:47:43Z', usable: 0, total: 2 });
  assert.deepEqual(familyQuotaAll([], 'gemini'), { weekly: null, weeklyReset: null, usable: 0, total: 0 });
  const disabled = [{ ...mk(0.9), enabled: false }, mk(0.1)];
  assert.equal(familyQuotaAll(disabled, 'gemini').weekly, 10);
});

test('familySummary reads weekly + 5h buckets from quotaGroups', () => {
  // Shape mirrors v1internal:retrieveUserQuotaSummary.
  const groups = [
    { displayName: 'Gemini Models', description: '', buckets: [
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.13521859, resetTime: '2026-09-11T08:34:28Z', displayName: 'Weekly Limit Remaining' },
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.71735, resetTime: '2026-09-06T21:04:30Z', displayName: 'Five Hour Limit Remaining' }
    ] },
    { displayName: 'Claude and GPT models', description: '', buckets: [
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.6607296, resetTime: '2026-09-13T11:19:58Z', displayName: 'Weekly Limit Remaining' },
      { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-09-06T22:32:19Z', displayName: 'Five Hour Limit Remaining' }
    ] }
  ];
  const gem = familySummary([{ provider: 'google', quotaGroups: groups }], 'gemini');
  assert.deepEqual(gem.weekly, { pct: 14, reset: '2026-09-11T08:34:28Z' });
  assert.deepEqual(gem.fiveHour, { pct: 72, reset: '2026-09-06T21:04:30Z' });
  assert.equal(gem.summarized, true);
  const claude = familySummary([{ provider: 'google', quotaGroups: groups }], 'claude');
  assert.deepEqual(claude.weekly, { pct: 66, reset: '2026-09-13T11:19:58Z' });
  assert.deepEqual(claude.fiveHour, { pct: 100, reset: '2026-09-06T22:32:19Z' });

  // Best across accounts, with usable counts.
  const both = familySummary([
    { provider: 'google', quotaGroups: groups },
    { provider: 'google', quotaGroups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0, resetTime: 'x' }, { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0, resetTime: 'x' }] }] }
  ], 'gemini');
  assert.equal(both.weekly.pct, 14);
  assert.equal(both.fiveHour.pct, 72);
  assert.equal(both.usableWeekly, 1);
  assert.equal(both.total, 2);

  // Legacy fallback when groups are absent.
  const legacy = familySummary([{ provider: 'google', quota: { 'gemini-3.8-flash-medium': { remainingFraction: 0.5, resetTime: '2026-09-12T00:00:00Z' } } }], 'gemini');
  assert.deepEqual(legacy.weekly, { pct: 50, reset: '2026-09-12T00:00:00Z' });
  assert.equal(legacy.fiveHour, null);
  assert.equal(legacy.summarized, false);
});

test('reset countdowns render compactly', () => {
  const now = Date.parse('2026-09-06T13:00:00Z');
  assert.equal(resetCountdown('2026-09-12T22:47:43Z', now), 'resets in 6d 9h');
  assert.equal(resetCountdown('2026-09-06T17:30:00Z', now), 'resets in 4h 30m');
  assert.equal(resetCountdown('not-a-date', now), null);
  assert.equal(countdownFromSec(11927), 'resets in 3h 18m');
  assert.equal(countdownFromSec(577869), 'resets in 6d 16h');
  assert.equal(countdownFromSec(undefined), null);
});

test('dashboard renders family quota sections for google and openai', () => {
  const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /Quota by family/);
  assert.match(appJs, /Weekly Limit Remaining/);
  assert.match(appJs, /Five Hour Limit Remaining/);
  assert.match(appJs, /Gemini Models/);
  assert.match(appJs, /Claude Models/);
  assert.match(appJs, /GPT Models/);
  assert.match(appJs, /All accounts/);
  assert.match(appJs, /selectedAccountId/);
  assert.match(appJs, /Click to show family quota for this account/);
  assert.match(appJs, /pre-selected on tab enter/);
  assert.doesNotMatch(appJs, /quotaSelect/);
});
