import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Cache of last successful `GET {baseUrl}/models` discovery per endpoint.
// Detection (`context_length` / `top_provider.max_completion_tokens`, e.g.
// OpenRouter) runs ONLY here — at fetch time — and the result is persisted to
// a JSON file so reopening the dashboard (or restarting the server) reads it
// back without another network call. Import (KV mapping) and DSH plan/install
// only read stored/cached values and fall back to 128K context / 32K output.
const FILE_NAME = 'endpoint-models-cache.json';

const toLimit = v => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
};

function normalizeEntry(x) {
  if (!x || typeof x !== 'object') return null;
  const id = typeof x.id === 'string' && x.id ? x.id : typeof x.upstreamId === 'string' && x.upstreamId ? x.upstreamId : null;
  if (!id) return null;
  const out = { id };
  if (typeof x.name === 'string' && x.name) out.name = x.name;
  if (typeof x.upstreamId === 'string' && x.upstreamId && x.upstreamId !== id) out.upstreamId = x.upstreamId;
  const contextWindow = toLimit(x.contextWindow ?? x.windowContext ?? x.context_length ?? x.contextLength);
  const maxTokens = toLimit(x.maxTokens ?? x.maxOutputTokens ?? x.max_completion_tokens ?? x.maxCompletionTokens);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  return out;
}

function blankCache() {
  return { version: 1, endpoints: {} };
}

function isCacheShape(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && !!x.endpoints && typeof x.endpoints === 'object' && !Array.isArray(x.endpoints);
}

// Stores used in tests are plain objects without `dataDir`; keep their cache
// in memory on the store itself so the same helpers work everywhere.
function memCache(store) {
  if (!store._endpointModelsCache || !isCacheShape(store._endpointModelsCache)) store._endpointModelsCache = blankCache();
  return store._endpointModelsCache;
}

function cacheFile(store) {
  const dir = store && typeof store.dataDir === 'string' ? store.dataDir : null;
  return dir ? path.join(dir, FILE_NAME) : null;
}

export function readEndpointCache(store) {
  const file = cacheFile(store);
  if (!file) return memCache(store);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isCacheShape(parsed)) return parsed;
  } catch (e) { if (e && e.code !== 'ENOENT') console.warn('[endpoint-cache] ignoring unreadable cache:', e.message); }
  return blankCache();
}

function persistEndpointCache(store, cache) {
  const file = cacheFile(store);
  if (!file) {
    store._endpointModelsCache = cache;
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(cache, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  } catch (e) { console.warn('[endpoint-cache] failed to persist cache:', e.message); }
}

// Called ONLY from the discover route (fetch time). Overwrites the entry for
// this endpoint with the latest successful result, including fetchedAt.
export function putCachedEndpointModels(store, endpointId, models) {
  if (!endpointId || !Array.isArray(models)) return { models: [], fetchedAt: null };
  const cache = readEndpointCache(store);
  const normalized = models.map(normalizeEntry).filter(Boolean);
  const entry = { fetchedAt: new Date().toISOString(), models: normalized };
  cache.endpoints[endpointId] = entry;
  // Drop entries for endpoints that no longer exist (real stores only).
  try {
    const live = new Set((store.list('endpoints') || []).map(e => e && e.id).filter(Boolean));
    if (live.size) for (const id of Object.keys(cache.endpoints)) if (!live.has(id)) delete cache.endpoints[id];
  } catch { /* in-memory test stores always have list() */ }
  persistEndpointCache(store, cache);
  return entry;
}

// Read back without any network access. Used on reopen and as a fallback.
export function getCachedEndpointModels(store, endpointId) {
  if (!endpointId) return null;
  const cache = readEndpointCache(store);
  const entry = cache.endpoints[endpointId];
  if (!entry || !Array.isArray(entry.models)) return null;
  return { models: entry.models, fetchedAt: entry.fetchedAt || null };
}

// Fill limits missing from an import body with last-known cached values.
// Matches on upstream id first, then public id.
export function lookupCachedLimits(store, endpointId, { upstreamId, publicId } = {}) {
  const cached = getCachedEndpointModels(store, endpointId);
  if (!cached) return null;
  const keys = [upstreamId, publicId].filter(k => typeof k === 'string' && k);
  for (const key of keys) {
    const hit = cached.models.find(m => m.id === key || m.upstreamId === key);
    if (hit && (hit.contextWindow || hit.maxTokens)) {
      const out = {};
      if (toLimit(hit.contextWindow) !== undefined) out.contextWindow = toLimit(hit.contextWindow);
      if (toLimit(hit.maxTokens) !== undefined) out.maxTokens = toLimit(hit.maxTokens);
      if (Object.keys(out).length) return out;
    }
  }
  return null;
}

export function dropCachedEndpoint(store, endpointId) {
  if (!endpointId) return;
  const cache = readEndpointCache(store);
  if (!cache.endpoints[endpointId]) return;
  delete cache.endpoints[endpointId];
  persistEndpointCache(store, cache);
}
