import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/storage/store.js';
import { importFromCodex } from '../src/auth/codex-import.js';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-import-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store({ dataDir: path.join(dir, 'proxy'), keyFile: path.join(dir, 'key') });
  return { dir, store, file: path.join(dir, 'auth.json') };
}
const jwt = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
test('Codex import reads reference token fields, deduplicates, encrypts and leaves source unchanged', t => {
  const { dir, store, file } = setup(t);
  const original = JSON.stringify({ tokens: { access_token: jwt({ email: 'codex@example.com', exp: 1900000000, 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-account', chatgpt_plan_type: 'plus' } }), account_id: 'file-account', refresh_token: 'private-refresh', id_token: 'private-id' } });
  fs.writeFileSync(file, original);
  const result = importFromCodex(store, { codexHome: dir });
  assert.equal(result.status, 'completed'); assert.equal(result.email, 'codex@example.com');
  const account = store.list('accounts')[0]; assert.equal(account.accountId, 'file-account'); assert.equal(account.planType, 'plus'); assert.equal(account.expiresAt, 1900000000000);
  store.upsert('accounts', { ...account, enabled: false });
  importFromCodex(store, { codexHome: dir }); assert.equal(store.list('accounts').length, 1); assert.equal(store.list('accounts')[0].enabled, false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(!fs.readFileSync(store.stateFile, 'utf8').includes('private-refresh')); assert.ok(!JSON.stringify(result).includes('private'));
});
test('Codex import fails clearly for absent, malformed and API-key-only source without writes', t => {
  const { dir, store, file } = setup(t);
  assert.throws(() => importFromCodex(store, { codexHome: dir }), /No Codex auth.json/);
  for (const text of ['<!DOCTYPE html>', '{"OPENAI_API_KEY":"not-imported"}', 'null', '{"tokens":{"access_token":42}}']) {
    fs.writeFileSync(file, text); assert.throws(() => importFromCodex(store, { codexHome: dir }), { status: 400 });
    assert.equal(store.list('accounts').length, 0); assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});
test('Codex import supports identity from id_token and unknown expiry triggers later refresh', t => {
  const { dir, store, file } = setup(t);
  fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: 'opaque-access', refresh_token: 'refresh', id_token: jwt({ email: 'identity@example.com' }), account_id: 'account' } }));
  importFromCodex(store, { codexHome: dir }); assert.equal(store.list('accounts')[0].email, 'identity@example.com'); assert.equal(store.list('accounts')[0].expiresAt, 0);
});
