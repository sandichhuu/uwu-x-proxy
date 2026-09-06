import { timingSafeEqual } from 'node:crypto';
export function auth(store, admin = false) {
  return (req, res, next) => {
    // The local administration plane deliberately has no shared admin-key gate.
    // It is reachable only from loopback; inference may still use UWU_PROXY_KEY.
    if (admin) {
      const address = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return res.status(403).json({ error: { message: 'Administration is local-only', type: 'authentication_error' } });
      return next();
    }
    const expected = process.env.UWU_PROXY_KEY || store.data.settings.proxyKey;
    if (!expected) return next();
    const supplied = req.get('x-api-key') || (/^Bearer\s+/i.test(req.get('authorization') || '') ? req.get('authorization').replace(/^Bearer\s+/i, '') : '');
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } }); next();
  };
}
