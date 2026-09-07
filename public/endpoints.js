import { toggleSwitch, renderModelDictionary } from './model-dict.js';

export function openImportModelsModal({ endpoint, discoveredModels, onImport, el, note }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const box = document.createElement('div');
  box.className = 'modal-box';
  box.style.maxWidth = '560px';
  backdrop.appendChild(box);

  function closeModal() {
    document.removeEventListener('keydown', onKeyDown);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
  }
  document.addEventListener('keydown', onKeyDown);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  // Modal Header
  const header = el('div', undefined, box, 'modal-header');
  el('h3', `Import Models - ${endpoint.name}`, header);
  const closeBtn = el('button', 'x', header, 'modal-close');
  closeBtn.title = 'Close';
  closeBtn.onclick = closeModal;

  // Modal Description
  el('p', `Select which models from "${endpoint.name}" you want to import into x-proxy. Selected models will be mapped and active.`, box, 'modal-desc');
  if (note) el('p', note, box, 'modal-desc muted');

  // Toolbar: Search + Select All / Deselect All
  const toolbar = el('div', undefined, box, 'modal-model-toolbar');
  const searchInput = el('input', undefined, toolbar, 'modal-model-search');
  searchInput.type = 'text';
  searchInput.placeholder = 'Filter models...';

  const linksBox = el('div', undefined, toolbar, 'modal-model-links');
  const selectAllBtn = el('button', 'Select All', linksBox, 'modal-model-link');
  selectAllBtn.type = 'button';
  const deselectAllBtn = el('button', 'Deselect All', linksBox, 'modal-model-link');
  deselectAllBtn.type = 'button';

  // Selected state: map modelId -> boolean (default all true)
  const selectedState = new Map();
  for (const m of discoveredModels) {
    const id = m.id || m.slug || m.name;
    if (id) selectedState.set(id, true);
  }

  // Count badge
  const countBadge = el('div', undefined, box, 'modal-model-counts');

  // Scrollable model list container
  const listContainer = el('div', undefined, box, 'modal-model-list');

  // Modal Footer
  const footer = el('div', undefined, box, 'modal-footer');
  const cancelBtn = el('button', 'Cancel', footer);
  cancelBtn.type = 'button';
  cancelBtn.onclick = closeModal;

  const importBtn = el('button', 'Import', footer, 'primary');
  importBtn.type = 'button';

  function updateCountBadge() {
    let count = 0;
    for (const val of selectedState.values()) if (val) count++;
    countBadge.textContent = `${count} of ${discoveredModels.length} models selected`;
    importBtn.disabled = count === 0;
    importBtn.textContent = `Import (${count} selected)`;
  }

  function renderList(filter = '') {
    listContainer.replaceChildren();
    const query = filter.toLowerCase().trim();
    const filtered = discoveredModels.filter(m => {
      const id = (m.id || m.slug || m.name || '').toLowerCase();
      return !query || id.includes(query);
    });

    if (filtered.length === 0) {
      const emptyP = el('p', 'No matching models found.', listContainer, 'muted');
      emptyP.style.padding = '16px';
      emptyP.style.textAlign = 'center';
      return;
    }

    filtered.forEach(m => {
      const id = m.id || m.slug || m.name;
      const row = el('label', undefined, listContainer, 'modal-model-item');

      const checkbox = el('input', undefined, row);
      checkbox.type = 'checkbox';
      checkbox.checked = !!selectedState.get(id);

      checkbox.onchange = (e) => {
        e.stopPropagation();
        selectedState.set(id, checkbox.checked);
        updateCountBadge();
      };

      const nameCode = el('code', id, row, 'modal-model-label');
      nameCode.title = id;
    });
  }

  searchInput.oninput = () => {
    renderList(searchInput.value);
  };

  selectAllBtn.onclick = () => {
    for (const m of discoveredModels) {
      const id = m.id || m.slug || m.name;
      if (id) selectedState.set(id, true);
    }
    renderList(searchInput.value);
    updateCountBadge();
  };

  deselectAllBtn.onclick = () => {
    for (const m of discoveredModels) {
      const id = m.id || m.slug || m.name;
      if (id) selectedState.set(id, false);
    }
    renderList(searchInput.value);
    updateCountBadge();
  };

  renderList();
  updateCountBadge();

  importBtn.onclick = async () => {
    const selectedModels = discoveredModels.filter(m => {
      const id = m.id || m.slug || m.name;
      return selectedState.get(id);
    });
    if (selectedModels.length === 0) return;

    importBtn.disabled = true;
    cancelBtn.disabled = true;
    importBtn.textContent = 'Importing...';
    try {
      await onImport(selectedModels);
      closeModal();
    } catch (err) {
      console.error('Import failed:', err);
      importBtn.disabled = false;
      cancelBtn.disabled = false;
      updateCountBadge();
    }
  };

  document.body.appendChild(backdrop);
}

export function endpointsPanel(parent, rows, { api, el, error, table, enabled }) {
  let selectedEndpoint = rows.find(r => r.protocol === 'openai') || rows[0];
  let editingId = null;

  const header = el('div', undefined, parent, 'card-header');
  el('h2', 'OpenAI-compatible endpoints', header);

  const headerActions = el('div', undefined, header, 'tabs');
  headerActions.style.marginBottom = '0';
  const addRecordBtn = el('button', '+ Add Endpoint Record', headerActions, 'primary');

  // Add/Edit Endpoint Form Container (toggleable)
  const formWrap = el('div', undefined, parent);
  formWrap.style.display = rows.length === 0 ? 'block' : 'none';

  const form = el('form', undefined, formWrap, 'connection-form compact');
  form.style.maxWidth = '900px';
  const formTitle = el('h3', 'Add New Endpoint Record', form);

  const formCols = el('div', undefined, form);
  formCols.style.display = 'grid';
  formCols.style.gridTemplateColumns = 'repeat(auto-fit, minmax(260px, 1fr))';
  formCols.style.gap = '14px';
  formCols.style.gridColumn = '1/-1';
  const leftCol = el('div', undefined, formCols);
  leftCol.style.display = 'grid';
  leftCol.style.gap = '10px';
  leftCol.style.alignContent = 'start';
  const rightCol = el('div', undefined, formCols);
  rightCol.style.display = 'grid';
  rightCol.style.gap = '10px';
  rightCol.style.alignContent = 'start';

  function field(parent, label, type, placeholder, required = false) {
    const wrap = el('label', label, parent), input = el('input', undefined, wrap);
    input.type = type; input.placeholder = placeholder; input.required = required; return input;
  }

  const nameInput = field(leftCol, 'Endpoint name', 'text', 'My Ollama', true);
  const baseUrlInput = field(leftCol, 'Base URL (including /v1)', 'url', 'http://localhost:11434/v1', true);
  const apiKeyInput = field(leftCol, 'API key (optional)', 'password', 'Not required for local Ollama');
  apiKeyInput.autocomplete = 'new-password';

  const HEADER_PRESETS = {
    'OpenCode': { 'HTTP-Referer': 'https://opencode.ai', 'X-Title': 'OpenCode' },
    'DeepSeek Harness': { 'HTTP-Referer': 'https://github.com/deepseek-ai/deepseek-harness', 'X-Title': 'DeepSeek Harness' },
  };
  const presetWrap = el('label', 'Header preset', leftCol);
  const presetSelect = el('select', undefined, presetWrap);
  presetSelect.style.width = '100%';
  presetSelect.style.padding = '7px 10px';
  presetSelect.style.fontSize = '13px';
  presetSelect.style.borderRadius = '6px';
  presetSelect.style.background = 'var(--surface)';
  presetSelect.style.border = '1px solid var(--border)';
  presetSelect.style.color = 'var(--text)';
  for (const presetName of ['None', ...Object.keys(HEADER_PRESETS), 'Custom']) {
    const opt = el('option', presetName, presetSelect);
    opt.value = presetName;
  }

  const headersWrap = el('label', 'Additional headers (JSON, optional)', rightCol);
  const headersInput = el('textarea', undefined, headersWrap);
  headersInput.placeholder = '{"HTTP-Referer": "https://opencode.ai", "X-Title": "OpenCode"}';
  headersInput.rows = 5;
  headersInput.style.width = '100%';
  headersInput.style.fontFamily = 'monospace';
  headersInput.style.resize = 'vertical';
  headersInput.spellcheck = false;
  headersInput.autocomplete = 'off';
  headersInput.setAttribute('autocorrect', 'off');
  headersInput.setAttribute('autocapitalize', 'off');
  el('small', 'API Endpoints only. Custom JSON headers (HTTP-Referer + X-Title for OpenRouter).', headersWrap, 'muted');

  function presetForHeaders(headers) {
    if (!headers || !Object.keys(headers).length) return 'None';
    for (const [name, preset] of Object.entries(HEADER_PRESETS)) {
      const keys = Object.keys(preset);
      if (keys.length === Object.keys(headers).length && keys.every(k => headers[k] === preset[k])) return name;
    }
    return 'Custom';
  }
  function syncHeadersVisibility() {
    const isCustom = presetSelect.value === 'Custom';
    rightCol.style.display = isCustom ? '' : 'none';
  }
  presetSelect.onchange = syncHeadersVisibility;
  presetSelect.value = 'None';
  syncHeadersVisibility();

  function parseHeadersInput() {
    if (presetSelect.value === 'None') return {};
    if (presetSelect.value !== 'Custom') return { ...HEADER_PRESETS[presetSelect.value] };
    const raw = (headersInput.value || '').trim();
    if (!raw) return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Additional headers must be valid JSON object');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Additional headers must be a JSON object');
    return parsed;
  }

  const formActions = el('div', undefined, form, 'tabs');
  formActions.style.marginBottom = '0';
  formActions.style.marginTop = '6px';
  formActions.style.justifyContent = 'flex-end';
  const saveBtn = el('button', 'Save endpoint', formActions, 'primary');
  saveBtn.type = 'submit';
  saveBtn.style.padding = '10px 20px';
  saveBtn.style.fontSize = '14px';
  const cancelBtn = el('button', 'Cancel', formActions, 'secondary');
  cancelBtn.type = 'button';
  cancelBtn.style.padding = '10px 20px';
  cancelBtn.style.fontSize = '14px';

  function resetEndpointForm() {
    editingId = null;
    formTitle.textContent = 'Add New Endpoint Record';
    saveBtn.textContent = 'Save endpoint';
    nameInput.value = '';
    baseUrlInput.value = '';
    apiKeyInput.value = '';
    apiKeyInput.placeholder = 'Not required for local Ollama';
    presetSelect.value = 'None';
    headersInput.value = '';
    syncHeadersVisibility();
  }

  function startAddEndpoint() {
    resetEndpointForm();
    formWrap.style.display = 'block';
    nameInput.focus();
  }

  function startEditEndpoint(ep) {
    editingId = ep.id;
    formTitle.textContent = `Edit Endpoint Record - ${ep.name}`;
    saveBtn.textContent = 'Save changes';
    nameInput.value = ep.name || '';
    baseUrlInput.value = ep.baseUrl || '';
    apiKeyInput.value = '';
    apiKeyInput.placeholder = 'Leave blank to keep existing key';
    try {
      presetSelect.value = presetForHeaders(ep.headers);
      headersInput.value = presetSelect.value === 'Custom' && ep.headers && Object.keys(ep.headers).length
        ? JSON.stringify(ep.headers, null, 2)
        : '';
    } catch {
      presetSelect.value = 'Custom';
      headersInput.value = '';
    }
    syncHeadersVisibility();
    formWrap.style.display = 'block';
    nameInput.focus();
  }

  cancelBtn.onclick = () => {
    resetEndpointForm();
    formWrap.style.display = 'none';
  };

  addRecordBtn.onclick = () => {
    if (formWrap.style.display !== 'none' && !editingId) {
      formWrap.style.display = 'none';
      return;
    }
    startAddEndpoint();
  };

  const listContainer = el('div', undefined, parent);
  const modelPanel = el('div', undefined, parent);

  function renderModelPanel() {
    modelPanel.replaceChildren();
    if (!selectedEndpoint) {
      el('p', 'Select an endpoint above or add one to manage its models.', modelPanel, 'muted');
      return;
    }

    renderModelDictionary(modelPanel, {
      title: `Models - ${selectedEndpoint.name}`,
      subtitle: '',
      endpointId: selectedEndpoint.id,
      api,
      el,
      error,
      autoFetch: false,
      onFetchClick: async ({ fetchBtn, setFeedback, loadExistingModels, existingMappings, setItems }) => {
        fetchBtn.disabled = true;
        const origText = fetchBtn.textContent;
        fetchBtn.textContent = 'Fetching...';
        setFeedback('');

        // Shared import flow: limits detected at fetch time travel with each
        // entry into the KV mapping; the backend also fills them from its
        // JSON cache when the client omits them.
        const openForModels = (list, note) => {
          openImportModelsModal({
            endpoint: selectedEndpoint,
            discoveredModels: list,
            note,
            el,
            onImport: async (selectedModels) => {
              // 1. Clear old records
              await loadExistingModels();
              const oldModelIds = Array.from(new Set((existingMappings ? Array.from(existingMappings.values()) : []).map(m => m.id)));
              for (const oldId of oldModelIds) {
                try {
                  await api(`endpoints/${encodeURIComponent(selectedEndpoint.id)}/models/${encodeURIComponent(oldId)}`, { method: 'DELETE' });
                } catch (err) {
                  console.warn('Could not remove old model:', oldId, err);
                }
              }
              if (existingMappings) existingMappings.clear();

              // 2. Map selected models
              const newItems = [];
              const seenIds = new Set();
              for (const m of selectedModels) {
                const pubId = m.id || m.slug || m.name;
                const upId = m.upstreamId || m.id || m.slug || m.name;
                if (!pubId || !upId || seenIds.has(pubId)) continue;
                seenIds.add(pubId);

                await api(`endpoints/${encodeURIComponent(selectedEndpoint.id)}/models`, {
                  method: 'POST',
                  body: JSON.stringify({
                    publicId: pubId, upstreamId: upId,
                    ...(Number(m.contextWindow ?? m.windowContext ?? m.context_length) > 0 ? { contextWindow: Math.floor(Number(m.contextWindow ?? m.windowContext ?? m.context_length)) } : {}),
                    ...(Number(m.maxTokens ?? m.maxOutputTokens ?? m.max_completion_tokens) > 0 ? { maxTokens: Math.floor(Number(m.maxTokens ?? m.maxOutputTokens ?? m.max_completion_tokens)) } : {})
                  })
                });

                newItems.push({
                  key: pubId,
                  value: upId,
                  effort: m.effort || { mode: 'forward', supported: [] },
                  mapped: true,
                  originalKey: pubId
                });
              }

              setItems(newItems);
              await loadExistingModels();
              setFeedback(`Successfully imported and mapped ${newItems.length} models.`);
            }
          });
        };

        try {
          const data = await api(`endpoints/${encodeURIComponent(selectedEndpoint.id)}/discover`, { method: 'POST' });
          const discovered = data.models || [];

          if (discovered.length === 0) {
            setFeedback('No models discovered on this endpoint.');
            return;
          }

          openForModels(discovered, data.fetchedAt ? `Fetched just now (${data.fetchedAt}). Limits are cached for reopen.` : undefined);
        } catch (err) {
          // Offline / reopen without network: fall back to the JSON cache.
          try {
            const cached = await api(`endpoints/${encodeURIComponent(selectedEndpoint.id)}/discover/cache`);
            if (cached && Array.isArray(cached.models) && cached.models.length > 0) {
              openForModels(cached.models, `Live fetch failed; using cached discovery${cached.fetchedAt ? ` from ${cached.fetchedAt}` : ''}.`);
              setFeedback(`Live fetch failed, showing ${cached.models.length} cached models.`);
              return;
            }
          } catch { /* ignore, report the original error below */ }
          setFeedback(err, true);
        } finally {
          fetchBtn.disabled = false;
          fetchBtn.textContent = origText;
        }
      }
    });
  }

  function renderEndpointsList() {
    listContainer.replaceChildren();
    const currentRows = rows.filter(r => r.protocol === 'openai');

    if (currentRows.length === 0) {
      el('p', 'No endpoints configured yet. Click "+ Add Endpoint Record" to add your first endpoint.', listContainer, 'muted');
      return;
    }

    const wrap = el('div', undefined, listContainer, 'table-wrap');
    const tbl = el('table', undefined, wrap);
    const thead = el('thead', undefined, tbl);
    const trHead = el('tr', undefined, thead);
    el('th', 'Status', trHead);
    el('th', 'Name', trHead);
    el('th', 'Base URL', trHead);
    el('th', 'Actions', trHead);

    const tbody = el('tbody', undefined, tbl);
    for (const ep of currentRows) {
      const tr = el('tr', undefined, tbody);
      if (selectedEndpoint && selectedEndpoint.id === ep.id) {
        tr.style.backgroundColor = '#fbf7ee';
      }
      // Row click selects this endpoint and shows its models below.
      tr.style.cursor = 'pointer';
      tr.title = `Manage models for endpoint ${ep.name}`;
      tr.onclick = e => {
        if (e.target.closest('button, a, input, select, label')) return;
        selectedEndpoint = ep;
        renderEndpointsList();
        renderModelPanel();
      };

      // Status Toggle (Enable / Disable) - First Column
      const tdStatus = el('td', undefined, tr);
      const isEnabled = ep.enabled !== false;
      const toggle = toggleSwitch({
        checked: isEnabled,
        ariaLabel: `Enable or disable endpoint ${ep.name}`,
        label: isEnabled ? 'Enabled' : 'Disabled',
        onChange: async (newChecked) => {
          try {
            await api(`endpoints/${encodeURIComponent(ep.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ enabled: newChecked })
            });
            ep.enabled = newChecked;
            const labelEl = toggle.querySelector('.toggle-label');
            if (labelEl) labelEl.textContent = newChecked ? 'Enabled' : 'Disabled';
          } catch (e) {
            error(parent, e);
            throw e;
          }
        }
      });
      tdStatus.appendChild(toggle);

      // Name
      const tdName = el('td', ep.name, tr);
      tdName.style.fontWeight = '500';

      // Base URL
      el('td', ep.baseUrl, tr);

      // Actions: Edit + Delete (row click manages models)
      const tdActions = el('td', undefined, tr);
      const btnGroup = el('div', undefined, tdActions);
      btnGroup.style.display = 'flex';
      btnGroup.style.gap = '6px';
      btnGroup.style.alignItems = 'center';

      const editBtn = el('button', 'Edit', btnGroup, 'sm');
      editBtn.title = `Edit endpoint ${ep.name}`;
      editBtn.onclick = () => {
        startEditEndpoint(ep);
      };

      const deleteBtn = el('button', 'Delete', btnGroup, 'sm danger');
      deleteBtn.title = `Delete endpoint ${ep.name}`;
      deleteBtn.onclick = async () => {
        if (!confirm(`Are you sure you want to delete endpoint "${ep.name}"?`)) return;
        deleteBtn.disabled = true;
        try {
          await api(`endpoints/${encodeURIComponent(ep.id)}`, { method: 'DELETE' });
          const idx = rows.indexOf(ep);
          if (idx >= 0) rows.splice(idx, 1);
          if (selectedEndpoint && selectedEndpoint.id === ep.id) {
            selectedEndpoint = rows.find(r => r.protocol === 'openai') || null;
          }
          if (editingId === ep.id) {
            resetEndpointForm();
            formWrap.style.display = 'none';
          }
          renderEndpointsList();
          renderModelPanel();
        } catch (e) {
          error(parent, e);
          deleteBtn.disabled = false;
        }
      };
    }
  }

  form.onsubmit = async event => {
    event.preventDefault();
    saveBtn.disabled = true;
    try {
      const name = nameInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      const apiKeyValue = apiKeyInput.value;
      let headers;
      try {
        headers = parseHeadersInput();
      } catch (err) {
        error(parent, err);
        return;
      }
      if (editingId) {
        const payload = { name, baseUrl, headers };
        if (apiKeyValue) payload.apiKey = apiKeyValue;
        const updated = await api(`endpoints/${encodeURIComponent(editingId)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
        const idx = rows.findIndex(r => r.id === editingId);
        if (idx >= 0) rows[idx] = { ...rows[idx], ...updated };
        if (selectedEndpoint && selectedEndpoint.id === editingId) {
          selectedEndpoint = rows[idx] || updated;
        }
        resetEndpointForm();
        formWrap.style.display = 'none';
        renderEndpointsList();
        renderModelPanel();
        return;
      }
      const endpoint = await api('endpoints', {
        method: 'POST',
        body: JSON.stringify({
          name,
          baseUrl,
          protocol: 'openai',
          apiKey: apiKeyValue || undefined,
          headers,
          allowPrivate: true
        })
      });

      resetEndpointForm();
      rows.push(endpoint);
      selectedEndpoint = endpoint;
      formWrap.style.display = 'none';

      renderEndpointsList();
      renderModelPanel();
    } catch (e) {
      error(parent, e);
    } finally {
      saveBtn.disabled = false;
    }
  };

  renderEndpointsList();
  renderModelPanel();
}