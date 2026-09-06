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
export function trendChart(parent, points) {
  const svg = svgNode('svg', { viewBox: '0 0 640 260', class: 'chart', role: 'img', 'aria-label': 'Requests and errors over time' }, parent);
  svgNode('title', {}, svg, 'Usage trend: requests (orange) and errors (gold). Each point includes its count.');
  const max = Math.max(4, ...points.map(p => p.requests));
  const x = i => 42 + i * 580 / Math.max(1, points.length - 1), y = n => 215 - n / max * 180;
  for (let i = 0; i <= 4; i++) {
    const value = max * i / 4;
    svgNode('line', { x1: 42, x2: 622, y1: y(value), y2: y(value), stroke: '#eae2d6', 'stroke-dasharray': '3 5' }, svg);
    svgNode('text', { x: 30, y: y(value) + 4, 'text-anchor': 'end' }, svg, Math.round(value));
  }
  const defs = svgNode('defs', {}, svg), gradient = svgNode('linearGradient', { id: 'trend-fill', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgNode('stop', { offset: '0%', 'stop-color': COLORS[0], 'stop-opacity': '.18' }, gradient);
  svgNode('stop', { offset: '100%', 'stop-color': COLORS[0], 'stop-opacity': '0' }, gradient);
  for (const [key, color] of [['requests', COLORS[0]], ['errors', COLORS[1]]]) {
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[key])}`).join(' ');
    if (key === 'requests' && points.length) svgNode('path', { d: `${line} L622,215 L42,215 Z`, fill: 'url(#trend-fill)' }, svg);
    svgNode('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, svg);
    points.forEach((p, i) => {
      const dot = svgNode('circle', { cx: x(i), cy: y(p[key]), r: 3, fill: color }, svg);
      svgNode('title', {}, dot, `${new Date(p.at).toLocaleString()}: ${p[key]} ${key}`);
    });
  }
  points.forEach((p, i) => {
    if (i % Math.ceil(points.length / 5) && i !== points.length - 1) return;
    const date = new Date(p.at), multiDay = points.length > 0 && new Date(points[0].at).toDateString() !== new Date(points.at(-1).at).toDateString();
    svgNode('text', { x: x(i), y: 245, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' }, svg,
      multiDay ? date.toLocaleDateString([], { month: 'short', day: 'numeric' }) : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
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

