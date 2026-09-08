// Usage-trend and distribution layout adapted from antigravity-claude-proxy's
// public/js/components/dashboard/charts.js (MIT). See public/chart-license.txt.
// Native SVG replaces Chart.js/Alpine so the admin UI also works offline.
const NS = 'http://www.w3.org/2000/svg';
export const COLORS = ['#bd5838', '#d8ad55', '#77896b', '#a88772', '#8884a0', '#6c9095'];
function svgNode(tag, attrs, parent, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  parent.append(node); return node;
}
export function trendChart(parent, points, modelNames, tzOffsetMin = null) {
  const multi = Array.isArray(modelNames) && modelNames.length > 0 && points.some(p => p.models && Object.keys(p.models).length > 0);
  const lines = multi ? modelNames.map((name, i) => ({ key: name, color: COLORS[i % COLORS.length] })) : [{ key: 'requests', color: COLORS[0] }, { key: 'errors', color: COLORS[1] }];
  const svg = svgNode('svg', { viewBox: '0 0 640 260', class: 'chart', role: 'img', 'aria-label': multi ? `Usage trend per model: ${modelNames.join(', ')}` : 'Requests and errors over time' }, parent);
  svgNode('title', {}, svg, multi ? `Usage trend per model: ${modelNames.join(', ')}. Each point includes its count.` : 'Usage trend: requests (orange) and errors (gold). Each point includes its count.');
  const valueOf = multi ? ((p, name) => p.models?.[name] || 0) : null;
  // Fixed UTC-offset timezone (minutes east of UTC), or browser-local when null.
  const tzOpt = tzOffsetMin == null ? {} : { timeZone: 'UTC' };
  const inTz = ms => tzOffsetMin == null ? new Date(ms) : new Date(ms + tzOffsetMin * 60000);
  const max = multi
    ? Math.max(4, ...points.flatMap(p => modelNames.map(name => valueOf(p, name))))
    : Math.max(4, ...points.map(p => p.requests));
  const x = i => 42 + i * 580 / Math.max(1, points.length - 1), y = n => 215 - n / max * 180;
  for (let i = 0; i <= 4; i++) {
    const value = max * i / 4;
    svgNode('line', { x1: 42, x2: 622, y1: y(value), y2: y(value), stroke: '#eae2d6', 'stroke-dasharray': '3 5' }, svg);
    const tick = svgNode('text', { x: 30, y: y(value) + 4, 'text-anchor': 'end' }, svg, Math.round(value));
    tick.style.fontSize = '11px'; tick.style.fill = '#6b675e';
  }
  const defs = svgNode('defs', {}, svg), gradient = svgNode('linearGradient', { id: 'trend-fill', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgNode('stop', { offset: '0%', 'stop-color': COLORS[0], 'stop-opacity': '.18' }, gradient);
  svgNode('stop', { offset: '100%', 'stop-color': COLORS[0], 'stop-opacity': '0' }, gradient);
  // Catmull-Rom smoothing for softer lines; control points are clamped to
  // the plot area so spikes never overshoot above/below the axis.
  const fmt = n => Math.round(n * 10) / 10;
  const clampY = n => Math.min(215, Math.max(30, n));
  const smoothLine = pts => {
    if (pts.length < 2) return pts.length ? `M${fmt(pts[0][0])},${fmt(pts[0][1])}` : '';
    let d = `M${fmt(pts[0][0])},${fmt(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      d += `C${fmt(p1[0] + (p2[0] - p0[0]) / 6)},${fmt(clampY(p1[1] + (p2[1] - p0[1]) / 6))} ${fmt(p2[0] - (p3[0] - p1[0]) / 6)},${fmt(clampY(p2[1] - (p3[1] - p1[1]) / 6))} ${fmt(p2[0])},${fmt(p2[1])}`;
    }
    return d;
  };
  const isFirst = key => (!multi && key === 'requests') || (multi && key === modelNames[0]);
  for (const { key, color } of lines) {
    const getValue = multi ? (p => valueOf(p, key)) : (p => p[key]);
    const line = smoothLine(points.map((p, i) => [x(i), y(getValue(p))]));
    if (isFirst(key) && points.length) svgNode('path', { d: `${line}L622,215L42,215Z`, fill: 'url(#trend-fill)' }, svg);
    const path = svgNode('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
    const total = points.reduce((n, p) => n + getValue(p), 0);
    svgNode('title', {}, path, `${key}: ${total} requests in this period`);
  }
  // Hourly buckets (24h) always span two calendar days, so each tick shows
  // time + day; daily buckets (7d) only need the date.
  const stepMs = points.length > 1 ? Date.parse(points[1].at) - Date.parse(points[0].at) : 0;
  const hourly = stepMs > 0 && stepMs < 12 * 3600e3;
  const tickStep = hourly ? Math.max(1, Math.ceil(points.length / 8)) : 1;
  points.forEach((p, i) => {
    if (i % tickStep && i !== points.length - 1) return;
    const date = inTz(Date.parse(p.at));
    const text = hourly
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...tzOpt })
      : date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'numeric', ...tzOpt });
    const label = svgNode('text', { x: x(i), y: 230, transform: `rotate(-30 ${fmt(x(i))},230)`, 'text-anchor': 'end' }, svg, text);
    label.style.fontSize = '11px'; label.style.fill = '#6b675e';
  });
}
export function distributionChart(parent, models) {
  const total = models.reduce((n, m) => n + m.requests, 0);
  const svg = svgNode('svg', { viewBox: '0 0 220 220', class: 'chart donut', role: 'img', 'aria-label': `Model distribution: ${total} requests` }, parent);
  svgNode('circle', { cx: 110, cy: 110, r: 82, fill: 'none', stroke: '#eee7db', 'stroke-width': 24 }, svg);
  let offset = 0;
  models.forEach((m, i) => {
    const part = m.requests / total * 100;
    const arc = svgNode('circle', { cx: 110, cy: 110, r: 82, fill: 'none', stroke: COLORS[i % COLORS.length], 'stroke-width': 24, pathLength: 100, 'stroke-dasharray': `${part} ${100 - part}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 110 110)' }, svg);
    svgNode('title', {}, arc, `${m.model}: ${m.requests} requests (${Math.round(part)}%)`); offset += part;
  });
  const text = svgNode('text', { x: 110, y: 109, 'text-anchor': 'middle' }, svg, total.toLocaleString());
  text.style.fontSize = '30px'; text.style.fill = '#39352e';
  svgNode('text', { x: 110, y: 133, 'text-anchor': 'middle' }, svg, 'requests');
}

