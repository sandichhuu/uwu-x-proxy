import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './storage/store.js';
import { inferenceRouter } from './api/inference.js';
import { adminRouter, getAppVersion } from './api/admin.js';
import { integrationRouter } from './api/integrations.js';
import { auth } from './security/auth.js';
const here = path.dirname(fileURLToPath(import.meta.url));
export function createApp(store, integrationOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const ownOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== ownOrigin && origin !== process.env.UWU_CORS_ORIGIN) return res.status(403).json({ error: { message: 'Origin not allowed' } });
    if (origin) { res.set('access-control-allow-origin', origin); res.vary('Origin'); }
    res.set('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version');
    res.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/health', (_, res) => res.json({ ok: true, service: 'uwu-x-proxy' }));
  app.use('/admin/api/integrations', auth(store, true), integrationRouter(store, integrationOptions));
  app.use('/admin/api', adminRouter(store));
  app.use('/admin/api', (_, res) => res.status(404).json({ error: { message: 'Unknown admin API route. Restart x-proxy and reload the dashboard if you recently updated.' } }));
  // Dashboard HTML is served with the running build version injected
  // server-side, so the brand line is correct even when the
  // /admin/api/version fetch cannot run (remote access is loopback-gated,
  // subpath proxies, blocked JS). The fetch in index.html stays as fallback.
  const publicDir = path.join(here, '../public');
  const serveDashboard = (_, res) => {
    try {
      const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
        .replaceAll('__UWU_APP_VERSION__', `v${getAppVersion()}`);
      res.set('Cache-Control', 'no-store').type('html').send(html);
    } catch {
      res.sendFile(path.join(publicDir, 'index.html'));
    }
  };
  app.get('/admin/', serveDashboard);
  app.get('/admin/index.html', serveDashboard);
  app.use('/admin', express.static(publicDir));
  app.get('/', (_, res) => res.redirect('/admin/'));  const infer = inferenceRouter(store);
  app.use('/v1', infer); app.use('/', infer);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 400;
    res.status(status).json({ error: { message: status >= 500 && !err.publicMessage ? 'Internal server error' : err.type === 'entity.parse.failed' ? 'Invalid JSON' : err.message || 'Bad request' } });
  });
  return app;
}
if (process.env.NODE_ENV !== 'test') {
  const store = new Store(), app = createApp(store);
  const port = Number(process.env.PORT || 3081), host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`uwu-x-proxy listening on http://${host}:${port}`));
}
