import { importFromCodex } from '../auth/codex-import.js';
import { analytics } from './analytics.js';
import express from 'express';
import { auth } from '../security/auth.js';
import { assertSafeUrl } from '../security/network.js';
import { id } from '../storage/store.js';
import { discoverEndpoint, endpointHeaders } from '../providers/api-endpoint.js';
import { validAccessToken } from '../auth/oauth.js';
import { createOAuthFlows } from '../auth/flows.js';
import { discoverGoogle } from '../providers/google-antigravity.js';
import { buildAccountExport, normalizeAccountImport, findImportTarget, TRANSFERABLE_PROVIDERS } from '../auth/account-transfer.js';
import { discoverOpenAI, quotaOpenAI } from '../providers/openai-codex.js';
import { putCachedEndpointModels, getCachedEndpointModels, lookupCachedLimits, dropCachedEndpoint } from '../storage/endpoint-cache.js';
import { run } from './inference.js';

const safeAccount = ({ accessToken, refreshToken, idToken, ...account }) => account;
const normalizeRoutePrefix = (raw) => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  return s.replace(/[\s/]+/g, '_');
};
const prefixedRouteId = (prefixRaw, baseId) => {
  const prefix = normalizeRoutePrefix(prefixRaw);
  const base = String(baseId ?? '').trim();
  if (!prefix) return base;
  if (base.toLowerCase().startsWith(`${prefix}/`)) return base;
  return `${prefix}/${base}`;
};
const account = (store, provider, accountId) => {
  const value = store.list('accounts').find(x => x.id === accountId && x.provider === provider);
  if (!value) throw Object.assign(new Error('Account not found'), { status: 404 }); return value;
};
export function adminRouter(store) {
 const flows = createOAuthFlows(store);
 const r = express.Router(); r.use(auth(store, true));
 r.post('/accounts/openai/import-codex', (req,res,next) => { try { res.set('Cache-Control', 'no-store').json(importFromCodex(store)); } catch(e) { next(e); } });
 r.get('/health', (_, res) => res.json({ ok: true }));
 r.post('/chat', (req, res) => run(store, req, res, 'anthropic'));
 r.get('/models', (_, res) => res.json(store.list('models')));
 r.post('/models', (req,res) => {
   const { id: modelId, endpointId, upstreamId, name, effort, provider, accountIds, enabled = true, strategy = 'round-robin', variants, sources } = req.body;
   if (!modelId || !upstreamId || (!endpointId && !provider)) return res.status(400).json({ error: 'id, upstreamId, and endpointId or provider are required' });
   const effortConfig = effort || { mode: req.body.mode || 'forward', supported: req.body.supported || [] };
   if (variants) effortConfig.variants = variants;
   res.status(201).json(store.upsert('models', {
     id: modelId,
     endpointId,
     upstreamId,
     provider,
     accountIds,
     name: name || modelId,
     effort: effortConfig,
     variants: variants || effortConfig.variants,
     sources: sources || (endpointId ? [{ type: 'endpoint', endpointId, upstreamId }] : [{ type: 'account', provider, upstreamId }]),
     enabled,
     strategy
   }));
 });
 r.get('/routes', (_, res) => res.json(store.list('routes')));
 r.post('/routes', (req, res) => {
   const { id: routeId, endpointId, upstreamId, name, effort, provider, accountIds, enabled = true, strategy = 'round-robin', variants, sources } = req.body;
   if (!routeId || !upstreamId || (!endpointId && !provider)) return res.status(400).json({ error: 'id, upstreamId, and endpointId or provider are required' });
   const effortConfig = effort || { mode: req.body.mode || 'forward', supported: req.body.supported || [] };
   if (variants) effortConfig.variants = variants;
   res.status(201).json(store.upsert('routes', {
     id: routeId, endpointId, upstreamId, provider, accountIds, name: name || routeId,
     effort: effortConfig, variants: variants || effortConfig.variants,
     sources: sources || (endpointId ? [{ type: 'endpoint', endpointId, upstreamId }] : [{ type: 'account', provider, upstreamId }]),
     enabled, strategy
   }));
 });
 r.post('/routes/auto-map', (req, res, next) => {
   try {
     // Routes are a separate registry. Auto Map must never mutate account/endpoint model cards.


      const defaultRoutes = [
        {
          id: 'google/gemini-3.8-flash',
          name: 'Gemini 3.8 Flash',
          provider: 'google',
          upstreamId: 'gemini-3.8-flash-medium',
         effort: {
           mode: 'variant',
           default: 'medium',
           supported: ['low', 'medium', 'high', 'xhigh'],
           variants: {
             low: 'gemini-3.8-flash-low',
             medium: 'gemini-3.8-flash-medium',
             high: 'gemini-3.8-flash-high',
             xhigh: 'gemini-3.8-flash-tiered'
           }
         },
         variants: {
           low: 'gemini-3.8-flash-low',
           medium: 'gemini-3.8-flash-medium',
           high: 'gemini-3.8-flash-high',
           xhigh: 'gemini-3.8-flash-tiered'
         },
         enabled: true,
         strategy: 'round-robin'
       },
        {
          id: 'google/gemini-3.7-flash',
          name: 'Gemini 3.7 Flash',
          provider: 'google',
          upstreamId: 'gemini-3.7-flash-medium',
         effort: {
           mode: 'variant',
           default: 'medium',
           supported: ['low', 'medium', 'high', 'xhigh'],
           variants: {
             low: 'gemini-3.7-flash-low',
             medium: 'gemini-3.7-flash-medium',
             high: 'gemini-3.7-flash-high',
             xhigh: 'gemini-3.7-flash-tiered'
           }
         },
         variants: {
           low: 'gemini-3.7-flash-low',
           medium: 'gemini-3.7-flash-medium',
           high: 'gemini-3.7-flash-high',
           xhigh: 'gemini-3.7-flash-tiered'
         },
         enabled: true,
         strategy: 'round-robin'
       },
        {
          id: 'google/gemini-3.6-flash',
          name: 'Gemini 3.6 Flash',
          provider: 'google',
          upstreamId: 'gemini-3.6-flash-medium',
         effort: {
           mode: 'variant',
           default: 'medium',
           supported: ['low', 'medium', 'high', 'xhigh'],
           variants: {
             low: 'gemini-3.6-flash-low',
             medium: 'gemini-3.6-flash-medium',
             high: 'gemini-3.6-flash-high',
             xhigh: 'gemini-3.6-flash-tiered'
           }
         },
         variants: {
           low: 'gemini-3.6-flash-low',
           medium: 'gemini-3.6-flash-medium',
           high: 'gemini-3.6-flash-high',
           xhigh: 'gemini-3.6-flash-tiered'
         },
         enabled: true,
         strategy: 'round-robin'
       },
        {
          id: 'google/claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          provider: 'google',
          upstreamId: 'claude-sonnet-4-6',
         effort: {
           mode: 'variant',
           default: 'medium',
           supported: ['low', 'medium', 'high'],
           variants: {
             low: 'claude-sonnet-4-6',
             medium: 'claude-sonnet-4-6',
             high: 'claude-sonnet-4-6-thinking'
           }
         },
         variants: {
           low: 'claude-sonnet-4-6',
           medium: 'claude-sonnet-4-6',
           high: 'claude-sonnet-4-6-thinking'
         },
         enabled: true,
         strategy: 'round-robin'
       },
        {
          id: 'openai/gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          provider: 'openai',
          upstreamId: 'gpt-5.6-sol',
         effort: {
           mode: 'forward',
           supported: []
         },
         enabled: true,
         strategy: 'round-robin'
       },
        {
          id: 'openai/gpt-5.6-terra',
          name: 'GPT-5.6 Terra',
          provider: 'openai',
          upstreamId: 'gpt-5.6-terra',
         effort: {
           mode: 'forward',
           supported: []
         },
         enabled: true,
         strategy: 'round-robin'
       },
        {
          id: 'openai/gpt-5.6-luna',
          name: 'GPT-5.6 Luna',
          provider: 'openai',
          upstreamId: 'gpt-5.6-luna',
         effort: {
           mode: 'forward',
           supported: []
         },
         enabled: true,
         strategy: 'round-robin'
       },
        {
          id: 'openai/gpt-6-astra',
          name: 'GPT-6 Astra',
          provider: 'openai',
          upstreamId: 'gpt-6-astra',
         effort: {
           mode: 'forward',
           supported: []
         },
         enabled: true,
         strategy: 'round-robin'
       }
     ];

      const legacyDefaultIds = {
        'gemini-3.8-flash': 'google/gemini-3.8-flash',
        'gemini-3.7-flash': 'google/gemini-3.7-flash',
        'gemini-3.6-flash': 'google/gemini-3.6-flash',
        'claude-sonnet-4-6': 'google/claude-sonnet-4-6',
        'gpt-5.6-sol': 'openai/gpt-5.6-sol',
        'gpt-5.6-terra': 'openai/gpt-5.6-terra',
        'gpt-5.6-luna': 'openai/gpt-5.6-luna',
        'gpt-6-astra': 'openai/gpt-6-astra'
      };

      for (const route of defaultRoutes) {
        // Migrate legacy unprefixed route customizations (enabled/strategy) on upgrade.
        const legacyId = Object.keys(legacyDefaultIds).find(k => legacyDefaultIds[k] === route.id);
        const legacy = legacyId ? store.list('routes').find(r => r.id === legacyId) : null;
        const existing = store.list('routes').find(r => r.id === route.id);
        if (legacy && !existing) {
          if (typeof legacy.enabled === 'boolean') route.enabled = legacy.enabled;
          if (legacy.strategy) route.strategy = legacy.strategy;
        }
        store.upsert('routes', route);
        if (legacyId) store.remove('routes', legacyId);
      }

      // Map endpoint-backed model cards to routes as well (forward mode:
      // the public name is "<endpoint>/<model>" so the origin is explicit,
      // e.g. "ollama/llama3.2:latest". Existing routes are never
      // overwritten; account cards are skipped here.
      let endpointCount = 0;
      for (const m of store.list('models')) {
        const endpointIds = Array.from(new Set([
          ...(m.endpointIds || (m.endpointId ? [m.endpointId] : [])),
          ...(m.sources || []).filter(s => (s.type === 'endpoint' || s.endpointId) && s.endpointId).map(s => s.endpointId)
        ])).filter(id => store.list('endpoints').some(e => e.id === id && e.enabled !== false));
        if (!endpointIds.length) continue;
        const primaryEndpoint = store.list('endpoints').find(e => e.id === endpointIds[0]);
        const routeId = prefixedRouteId(primaryEndpoint?.name || primaryEndpoint?.id || 'endpoint', m.id);
        if (store.list('routes').some(r => r.id === routeId)) continue;
        // Migrate stale endpoint routes for the same model+endpoint: legacy
        // unprefixed ids ("llama3.2:latest") or old prefixes left behind
        // after the endpoint was renamed ("ollama/..." -> "ollama_edited/...").
        const staleEndpointRoutes = store.list('routes').filter(r => {
          if (r.id === routeId) return false;
          if (!(r.id === m.id || r.id.endsWith('/' + m.id))) return false;
          if (r.upstreamId !== m.upstreamId) return false;
          const refs = new Set([
            ...(r.endpointIds || (r.endpointId ? [r.endpointId] : [])),
            ...((r.sources || []).filter(s => s.endpointId).map(s => s.endpointId))
          ]);
          return endpointIds.some(id => refs.has(id));
        });
        let enabled = m.enabled !== false;
        let strategy = m.strategy || 'round-robin';
        const donorRoute = staleEndpointRoutes[0];
        if (donorRoute) {
          if (typeof donorRoute.enabled === 'boolean') enabled = donorRoute.enabled;
          if (donorRoute.strategy) strategy = donorRoute.strategy;
          for (const stale of staleEndpointRoutes) store.remove('routes', stale.id);
        }
        store.upsert('routes', {
          id: routeId,
          name: routeId,
          upstreamId: m.upstreamId,
          endpointId: endpointIds[0],
          endpointIds,
          sources: endpointIds.map(endpointId => ({ type: 'endpoint', endpointId, upstreamId: m.upstreamId })),
          effort: { mode: 'forward', supported: [] },
          enabled,
          strategy,
          ...(Number(m.contextWindow) > 0 ? { contextWindow: Math.floor(Number(m.contextWindow)) } : {}),
          ...(Number(m.maxTokens) > 0 ? { maxTokens: Math.floor(Number(m.maxTokens)) } : {})
        });
        endpointCount++;
      }
      // Final sweep: drop any leftover legacy default ids superseded by prefixed ones.
      for (const [legacyId, newId] of Object.entries(legacyDefaultIds)) {
        if (store.list('routes').some(r => r.id === newId)) store.remove('routes', legacyId);
      }
      res.json({ ok: true, count: defaultRoutes.length + endpointCount, routes: store.list('routes') });
   } catch (e) { next(e); }
 });
 r.patch('/routes/:id', (req,res) => { const old = store.list('routes').find(x => x.id === req.params.id); if (!old) return res.sendStatus(404); res.json(store.upsert('routes', { ...old, ...req.body, id: old.id })); });
 r.delete('/routes/:id', (req,res) => res.sendStatus(store.remove('routes', req.params.id) ? 204 : 404));
 r.patch('/models/:id', (req,res) => { const old = store.list('models').find(x => x.id === req.params.id); if (!old) return res.sendStatus(404); res.json(store.upsert('models', { ...old, ...req.body, id: old.id })); });
 r.delete('/models/:id', (req,res) => res.sendStatus(store.remove('models', req.params.id) ? 204 : 404));
 r.get('/accounts', (req,res) => res.json(store.list('accounts').filter(x => !req.query.provider || x.provider === req.query.provider).map(safeAccount)));
 r.post('/accounts/:provider/oauth/start', async (req,res,next) => { try { res.set('Cache-Control', 'no-store').json(await flows.start(req.params.provider, req.body?.mode || 'browser')); } catch(e) { next(e); } });
 r.post('/accounts/:provider/oauth/complete', async (req,res,next) => { try { res.json(await flows.complete(req.params.provider, req.body.callbackInput || req.body.callback || req.body.code, req.body.state)); } catch(e) { next(e); } });
 r.get('/accounts/:provider/oauth/status', (req,res,next) => { try { res.set('Cache-Control', 'no-store').json(flows.status(req.params.provider, req.query.state)); } catch(e) { next(e); } });
 r.post('/accounts/:provider/oauth/cancel', (req,res,next) => { try { res.json(flows.cancel(req.params.provider, req.body.state)); } catch(e) { next(e); } });
 r.patch('/accounts/:provider/:id', (req,res,next) => { try { const old = account(store, req.params.provider, req.params.id); const allowed = {}; if (typeof req.body.enabled === 'boolean') allowed.enabled = req.body.enabled; res.json(safeAccount(store.upsert('accounts', { ...old, ...allowed }))); } catch(e) { next(e); } });
 r.delete('/accounts/:provider/:id', (req,res) => res.sendStatus(store.remove('accounts', req.params.id) ? 204 : 404));
 r.post('/accounts/:provider/:id/refresh', async (req,res,next) => { try { const value = account(store, req.params.provider, req.params.id); await validAccessToken(store, { ...value, expiresAt: 0 }); res.json(safeAccount(account(store, req.params.provider, req.params.id))); } catch(e) { next(e); } });
 r.post('/accounts/:provider/:id/discover', async (req,res,next) => { try { const value = account(store, req.params.provider, req.params.id); const models = req.params.provider === 'google' ? await discoverGoogle(store, value) : await discoverOpenAI(store, value); res.json({ models }); } catch(e) { next(e); } });
 r.post('/accounts/:provider/:id/quota', async (req,res,next) => {
   try {
     const value = account(store, req.params.provider, req.params.id);
     if (req.params.provider === 'openai') {
       res.json(await quotaOpenAI(store, value));
     } else if (req.params.provider === 'google') {
       await discoverGoogle(store, value);
       const updated = account(store, 'google', req.params.id);
       res.json({ quota: updated.quota, lastDiscoveredAt: updated.lastDiscoveredAt });
     } else {
       res.status(400).json({ error: 'Provider does not support quota' });
     }
   } catch(e) { next(e); }
 });
  r.get('/accounts/:provider/export', (req, res) => {
    if (!TRANSFERABLE_PROVIDERS.includes(req.params.provider)) return res.status(400).json({ error: { message: 'Provider does not support transfer' } });
    const payload = buildAccountExport(req.params.provider, store.list('accounts'));
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="uwu-x-proxy-${req.params.provider}-accounts-${new Date().toISOString().slice(0, 10)}.json"` });
    res.send(JSON.stringify(payload, null, 2));
  });
  r.post('/accounts/:provider/import', (req, res) => {
    if (!TRANSFERABLE_PROVIDERS.includes(req.params.provider)) return res.status(400).json({ error: { message: 'Provider does not support transfer' } });
    const { entries, errors } = normalizeAccountImport(req.params.provider, req.body);
    const skipped = [...errors];
    let imported = 0, updated = 0;
    for (const entry of entries) {
      const old = findImportTarget(store.list('accounts'), req.params.provider, entry);
      if (old) {
        store.upsert('accounts', {
          ...old,
          refreshToken: entry.refreshToken,
          ...(entry.accountId ? { accountId: entry.accountId } : {}),
          ...(entry.projectId ? { projectId: entry.projectId } : {})
        });
        updated++;
      } else {
        store.upsert('accounts', {
          id: id('account'), provider: req.params.provider, source: 'imported',
          email: entry.email, accountId: entry.accountId, refreshToken: entry.refreshToken, projectId: entry.projectId,
          enabled: entry.enabled, createdAt: new Date().toISOString()
        });
        imported++;
      }
    }
    res.json({ imported, updated, skipped });
  });
  r.get('/endpoints', (_, res) => res.json(store.list('endpoints').map(({ apiKey, ...safe }) => safe)));
 r.post('/endpoints', async (req,res,next) => { try { const { name, baseUrl, protocol = 'openai', apiKey, headers, timeoutMs, enabled = true, allowPrivate = false } = req.body; if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl are required' }); const normalized = await assertSafeUrl(baseUrl, { allowPrivate }); const endpoint = { id: id('endpoint'), name, baseUrl: normalized, protocol, apiKey, headers: headers || {}, timeoutMs, enabled, allowPrivate }; validateEndpoint(endpoint); store.upsert('endpoints', endpoint); const { apiKey: _, ...safe } = endpoint; res.status(201).json(safe); } catch(e) { next(e); } });
 r.patch('/endpoints/:id', async (req,res,next) => { try { const old = store.list('endpoints').find(x => x.id === req.params.id); if (!old) return res.sendStatus(404); const updated = { ...old, ...req.body, id: old.id }; if (req.body.baseUrl) updated.baseUrl = await assertSafeUrl(req.body.baseUrl, { allowPrivate: updated.allowPrivate }); validateEndpoint(updated); store.upsert('endpoints', updated); const { apiKey, ...safe } = updated; res.json(safe); } catch(e) { next(e); } });
 r.delete('/endpoints/:id', (req, res) => {
    const epId = req.params.id;
    const removed = store.remove('endpoints', epId);
    if (!removed) return res.sendStatus(404);
    dropCachedEndpoint(store, epId);
   for (const m of store.list('models')) {
     let changed = false;
     if (m.sources) {
       const beforeLen = m.sources.length;
       m.sources = m.sources.filter(s => s.endpointId !== epId);
       if (m.sources.length !== beforeLen) changed = true;
     }
     if (m.endpointIds) {
       const beforeLen = m.endpointIds.length;
       m.endpointIds = m.endpointIds.filter(id => id !== epId);
       if (m.endpointIds.length !== beforeLen) changed = true;
     }
     if (m.endpointId === epId) {
       m.endpointId = m.endpointIds?.[0];
       changed = true;
     }
     const hasRemaining = (m.sources && m.sources.length > 0) || (m.endpointIds && m.endpointIds.length > 0) || m.endpointId || m.provider;
     if (!hasRemaining) {
       store.remove('models', m.id);
     } else if (changed) {
       store.upsert('models', m);
     }
   }
   res.sendStatus(204);
 });
 r.delete('/endpoints/:id/models/:modelId', (req, res, next) => {
   try {
     const epId = req.params.id;
     const modelId = req.params.modelId;
     const model = store.list('models').find(m => m.id === modelId);
     if (!model) return res.sendStatus(404);
     if (model.sources) {
       model.sources = model.sources.filter(s => !(s.type === 'endpoint' && s.endpointId === epId));
     }
     if (model.endpointIds) {
       model.endpointIds = model.endpointIds.filter(id => id !== epId);
     }
     if (model.endpointId === epId) {
       model.endpointId = model.endpointIds?.[0] || undefined;
     }
     const hasRemaining = (model.sources && model.sources.length > 0) || (model.endpointIds && model.endpointIds.length > 0) || model.endpointId || model.provider;
     if (!hasRemaining) {
       store.remove('models', model.id);
     } else {
       store.upsert('models', model);
     }
     res.sendStatus(204);
   } catch (e) { next(e); }
 });
  r.post('/endpoints/:id/models', (req, res, next) => {
    try {
      const endpoint = store.list('endpoints').find(e => e.id === req.params.id);
      if (!endpoint) return res.sendStatus(404);
      if (endpoint.protocol !== 'openai') return res.status(400).json({ error: { message: 'This import requires an OpenAI-compatible endpoint' } });
      const { publicId, upstreamId } = req.body;
      if (typeof publicId !== 'string' || !publicId.trim() || publicId.length > 256 || typeof upstreamId !== 'string' || !upstreamId.trim() || upstreamId.length > 256) {
        return res.status(400).json({ error: { message: 'Valid publicId and upstreamId are required (max 256 characters)' } });
      }
      const toLimit = v => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return undefined;
        return Math.floor(n);
      };
      // Accept canonical + OpenRouter-style aliases so discovered limits survive import.
      // Missing values fall back to the fetch-time JSON cache (endpoint-cache).
      let contextWindow = toLimit(req.body.contextWindow ?? req.body.windowContext ?? req.body.context_length ?? req.body.contextLength);
      let maxTokens = toLimit(req.body.maxTokens ?? req.body.maxOutputTokens ?? req.body.max_completion_tokens ?? req.body.maxCompletionTokens);
      if (contextWindow === undefined || maxTokens === undefined) {
        const cached = lookupCachedLimits(store, endpoint.id, { upstreamId: upstreamId.trim(), publicId: publicId.trim() });
        if (cached) {
          if (contextWindow === undefined && cached.contextWindow !== undefined) contextWindow = cached.contextWindow;
          if (maxTokens === undefined && cached.maxTokens !== undefined) maxTokens = cached.maxTokens;
        }
      }
      const trimmedPubId = publicId.trim();
      const trimmedUpId = upstreamId.trim();
      const existing = store.list('models').find(m => m.id === trimmedPubId);
      if (existing) {
        const isSameEndpoint = existing.endpointId === endpoint.id || existing.endpointIds?.includes(endpoint.id) || existing.sources?.some(s => s.endpointId === endpoint.id);
        if (isSameEndpoint) {
          const existingUpstream = existing.sources?.find(s => s.endpointId === endpoint.id)?.upstreamId || (existing.endpointId === endpoint.id ? existing.upstreamId : null);
          if (existingUpstream && existingUpstream !== trimmedUpId) {
            return res.status(409).json({ error: { message: 'Public model ID already exists. Choose another name.' } });
          }
          existing.enabled = true;
          if (contextWindow !== undefined) existing.contextWindow = contextWindow;
          if (maxTokens !== undefined) existing.maxTokens = maxTokens;
          return res.json(store.upsert('models', existing));
        }
        if (!existing.sources) {
          existing.sources = [];
          if (existing.provider) {
            existing.sources.push({ type: 'account', provider: existing.provider, accountIds: existing.accountIds || [], upstreamId: existing.upstreamId });
          }
          if (existing.endpointId) {
            existing.sources.push({ type: 'endpoint', endpointId: existing.endpointId, upstreamId: existing.upstreamId });
          }
        }
        existing.sources.push({ type: 'endpoint', endpointId: endpoint.id, upstreamId: trimmedUpId });
        existing.endpointIds = Array.from(new Set([...(existing.endpointIds || (existing.endpointId ? [existing.endpointId] : [])), endpoint.id]));
        if (!existing.endpointId) existing.endpointId = endpoint.id;
        existing.enabled = true;
        if (contextWindow !== undefined) existing.contextWindow = contextWindow;
        if (maxTokens !== undefined) existing.maxTokens = maxTokens;
        return res.status(201).json(store.upsert('models', existing));
      }
      res.status(201).json(store.upsert('models', {
        id: trimmedPubId,
        name: trimmedPubId,
        endpointId: endpoint.id,
        endpointIds: [endpoint.id],
        upstreamId: trimmedUpId,
        sources: [{ type: 'endpoint', endpointId: endpoint.id, upstreamId: trimmedUpId }],
        enabled: true,
        strategy: 'round-robin',
        effort: { mode: 'forward', supported: [] },
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {})
      }));
    } catch (e) { next(e); }
  });
  r.post('/endpoints/:id/discover', async (req,res,next) => { try { const ep = store.list('endpoints').find(x => x.id === req.params.id); if (!ep) return res.sendStatus(404); const models = await discoverEndpoint(ep); const cached = putCachedEndpointModels(store, ep.id, models); res.json({ models, fetchedAt: cached.fetchedAt }); } catch(e) { next(e); } });
  // Read back last successful discovery without network access (dashboard reopen).
  r.get('/endpoints/:id/discover/cache', (req,res) => { if (!store.list('endpoints').some(x => x.id === req.params.id)) return res.sendStatus(404); res.json(getCachedEndpointModels(store, req.params.id) || { models: [], fetchedAt: null }); });
 r.get('/analytics', (req,res) => res.json(analytics(store.list('requests'), req.query.range)));
 return r;
}
function validateEndpoint(endpoint) {
  if (!['openai', 'anthropic'].includes(endpoint.protocol)) throw new Error('protocol must be openai or anthropic');
  if (typeof endpoint.enabled !== 'boolean' || typeof endpoint.allowPrivate !== 'boolean') throw new Error('enabled and allowPrivate must be boolean');
  if (endpoint.timeoutMs !== undefined && (!Number.isInteger(endpoint.timeoutMs) || endpoint.timeoutMs < 100 || endpoint.timeoutMs > 600000)) throw new Error('timeoutMs must be between 100 and 600000');
  if (endpoint.apiKey !== undefined && typeof endpoint.apiKey !== 'string') throw new Error('apiKey must be a string'); endpointHeaders(endpoint);
}
