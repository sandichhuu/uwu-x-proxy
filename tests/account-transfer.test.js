import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { buildGoogleExport, normalizeGoogleImport } from '../src/auth/google/account-transfer.js';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/index.js');

function memory() {
  return {
    data: { settings: { proxyKey: '' }, endpoints: [], models: [], routes: [], accounts: [], requests: [] },
    list(k) { return this.data[k] || []; },
    record(r) { this.data.requests.push(r); },
    upsert(k, v) {
      const all = this.list(k), i = all.findIndex(x => x.id === v.id);
      i < 0 ? all.push(v) : all[i] = { ...all[i], ...v };
      this.data[k] = all;
      return v;
    },
    remove(k, id) {
      const before = this.data[k] || [];
      this.data[k] = before.filter(x => x.id !== id);
      return before.length !== this.data[k].length;
    }
  };
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('buildGoogleExport keeps only portable credentials', () => {
  const payload = buildGoogleExport([
    { id: 'a1', provider: 'google', email: 'g@example.com', accessToken: 'short-lived', refreshToken: '1//refresh-secret', projectId: 'proj', quota: {}, enabled: true },
    { id: 'a2', provider: 'openai', email: 'o@example.com', refreshToken: 'other' }
  ]);
  assert.equal(payload.app, 'uwu-x-proxy');
  assert.equal(payload.provider, 'google');
  assert.equal(payload.accounts.length, 1);
  assert.deepEqual(payload.accounts[0], { email: 'g@example.com', accountId: undefined, refreshToken: '1//refresh-secret', projectId: 'proj', enabled: true });
  assert.ok(!JSON.stringify(payload).includes('short-lived'));
});

test('normalizeGoogleImport accepts own, flat and wrapped formats', () => {
  const own = normalizeGoogleImport(buildGoogleExport([{ provider: 'google', email: 'g@example.com', refreshToken: '1//aaaabbbb', projectId: 'p' }]));
  assert.deepEqual(own, { entries: [{ email: 'g@example.com', accountId: undefined, refreshToken: '1//aaaabbbb', projectId: 'p', enabled: true }], errors: [] });

  const flat = normalizeGoogleImport([{ email: 'h@example.com', refresh_token: '1//ccccdddd' }]);
  assert.equal(flat.entries[0].refreshToken, '1//ccccdddd');

  const wrapped = normalizeGoogleImport({ accounts: [{ email: 'z@example.com', refresh_token: '1//eeeeffff' }], active: 'z@example.com' });
  assert.equal(wrapped.entries.length, 1);

  const bad = normalizeGoogleImport({ accounts: [{ email: 'no-token@example.com' }, 'nope', { email: 'dup@example.com', refresh_token: '1//gggghhhh' }, { email: 'dup2@example.com', refresh_token: '1//gggghhhh' }] });
  assert.equal(bad.entries.length, 1);
  assert.equal(bad.errors.length, 3);

  assert.equal(normalizeGoogleImport({ nope: true }).errors.length, 1);
  assert.equal(normalizeGoogleImport({ accounts: new Array(1001).fill({ refresh_token: 'x' }) }).errors.length, 1);
});

test('google export/import round-trips through the admin API', async t => {
  const store = memory();
  store.data.accounts.push({ id: 'acc_old', provider: 'google', email: 'old@example.com', refreshToken: '1//old-token-123', projectId: 'proj-old', enabled: true });
  const base = await listen(t, createApp(store));

  const importRes = await fetch(`${base}/admin/api/accounts/google/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { email: 'old@example.com', refresh_token: '1//rotated-token-456' },
      { email: 'new@example.com', refresh_token: '1//brand-new-789', project_id: 'proj-new' },
      { email: 'broken@example.com' }
    ])
  });
  assert.equal(importRes.status, 200);
  assert.deepEqual(await importRes.json(), { imported: 1, updated: 1, skipped: ['Entry 2: refresh token is missing or invalid'] });
  assert.equal(store.list('accounts').length, 2);
  assert.equal(store.list('accounts').find(a => a.email === 'old@example.com').refreshToken, '1//rotated-token-456');
  const created = store.list('accounts').find(a => a.email === 'new@example.com');
  assert.equal(created.provider, 'google');
  assert.equal(created.source, 'imported');

  const exportRes = await fetch(`${base}/admin/api/accounts/google/export`);
  assert.equal(exportRes.status, 200);
  assert.match(exportRes.headers.get('content-disposition'), /attachment; filename="uwu-x-proxy-google-accounts-.*\.json"/);
  const exported = await exportRes.json();
  assert.equal(exported.accounts.length, 2);
  assert.ok(exported.accounts.some(a => a.refreshToken === '1//brand-new-789'));

  const invalid = await fetch(`${base}/admin/api/accounts/google/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: true })
  });
  assert.equal(invalid.status, 200);
  assert.deepEqual(await invalid.json(), { imported: 0, updated: 0, skipped: ['Body must be a JSON array or an object with an accounts array'] });
});

test('dashboard wires export download and file import for Google', () => {
  const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /accounts\/\$\{provider\}\/export/);
  assert.match(appJs, /accounts\/\$\{provider\}\/import/);
  assert.match(appJs, /provider === 'google' \|\| provider === 'openai'/);
});

test('openai export/import round-trips and merges by accountId', async t => {
  const store = memory();
  store.data.accounts.push({ id: 'acc_oai', provider: 'openai', email: 'oai@example.com', accountId: 'acc-123', refreshToken: 'oai-old-refresh-token', enabled: true });
  const base = await listen(t, createApp(store));

  const exportRes = await fetch(`${base}/admin/api/accounts/openai/export`);
  assert.equal(exportRes.status, 200);
  assert.match(exportRes.headers.get('content-disposition'), /uwu-x-proxy-openai-accounts-/);
  const exported = await exportRes.json();
  assert.equal(exported.provider, 'openai');
  assert.deepEqual(exported.accounts[0], { email: 'oai@example.com', accountId: 'acc-123', refreshToken: 'oai-old-refresh-token', enabled: true });

  const importRes = await fetch(`${base}/admin/api/accounts/openai/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { email: 'changed@example.com', account_id: 'acc-123', refresh_token: 'oai-rotated-token-xyz' },
      { email: 'fresh@example.com', refresh_token: 'oai-brand-new-token-abc' }
    ])
  });
  assert.equal(importRes.status, 200);
  assert.deepEqual(await importRes.json(), { imported: 1, updated: 1, skipped: [] });
  const merged = store.list('accounts').find(a => a.id === 'acc_oai');
  assert.equal(merged.refreshToken, 'oai-rotated-token-xyz');
  assert.equal(store.list('accounts').find(a => a.email === 'fresh@example.com').source, 'imported');

  const unsupported = await fetch(`${base}/admin/api/accounts/anthropic/export`);
  assert.equal(unsupported.status, 400);
});
