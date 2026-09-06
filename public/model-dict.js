// Reusable Key-Value Model Dictionary & Quota / Toggle Components
// Supports both Accounts (Google/OpenAI) and API Endpoints.

export function accountModelCards(models, provider) {
  if (!Array.isArray(models)) return [];
  return models.map(model => {
    const upstreamId = model.upstreamId || model.id;
    const publicId = provider === 'google'
      ? model.id.replace(/^(gemini-3\.[678]-flash)-medium-(low)$/i, '$1-$2')
      : model.id;
    return {
      ...model,
      id: publicId,
      upstreamId,
      // An account row maps one public name to exactly one card. It must not
      // aggregate card variants or rewrite a future request's effort.
      effort: { mode: 'forward', supported: [] }
    };
  });
}

export function toggleSwitch({ checked = true, onChange, ariaLabel = '', label = '' }) {
  const wrap = document.createElement('label');
  wrap.className = 'toggle-switch';
  if (ariaLabel) wrap.setAttribute('aria-label', ariaLabel);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!checked;

  const slider = document.createElement('span');
  slider.className = 'toggle-slider';

  wrap.appendChild(input);
  wrap.appendChild(slider);

  if (label) {
    const text = document.createElement('span');
    text.className = 'toggle-label';
    text.textContent = label;
    wrap.appendChild(text);
  }

  input.addEventListener('change', async (e) => {
    e.stopPropagation();
    const newChecked = input.checked;
    if (onChange) {
      input.disabled = true;
      try {
        await onChange(newChecked);
      } catch (err) {
        input.checked = !newChecked;
        console.error('Toggle action failed:', err);
      } finally {
        input.disabled = false;
      }
    }
  });

  return wrap;
}

export function calculateQuotaPercent(account) {
  if (!account) return null;
  const q = account.quota;
  if (!q) return null;

  // OpenAI / Codex quota format (from /wham/usage)
  if (account.provider === 'openai' || q.rate_limit) {
    if (q.rate_limit?.limit_reached === true) return 0;
    if (q.rate_limit?.primary_window?.used_percent !== undefined) {
      const used = Number(q.rate_limit.primary_window.used_percent);
      if (!Number.isNaN(used)) return Math.max(0, Math.min(100, Math.round(100 - used)));
    }
    if (q.remaining !== undefined) {
      const rem = Number(q.remaining);
      if (!Number.isNaN(rem)) return Math.max(0, Math.min(100, Math.round(rem)));
    }
    if (q.percentage !== undefined) {
      const pct = Number(q.percentage);
      if (!Number.isNaN(pct)) return Math.max(0, Math.min(100, Math.round(100 - pct)));
    }
    if (q.used_percent !== undefined) {
      const used = Number(q.used_percent);
      if (!Number.isNaN(used)) return Math.max(0, Math.min(100, Math.round(100 - used)));
    }
  }

  // Google Antigravity quota format (map of modelId -> quotaInfo).
  // An account is only as usable as its most exhausted model, so the
  // account-level figure is the minimum across all known models. Picking a
  // single family (e.g. Claude-first) hides exhaustion elsewhere: it once
  // reported 100% while every Gemini variant sat at 0.
  if (account.provider === 'google' || typeof q === 'object') {
    if (typeof q.remainingFraction === 'number') {
      return Math.max(0, Math.min(100, Math.round(q.remainingFraction * 100)));
    }
    const modelMap = q.models || q;
    const entries = Object.entries(modelMap);
    if (entries.length > 0) {
      const fractions = entries
        .map(([, info]) => info?.remainingFraction ?? (info?.resetTime ? 0 : null))
        .filter(f => typeof f === 'number');
      if (fractions.length > 0) {
        return Math.max(0, Math.min(100, Math.round(Math.min(...fractions) * 100)));
      }
    }
  }

  return null;
}

// Per-model percentages for tooltips/diagnostics, e.g.
// "gemini-3.8-flash-medium 0%, claude-sonnet-4-6 100%". Returns null when
// the account carries no per-model quota map.
export function quotaBreakdown(account) {
  const q = account?.quota;
  if (!q || typeof q !== 'object' || typeof q.remainingFraction === 'number') return null;
  const modelMap = q.models || q;
  const parts = Object.entries(modelMap)
    .map(([id, info]) => {
      const frac = info?.remainingFraction ?? (info?.resetTime ? 0 : null);
      return typeof frac === 'number' ? `${id} ${Math.round(frac * 100)}%` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Antigravity-style family quota: the weekly remaining of a model family is
// the bottleneck across that family's models (and accounts). Google exposes
// a single quota window per model, so there is no five-hour figure.
export function familyQuota(accounts, family) {
  const test = family === 'claude' ? /^claude/i : /^gemini/i;
  let best = null;
  for (const acc of accounts || []) {
    const q = acc?.quota;
    if (!q || typeof q !== 'object') continue;
    for (const [id, info] of Object.entries(q.models || q)) {
      if (!test.test(id)) continue;
      const frac = info?.remainingFraction ?? (info?.resetTime ? 0 : null);
      if (typeof frac !== 'number') continue;
      if (!best || frac < best.frac) best = { frac, reset: info?.resetTime };
    }
  }
  if (!best) return { weekly: null, weeklyReset: null };
  return { weekly: Math.max(0, Math.min(100, Math.round(best.frac * 100))), weeklyReset: best.reset || null };
}

// Combined "All accounts" view: the proxy routes around depleted accounts,
// so the headline is the BEST account's weekly figure, plus how many accounts
// can still serve the family. Min-across-accounts here once reported 0% while
// a healthy account sat at 72%.
export function familyQuotaAll(accounts, family) {
  const pool = (accounts || []).filter(a => a?.enabled !== false);
  const per = pool.map(acc => ({ acc, ...familyQuota([acc], family) }));
  const known = per.filter(p => p.weekly !== null);
  if (!known.length) return { weekly: null, weeklyReset: null, usable: 0, total: pool.length };
  const usable = known.filter(p => p.weekly > 0);
  const best = (usable.length ? usable : known).reduce((a, b) => (a.weekly >= b.weekly ? a : b));
  return { weekly: best.weekly, weeklyReset: best.weeklyReset, usable: usable.length, total: pool.length };
}

// Antigravity-style family summary from retrieveUserQuotaSummary groups:
// { weekly: {pct, reset}|null, fiveHour: {pct, reset}|null, usableWeekly,
//   usableFiveHour, total, summarized }. Falls back to the per-model quota map
// (weekly only) for accounts refreshed before groups existed.
export function familySummary(accounts, family) {
  const groupTest = family === 'claude' ? /claude/i : /gemini/i;
  const pool = (accounts || []).filter(a => a?.enabled !== false);
  const collect = window => {
    const cands = [];
    for (const acc of pool) {
      for (const g of acc.quotaGroups || []) {
        if (!groupTest.test(g.displayName || '')) continue;
        for (const b of g.buckets || []) {
          const win = String(b.window || '').toLowerCase();
          if (win !== window && !String(b.bucketId || '').toLowerCase().endsWith(`-${window}`)) continue;
          if (typeof b.remainingFraction !== 'number') continue;
          cands.push({ pct: Math.max(0, Math.min(100, Math.round(b.remainingFraction * 100))), reset: b.resetTime || null });
        }
      }
    }
    return cands;
  };
  const weeklies = collect('weekly'), fiveHours = collect('5h');
  const bestOf = list => list.length ? list.reduce((a, b) => (a.pct >= b.pct ? a : b)) : null;
  if (!weeklies.length && !fiveHours.length) {
    const f = familyQuotaAll(accounts, family);
    return { weekly: f.weekly !== null ? { pct: f.weekly, reset: f.weeklyReset } : null, fiveHour: null, usableWeekly: f.usable, usableFiveHour: 0, total: f.total, summarized: false };
  }
  const weekly = bestOf(weeklies), fiveHour = bestOf(fiveHours);
  return {
    weekly, fiveHour,
    usableWeekly: weeklies.filter(c => c.pct > 0).length,
    usableFiveHour: fiveHours.filter(c => c.pct > 0).length,
    total: pool.length,
    summarized: true
  };
}

// Codex quota really has two windows: primary (~5h) and secondary (~1w).
// Headlines are the best account's figure (requests route around depletion),
// with usable/total counts for the combined view.
export function codexQuota(accounts) {
  const read = (acc, key) => {
    const w = acc?.quota?.rate_limit?.[key];
    if (!w || typeof w.used_percent !== 'number') return null;
    if (key === 'primary_window' && acc.quota.rate_limit.limit_reached === true) {
      return { pct: 0, resetAfterSec: w.reset_after_seconds };
    }
    return { pct: Math.max(0, Math.min(100, Math.round(100 - w.used_percent))), resetAfterSec: w.reset_after_seconds };
  };
  const pool = (accounts || []).filter(a => a?.provider === 'openai' && a?.enabled !== false);
  const collect = key => pool.map(acc => read(acc, key)).filter(Boolean);
  const fiveHours = collect('primary_window'), weeklies = collect('secondary_window');
  const best = list => list.length ? list.reduce((a, b) => (a.pct >= b.pct ? a : b)) : null;
  return {
    fiveHour: best(fiveHours),
    weekly: best(weeklies),
    usableFiveHour: fiveHours.filter(w => w.pct > 0).length,
    usableWeekly: weeklies.filter(w => w.pct > 0).length,
    total: pool.length
  };
}

// 'resets in 5d 4h' / 'resets in 3h 12m' / 'resets in 45m'. Null when unknown.
export function resetCountdown(iso, now = Date.now()) {
  const target = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(target)) return null;
  let sec = Math.max(0, Math.round((target - now) / 1000));
  const days = Math.floor(sec / 86400); sec -= days * 86400;
  const hours = Math.floor(sec / 3600); sec -= hours * 3600;
  const minutes = Math.floor(sec / 60);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export function countdownFromSec(sec) {
  if (typeof sec !== 'number' || Number.isNaN(sec) || sec < 0) return null;
  const hours = Math.floor(sec / 3600), minutes = Math.floor((sec % 3600) / 60);
  if (hours >= 24) return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export function renderQuotaBadge(percent, el, onRefresh) {
  const container = el('span', undefined, undefined, 'quota-cell');
  let pillClass = 'pill good';
  let text = 'N/A';

  if (percent !== null && percent !== undefined) {
    text = `${percent}% usable`;
    if (percent <= 20) pillClass = 'pill error';
    else if (percent <= 50) pillClass = 'pill warning';
  } else {
    pillClass = 'pill muted-pill';
    text = 'Checking...';
  }

  const badge = el('span', text, container, pillClass);

  if (onRefresh) {
    const refreshBtn = el('button', '⟳', container, 'quota-refresh');
    refreshBtn.title = 'Refresh quota';
    refreshBtn.setAttribute('aria-label', 'Refresh quota');
    refreshBtn.onclick = async (e) => {
      e.stopPropagation();
      refreshBtn.disabled = true;
      badge.textContent = '...';
      try {
        await onRefresh();
      } catch (err) {
        console.error('Refresh quota failed:', err);
      } finally {
        refreshBtn.disabled = false;
      }
    };
  }

  return container;
}

export function renderModelDictionary(parent, {
  title = 'Model Mappings',
  subtitle = '',
  provider,
  endpointId,
  api,
  el,
  error,
  autoFetch = false,
  fetchModelsFn,
  onFetchClick
}) {
  const section = el('section', undefined, parent, 'dict-section');
  const header = el('div', undefined, section, 'dict-header');
  const titles = el('div', undefined, header);
  el('h3', title, titles);
  if (subtitle) el('p', subtitle, titles, 'muted');

  const actions = el('div', undefined, header, 'dict-actions');
  const fetchBtn = el('button', 'Fetch Models', actions, 'secondary sm');
  const addBtn = el('button', '+ Add Key-Value', actions, 'secondary sm');
  const removeAllBtn = el('button', 'Remove All', actions, 'danger sm');

  const feedback = el('div', undefined, section);
  const tableWrap = el('div', undefined, section, 'table-wrap');
  const table = el('table', undefined, tableWrap, 'dict-table');

  // items: [{ key, value, mapped, originalKey, isCustom }]
  let items = [];
  let existingMappings = new Map(); // model.id -> model (and upstreamId -> model)

  function setFeedback(msg, isErr = false) {
    feedback.replaceChildren();
    if (!msg) return;
    if (isErr) {
      error(feedback, typeof msg === 'string' ? new Error(msg) : msg);
    } else {
      const p = el('p', msg, feedback, 'muted');
      setTimeout(() => { if (p.isConnected) p.remove(); }, 4000);
    }
  }

  async function loadExistingModels() {
    try {
      const allModels = await api('models');
      existingMappings.clear();
      for (const m of allModels) {
        const hasEndpoint = endpointId && (m.endpointId === endpointId || m.endpointIds?.includes(endpointId) || m.sources?.some(s => s.endpointId === endpointId));
        const hasProvider = provider && (m.provider === provider || m.provider === `${provider}-antigravity` || m.provider === `${provider}-codex` || m.sources?.some(s => s.provider?.startsWith(provider)));
        if (hasEndpoint || hasProvider) {
          existingMappings.set(m.id, m);
          if (m.upstreamId) existingMappings.set(m.upstreamId, m);
        }
      }
    } catch (e) {
      console.warn('Could not load existing models:', e);
    }
  }

  async function mapModel(item, enable) {
    const pubId = item.key.trim();
    const upId = item.value.trim();

    if (!pubId || !upId) {
      throw new Error('Both Public Model ID (Key) and Upstream Model ID (Value) are required');
    }

    if (enable) {
      if (endpointId) {
        await api(`endpoints/${encodeURIComponent(endpointId)}/models`, {
          method: 'POST',
          body: JSON.stringify({ publicId: pubId, upstreamId: upId })
        });
      } else {
        await api('models', {
          method: 'POST',
          body: JSON.stringify({
            id: pubId,
            upstreamId: upId,
            provider: provider || 'google',
            effort: item.effort || { mode: 'forward', supported: [] },
            enabled: true
          })
        });
      }
      item.mapped = true;
      item.originalKey = pubId;
      setFeedback(`Mapped: ${pubId} -> ${upId}`);
    } else {
      const targetId = item.originalKey || pubId;
      if (endpointId) {
        await api(`endpoints/${encodeURIComponent(endpointId)}/models/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
      } else {
        await api(`models/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
      }
      item.mapped = false;
      item.originalKey = null;
      setFeedback(`Unmapped: ${targetId}`);
    }
  }

  function renderRows() {
    table.replaceChildren();
    const thead = el('thead', undefined, table);
    const headRow = el('tr', undefined, thead);
    el('th', 'Map Model', headRow);
    el('th', 'Public Model ID (Key)', headRow);
    el('th', 'Upstream Model ID (Value)', headRow);
    el('th', 'Action', headRow);

    const tbody = el('tbody', undefined, table);

    if (items.length === 0) {
      const emptyRow = el('tr', undefined, tbody);
      const td = el('td', 'No models loaded. Click "Fetch Models" or "+ Add Key-Value" to begin.', emptyRow);
      td.colSpan = 4;
      td.className = 'muted';
      td.style.textAlign = 'center';
      td.style.padding = '24px';
      return;
    }

    items.forEach((item, index) => {
      const row = el('tr', undefined, tbody);

      // Map Model Toggle (First Column)
      const tdToggle = el('td', undefined, row);
      const toggle = toggleSwitch({
        checked: item.mapped,
        ariaLabel: `Map model ${item.key || item.value}`,
        label: item.mapped ? 'Mapped' : 'Unmapped',
        onChange: async (newChecked) => {
          try {
            await mapModel(item, newChecked);
            const labelEl = toggle.querySelector('.toggle-label');
            if (labelEl) labelEl.textContent = newChecked ? 'Mapped' : 'Unmapped';
          } catch (err) {
            setFeedback(err, true);
            throw err;
          }
        }
      });
      tdToggle.appendChild(toggle);

      // Key input (Public Model ID)
      const tdKey = el('td', undefined, row);
      const inputKey = el('input', undefined, tdKey, 'dict-input');
      inputKey.value = item.key;
      inputKey.placeholder = 'e.g. gemini-2.5-flash';
      inputKey.setAttribute('aria-label', `Public Model ID for row ${index + 1}`);
      inputKey.oninput = () => { item.key = inputKey.value; };

      // Value input (Upstream Model ID)
      const tdVal = el('td', undefined, row);
      const inputVal = el('input', undefined, tdVal, 'dict-input');
      inputVal.value = item.value;
      inputVal.placeholder = 'e.g. gemini-2.5-flash';
      inputVal.setAttribute('aria-label', `Upstream Model ID for row ${index + 1}`);
      inputVal.oninput = () => { item.value = inputVal.value; };

      // Action: Remove row
      const tdAction = el('td', undefined, row);
      const removeBtn = el('button', 'x', tdAction, 'sm danger');
      removeBtn.title = 'Remove row';
      removeBtn.setAttribute('aria-label', `Remove row ${index + 1}`);
      removeBtn.onclick = async () => {
        if (item.mapped) {
          try {
            await mapModel(item, false);
          } catch (err) {
            setFeedback(err, true);
            return;
          }
        }
        items.splice(index, 1);
        renderRows();
      };
    });
  }

  async function fetchModels() {
    if (!fetchModelsFn) return;
    fetchBtn.disabled = true;
    const origText = fetchBtn.textContent;
    fetchBtn.textContent = 'Fetching...';
    setFeedback('');

    try {
      await loadExistingModels();
      const discovered = await fetchModelsFn();

      if (!discovered || discovered.length === 0) {
        setFeedback('No models discovered.');
        return;
      }

      // Clear old records
      const oldModelIds = Array.from(new Set(Array.from(existingMappings.values()).map(m => m.id)));
      for (const oldId of oldModelIds) {
        try {
          if (endpointId) {
            await api(`endpoints/${encodeURIComponent(endpointId)}/models/${encodeURIComponent(oldId)}`, { method: 'DELETE' });
          } else {
            await api(`models/${encodeURIComponent(oldId)}`, { method: 'DELETE' });
          }
        } catch (err) {
          console.warn('Could not remove old model:', oldId, err);
        }
      }
      existingMappings.clear();

      // Map new models
      const newItems = [];
      const seenIds = new Set();

      for (const m of discovered) {
        const pubId = m.id || m.slug || m.name;
        const upId = m.upstreamId || m.id || m.slug || m.name;
        if (!pubId || !upId || seenIds.has(pubId)) continue;
        seenIds.add(pubId);

        const effortConfig = m.effort || (m.supported?.length ? { mode: 'forward', supported: m.supported, default: m.default } : undefined);
        try {
          if (endpointId) {
            await api(`endpoints/${encodeURIComponent(endpointId)}/models`, {
              method: 'POST',
              body: JSON.stringify({
                publicId: pubId, upstreamId: upId,
                ...(Number(m.contextWindow ?? m.windowContext ?? m.context_length) > 0 ? { contextWindow: Math.floor(Number(m.contextWindow ?? m.windowContext ?? m.context_length)) } : {}),
                ...(Number(m.maxTokens ?? m.maxOutputTokens ?? m.max_completion_tokens) > 0 ? { maxTokens: Math.floor(Number(m.maxTokens ?? m.maxOutputTokens ?? m.max_completion_tokens)) } : {})
              })
            });
          } else {
            await api('models', {
              method: 'POST',
              body: JSON.stringify({
                id: pubId,
                upstreamId: upId,
                provider: provider || 'google',
                effort: effortConfig || { mode: 'forward', supported: [] },
                enabled: true
              })
            });
          }
          newItems.push({
            key: pubId,
            value: upId,
            effort: effortConfig,
            mapped: true,
            originalKey: pubId
          });
        } catch (mapErr) {
          console.error(`Failed to map ${pubId}:`, mapErr);
        }
      }

      items = newItems;
      await loadExistingModels();
      renderRows();
      setFeedback(`Fetched and mapped ${newItems.length} models.`);
    } catch (err) {
      setFeedback(err, true);
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = origText;
    }
  }

  if (onFetchClick) {
    fetchBtn.onclick = () => onFetchClick({
      fetchBtn,
      fetchModels,
      loadExistingModels,
      existingMappings,
      renderRows,
      setFeedback,
      mapModel,
      getItems: () => items,
      setItems: (newItems) => { items = newItems; renderRows(); }
    });
  } else {
    fetchBtn.onclick = () => fetchModels();
  }

  addBtn.onclick = () => {
    items.unshift({
      key: '',
      value: '',
      mapped: false,
      isCustom: true
    });
    renderRows();
  };

  removeAllBtn.onclick = async () => {
    if (items.length === 0 && existingMappings.size === 0) return;
    if (!confirm('Are you sure you want to remove all models?')) return;
    removeAllBtn.disabled = true;
    setFeedback('');
    try {
      await loadExistingModels();
      const idsToDelete = Array.from(new Set([
        ...items.map(it => it.originalKey || it.key).filter(Boolean),
        ...Array.from(existingMappings.values()).map(m => m.id)
      ]));
      for (const modelId of idsToDelete) {
        try {
          if (endpointId) {
            await api(`endpoints/${encodeURIComponent(endpointId)}/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
          } else {
            await api(`models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
          }
        } catch (e) {
          console.warn('Could not delete model:', modelId, e);
        }
      }
      existingMappings.clear();
      items = [];
      renderRows();
      setFeedback('All models removed. Click "Fetch Models" to reload.');
    } catch (err) {
      setFeedback(err, true);
    } finally {
      removeAllBtn.disabled = false;
    }
  };

  // Initial load
  loadExistingModels().then(() => {
    // Populate items with existing mappings first (deduplicate by id)
    if (existingMappings.size > 0) {
      const unique = Array.from(new Set(Array.from(existingMappings.values()).map(m => m.id)))
        .map(id => existingMappings.get(id))
        .filter(Boolean);
      items = unique.map(m => ({
        key: m.id,
        value: m.upstreamId || m.id,
        mapped: m.enabled !== false,
        originalKey: m.id
      }));
      renderRows();
    } else {
      renderRows();
    }

    if (autoFetch) {
      fetchModels();
    }
  }).catch(e => {
    console.error(e);
    renderRows();
  });

  return {
    fetchModels,
    getItems: () => items
  };
}