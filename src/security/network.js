import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
export function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIP(address) !== 6) return true;
  // Only global-unicast IPv6, excluding transition ranges with embedded IPv4.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return !/^[23][0-9a-f]{3}:/.test(normalized) || normalized.startsWith('2002:') || normalized.startsWith('2001:');
}
async function resolveSafe(raw, allowPrivate) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('A valid absolute URL is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Only credential-free HTTP(S) URLs without query or fragment are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost'))) throw new Error('Loopback endpoints are blocked');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addresses.length || (!allowPrivate && addresses.some(x => isPrivateAddress(x.address)))) throw new Error('Private, loopback, and link-local endpoints are blocked');
  return { url, addresses };
}
export async function assertSafeUrl(raw, { allowPrivate = false } = {}) {
  return (await resolveSafe(raw, allowPrivate)).url.toString().replace(/\/$/, '');
}
// Pin the checked DNS result to the actual connection (no second, rebindable lookup).
export async function safeFetch(raw, { allowPrivate = false, method = 'GET', headers, body, signal } = {}) {
  const { url, addresses } = await resolveSafe(raw, allowPrivate);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers, signal, agent: false,
      lookup: (_host, options, callback) => options.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, addresses[0].family)
    }, response => {
      const status = response.statusCode;
      if (status >= 300 && status < 400) { response.destroy(); reject(new Error('Upstream redirects are blocked')); return; }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response), { status, headers: responseHeaders }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
export function redact(value = '') { return String(value).replace(/(authorization|api[-_]?key|token|secret)=?\s*[^\s,]+/gi, '$1=[redacted]'); }
