const WINDOWS = { '24h': { count: 24, step: 3600000 }, '7d': { count: 7, step: 86400000 } };
export function analytics(rows, range = '24h', now = Date.now()) {
  rows = rows.filter(row => !row.kind);
  range = Object.hasOwn(WINDOWS, range) ? range : '24h';
  const { count, step } = WINDOWS[range];
  const start = Math.floor(now / step) * step - (count - 1) * step;
  const series = Array.from({ length: count }, (_, i) => ({ at: new Date(start + i * step).toISOString(), requests: 0, errors: 0, tokens: 0 }));
  const models = new Map();
  const perBucket = Array.from({ length: count }, () => new Map());
  for (const row of rows) {
    const at = Date.parse(row.at), index = Math.floor((at - start) / step);
    if (!Number.isFinite(at) || at > now || index < 0 || index >= count) continue;
    const bucket = series[index]; bucket.requests++; bucket.errors += row.status >= 400 ? 1 : 0; bucket.tokens += Number(row.tokens) || 0;
    const name = row.model || 'Unknown'; models.set(name, (models.get(name) || 0) + 1);
    const bm = perBucket[index]; bm.set(name, (bm.get(name) || 0) + 1);
  }
  const sorted = [...models].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests);
  // Model distribution chart only shows top 5; the rest is grouped as Others.
  const TOP_MODELS = 5;
  const topNames = sorted.slice(0, TOP_MODELS).map(m => m.model);
  const hasOthers = sorted.length > TOP_MODELS;
  const trendModels = hasOthers ? [...topNames, 'Others'] : topNames;
  const topSet = new Set(topNames);
  series.forEach((bucket, i) => {
    const breakdown = {};
    for (const [name, c] of perBucket[i]) {
      if (topSet.has(name)) breakdown[name] = (breakdown[name] || 0) + c;
      else if (hasOthers) breakdown.Others = (breakdown.Others || 0) + c;
    }
    bucket.models = breakdown;
  });
  const distribution = sorted.length > TOP_MODELS
    ? [...sorted.slice(0, TOP_MODELS), { model: 'Others', requests: sorted.slice(TOP_MODELS).reduce((n, m) => n + m.requests, 0) }]
    : sorted;
  return {
    requests: rows.length, errors: rows.filter(row => row.status >= 400).length,
    tokens: rows.reduce((n, row) => n + (Number(row.tokens) || 0), 0),
    recent: rows.slice(-50).reverse(), series,
    distribution, trendModels,
    range, start: new Date(start).toISOString(), end: new Date(now).toISOString()
  };
}

