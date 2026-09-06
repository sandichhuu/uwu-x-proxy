// Temporary callback flow ported from the two reference OAuth modules.
// See oauth-license.txt. Loopback binding and strict state validation are intentional.
import http from 'node:http';
import { beginOAuth, completeOAuth, cancelOAuth, parseOAuthInput, oauthConfigs } from './oauth.js';
import { id } from '../storage/store.js';
export function createOAuthFlows(store, { fetchImpl = fetch, timeoutMs = 120000, ports = {} } = {}) {
  const flows = new Map(), starting = new Set();
  function find(provider, state) {
    const flow = flows.get(state);
    if (!flow || flow.provider !== provider) throw Object.assign(new Error('OAuth flow not found or expired'), { status: 404 });
    return flow;
  }
  function stop(flow) { clearTimeout(flow.timer); flow.server?.close(); flow.server?.closeIdleConnections?.(); cancelOAuth(flow.state); }
  function finish(flow, status, message) {
    flow.status = status; flow.message = message; stop(flow);
    flow.cleanup = setTimeout(() => flows.delete(flow.state), 600000); flow.cleanup.unref();
  }
  async function complete(provider, input, state) {
    const flow = find(provider, state);
    if (flow.status !== 'pending') throw Object.assign(new Error('OAuth flow is no longer awaiting a callback'), { status: 409 });
    if (/^https?:\/\//i.test(input?.trim() || '')) {
      if (new URL(input.trim()).searchParams.get('state') !== state) throw Object.assign(new Error('OAuth state mismatch'), { status: 400 });
    }
    // Invalid manual input must not consume a valid pending session.
    if (!/^https?:\/\//i.test(input?.trim() || '') || !new URL(input.trim()).searchParams.has('error')) parseOAuthInput(input);
    flow.status = 'exchanging'; clearTimeout(flow.timer);
    try {
      const credentials = await completeOAuth(provider, input, state, fetchImpl);
      const old = store.list('accounts').find(a => a.provider === provider && ((credentials.email && a.email === credentials.email) || (credentials.accountId && a.accountId === credentials.accountId)));
      const saved = store.upsert('accounts', { ...old, ...credentials, refreshToken: credentials.refreshToken || old?.refreshToken, id: old?.id || id('account'), provider, source: 'oauth', enabled: old?.enabled ?? true, createdAt: old?.createdAt || new Date().toISOString() });
      flow.accountId = saved.id; finish(flow, 'completed', 'Account connected. You can close this window and return to the dashboard.');
      return { status: flow.status, accountId: saved.id };
    } catch (e) { finish(flow, 'failed', e.message); throw e; }
  }
  return {
    async start(provider, mode = 'browser') {
      if (!['browser', 'manual'].includes(mode)) throw Object.assign(new Error('Invalid OAuth mode'), { status: 400 });
      if (!Object.hasOwn(oauthConfigs, provider)) throw Object.assign(new Error('Unknown OAuth provider'), { status: 404 });
      if (starting.has(provider) || [...flows.values()].some(f => f.provider === provider && ['pending', 'exchanging'].includes(f.status))) throw Object.assign(new Error('A login is already in progress. Complete or cancel it first.'), { status: 409 });
      if (mode === 'manual') {
        const info = beginOAuth(provider);
        const flow = { ...info, mode, status: 'pending' }; flows.set(info.state, flow);
        flow.timer = setTimeout(() => finish(flow, 'expired', 'Login timed out. Generate a new URL.'), 600000); flow.timer.unref();
        return { ...info, mode, expiresIn: 600 };
      }
      starting.add(provider);
      const config = oauthConfigs[provider], redirect = new URL(config.redirectUri);
      let flow;
      const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        const url = new URL(req.url, 'http://localhost');
        if (req.method !== 'GET' || url.pathname !== redirect.pathname) { res.writeHead(404); return res.end('Not found'); }
        if (!flow || url.searchParams.get('state') !== flow.state) { res.writeHead(400); return res.end('Invalid OAuth state'); }
        try { await complete(provider, `${flow.redirectUri}${url.search}`, flow.state); res.end(flow.message); }
        catch (e) { res.writeHead(e.status || 400); res.end(e.message); }
      });
      try {
        if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)) throw new Error('OAuth redirect must use HTTP localhost');
        const candidates = ports[provider] || (provider === 'openai' && !process.env.OPENAI_OAUTH_REDIRECT_URI ? [1455,1456,1457,1458,1459,1460] : [Number(redirect.port)]);
        let bound = false;
        for (const port of candidates) {
          try {
            await new Promise((resolve, reject) => {
              const onError = e => { server.removeListener('listening', onListen); reject(e); };
              const onListen = () => { server.removeListener('error', onError); resolve(); };
              server.once('error', onError); server.once('listening', onListen); server.listen(port, '127.0.0.1');
            }); bound = true; break;
          } catch (e) { if (!['EADDRINUSE', 'EACCES'].includes(e.code)) throw e; }
        }
        if (!bound) throw Object.assign(new Error(`OAuth callback port unavailable (${candidates.join(', ')}). Close the other login application and retry.`), { status: 409 });
        redirect.port = String(server.address().port);
        const info = beginOAuth(provider, redirect.href);
        flow = { ...info, server, status: 'pending' }; flows.set(info.state, flow);
        flow.timer = setTimeout(() => finish(flow, 'expired', 'Login timed out. Please try again.'), timeoutMs); flow.timer.unref();
        return { ...info, expiresIn: timeoutMs / 1000 };
      } catch (e) { server.close(); throw e; } finally { starting.delete(provider); }
    },
    complete,
    status(provider, state) { const f = find(provider, state); return { status: f.status, message: f.message, accountId: f.accountId }; },
    cancel(provider, state) { const f = find(provider, state); if (f.status === 'exchanging') throw Object.assign(new Error('Token exchange is in progress'), { status: 409 }); if (f.status === 'pending') finish(f, 'cancelled', 'Login cancelled'); return { status: f.status }; },
    close() { for (const f of flows.values()) { stop(f); clearTimeout(f.cleanup); } flows.clear(); }
  };
}
