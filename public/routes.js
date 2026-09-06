import { toggleSwitch } from './model-dict.js';

export function routesPanel(parent, { api, el, error }) {
  let routes = [];
  let selectedRoute = null;

  const header = el('div', undefined, parent, 'card-header');
  el('h2', 'API Routes', header);

  const headerActions = el('div', undefined, header, 'tabs');
  headerActions.style.marginBottom = '0';
  const autoMapBtn = el('button', 'Auto Map', headerActions, 'primary');
  const addRouteBtn = el('button', '+ Add Route', headerActions);
  const removeAllBtn = el('button', 'Remove All', headerActions, 'danger sm');

  const feedback = el('div', undefined, parent);
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

  // Add Route Form Container (toggleable)
  const formWrap = el('div', undefined, parent);
  formWrap.style.display = 'none';

  const form = el('form', undefined, formWrap, 'connection-form');
  el('h3', 'Add New API Route', form);

  function field(label, type, placeholder, required = false) {
    const wrap = el('label', label, form), input = el('input', undefined, wrap);
    input.type = type; input.placeholder = placeholder; input.required = required; return input;
  }

  const nameInput = field('Route / Public Model ID', 'text', 'e.g. gemini-3.8-flash', true);

  const wrapMode = el('label', 'Routing Mode', form);
  const modeSelect = el('select', undefined, wrapMode);
  const optMap = el('option', 'Map Model + Effort (Strip reasoning effort)', modeSelect);
  optMap.value = 'variant';
  const optFwd = el('option', 'Forward (Map model name; preserve reasoning effort)', modeSelect);
  optFwd.value = 'forward';

  const wrapProv = el('label', 'Target Provider / Source', form);
  const provSelect = el('select', undefined, wrapProv);

  const upstreamInput = field('Base Upstream Model ID', 'text', 'e.g. gemini-3.8-flash-medium', true);

  const formActions = el('div', undefined, form, 'tabs');
  formActions.style.marginBottom = '0';
  const saveBtn = el('button', 'Save route', formActions, 'primary');
  saveBtn.type = 'submit';
  const cancelBtn = el('button', 'Cancel', formActions);
  cancelBtn.type = 'button';

  cancelBtn.onclick = () => {
    formWrap.style.display = 'none';
  };

  addRouteBtn.onclick = () => {
    formWrap.style.display = formWrap.style.display === 'none' ? 'block' : 'none';
    if (formWrap.style.display === 'block') {
      nameInput.value = '';
      upstreamInput.value = '';
      modeSelect.value = 'variant';
      nameInput.focus();
    }
  };

  const listContainer = el('div', undefined, parent);
  const mappingPanel = el('div', undefined, parent);

  async function loadRoutes() {
    try {
      const [allModels, endpoints] = await Promise.all([
        api('routes'),
        api('endpoints').catch(() => [])
      ]);
      routes = allModels;

      // Update provider dropdown options
      provSelect.replaceChildren();
      const gOpt = el('option', 'Google Antigravity (Google Account)', provSelect);
      gOpt.value = 'google';
      const oOpt = el('option', 'OpenAI Codex (ChatGPT Account)', provSelect);
      oOpt.value = 'openai';
      for (const ep of endpoints) {
        const epOpt = el('option', 'Endpoint: ' + ep.name + ' (' + ep.baseUrl + ')', provSelect);
        epOpt.value = 'endpoint:' + ep.id;
      }

      if (routes.length > 0) {
        if (!selectedRoute || !routes.some(r => r.id === selectedRoute.id)) {
          selectedRoute = routes[0];
        } else {
          selectedRoute = routes.find(r => r.id === selectedRoute.id) || routes[0];
        }
      } else {
        selectedRoute = null;
      }

      renderRoutesList();
      renderMappingPanel();
    } catch (e) {
      setFeedback(e, true);
    }
  }

  function renderRoutesList() {
    listContainer.replaceChildren();

    if (routes.length === 0) {
      el('p', 'No API routes configured yet. Click "Auto Map" to automatically group models by effort, or "+ Add Route" to add your first route.', listContainer, 'muted');
      return;
    }

    const wrap = el('div', undefined, listContainer, 'table-wrap');
    const tbl = el('table', undefined, wrap);
    const thead = el('thead', undefined, tbl);
    const trHead = el('tr', undefined, thead);
    el('th', 'Status', trHead);
    el('th', 'Public Model ID', trHead);
    el('th', 'Mode', trHead);
    el('th', 'Target Provider / Upstream', trHead);
    el('th', 'Actions', trHead);

    const tbody = el('tbody', undefined, tbl);
    for (const r of routes) {
      const tr = el('tr', undefined, tbody);
      const isSelected = selectedRoute && selectedRoute.id === r.id;
      tr.style.cursor = 'pointer';
      tr.style.transition = 'background-color 0.15s';
      if (isSelected) {
        tr.style.backgroundColor = '#fdf4ea';
      }

      // Row click: selects this route and highlights row
      tr.onclick = () => {
        selectedRoute = r;
        renderRoutesList();
        renderMappingPanel();
      };

      // Status Toggle (Enable / Disable)
      const tdStatus = el('td', undefined, tr);
      const isEnabled = r.enabled !== false;
      const toggle = toggleSwitch({
        checked: isEnabled,
        ariaLabel: 'Enable or disable route ' + r.id,
        label: isEnabled ? 'Enabled' : 'Disabled',
        onChange: async (newChecked) => {
          try {
            await api('routes/' + encodeURIComponent(r.id), {
              method: 'PATCH',
              body: JSON.stringify({ enabled: newChecked })
            });
            r.enabled = newChecked;
            const labelEl = toggle.querySelector('.toggle-label');
            if (labelEl) labelEl.textContent = newChecked ? 'Enabled' : 'Disabled';
          } catch (e) {
            setFeedback(e, true);
            throw e;
          }
        }
      });
      toggle.onclick = (e) => e.stopPropagation();
      tdStatus.appendChild(toggle);

      // Public Model ID
      const tdName = el('td', undefined, tr);
      const codeName = el('code', r.id, tdName, 'model-meta-val');
      codeName.style.fontWeight = '600';
      codeName.style.fontSize = '13px';

      // Mode
      const tdMode = el('td', undefined, tr);
      const isVariant = r.effort?.mode === 'variant';
      if (isVariant) {
        el('span', 'Map Effort (Strip none)', tdMode, 'pill');
      } else {
        el('span', 'Forwards (As-Is)', tdMode, 'pill muted-pill');
      }

      // Target Provider / Upstream
      const tdTarget = el('td', undefined, tr);
      const provName = r.provider ? (r.provider.startsWith('google') ? 'Google' : 'OpenAI') : (r.endpointId ? 'API Endpoint' : 'Custom');
      el('span', provName + ': ' + r.upstreamId, tdTarget);

      // Actions: Delete only (row click handles selection)
      const tdActions = el('td', undefined, tr);
      const btnGroup = el('div', undefined, tdActions);
      btnGroup.style.display = 'flex';
      btnGroup.style.gap = '6px';
      btnGroup.style.alignItems = 'center';

      const deleteBtn = el('button', 'Delete', btnGroup, 'sm danger');
      deleteBtn.title = 'Delete route ' + r.id;
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('Are you sure you want to delete route "' + r.id + '"?')) return;
        deleteBtn.disabled = true;
        try {
          await api('routes/' + encodeURIComponent(r.id), { method: 'DELETE' });
          const idx = routes.indexOf(r);
          if (idx >= 0) routes.splice(idx, 1);
          if (selectedRoute && selectedRoute.id === r.id) {
            selectedRoute = routes[0] || null;
          }
          renderRoutesList();
          renderMappingPanel();
          setFeedback('Deleted route "' + r.id + '".');
        } catch (e) {
          setFeedback(e, true);
          deleteBtn.disabled = false;
        }
      };
    }
  }

  function renderMappingPanel() {
    mappingPanel.replaceChildren();
    if (!selectedRoute) {
      el('p', 'Click any route above to view and customize its effort mappings.', mappingPanel, 'muted');
      return;
    }

    const isVariant = selectedRoute.effort?.mode === 'variant';

    const section = el('section', undefined, mappingPanel, 'dict-section');
    const head = el('div', undefined, section, 'dict-header');
    const titles = el('div', undefined, head);
    el('h3', 'Effort Mappings - ' + selectedRoute.id, titles);

    const subText = isVariant
      ? 'Grouped models by effort. Incoming requests with an effort level are routed to the corresponding model with effort parameter stripped (none).'
      : 'Forward mode. The model name is mapped to one existing model card. Reasoning effort is forwarded unchanged and is never defaulted, normalized, or filtered.';
    el('p', subText, titles, 'muted');

    const actions = el('div', undefined, head, 'dict-actions');

    if (isVariant) {
      // Default effort selector
      const defWrap = el('label', 'Default Effort: ', actions);
      defWrap.style.fontSize = '12px';
      defWrap.style.display = 'flex';
      defWrap.style.alignItems = 'center';
      defWrap.style.gap = '6px';
      const defSelect = el('select', undefined, defWrap, 'sm-select');

      const effortLevels = ['low', 'medium', 'high', 'xhigh'];
      effortLevels.forEach(eff => {
        const opt = el('option', eff, defSelect);
        opt.value = eff;
      });
      defSelect.value = selectedRoute.effort?.default || 'medium';

      defSelect.onchange = async () => {
        defSelect.disabled = true;
        try {
          selectedRoute.effort = { ...selectedRoute.effort, default: defSelect.value };
          await api('routes/' + encodeURIComponent(selectedRoute.id), {
            method: 'PATCH',
            body: JSON.stringify({ effort: selectedRoute.effort })
          });
          setFeedback('Default effort for "' + selectedRoute.id + '" set to "' + defSelect.value + '".');
        } catch (e) {
          setFeedback(e, true);
        } finally {
          defSelect.disabled = false;
        }
      };

      // Add Mapping button
      const addMappingBtn = el('button', '+ Add Effort Mapping', actions, 'secondary sm');
      addMappingBtn.onclick = () => {
        const variantMap = selectedRoute.effort?.variants || selectedRoute.variants || {};
        const eff = prompt('Enter effort level (e.g. low, medium, high, xhigh, minimal, ultra):');
        if (!eff || !eff.trim()) return;
        const trimmedEff = eff.trim().toLowerCase();
        const targetMod = prompt('Enter target upstream model for effort "' + trimmedEff + '":', selectedRoute.id + '-' + trimmedEff);
        if (!targetMod || !targetMod.trim()) return;

        variantMap[trimmedEff] = targetMod.trim();
        const supported = Array.from(new Set([...(selectedRoute.effort?.supported || []), trimmedEff]));
        selectedRoute.variants = { ...variantMap };
        selectedRoute.effort = {
          ...selectedRoute.effort,
          mode: 'variant',
          supported,
          variants: { ...variantMap }
        };

        api('routes/' + encodeURIComponent(selectedRoute.id), {
          method: 'PATCH',
          body: JSON.stringify({
            effort: selectedRoute.effort,
            variants: selectedRoute.variants
          })
        }).then(() => {
          renderMappingPanel();
          setFeedback('Added mapping: ' + trimmedEff + ' -> ' + targetMod.trim());
        }).catch(e => setFeedback(e, true));
      };

      // Key-Value Table for Effort Mappings
      const tableWrap = el('div', undefined, section, 'table-wrap');
      const tbl = el('table', undefined, tableWrap, 'dict-table');
      const thead = el('thead', undefined, tbl);
      const trHead = el('tr', undefined, thead);
      el('th', 'Map Effort', trHead);
      el('th', 'Effort Level (Key)', trHead);
      el('th', 'Target Upstream Model (Value)', trHead);
      el('th', 'Outgoing Effort', trHead);
      el('th', 'Action', trHead);

      const tbody = el('tbody', undefined, tbl);
      const variantMap = selectedRoute.effort?.variants || selectedRoute.variants || {};
      const entries = Object.entries(variantMap);

      if (entries.length === 0) {
        const emptyRow = el('tr', undefined, tbody);
        const td = el('td', 'No effort mappings defined. Click "+ Add Effort Mapping" or "Auto Map" to begin.', emptyRow, 'muted');
        td.colSpan = 5;
        td.style.textAlign = 'center';
        td.style.padding = '20px';
        return;
      }

      entries.forEach(([eff, targetMod]) => {
        const row = el('tr', undefined, tbody);

        // Column 1: Map Effort Toggle
        const tdToggle = el('td', undefined, row);
        const toggle = toggleSwitch({
          checked: true,
          ariaLabel: 'Map effort ' + eff + ' to ' + targetMod,
          label: 'Mapped',
          onChange: async (newChecked) => {
            if (!newChecked) {
              delete variantMap[eff];
              selectedRoute.variants = { ...variantMap };
              selectedRoute.effort.variants = { ...variantMap };
              selectedRoute.effort.supported = Object.keys(variantMap);
              await api('routes/' + encodeURIComponent(selectedRoute.id), {
                method: 'PATCH',
                body: JSON.stringify({
                  effort: selectedRoute.effort,
                  variants: selectedRoute.variants
                })
              });
              renderMappingPanel();
              setFeedback('Unmapped effort "' + eff + '".');
            }
          }
        });
        tdToggle.appendChild(toggle);

        // Column 2: Effort Level (Key)
        const tdKey = el('td', undefined, row);
        const keySpan = el('span', eff, tdKey, 'pill variant-pill');
        keySpan.style.fontSize = '12px';
        keySpan.style.fontWeight = '600';

        // Column 3: Target Upstream Model (Value)
        const tdVal = el('td', undefined, row);
        const inputVal = el('input', undefined, tdVal, 'dict-input');
        inputVal.value = targetMod;
        inputVal.placeholder = 'e.g. ' + selectedRoute.id + '-' + eff;

        inputVal.onchange = async () => {
          const newVal = inputVal.value.trim();
          if (!newVal) {
            inputVal.value = targetMod;
            return;
          }
          variantMap[eff] = newVal;
          selectedRoute.variants = { ...variantMap };
          selectedRoute.effort.variants = { ...variantMap };
          try {
            await api('routes/' + encodeURIComponent(selectedRoute.id), {
              method: 'PATCH',
              body: JSON.stringify({
                effort: selectedRoute.effort,
                variants: selectedRoute.variants
              })
            });
            setFeedback('Updated mapping: ' + eff + ' -> ' + newVal);
          } catch (e) {
            setFeedback(e, true);
          }
        };

        // Column 4: Outgoing effort
        const tdSent = el('td', undefined, row);
        const badgeNone = el('span', 'none', tdSent, 'pill muted-pill');
        badgeNone.title = 'Effort parameter is stripped from payload before sending to upstream provider';

        // Column 5: Remove Row Action
        const tdAction = el('td', undefined, row);
        const removeBtn = el('button', 'x', tdAction, 'sm danger');
        removeBtn.title = 'Remove mapping for "' + eff + '"';
        removeBtn.onclick = async () => {
          delete variantMap[eff];
          selectedRoute.variants = { ...variantMap };
          selectedRoute.effort.variants = { ...variantMap };
          selectedRoute.effort.supported = Object.keys(variantMap);
          try {
            await api('routes/' + encodeURIComponent(selectedRoute.id), {
              method: 'PATCH',
              body: JSON.stringify({
                effort: selectedRoute.effort,
                variants: selectedRoute.variants
              })
            });
            renderMappingPanel();
            setFeedback('Removed mapping for "' + eff + '".');
          } catch (e) {
            setFeedback(e, true);
          }
        };
      });
    } else {
      // Forward Mode Panel
      const fwdBox = el('div', undefined, section, 'route-forward-section');
      el('h4', 'Forward Mode Configuration', fwdBox);
      el('p', 'The public model name is mapped to the target model card. All client options, including reasoning_effort, are forwarded unchanged.', fwdBox, 'muted');

      const metaRow = el('div', undefined, fwdBox, 'model-meta-row');
      el('span', 'Target Upstream Model', metaRow);
      const codeUp = el('code', selectedRoute.upstreamId || selectedRoute.id, metaRow, 'model-meta-val');
      codeUp.style.fontWeight = '600';

      const noteRow = el('div', undefined, fwdBox, 'model-meta-row');
      el('span', 'Reasoning Effort', noteRow);
      el('span', 'Forwarded unchanged (sent as-is)', noteRow, 'model-meta-val');
    }
  }

  // Form Submit Handler
  form.onsubmit = async (event) => {
    event.preventDefault();
    saveBtn.disabled = true;
    try {
      const publicId = nameInput.value.trim();
      const baseUpstream = upstreamInput.value.trim();
      const mode = modeSelect.value;
      const provVal = provSelect.value;

      let provider = undefined;
      let endpointId = undefined;
      if (provVal.startsWith('endpoint:')) {
        endpointId = provVal.replace('endpoint:', '');
      } else {
        provider = provVal;
      }

      let effortConfig;
      let variants = undefined;

      if (mode === 'variant') {
        variants = {
          low: publicId + '-low',
          medium: publicId + '-medium',
          high: publicId + '-high',
          xhigh: publicId + '-tiered'
        };
        effortConfig = {
          mode: 'variant',
          default: 'medium',
          supported: ['low', 'medium', 'high', 'xhigh'],
          variants
        };
      } else {
        effortConfig = {
          mode: 'forward',
          supported: []
        };
      }

      await api('routes', {
        method: 'POST',
        body: JSON.stringify({
          id: publicId,
          name: publicId,
          provider,
          endpointId,
          upstreamId: baseUpstream,
          effort: effortConfig,
          variants,
          enabled: true
        })
      });

      formWrap.style.display = 'none';
      await loadRoutes();
      selectedRoute = routes.find(r => r.id === publicId) || selectedRoute;
      renderRoutesList();
      renderMappingPanel();
      setFeedback('Route "' + publicId + '" created successfully.');
    } catch (e) {
      setFeedback(e, true);
    } finally {
      saveBtn.disabled = false;
    }
  };

  // Auto Map Button Handler
  autoMapBtn.onclick = async () => {
    autoMapBtn.disabled = true;
    const origText = autoMapBtn.textContent;
    autoMapBtn.textContent = 'Mapping...';
    setFeedback('');

    try {
      const res = await api('routes/auto-map', { method: 'POST' });
      await loadRoutes();
      setFeedback('Auto-mapped ' + (res.count || 8) + ' API routes successfully.');
    } catch (e) {
      setFeedback(e, true);
    } finally {
      autoMapBtn.disabled = false;
      autoMapBtn.textContent = origText;
    }
  };

  // Remove All Button Handler
  removeAllBtn.onclick = async () => {
    if (routes.length === 0) return;
    if (!confirm('Are you sure you want to remove all API routes?')) return;
    removeAllBtn.disabled = true;
    setFeedback('');

    try {
      for (const r of [...routes]) {
        try {
          await api('routes/' + encodeURIComponent(r.id), { method: 'DELETE' });
        } catch (e) {}
      }
      routes = [];
      selectedRoute = null;
      renderRoutesList();
      renderMappingPanel();
      setFeedback('All API routes removed. Click "Auto Map" to restore default routes.');
    } catch (e) {
      setFeedback(e, true);
    } finally {
      removeAllBtn.disabled = false;
    }
  };

  // Initial load
  loadRoutes();
}