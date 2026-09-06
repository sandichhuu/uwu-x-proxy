import { openAddAccountModal, oauthPanel } from './oauth.js';
import { endpointsPanel } from './endpoints.js';
import { routesPanel } from './routes.js';
import { trendChart, distributionChart, COLORS } from './charts.js';
import { toggleSwitch, calculateQuotaPercent, renderQuotaBadge, renderModelDictionary, accountModelCards } from './model-dict.js';
const content = document.querySelector('#content'), title = document.querySelector('#title');
const descriptions = {
  analytics: 'A little clarity on everything flowing through your proxy.',
  models: 'Your public models, connected through one endpoint.',
  routes: 'Configure routing rules, effort mappings, and model aliases.',
  accounts: 'Bring your providers together in one place.',
  logs: 'A closer look at your latest requests.',
  install: 'Connect your favorite tools to your unified proxy.'
};
let currentPage = 'analytics', generation = 0, range = '24h';
async function api(path, options = {}) {
  const response = await fetch('/admin/api/' + path, { ...options, headers: { 'content-type': 'application/json' } });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`Admin API ${path.split('?')[0]} returned non-JSON (HTTP ${response.status}). Restart x-proxy, reload the dashboard, and check that this URL points to x-proxy rather than a proxy/login page.`); }
  if (!response.ok) throw new Error(data.error?.message || (typeof data.error === 'string' ? data.error : '') || data.diagnostic || `HTTP ${response.status}`);
  return data;
}
function el(tag, text, parent, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  parent?.append(node); return node;
}
function empty(parent, heading, detail) { const box = el('div', undefined, parent, 'empty'); el('strong', heading, box); el('span', detail, box); }
function error(parent, e) { el('p', e.message, parent, 'error-message').setAttribute('role', 'alert'); }
function card(parent, heading, note) { const box = el('section', undefined, parent, 'card'); el('h2', heading, box); if (note) el('p', note, box, 'muted'); return box; }
function table(parent, columns, rows) {
  if (!rows.length) return empty(parent, 'Nothing here yet', 'New activity will appear here when it is available.');
  const wrap = el('div', undefined, parent, 'table-wrap'), table = el('table', undefined, wrap);
  const head = el('tr', undefined, el('thead', undefined, table));
  for (const [label] of columns) el('th', label, head).scope = 'col';
  const body = el('tbody', undefined, table);
  for (const row of rows) {
    const tr = el('tr', undefined, body);
    for (const [, value] of columns) {
      const td = el('td', undefined, tr), result = value(row);
      if (result instanceof Node) td.append(result); else td.textContent = result ?? '-';
    }
  }
}
const number = value => Number(value || 0).toLocaleString();
const enabled = row => el('span', row.enabled === false ? 'Disabled' : 'Enabled', null, `pill${row.enabled === false ? ' error' : ''}`);
function requests(parent, rows) {
  table(parent, [
    ['Time', r => new Date(r.at).toLocaleString()], ['Model', r => r.model],
    ['Status', r => el('span', r.status, null, `pill${r.status >= 400 ? ' error' : ''}`)],
    ['Latency', r => r.latencyMs == null ? '-' : `${number(r.latencyMs)} ms`], ['Tokens', r => number(r.tokens)]
  ], rows);
}
function legend(parent, label, color, value) {
  const row = el('div', undefined, parent, 'legend-row'); el('span', undefined, row, 'dot').style.background = color;
  el('span', label, row, 'label'); if (value !== undefined) el('strong', value, row);
}
function dashboard(root, data) {
  const stats = el('div', undefined, root, 'stats');
  for (const [label, value, note] of [
    ['Total requests', number(data.requests), 'All retained activity'], ['Tokens used', number(data.tokens), 'Recorded token usage'],
    ['Success rate', data.requests ? `${((data.requests - data.errors) / data.requests * 100).toFixed(1)}%` : '-', 'Responses below HTTP 400'],
    ['Errors', number(data.errors), 'HTTP 400 and above']
  ]) {
    const item = el('section', undefined, stats, 'card stat'); el('span', label, item, 'stat-label'); el('strong', value, item, 'stat-value'); el('span', note, item, 'stat-note');
  }
  const charts = el('div', undefined, root, 'chart-grid'), trend = el('section', undefined, charts, 'card');
  const header = el('div', undefined, trend, 'card-header'); el('h2', 'Usage trend', header);
  const select = el('select', undefined, header); select.setAttribute('aria-label', 'Chart time range');
  for (const [value, label] of [['24h', '24 hourly buckets'], ['7d', '7 days (UTC)']]) { const option = el('option', label, select); option.value = value; }
  select.value = range; select.onchange = () => { range = select.value; page('analytics'); };
  el('p', 'Request volume  -  current bucket included  -  labels in local time', trend, 'muted');
  trendChart(trend, data.series);
  const keys = el('div', undefined, trend, 'tabs'); legend(keys, 'Requests', COLORS[0]); legend(keys, 'Errors', COLORS[1]);
  if (!data.distribution.length) el('p', 'No requests in this period. Send a request to start your chart.', trend, 'muted');
  const distribution = card(charts, 'Model distribution', 'Request share  -  selected period');
  distributionChart(distribution, data.distribution);
  const labels = el('div', undefined, distribution, 'legend');
  data.distribution.forEach((m, i) => legend(labels, m.model, COLORS[i % COLORS.length], number(m.requests)));
  if (!data.distribution.length) el('p', 'No model activity in this period.', distribution, 'muted');
  const details = el('details', undefined, trend); el('summary', 'View chart data', details);
  table(details, [['Bucket', p => new Date(p.at).toLocaleString()], ['Requests', p => p.requests], ['Errors', p => p.errors]], data.series);
  requests(card(root, 'Recent requests', 'Latest 10 requests across all models'), data.recent.slice(0, 10));
}
function accounts(root) {
  const tabs = el('nav', undefined, root, 'tabs'); tabs.setAttribute('aria-label', 'Account providers');
  const panel = el('section', undefined, root, 'card'); let tabGeneration = 0;
  const tabIcons = {
    Google: `<svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/></svg>`,
    OpenAI: `<svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`,
    'API Endpoints': `<svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>`
  };
  for (const tab of ['Google', 'OpenAI', 'API Endpoints']) {
    const button = el('button', undefined, tabs);
    button.innerHTML = `${tabIcons[tab] || ''}<span>${tab}</span>`;
    button.onclick = async () => {
      const token = ++tabGeneration;
      tabs.querySelectorAll('button').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
      panel.replaceChildren(); el('p', 'Loading connections...', panel, 'muted');
      try {
        const provider = tab.toLowerCase(), rows = await api(tab === 'API Endpoints' ? 'endpoints' : `accounts?provider=${provider}`);
        if (token !== tabGeneration || !root.isConnected) return;
        panel.replaceChildren();
        if (tab === 'API Endpoints') {
          endpointsPanel(panel, rows, { api, el, error, table, enabled });
          return;
        }

        const header = el('div', undefined, panel, 'card-header');
        const titleWrap = el('div', undefined, header);
        el('h2', `${tab} Accounts`, titleWrap);

        const addAccountBtn = el('button', `+ Add Account`, header, 'primary sm');
        addAccountBtn.onclick = () => openAddAccountModal(provider, {
          api, el, error,
          connected: () => { if (token === tabGeneration && root.isConnected) button.click(); }
        });

        if (rows.length === 0) {
          const emptyBox = el('div', undefined, panel, 'empty');
          el('strong', `No ${tab} accounts connected yet`, emptyBox);
          el('span', `Add your first ${tab} account to increase quota and route requests.`, emptyBox);
          const addFirstBtn = el('button', `+ Add ${tab} Account`, emptyBox, 'primary sm');
          addFirstBtn.style.marginTop = '14px';
          addFirstBtn.onclick = () => openAddAccountModal(provider, {
            api, el, error,
            connected: () => { if (token === tabGeneration && root.isConnected) button.click(); }
          });
        } else {
          table(panel, [
            ['Status', r => toggleSwitch({
              checked: r.enabled !== false,
              ariaLabel: `Enable or disable account ${r.email || r.name || r.id}`,
              label: r.enabled !== false ? 'Enabled' : 'Disabled',
              onChange: async (newChecked) => {
                await api(`accounts/${provider}/${encodeURIComponent(r.id)}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ enabled: newChecked })
                });
                r.enabled = newChecked;
              }
            })],
            ['Account', r => r.email || r.name || r.id],
            ['Provider', () => tab],
            ['Quota', r => {
              const cellWrap = el('span');
              const updateBadge = () => {
                cellWrap.replaceChildren();
                const pct = calculateQuotaPercent(r);
                const badge = renderQuotaBadge(pct, el, async () => {
                  const q = await api(`accounts/${provider}/${encodeURIComponent(r.id)}/quota`, { method: 'POST' });
                  r.quota = q.quota || q;
                  updateBadge();
                });
                cellWrap.appendChild(badge);
              };
              updateBadge();

              // Auto-refresh quota from upstream every time the tab is clicked
              api(`accounts/${provider}/${encodeURIComponent(r.id)}/quota`, { method: 'POST' })
                .then(q => {
                  r.quota = q.quota || q;
                  if (token === tabGeneration && root.isConnected) updateBadge();
                })
                .catch(() => {});
              return cellWrap;
            }],
            ['Action', r => {
              const delBtn = el('button', 'Delete', undefined, 'sm danger');
              delBtn.title = `Delete account ${r.email || r.name || r.id}`;
              delBtn.onclick = async () => {
                if (!confirm(`Are you sure you want to delete account "${r.email || r.name || r.id}"?`)) return;
                delBtn.disabled = true;
                try {
                  await api(`accounts/${provider}/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
                  if (token === tabGeneration && root.isConnected) button.click();
                } catch (e) {
                  error(panel, e);
                  delBtn.disabled = false;
                }
              };
              return delBtn;
            }]
          ], rows);

          // Key-Value Model Dictionary Section
          // Fetch models using single account
          const fetchAccount = rows.find(a => a.enabled !== false) || rows[0];
          renderModelDictionary(panel, {
            title: `Models  -  ${tab}`,
            subtitle: '',
            provider: provider,
            api,
            el,
            error,
            autoFetch: false,
            fetchModelsFn: async () => {
              const data = await api(`accounts/${provider}/${encodeURIComponent(fetchAccount.id)}/discover`, { method: 'POST' });
              if (provider === 'google' && data.models) {
                const accs = await api(`accounts?provider=${provider}`);
                const found = accs.find(a => a.id === fetchAccount.id);
                if (found && found.quota) {
                  fetchAccount.quota = found.quota;
                }
                // Accounts are a one-to-one model-card dictionary. Effort grouping belongs
                // exclusively to API Routes, not model discovery. Antigravity sometimes
                // exposes the low card with a redundant "medium" segment; keep the exact
                // upstream ID as the value while presenting the canonical public card name.
                return accountModelCards(data.models, provider);
              }
              return data.models || [];
            }
          });
        }
      } catch (e) { if (token === tabGeneration) { panel.replaceChildren(); error(panel, e); } }
    };
  }
  tabs.firstElementChild.click();
}
async function integration(root, status) {
  const detail = card(root, 'DSH', 'Install the x-proxy provider without changing your other providers.'); detail.classList.add('integration');
  el('p', status.displayPath, detail, 'muted');
  el('p', status.state === 'installed' ? 'Your x-proxy provider is already installed.' : 'Preview the model mappings before installing. A backup is created automatically.', detail);

  const actions = el('div', undefined, detail, 'tabs');
  actions.style.marginBottom = '0';

  const button = el('button', status.state === 'installed' ? '✓ Installed' : 'Install', actions, status.state === 'installed' ? 'installed' : 'install');
  button.disabled = status.state !== 'ready';

  const updateBtn = el('button', '↻ Update', actions, 'secondary');
  updateBtn.disabled = status.state !== 'installed';
  updateBtn.title = 'Re-generate and overwrite the x-proxy provider block (keeps a backup)';

  const openBtn = el('button', '📄 Open configuration', actions);
  openBtn.disabled = status.state === 'ready' && !status.exists;
  openBtn.title = `Open ${status.displayPath} with the system default editor`;

  if (status.diagnostic) el('p', status.diagnostic, detail, 'error-message');
  const preview = el('div', undefined, detail);

  async function runPlanFlow(endpoint) {
    preview.replaceChildren();
    try {
      const plan = await api(`integrations/dsh/${endpoint === 'update' ? 'update-plan' : 'plan'}`, { method: 'POST' });
      if (!root.isConnected) return;
      if (endpoint === 'install' && plan.state === 'installed') return page('install');
      el('h3', endpoint === 'update' ? 'Update preview' : 'Installation preview', preview);
      el('pre', JSON.stringify(plan.changes, null, 2), preview);
      const confirmBtn = el('button', endpoint === 'update' ? 'Confirm update' : 'Confirm installation', preview, 'primary');
      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        try {
          await api(`integrations/dsh/${endpoint}`, { method: 'POST', body: JSON.stringify({ confirmed: true, revision: plan.revision }) });
          if (root.isConnected) await page('install');
        } catch (e) { error(preview, e); button.disabled = false; updateBtn.disabled = false; }
      };
    } catch (e) { error(preview, e); button.disabled = false; updateBtn.disabled = false; }
  }

  button.onclick = async () => {
    button.disabled = true; preview.replaceChildren();
    await runPlanFlow('install');
  };

  updateBtn.onclick = async () => {
    updateBtn.disabled = true; preview.replaceChildren();
    await runPlanFlow('update');
  };

  openBtn.onclick = async () => {
    openBtn.disabled = true;
    try { await api('integrations/dsh/open', { method: 'POST' }); }
    catch (e) { error(preview, e); }
    finally { openBtn.disabled = false; }
  };
}

function modelsPanel(root, data) {
  card(root, 'Public Models', `${data.length} public mappings  -  managed through /admin/api/models`);

  if (!data.length) {
    empty(root, 'No public models mapped yet', 'Go to Accounts or API Endpoints to discover and map models into x-proxy.');
    return;
  }

  const grid = el('div', undefined, root, 'model-grid');

  for (const m of data) {
    const isEnabled = m.enabled !== false;
    const cardEl = el('div', undefined, grid, `model-card${isEnabled ? '' : ' disabled'}`);

    // Read-only card header. Model activation and routing are managed in API Routes.
    const cardHeader = el('div', undefined, cardEl, 'model-card-header');
    const titleBox = el('div', undefined, cardHeader);
    const title = el('h3', m.name || m.id, titleBox, 'model-card-title');
    title.title = m.name || m.id;
    el('span', isEnabled ? 'Public & Active' : 'Disabled', titleBox, `pill ${isEnabled ? 'good' : 'error'}`);

    // Badges / Tags
    const badges = el('div', undefined, cardEl, 'model-badges');
    const sourceCount = (m.sources && m.sources.length) || (m.endpointIds && m.endpointIds.length) || 1;
    const providerName = m.provider ? (m.provider.includes('google') ? 'Google' : 'OpenAI') : (m.endpointId ? 'API Endpoint' : 'Custom');
    el('span', providerName, badges, 'pill');
    if (sourceCount > 1) {
      el('span', `${sourceCount} Sources`, badges, 'pill');
    }
    if (m.effort?.mode) {
      el('span', `Effort: ${m.effort.mode}`, badges, 'pill muted-pill');
    }

    // Metadata List
    const metaList = el('div', undefined, cardEl, 'model-meta-list');

    const rowPub = el('div', undefined, metaList, 'model-meta-row');
    el('span', 'Public Model ID', rowPub);
    const codePub = el('code', m.id, rowPub, 'model-meta-val');
    codePub.title = m.id;

    const rowUp = el('div', undefined, metaList, 'model-meta-row');
    el('span', 'Upstream Model ID', rowUp);
    const codeUp = el('code', m.upstreamId, rowUp, 'model-meta-val');
    codeUp.title = m.upstreamId;

    if (m.endpointId || m.endpointIds?.length) {
      const rowEp = el('div', undefined, metaList, 'model-meta-row');
      el('span', 'Endpoint ID', rowEp);
      const epDisplay = m.endpointIds?.length > 1 ? m.endpointIds.join(', ') : (m.endpointId || m.endpointIds?.[0]);
      el('span', epDisplay, rowEp, 'model-meta-val');
    }

    // This tab is intentionally preview-only; edit routes in API Routes.
  }
}
async function page(name) {
  if (!descriptions[name]) name = 'analytics';
  currentPage = name; const token = ++generation;
  title.textContent = name[0].toUpperCase() + name.slice(1);
  document.title = `${title.textContent} - uwu-x-proxy`;
  document.querySelector('#breadcrumb').textContent = name.toUpperCase(); document.querySelector('#subtitle').textContent = descriptions[name];
  document.querySelectorAll('[data-page]').forEach(b => { b.classList.toggle('active', b.dataset.page === name); if (b.dataset.page === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const root = el('div'); content.replaceChildren(root); content.setAttribute('aria-busy', 'true');
  el('div', 'Loading your workspace...', root, 'loading');
  try {
    if (name === 'accounts') { root.replaceChildren(); accounts(root); return; }
    if (name === 'routes') { root.replaceChildren(); routesPanel(root, { api, el, error }); return; }
    const data = await api(name === 'analytics' ? `analytics?range=${range}` : name === 'logs' ? 'analytics' : name === 'install' ? 'integrations' : name);
    if (token !== generation) return;
    root.replaceChildren();
    if (name === 'analytics') dashboard(root, data);
    else if (name === 'logs') requests(card(root, 'Request log', 'Latest 50 retained requests  -  newest first'), data.recent);
    else if (name === 'models') modelsPanel(root, data);
    else await integration(root, data);
  } catch (e) { if (token === generation) { root.replaceChildren(); error(root, e); const retry = el('button', 'Try again', root); retry.onclick = () => page(name); } }
  finally { if (token === generation) content.setAttribute('aria-busy', 'false'); }
}
document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => { if (location.hash === `#${b.dataset.page}`) page(b.dataset.page); else location.hash = b.dataset.page; });
document.querySelector('#refresh').onclick = () => page(currentPage);
window.addEventListener('hashchange', () => page(location.hash.slice(1)));
page(location.hash.slice(1) || 'analytics');
