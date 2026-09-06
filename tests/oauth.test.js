import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createOAuthFlows } from '../src/auth/flows.js';
function store() {
  const accounts = [];
  return { accounts, list: () => accounts, upsert(_, value) { const i = accounts.findIndex(a => a.id === value.id); if (i < 0) accounts.push(value); else accounts[i] = value; return value; } };
}
const jwt = `e30.${Buffer.from(JSON.stringify({ email: 'test@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'a1' } })).toString('base64url')}.signature`;
test('OpenAI automatic callback validates state, exchanges bound redirect/PKCE and persists before success', async t => {
  const data = store(); let exchanges = 0, auth;
  const flows = createOAuthFlows(data, { ports: { openai: [0] }, fetchImpl: async (_, options) => {
    exchanges++; const body = options.body;
    assert.equal(body.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
    return Response.json({ access_token: jwt, refresh_token: 'refresh', expires_in: 3600 });
  } }); t.after(() => flows.close());
  const flow = await flows.start('openai'); auth = new URL(flow.authorizationUrl);
  assert.equal(auth.searchParams.get('max_age'), '0'); assert.equal(auth.searchParams.get('originator'), 'codex_cli_rs');
  await assert.rejects(flows.start('openai'), { status: 409 });
  const callback = flow.redirectUri.replace('localhost', '127.0.0.1');
  assert.equal((await fetch(`${callback}?code=long-code-123&state=wrong`)).status, 400);
  assert.equal(exchanges, 0); assert.equal(flows.status('openai', flow.state).status, 'pending');
  const response = await fetch(`${callback}?code=long-code-123&state=${flow.state}`);
  assert.equal(response.status, 200); assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].accountId, 'a1'); assert.equal(flows.status('openai', flow.state).status, 'completed');
  assert.equal(JSON.stringify(flows.status('openai', flow.state)).includes('refresh'), false);
  await assert.rejects(flows.complete('openai', 'long-code-123', flow.state), { status: 409 });
});
test('OpenAI binds fallback port and manual completion shares one flow', async t => {
  const blocker = http.createServer(); await new Promise(r => blocker.listen(0, '127.0.0.1', r)); t.after(() => blocker.close());
  const flows = createOAuthFlows(store(), { ports: { openai: [blocker.address().port, 0] }, fetchImpl: async () => Response.json({ access_token: jwt, expires_in: 1000 }) }); t.after(() => flows.close());
  const flow = await flows.start('openai'); assert.notEqual(new URL(flow.redirectUri).port, String(blocker.address().port));
  await assert.rejects(flows.complete('openai', `${flow.redirectUri}?code=long-code-123&state=wrong`, flow.state), { status: 400 });
  assert.equal((await flows.complete('openai', 'long-code-123', flow.state)).status, 'completed');
});
test('OAuth cancellation, timeout and provider denial release listeners', async t => {
  const flows = createOAuthFlows(store(), { ports: { google: [0], openai: [0] }, timeoutMs: 60 }); t.after(() => flows.close());
  const cancelled = await flows.start('google'); assert.equal(flows.cancel('google', cancelled.state).status, 'cancelled');
  const denied = await flows.start('openai');
  const response = await fetch(`${denied.redirectUri.replace('localhost', '127.0.0.1')}?error=access_denied&state=${denied.state}`);
  assert.equal(response.status, 400); assert.equal(flows.status('openai', denied.state).status, 'failed');
  const expired = await flows.start('google'); await new Promise(r => setTimeout(r, 100));
  assert.equal(flows.status('google', expired.state).status, 'expired');
});
test('Google automatic callback uses consent, client secret, profile and reference project discovery', async t => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ cloudaicompanionProject: 'project-test' }); };
  t.after(() => { globalThis.fetch = original; });
  const data = store();
  const flows = createOAuthFlows(data, { ports: { google: [0] }, fetchImpl: async (url, options) => {
    if (url.includes('/token')) { assert.ok(options.body.get('client_secret')); return Response.json({ access_token: 'google-access', refresh_token: 'google-refresh', expires_in: 3600 }); }
    return Response.json({ email: 'google@example.com' });
  } }); t.after(() => flows.close());
  const flow = await flows.start('google'), auth = new URL(flow.authorizationUrl);
  assert.equal(auth.searchParams.get('access_type'), 'offline'); assert.equal(auth.searchParams.get('prompt'), 'consent');
  const response = await original(`${flow.redirectUri.replace('localhost','127.0.0.1')}?code=long-code-123&state=${flow.state}`);
  assert.equal(response.status, 200); assert.equal(data.accounts[0].projectId, 'project-test');
  assert.ok(calls[0].url.endsWith('/v1internal:loadCodeAssist'));
});

test('manual URL mode does not bind a callback port and accepts validation URLs', async t => {
  const flows = createOAuthFlows(store(), { ports: { openai: [-1] }, fetchImpl: async () => Response.json({ access_token: jwt, expires_in: 3600 }) }); t.after(() => flows.close());
  const flow = await flows.start('openai', 'manual');
  assert.equal(flow.mode, 'manual'); assert.equal(flow.expiresIn, 600);
  await assert.rejects(flows.complete('openai', 'bad', flow.state), { status: 400 });
  assert.equal(flows.status('openai', flow.state).status, 'pending');
  assert.equal((await flows.complete('openai', `${flow.redirectUri}?code=validation-code&state=${flow.state}`, flow.state)).status, 'completed');
});
test('HTML token/profile responses produce stage-specific safe diagnostics', async t => {
  for (const stage of ['token', 'profile']) {
    const flows = createOAuthFlows(store(), { fetchImpl: async url => {
      if (stage === 'profile' && url.includes('/token')) return Response.json({ access_token: 'secret-token', expires_in: 3600 });
      return new Response('<!DOCTYPE html><body>secret-content</body>', { status: 200, headers: { 'content-type': 'text/html' } });
    } }); t.after(() => flows.close());
    const flow = await flows.start('google', 'manual');
    await assert.rejects(flows.complete('google', 'validation-code', flow.state), e => {
      assert.match(e.message, stage === 'token' ? /OAuth token exchange returned a non-JSON/ : /Google account profile returned a non-JSON/);
      assert.ok(!e.message.includes('secret')); return true;
    });
    assert.equal(flows.status('google', flow.state).status, 'failed');
  }
});
