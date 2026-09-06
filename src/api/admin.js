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
import { discoverOpenAI, quotaOpenAI } from '../providers/openai-codex.js';

const safeAccount = ({ accessToken, refreshToken, idToken, ...account }) => account;
const account = (store, provider, accountId) => {
  const value = store.list('accounts').find(x => x.id === accountId && x.provider === provider);
  if (!value) throw Object.assign(new Error('Account not found'), { status: 404 }); return value;
};
export function adminRouter(store) {
 const flows = createOAuthFlows(store);
 const r = express.Router(); r.use(auth(store, true));
 r.post('/accounts/openai/import-codex', (req,res,next) => { try { res.set('Cache-Control', 'no-store').json(importFromCodex(store)); } catch(e) { next(e); } });
 r.get('/health', (_, res) => res.json({ ok: true }));
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
         id: 'gemini-3.8-flash',
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
         id: 'gemini-3.7-flash',
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
         id: 'gemini-3.6-flash',
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
         id: 'claude-sonnet-4-6',
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
         id: 'gpt-5.6-sol',
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
         id: 'gpt-5.6-terra',
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
         id: 'gpt-5.6-luna',
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
         id: 'gpt-6-astra',
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

     for (const route of defaultRoutes) {
       store.upsert('routes', route);
     }
     res.json({ ok: true, count: defaultRoutes.length, routes: store.list('routes') });
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
 r.get('/endpoints', (_, res) => res.json(store.list('endpoints').map(({ apiKey, ...safe }) => safe)));
 r.post('/endpoints', async (req,res,next) => { try { const { name, baseUrl, protocol = 'openai', apiKey, headers, timeoutMs, enabled = true, allowPrivate = false } = req.body; if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl are required' }); const normalized = await assertSafeUrl(baseUrl, { allowPrivate }); const endpoint = { id: id('endpoint'), name, baseUrl: normalized, protocol, apiKey, headers: headers || {}, timeoutMs, enabled, allowPrivate }; validateEndpoint(endpoint); store.upsert('endpoints', endpoint); const { apiKey: _, ...safe } = endpoint; res.status(201).json(safe); } catch(e) { next(e); } });
 r.patch('/endpoints/:id', async (req,res,next) => { try { const old = store.list('endpoints').find(x => x.id === req.params.id); if (!old) return res.sendStatus(404); const updated = { ...old, ...req.body, id: old.id }; if (req.body.baseUrl) updated.baseUrl = await assertSafeUrl(req.body.baseUrl, { allowPrivate: updated.allowPrivate }); validateEndpoint(updated); store.upsert('endpoints', updated); const { apiKey, ...safe } = updated; res.json(safe); } catch(e) { next(e); } });
 r.delete('/endpoints/:id', (req, res) => {
   const epId = req.params.id;
   const removed = store.remove('endpoints', epId);
   if (!removed) return res.sendStatus(404);
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
       effort: { mode: 'forward', supported: [] }
     }));
   } catch (e) { next(e); }
 });
 r.post('/endpoints/:id/discover', async (req,res,next) => { try { const ep = store.list('endpoints').find(x => x.id === req.params.id); if (!ep) return res.sendStatus(404); res.json({ models: await discoverEndpoint(ep) }); } catch(e) { next(e); } });
 r.get('/analytics', (req,res) => res.json(analytics(store.list('requests'), req.query.range)));
 return r;
}
function validateEndpoint(endpoint) {
  if (!['openai', 'anthropic'].includes(endpoint.protocol)) throw new Error('protocol must be openai or anthropic');
  if (typeof endpoint.enabled !== 'boolean' || typeof endpoint.allowPrivate !== 'boolean') throw new Error('enabled and allowPrivate must be boolean');
  if (endpoint.timeoutMs !== undefined && (!Number.isInteger(endpoint.timeoutMs) || endpoint.timeoutMs < 100 || endpoint.timeoutMs > 600000)) throw new Error('timeoutMs must be between 100 and 600000');
  if (endpoint.apiKey !== undefined && typeof endpoint.apiKey !== 'string') throw new Error('apiKey must be a string'); endpointHeaders(endpoint);
}
