import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export class Store {
  constructor({ dataDir = process.env.UWU_DATA_DIR || path.join(os.homedir(), '.uwu-x-proxy'), keyFile = process.env.UWU_SECRET_KEY_FILE || path.join(os.homedir(), '.uwu-x-proxy-secrets', 'key') } = {}) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
    this.keyFile = keyFile;
    this.data = { version: 1, endpoints: [], models: [], accounts: [], requests: [], settings: { proxyKey: '' } };
    this.load();
  }
  secretKey() {
    if (this.key) return this.key;
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.key = fs.readFileSync(this.keyFile);
    if (this.key.length !== 32) throw new Error('Invalid secret encryption key');
    return this.key;
  }
  encrypt(value) {
    if (!value) return value;
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.secretKey(), iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { encrypted: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  decrypt(value) {
    if (!value || typeof value === 'string') return value;
    if (value.encrypted !== 1) throw new Error('Invalid encrypted secret');
    if (!this.key) this.key = fs.readFileSync(this.keyFile);
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8');
  }
  load() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw new Error('Cannot read state safely; restore a valid state file', { cause: e }); }
    for (const key of ['endpoints', 'models', 'accounts', 'requests']) if (!Array.isArray(saved[key])) throw new Error('Invalid state schema');
    const { adminKey: _legacyAdminKey, ...savedSettings } = saved.settings || {};
    this.data = { ...this.data, ...saved, settings: { ...this.data.settings, ...savedSettings } };
    for (const ep of this.data.endpoints) ep.apiKey = this.decrypt(ep.apiKey);
    for (const account of this.data.accounts) for (const key of ['accessToken', 'refreshToken', 'idToken']) account[key] = this.decrypt(account[key]);
    this.data.settings.proxyKey = this.decrypt(this.data.settings.proxyKey);
    // Migrate legacy plaintext credentials on successful load, never silently reset corrupt state.
    this.save();
  }
  save() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const snapshot = structuredClone(this.data), temp = `${this.stateFile}.${randomUUID()}.tmp`;
    for (const ep of snapshot.endpoints) ep.apiKey = this.encrypt(ep.apiKey);
    for (const account of snapshot.accounts) for (const key of ['accessToken', 'refreshToken', 'idToken']) account[key] = this.encrypt(account[key]);
    snapshot.settings.proxyKey = this.encrypt(snapshot.settings.proxyKey);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.stateFile);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  list(key) { return this.data[key] ?? []; }
  upsert(key, value) {
    const before = structuredClone(this.data);
    const all = this.list(key), i = all.findIndex(x => x.id === value.id);
    i < 0 ? all.push(value) : all[i] = { ...all[i], ...value };
    this.data[key] = all;
    try { this.save(); } catch (e) { this.data = before; throw e; }
    return value;
  }
  remove(key, id) {
    const before = this.data[key];
    this.data[key] = this.list(key).filter(x => x.id !== id);
    const changed = before.length !== this.data[key].length;
    try { if (changed) this.save(); } catch (e) { this.data[key] = before; throw e; }
    return changed;
  }
  record(request) { const before = this.data.requests; this.data.requests = [...before.slice(-999), request]; try { this.save(); } catch (e) { this.data.requests = before; throw e; } }
}
export const id = prefix => `${prefix}_${randomUUID()}`;
