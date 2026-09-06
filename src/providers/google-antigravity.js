import { randomUUID } from 'node:crypto';
import { validAccessToken } from '../auth/oauth.js';
import { ANTIGRAVITY_HEADERS } from '../auth/google/runtime.js';
import { discoverProjectId } from '../auth/google/project.js';

const ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
];

const upstreamError = (status, detail) => {
  const message = `Google upstream returned HTTP ${status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`;
  return Object.assign(new Error(message), { status, upstreamStatus: status });
};

// Wrap a Gemini inner request in the Cloud Code envelope and POST it to
// v1internal:generateContent (non-stream) or v1internal:streamGenerateContent
// (SSE). Falls over from daily to prod on network/5xx failures; 4xx surfaces
// immediately so quota/auth problems keep their real status instead of a 502.
export async function executeGoogle(store, account, innerRequest, upstreamId, signal, { stream = false } = {}) {
  const token = await validAccessToken(store, account);
  const projectId = account.projectId || await discoverProjectId(token);
  if (!projectId) throw Object.assign(new Error('Google account has no project ID; re-run discovery'), { status: 503 });
  const envelope = {
    project: projectId,
    model: upstreamId,
    request: innerRequest,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `agent-${randomUUID()}`
  };
  const path = stream ? 'v1internal:streamGenerateContent?alt=sse' : 'v1internal:generateContent';
  const headers = { Authorization: `Bearer ${token}`, ...ANTIGRAVITY_HEADERS };
  let lastError;
  for (const endpoint of ENDPOINTS) {
    let response;
    try {
      response = await fetch(`${endpoint}/${path}`, { method: 'POST', headers, body: JSON.stringify(envelope), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
      continue;
    }
    if (response.ok) return response;
    const detail = await response.text().catch(() => '');
    lastError = upstreamError(response.status, detail);
    await response.body?.cancel().catch(() => {});
    if (response.status < 500) throw lastError;
  }
  throw lastError || new Error('Google upstream request failed');
}

export const isAllowedGoogleModel = id => /^(?:gemini-3\.[678]-flash-.+|claude-.+)$/i.test(id);

export const FALLBACK_GOOGLE_MODELS = [
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-6',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-tiered',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash-tiered',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.6-flash-tiered'
];

export async function fetchAvailableModelsGoogle(token, projectId = null) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...ANTIGRAVITY_HEADERS
  };

  const body = projectId ? { project: projectId } : {};
  let mergedModels = {};
  let foundAny = false;

  // Try daily first (has all preview and 3.8 models), then prod, merging discovered models
  for (const endpoint of ENDPOINTS) {
    try {
      const url = `${endpoint}/v1internal:fetchAvailableModels`;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });

      if (response.ok) {
        const data = await response.json();
        if (data.models && typeof data.models === 'object') {
          foundAny = true;
          for (const [k, v] of Object.entries(data.models)) {
            if (!mergedModels[k]) mergedModels[k] = v;
          }
        }
      } else {
        const errorText = await response.text().catch(() => '');
        if (response.status === 403) {
          const lower = errorText.toLowerCase();
          if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
            throw new Error(`ACCOUNT_BANNED: ${errorText}`);
          }
        }
      }
    } catch (e) {
      if (e.message?.startsWith('ACCOUNT_BANNED')) throw e;
    }
  }

  // Fallback: try without projectId in body if body with project had no models
  if (!foundAny && projectId) {
    for (const endpoint of ENDPOINTS) {
      try {
        const url = `${endpoint}/v1internal:fetchAvailableModels`;
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(15000)
        });
        if (response.ok) {
          const data = await response.json();
          if (data.models && typeof data.models === 'object') {
            foundAny = true;
            for (const [k, v] of Object.entries(data.models)) {
              if (!mergedModels[k]) mergedModels[k] = v;
            }
          }
        }
      } catch {}
    }
  }

  if (foundAny) return { models: mergedModels };
  throw new Error('Failed to fetch available models from Google Antigravity endpoints');
}

const SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
];

// Grouped quota summary (weekly + 5h windows per model family), the same
// source the Antigravity IDE displays. Best-effort: returns null on any
// failure so discovery/quota refresh is never blocked by it.
export async function fetchQuotaSummary(token, projectId = null) {
  const headers = { Authorization: `Bearer ${token}`, ...ANTIGRAVITY_HEADERS };
  const body = projectId ? { project: projectId } : {};
  for (const endpoint of SUMMARY_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (!Array.isArray(data.groups)) continue;
      const groups = data.groups
        .filter(g => g && Array.isArray(g.buckets))
        .map(g => ({
          displayName: g.displayName || '',
          description: g.description || '',
          buckets: g.buckets.map(b => ({
            bucketId: b.bucketId || '',
            window: b.window || '',
            remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
            resetTime: b.resetTime || null,
            displayName: b.displayName || ''
          }))
        }));
      return groups;
    } catch {
      continue;
    }
  }
  return null;
}
export async function discoverGoogle(store, account) {
  const token = await validAccessToken(store, account);
  let projectId = account.projectId;

  if (!projectId) {
    try {
      projectId = await discoverProjectId(token);
    } catch (err) {
      console.warn('discoverProjectId fallback failed:', err.message);
    }
  }

  let data = null;
  try {
    data = await fetchAvailableModelsGoogle(token, projectId);
  } catch (err) {
    if (err.message?.startsWith('ACCOUNT_BANNED')) throw err;
    console.warn('fetchAvailableModelsGoogle failed, using fallback models:', err.message);
  }

  const rawModels = data?.models || {};
  const models = Object.entries(rawModels)
    .filter(([id]) => isAllowedGoogleModel(id))
    .map(([id, value]) => ({
      id,
      name: value.displayName || id,
      upstreamId: id,
      quota: value.quotaInfo ? {
        remainingFraction: value.quotaInfo.remainingFraction ?? (value.quotaInfo.resetTime ? 0 : null),
        resetTime: value.quotaInfo.resetTime ?? null
      } : null
    }));

  // Ensure claude-sonnet-4-6-thinking is exposed (matching sample project)
  const sonnetBase = models.find(m => m.id === 'claude-sonnet-4-6');
  if (sonnetBase && !models.some(m => m.id === 'claude-sonnet-4-6-thinking')) {
    models.push({
      id: 'claude-sonnet-4-6-thinking',
      name: 'Claude Sonnet 4.6 (Thinking)',
      upstreamId: 'claude-sonnet-4-6',
      quota: sonnetBase.quota
    });
  }

  // If upstream discovery returned empty, populate with fallback models
  if (models.length === 0) {
    for (const id of FALLBACK_GOOGLE_MODELS) {
      models.push({
        id,
        name: id,
        upstreamId: id === 'claude-sonnet-4-6-thinking' ? 'claude-sonnet-4-6' : id,
        quota: null
      });
    }
  }

  const quotaMap = Object.fromEntries(models.map(x => [x.id, x.quota]));
  // Grouped weekly + 5h summary (the Antigravity display source). Best-effort
  // and never blocking: a failed fetch keeps the previous groups.
  let quotaGroups;
  try {
    quotaGroups = await fetchQuotaSummary(token, projectId);
  } catch (err) {
    console.warn('fetchQuotaSummary failed, keeping previous groups:', err.message);
  }
  store.upsert('accounts', {
    ...account,
    projectId,
    quota: quotaMap,
    ...(quotaGroups ? { quotaGroups, quotaGroupsAt: new Date().toISOString() } : {}),
    lastDiscoveredAt: new Date().toISOString()
  });

  return models;
}