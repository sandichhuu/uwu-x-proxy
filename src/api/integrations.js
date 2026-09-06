import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
const displayPath = '~/.dsh/settings.yaml';
const mapping = { minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max', max: 'ultra' };
const conflict = message => Object.assign(new Error(message), { status: 409 });
const isMap = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function inspect(doc) {
  if (!isMap(doc)) return { state: 'invalid', diagnostic: 'YAML root must be a mapping.' };
  const llm = doc['llm-pi-ai'];
  if (llm !== undefined && !isMap(llm)) return { state: 'invalid', diagnostic: 'llm-pi-ai must be a mapping.' };
  const providers = llm?.providers;
  if (providers !== undefined && !isMap(providers)) return { state: 'invalid', diagnostic: 'providers must be a mapping.' };
  if (providers && Object.hasOwn(providers, 'x-proxy')) return isMap(providers['x-proxy']) ? { state: 'installed' } : { state: 'invalid', diagnostic: 'x-proxy must be a mapping.' };
  return { state: 'ready' };
}
export function createDshIntegration(store, { file = path.join(os.homedir(), '.dsh', 'settings.yaml'), baseURL = `http://127.0.0.1:${process.env.PORT || 3081}` } = {}) {
  function read() {
    let text = null;
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw conflict('Symbolic-link configuration is not supported');
      text = fs.readFileSync(file, 'utf8');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const doc = YAML.parseDocument(text ?? '{}');
    if (doc.errors.length) throw conflict('Unable to parse YAML safely');
    const value = doc.toJS({ maxAliasCount: 100 });
    const state = inspect(value);
    return { text, doc, value, ...state };
  }
  function modelEntry(m) {
    const isEndpoint = !!(m.endpointId || m.endpointIds?.length);
    const isGemini = !isEndpoint && (m.provider?.startsWith('google') || /gemini/i.test(m.id));
    const isGpt = !isEndpoint && (
      m.provider === 'openai-codex' || m.provider === 'openai' ||
      m.bindings?.some(b => b.provider === 'openai-codex' || b.provider === 'openai')
    );
    const contextWindow = isEndpoint ? 262144 : 1048576;
    const maxTokens = isEndpoint ? 32768 : isGemini ? 65536 : 131072;
    const supported = m.effort?.supported;
    const effortDefault = m.effort?.default;
    // GPT models use the codex remapping (minimal→low, low→medium, …)
    // Gemini/Claude/endpoint models with effort use an identity mapping of their supported levels
    const reasoningEfforts = isGpt
      ? mapping
      : (supported?.length ? Object.fromEntries(supported.map(l => [l, l])) : null);
    return {
      id: m.id,
      name: m.name || m.id,
      contextWindow,
      maxTokens,
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(effortDefault ? { reasoningEffort: effortDefault } : {})
    };
  }
  function provider() {
    return { displayName: 'uwu-x-proxy', apiKeyEnv: 'UWU_PROXY_KEY', api: 'anthropic-messages', baseURL,
      models: store.list('models').filter(m => m.enabled !== false).map(modelEntry) };
  }
  function planFrom(current) {
    if (current.state === 'invalid') throw conflict(current.diagnostic);
    const changes = current.state === 'installed' ? [] : [{ add: 'llm-pi-ai.providers.x-proxy', ...provider() }];
    const revision = createHash('sha256').update(JSON.stringify([current.text, changes])).digest('hex');
    return { tool: 'dsh', displayPath, state: current.state, changes, revision };
  }
  return {
    detect() {
      try { const current = read(); return { tool: 'dsh', displayPath, exists: current.text !== null, providers: { 'x-proxy': current.state === 'installed' }, state: current.state, diagnostic: current.diagnostic, lastCheckedAt: new Date().toISOString() }; }
      catch { return { tool: 'dsh', displayPath, state: 'invalid', diagnostic: 'Cannot safely read configuration.' }; }
    },
    plan() { return planFrom(read()); },
    updatePlan() {
      const current = read();
      if (current.state === 'invalid') throw conflict(current.diagnostic);
      const doc = current.doc.clone();
      doc.deleteIn(['llm-pi-ai', 'providers', 'x-proxy']);
      const pseudo = { text: current.text, doc, value: doc.toJS({ maxAliasCount: 100 }), state: 'ready' };
      return planFrom(pseudo);
    },
    install({ confirmed, revision } = {}) {
      if (confirmed !== true || typeof revision !== 'string') throw conflict('A confirmed preview revision is required');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const lock = `${file}.uwu.lock`, temp = `${file}.${randomUUID()}.tmp`;
      let lockFd;
      try {
        try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw conflict('Another installer holds the lock'); throw e; }
        const current = read(), plan = planFrom(current);
        if (current.state === 'installed') return { state: 'installed', changed: false };
        if (revision !== plan.revision) throw conflict('Configuration or models changed; preview again');
        // Do not mutate alias targets shared with unrelated settings.
        for (const keyPath of [['llm-pi-ai'], ['llm-pi-ai', 'providers']]) {
          const node = current.doc.getIn(keyPath, true);
          if (node && !YAML.isMap(node)) throw conflict('Managed parent must be a direct YAML mapping');
        }
        current.doc.setIn(['llm-pi-ai', 'providers', 'x-proxy'], provider());
        const output = current.doc.toString();
        if (inspect(YAML.parse(output)).state !== 'installed') throw conflict('Invalid generated configuration');
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, output); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        let backup;
        if (current.text !== null) {
          backup = `${file}.backup-${Date.now()}-${randomUUID()}`;
          fs.writeFileSync(backup, current.text, { flag: 'wx', mode: 0o600 });
        }
        if (read().text !== current.text) throw conflict('Configuration changed during install; preview again');
        fs.renameSync(temp, file);
        if (read().state !== 'installed') throw conflict('Post-write validation failed');
        store.record({ at: new Date().toISOString(), kind: 'integration-install', tool: 'dsh', status: 200, backup: backup ? `${displayPath} backup created` : undefined });
        return { state: 'installed', changed: true, backup: backup ? `${displayPath} backup created` : undefined };
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
        if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
      }
    },
    update({ confirmed, revision } = {}) {
      if (confirmed !== true || typeof revision !== 'string') throw conflict('A confirmed preview revision is required');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const lock = `${file}.uwu.lock`, temp = `${file}.${randomUUID()}.tmp`;
      let lockFd;
      try {
        try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw conflict('Another installer holds the lock'); throw e; }
        const current = read();
        if (current.state === 'invalid') throw conflict(current.diagnostic);
        // Clone the doc and remove x-proxy so planFrom generates the full provider block
        const docForPlan = current.doc.clone();
        docForPlan.deleteIn(['llm-pi-ai', 'providers', 'x-proxy']);
        const pseudoCurrent = { text: current.text, doc: docForPlan, value: docForPlan.toJS({ maxAliasCount: 100 }), state: 'ready' };
        const plan = planFrom(pseudoCurrent);
        if (revision !== plan.revision) throw conflict('Configuration or models changed; preview again');
        for (const keyPath of [['llm-pi-ai'], ['llm-pi-ai', 'providers']]) {
          const node = current.doc.getIn(keyPath, true);
          if (node && !YAML.isMap(node)) throw conflict('Managed parent must be a direct YAML mapping');
        }
        current.doc.setIn(['llm-pi-ai', 'providers', 'x-proxy'], provider());
        const output = current.doc.toString();
        if (inspect(YAML.parse(output)).state !== 'installed') throw conflict('Invalid generated configuration');
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, output); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        let backup;
        if (current.text !== null) {
          backup = `${file}.backup-${Date.now()}-${randomUUID()}`;
          fs.writeFileSync(backup, current.text, { flag: 'wx', mode: 0o600 });
        }
        if (read().text !== current.text) throw conflict('Configuration changed during update; preview again');
        fs.renameSync(temp, file);
        if (read().state !== 'installed') throw conflict('Post-write validation failed');
        store.record({ at: new Date().toISOString(), kind: 'integration-update', tool: 'dsh', status: 200, backup: backup ? `${displayPath} backup created` : undefined });
        return { state: 'installed', changed: true, backup: backup ? `${displayPath} backup created` : undefined };
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
        if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
      }
    },
    openFile() {
      if (!fs.existsSync(file)) throw Object.assign(new Error('Configuration file does not exist yet'), { status: 404 });
      const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFile(cmd, [file], { timeout: 5000 });
      return { opened: true, displayPath };
    }
  };
}
export function integrationRouter(store, options) {
  const r = express.Router(), dsh = createDshIntegration(store, options);
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const requireLoopback = (req, res, next) => {
    if (!loopback.includes(req.socket.remoteAddress)) return res.status(403).json({ error: { message: 'Local administration required' } });
    next();
  };
  r.get('/', (_, res) => res.json(dsh.detect()));
  r.post('/dsh/plan', (_, res, next) => { try { res.json(dsh.plan()); } catch (e) { next(e); } });
  r.post('/dsh/update-plan', (_, res, next) => { try { res.json(dsh.updatePlan()); } catch (e) { next(e); } });
  r.post('/dsh/install', requireLoopback, (req, res, next) => { try { res.json(dsh.install(req.body)); } catch (e) { next(e); } });
  r.post('/dsh/update', requireLoopback, (req, res, next) => { try { res.json(dsh.update(req.body)); } catch (e) { next(e); } });
  r.post('/dsh/open', requireLoopback, (_, res, next) => { try { res.json(dsh.openFile()); } catch (e) { next(e); } });
  return r;
}
