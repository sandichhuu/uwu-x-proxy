// Modal Popup implementation for Add Account (Google Antigravity & OpenAI Codex)
// Matches reference projects (antigravity-claude-proxy & codex-claude-proxy)

export function openAddAccountModal(provider, { api, el, error, connected }) {
  const isGoogle = provider === 'google';
  let flow = null;
  let timer = null;
  let ended = false;
  let generation = 0;
  const terminal = new Set(['completed', 'failed', 'expired', 'cancelled']);

  // Create Modal Overlay
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const box = document.createElement('div');
  box.className = 'modal-box';
  backdrop.appendChild(box);

  function closeModal() {
    ended = true;
    clearTimeout(timer);
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

  function renderHeader() {
    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('h3');
    title.textContent = isGoogle ? 'Add Google Account' : 'Add ChatGPT Account';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = closeModal;
    header.appendChild(closeBtn);

    return header;
  }

  function renderMainView() {
    box.replaceChildren();
    box.appendChild(renderHeader());

    const desc = document.createElement('p');
    desc.className = 'modal-desc';
    desc.textContent = isGoogle
      ? 'Connect a Google Workspace account to increase your API quota limit. The account will be used to proxy Claude and Gemini requests via Antigravity.'
      : 'Connect a ChatGPT account to use with the proxy. The account will be used for API calls via Codex Responses.';
    box.appendChild(desc);

    const feedbackArea = document.createElement('div');
    box.appendChild(feedbackArea);

    // Primary Action Button (Browser OAuth)
    const primaryBtn = document.createElement('button');
    primaryBtn.className = 'oauth-primary-btn';
    if (isGoogle) {
      primaryBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        <span>Connect Google Account</span>
      `;
    } else {
      primaryBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
        </svg>
        <span>Connect via OAuth</span>
      `;
    }
    primaryBtn.onclick = () => startBrowserFlow(feedbackArea);
    box.appendChild(primaryBtn);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'modal-divider';
    divider.textContent = 'OR';
    box.appendChild(divider);

    // Collapsible Manual Authorization (Headless)
    const manualDetails = document.createElement('details');
    manualDetails.className = 'collapsible-section';
    const manualSummary = document.createElement('summary');
    manualSummary.textContent = 'Manual Authorization (Headless)';
    manualDetails.appendChild(manualSummary);

    const manualBody = document.createElement('div');
    manualBody.className = 'collapsible-body';
    manualBody.textContent = 'Click to initialize headless login URL...';
    manualDetails.appendChild(manualBody);

    let manualLoaded = false;
    manualDetails.addEventListener('toggle', async () => {
      if (manualDetails.open && !manualLoaded) {
        manualLoaded = true;
        manualBody.textContent = 'Generating authorization URL...';
        try {
          const mFlow = await api(`accounts/${provider}/oauth/start`, {
            method: 'POST',
            body: JSON.stringify({ mode: 'manual' })
          });
          renderManualControls(manualBody, mFlow);
        } catch (e) {
          manualBody.textContent = `Error: ${e.message}`;
        }
      }
    });
    box.appendChild(manualDetails);

    // Provider Specific Options: Import from local Codex / CLI Command
    if (!isGoogle) {
      const codexDivider = document.createElement('div');
      codexDivider.className = 'modal-divider';
      codexDivider.textContent = 'OR';
      box.appendChild(codexDivider);

      const importBtn = document.createElement('button');
      importBtn.className = 'oauth-secondary-btn';
      importBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <span>Import from Codex App (~/.codex/auth.json)</span>
      `;
      importBtn.onclick = async () => {
        importBtn.disabled = true;
        feedbackArea.replaceChildren();
        try {
          const res = await api('accounts/openai/import-codex', { method: 'POST' });
          const successMsg = document.createElement('p');
          successMsg.className = 'pill good';
          successMsg.style.display = 'block';
          successMsg.style.margin = '10px 0';
          successMsg.textContent = res.message || 'Successfully imported Codex account!';
          feedbackArea.appendChild(successMsg);
          setTimeout(() => {
            closeModal();
            connected();
          }, 600);
        } catch (err) {
          error(feedbackArea, err);
          importBtn.disabled = false;
        }
      };
      box.appendChild(importBtn);

      const importNote = document.createElement('p');
      importNote.className = 'muted';
      importNote.style.marginTop = '6px';
      importNote.textContent = 'Reads CODEX_HOME/auth.json or ~/.codex/auth.json on the machine running x-proxy. Original files are never modified.';
      box.appendChild(importNote);
    } else {
      const cliDetails = document.createElement('details');
      cliDetails.className = 'collapsible-section';
      const cliSummary = document.createElement('summary');
      cliSummary.textContent = 'Use CLI Command';
      cliDetails.appendChild(cliSummary);

      const cliBody = document.createElement('div');
      cliBody.className = 'collapsible-body';
      cliBody.innerHTML = `
        <p class="muted" style="margin:0 0 8px;">Run this command in your terminal to authorize with browser or headless prompt:</p>
        <div style="font-family:monospace;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;">
          <code>npm run accounts:add</code>
        </div>
      `;
      cliDetails.appendChild(cliBody);
      box.appendChild(cliDetails);
    }

    // Modal Footer
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = 'Close';
    cancelBtn.onclick = closeModal;
    footer.appendChild(cancelBtn);
    box.appendChild(footer);
  }

  function renderManualControls(container, mFlow) {
    container.replaceChildren();

    const p1 = document.createElement('p');
    p1.className = 'muted';
    p1.style.margin = '0 0 6px';
    p1.textContent = '1. Open this URL on any device and complete sign in:';
    container.appendChild(p1);

    const urlRow = document.createElement('div');
    urlRow.className = 'copy-url-row';
    const urlInput = document.createElement('input');
    urlInput.readOnly = true;
    urlInput.value = mFlow.authorizationUrl;
    urlInput.onclick = () => urlInput.select();
    urlRow.appendChild(urlInput);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'secondary sm';
    copyBtn.textContent = 'Copy URL';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(mFlow.authorizationUrl);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 2000);
      } catch {
        urlInput.select();
      }
    };
    urlRow.appendChild(copyBtn);

    const openLink = document.createElement('a');
    openLink.href = mFlow.authorizationUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.className = 'pill';
    openLink.style.textDecoration = 'none';
    openLink.textContent = 'Open ->';
    urlRow.appendChild(openLink);
    container.appendChild(urlRow);

    const p2 = document.createElement('p');
    p2.className = 'muted';
    p2.style.margin = '10px 0 6px';
    p2.textContent = '2. After signing in, paste the entire redirected URL or code:';
    container.appendChild(p2);

    const form = document.createElement('form');
    form.className = 'oauth-callback-form';
    const callbackInput = document.createElement('input');
    callbackInput.placeholder = 'http://localhost:.../callback?code=...';
    callbackInput.required = true;
    form.appendChild(callbackInput);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'primary sm';
    submitBtn.textContent = 'Complete sign-in';
    form.appendChild(submitBtn);

    const formFeedback = document.createElement('div');
    form.appendChild(formFeedback);

    form.onsubmit = async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      formFeedback.replaceChildren();
      try {
        const res = await api(`accounts/${provider}/oauth/complete`, {
          method: 'POST',
          body: JSON.stringify({
            callbackInput: callbackInput.value.trim(),
            state: mFlow.state
          })
        });
        const msg = document.createElement('p');
        msg.className = 'pill good';
        msg.style.display = 'block';
        msg.style.margin = '8px 0';
        msg.textContent = res.message || 'Account successfully authorized!';
        formFeedback.appendChild(msg);
        setTimeout(() => {
          closeModal();
          connected();
        }, 600);
      } catch (err) {
        error(formFeedback, err);
        submitBtn.disabled = false;
      }
    };

    container.appendChild(form);
  }

  async function startBrowserFlow(feedbackArea) {
    const token = ++generation;
    ended = false;
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;

    try {
      flow = await api(`accounts/${provider}/oauth/start`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'browser' })
      });
      if (popup) popup.location.href = flow.authorizationUrl;
      renderWaitingView(token, flow);
      poll(token);
    } catch (err) {
      if (popup) popup.close();
      error(feedbackArea, err);
    }
  }

  function renderWaitingView(token, currentFlow) {
    box.replaceChildren();
    box.appendChild(renderHeader());

    const waitingBox = document.createElement('div');
    waitingBox.className = 'oauth-waiting';

    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    waitingBox.appendChild(spinner);

    const waitTitle = document.createElement('strong');
    waitTitle.style.fontSize = '16px';
    waitTitle.textContent = 'Waiting for sign-in...';
    waitingBox.appendChild(waitTitle);

    const waitDesc = document.createElement('p');
    waitDesc.className = 'muted';
    waitDesc.style.margin = '0';
    waitDesc.textContent = 'Please complete the authorization in the browser window. This popup will close automatically when done.';
    waitingBox.appendChild(waitDesc);

    const waitStatus = document.createElement('p');
    waitStatus.className = 'stat-note';
    waitStatus.id = 'oauth-poll-status';
    waitStatus.textContent = 'Polling for callback...';
    waitingBox.appendChild(waitStatus);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '10px';
    actions.style.marginTop = '12px';

    const cancelAuthBtn = document.createElement('button');
    cancelAuthBtn.className = 'secondary sm';
    cancelAuthBtn.textContent = 'Cancel Authorization';
    cancelAuthBtn.onclick = async () => {
      cancelAuthBtn.disabled = true;
      try {
        await api(`accounts/${provider}/oauth/cancel`, {
          method: 'POST',
          body: JSON.stringify({ state: currentFlow.state })
        });
      } catch {}
      ended = true;
      clearTimeout(timer);
      renderMainView();
    };
    actions.appendChild(cancelAuthBtn);

    waitingBox.appendChild(actions);

    // Collapsible fallback for manual callback paste
    const manualPaste = document.createElement('details');
    manualPaste.className = 'collapsible-section';
    manualPaste.style.width = '100%';
    manualPaste.style.textAlign = 'left';
    manualPaste.style.marginTop = '16px';
    const manualPasteSummary = document.createElement('summary');
    manualPasteSummary.textContent = "Browser didn't redirect? Paste callback URL";
    manualPaste.appendChild(manualPasteSummary);

    const pasteBody = document.createElement('div');
    pasteBody.className = 'collapsible-body';
    renderManualControls(pasteBody, currentFlow);
    manualPaste.appendChild(pasteBody);
    waitingBox.appendChild(manualPaste);

    box.appendChild(waitingBox);
  }

  async function poll(token) {
    if (ended || token !== generation) return;
    try {
      const result = await api(`accounts/${provider}/oauth/status?state=${encodeURIComponent(flow.state)}`);
      if (ended || token !== generation) return;

      const statusEl = box.querySelector('#oauth-poll-status');
      if (statusEl) {
        statusEl.textContent = result.status === 'exchanging'
          ? 'Exchanging code and storing credentials...'
          : 'Waiting for sign-in confirmation...';
      }

      if (terminal.has(result.status)) {
        ended = true;
        clearTimeout(timer);
        if (result.status === 'completed') {
          box.replaceChildren();
          box.appendChild(renderHeader());
          const successBox = document.createElement('div');
          successBox.className = 'oauth-waiting';
          const badge = document.createElement('div');
          badge.className = 'pill good';
          badge.style.fontSize = '14px';
          badge.style.padding = '8px 16px';
          badge.textContent = '[ok] Account connected successfully!';
          successBox.appendChild(badge);
          box.appendChild(successBox);
          setTimeout(() => {
            closeModal();
            connected();
          }, 700);
          return;
        } else {
          renderMainView();
          const errP = document.createElement('p');
          errP.className = 'pill error';
          errP.style.margin = '10px 0';
          errP.textContent = result.message || `Sign-in ended with status: ${result.status}`;
          box.querySelector('.modal-desc')?.after(errP);
          return;
        }
      }

      timer = setTimeout(() => poll(token), 1200);
    } catch (e) {
      ended = true;
      clearTimeout(timer);
      renderMainView();
      const errP = document.createElement('p');
      errP.className = 'pill error';
      errP.style.margin = '10px 0';
      errP.textContent = e.message;
      box.querySelector('.modal-desc')?.after(errP);
    }
  }

  // Initial render & attach to DOM
  renderMainView();
  document.body.appendChild(backdrop);
}

// Backward compatibility wrapper
export function oauthPanel(parent, provider, { api, el, error, connected }) {
  const box = el('div', undefined, parent, 'oauth-panel');
  const btn = el('button', `+ Add ${provider === 'google' ? 'Google' : 'OpenAI'} Account`, box, 'primary');
  btn.onclick = () => openAddAccountModal(provider, { api, el, error, connected });
}

