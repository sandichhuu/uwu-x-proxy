// Inference Chat Tab for uwu-x-proxy
const STORAGE_KEY_MESSAGES = 'uwu_chat_messages_v1';
const STORAGE_KEY_MODEL = 'uwu_chat_model_v1';
const STORAGE_KEY_EFFORT = 'uwu_chat_effort_v1';
const STORAGE_KEY_SYSTEM = 'uwu_chat_system_v1';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(raw) {
  if (!raw) return '';
  let text = String(raw);
  const codeBlocks = [];
  const codeRegex = new RegExp('```([\\w-]*)\\s*\\n?([\\s\\S]*?)```', 'g');
  text = text.replace(codeRegex, (match, lang, code) => {
    const token = '__CODE_BLOCK_' + codeBlocks.length + '__';
    codeBlocks.push({ lang: lang.trim().toLowerCase() || 'code', code: code.replace(/\n$/, '') });
    return token;
  });
  const inlineCodes = [];
  const inlineRegex = new RegExp('`([^`\\n]+)`', 'g');
  text = text.replace(inlineRegex, (match, code) => {
    const token = '__INLINE_CODE_' + inlineCodes.length + '__';
    inlineCodes.push(code);
    return token;
  });
  text = escapeHtml(text);
  text = text.replace(/^### (.*?)$/gm, '<h4 class="chat-h3">$1</h4>');
  text = text.replace(/^## (.*?)$/gm, '<h3 class="chat-h2">$1</h3>');
  text = text.replace(/^# (.*?)$/gm, '<h2 class="chat-h1">$1</h2>');
  text = text.replace(/^> (.*?)$/gm, '<blockquote class="chat-blockquote">$1</blockquote>');
  text = text.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.*?)__/g, '<strong>$1</strong>');
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  text = text.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  text = text.replace(/~~(.*?)~~/g, '<del>$1</del>');
  text = text.replace(/^(\s*)[-*+] (.*?)$/gm, (m, indent, item) => indent + '<li class="chat-li">' + item + '</li>');
  text = text.replace(/((?:<li class="chat-li">.*?<\/li>\s*)+)/g, '<ul class="chat-ul">$1</ul>');
  text = text.replace(/^(\s*)\d+\.\s+(.*?)$/gm, (m, indent, item) => indent + '<li class="chat-oli">' + item + '</li>');
  text = text.replace(/((?:<li class="chat-oli">.*?<\/li>\s*)+)/g, '<ol class="chat-ol">$1</ol>');
  text = text.replace(/\n{2,}/g, '</p><p class="chat-p">');
  text = text.replace(/\n/g, '<br>');
  text = '<p class="chat-p">' + text + '</p>';
  text = text.replace(/<p class="chat-p"><\/p>/g, '');
  text = text.replace(/<p class="chat-p">(<(?:h[1-4]|blockquote|ul|ol|pre)[^>]*>[\\s\\S]*?<\/(?:h[1-4]|blockquote|ul|ol|pre)>)<\/p>/g, '$1');
  inlineCodes.forEach((code, idx) => {
    text = text.replace('__INLINE_CODE_' + idx + '__', '<code class="chat-inline-code">' + escapeHtml(code) + '</code>');
  });
  codeBlocks.forEach((block, idx) => {
    const escapedCode = escapeHtml(block.code);
    const htmlBlock = '<div class="chat-code-block">' +
      '<div class="chat-code-header">' +
        '<span class="chat-code-lang">' + escapeHtml(block.lang) + '</span>' +
        '<button type="button" class="chat-copy-code-btn" data-code="' + encodeURIComponent(block.code) + '">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg> Copy' +
        '</button>' +
      '</div>' +
      '<pre class="chat-code-pre"><code class="chat-code-content">' + escapedCode + '</code></pre>' +
    '</div>';
    text = text.replace('__CODE_BLOCK_' + idx + '__', htmlBlock);
  });
  return text;
}

export function inferencePanel(parent, { api, el, error }) {
  let messages = [];
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY_MESSAGES);
    if (saved) messages = JSON.parse(saved);
  } catch {}

  let savedModel = sessionStorage.getItem(STORAGE_KEY_MODEL) || '';
  let savedEffort = sessionStorage.getItem(STORAGE_KEY_EFFORT) || 'default';
  let systemPrompt = sessionStorage.getItem(STORAGE_KEY_SYSTEM) || '';

  let availableModels = [];
  let selectedModelId = savedModel;
  let selectedEffort = savedEffort;
  let isGenerating = false;
  let currentAbortController = null;
  let showSystemDrawer = !!systemPrompt;

  const container = el('div', undefined, parent, 'inference-view');

  // Top Bar
  const topbar = el('div', undefined, container, 'chat-topbar');
  const modelControls = el('div', undefined, topbar, 'chat-model-controls');

  // Model Selector
  const modelSelectWrap = el('div', undefined, modelControls, 'chat-select-group');
  const modelLabel = el('label', 'Model:', modelSelectWrap, 'chat-control-label');
  modelLabel.setAttribute('for', 'inference-model-select');
  const modelSelect = el('select', undefined, modelSelectWrap, 'chat-select model-select');
  modelSelect.id = 'inference-model-select';

  // Effort Selector
  const effortSelectWrap = el('div', undefined, modelControls, 'chat-select-group');
  const effortLabel = el('label', 'Reasoning:', effortSelectWrap, 'chat-control-label');
  effortLabel.setAttribute('for', 'inference-effort-select');
  const effortSelect = el('select', undefined, effortSelectWrap, 'chat-select effort-select');
  effortSelect.id = 'inference-effort-select';

  // Top Right Actions
  const topActions = el('div', undefined, topbar, 'chat-top-actions');

  const systemBtn = el('button', undefined, topActions, 'chat-action-btn sm');
  systemBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg><span>System Prompt</span>';
  systemBtn.title = 'Configure system instructions / prompt';

  const clearBtn = el('button', undefined, topActions, 'chat-action-btn sm');
  clearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>New Chat</span>';
  clearBtn.title = 'Clear current chat history';

  // System Drawer
  const systemDrawer = el('div', undefined, container, 'chat-system-drawer');
  systemDrawer.style.display = showSystemDrawer ? 'block' : 'none';

  const systemDrawerHeader = el('div', undefined, systemDrawer, 'chat-system-header');
  el('strong', 'System Instructions / Persona', systemDrawerHeader);
  const systemPresets = el('div', undefined, systemDrawerHeader, 'chat-presets');

  const presetDefault = el('button', 'Default', systemPresets, 'preset-btn sm');
  const presetCoder = el('button', 'Coding', systemPresets, 'preset-btn sm');
  const presetConcise = el('button', 'Concise', systemPresets, 'preset-btn sm');

  const systemTextarea = el('textarea', undefined, systemDrawer, 'chat-system-textarea');
  systemTextarea.placeholder = 'e.g. You are a helpful, knowledgeable AI assistant. Answer accurately and format code with syntax tags.';
  systemTextarea.value = systemPrompt;

  function updateSystem() {
    systemPrompt = systemTextarea.value.trim();
    try { sessionStorage.setItem(STORAGE_KEY_SYSTEM, systemPrompt); } catch {}
    systemBtn.classList.toggle('active', !!systemPrompt);
  }
  presetDefault.onclick = () => { systemTextarea.value = ''; updateSystem(); };
  presetCoder.onclick = () => { systemTextarea.value = 'You are an expert software engineer. Provide clean, secure, production-ready code with concise explanations.'; updateSystem(); };
  presetConcise.onclick = () => { systemTextarea.value = 'You are a direct, concise assistant. Answer questions directly without filler.'; updateSystem(); };
  systemTextarea.oninput = updateSystem;
  systemBtn.classList.toggle('active', !!systemPrompt);

  systemBtn.onclick = () => {
    showSystemDrawer = !showSystemDrawer;
    systemDrawer.style.display = showSystemDrawer ? 'block' : 'none';
    if (showSystemDrawer) systemTextarea.focus();
  };

  // Scrollable Messages Area
  const messagesScroll = el('div', undefined, container, 'chat-messages-area');
  const messagesWrap = el('div', undefined, messagesScroll, 'chat-messages-wrap');

  // Input Container
  const inputContainer = el('div', undefined, container, 'chat-input-container');
  const inputInner = el('div', undefined, inputContainer, 'chat-input-card');

  const inputToolbar = el('div', undefined, inputInner, 'chat-input-toolbar');
  const activeModelBadge = el('span', '', inputToolbar, 'chat-model-indicator');

  const inputRow = el('div', undefined, inputInner, 'chat-input-row');
  const textarea = el('textarea', undefined, inputRow, 'chat-textarea');
  textarea.placeholder = 'Send a message... (Enter to send, Shift+Enter for new line)';
  textarea.rows = 1;

  const actionBtnWrap = el('div', undefined, inputRow, 'chat-input-actions');
  const sendBtn = el('button', undefined, actionBtnWrap, 'chat-send-btn');
  sendBtn.type = 'button';
  sendBtn.setAttribute('aria-label', 'Send message');
  sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';

  const stopBtn = el('button', undefined, actionBtnWrap, 'chat-stop-btn');
  stopBtn.type = 'button';
  stopBtn.setAttribute('aria-label', 'Stop generating');
  stopBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>';
  stopBtn.style.display = 'none';

  const footerNotice = el('div', undefined, inputContainer, 'chat-disclaimer');
  footerNotice.textContent = 'uwu-x-proxy unified inference • Models may produce inaccurate information.';

  function autoResize() {
    textarea.style.height = 'auto';
    const nextH = Math.min(Math.max(textarea.scrollHeight, 42), 180);
    textarea.style.height = nextH + 'px';
  }
  textarea.addEventListener('input', autoResize);

  function persistMessages() {
    try {
      sessionStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(messages));
    } catch {}
  }

  function scrollToBottom(smooth = true) {
    requestAnimationFrame(() => {
      messagesScroll.scrollTo({
        top: messagesScroll.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
    });
  }

  function updateEffortOptions(model) {
    effortSelect.replaceChildren();
    if (!model) {
      effortSelectWrap.style.display = 'none';
      return;
    }

    const effortConfig = model.effort || {};
    const mode = effortConfig.mode;

    if (mode === 'variant') {
      effortSelectWrap.style.display = 'flex';
      const variants = effortConfig.supported || Object.keys(effortConfig.variants || model.variants || {});
      const defaultVal = effortConfig.default || 'medium';

      for (const v of variants) {
        const opt = el('option', v === defaultVal ? (v + ' (default)') : v, effortSelect);
        opt.value = v;
      }
      if (variants.includes(selectedEffort)) {
        effortSelect.value = selectedEffort;
      } else {
        effortSelect.value = defaultVal;
        selectedEffort = defaultVal;
      }
    } else if (mode === 'forward') {
      effortSelectWrap.style.display = 'flex';
      for (const [val, lbl] of [['default', 'Default (client)'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra High']]) {
        const opt = el('option', lbl, effortSelect);
        opt.value = val;
      }
      effortSelect.value = selectedEffort || 'default';
    } else {
      effortSelectWrap.style.display = 'none';
      selectedEffort = 'default';
    }
  }

  function updateActiveBadge() {
    const model = availableModels.find(m => m.id === selectedModelId);
    if (model) {
      activeModelBadge.textContent = model.name || model.id;
      activeModelBadge.title = 'Active model: ' + model.id;
      textarea.placeholder = 'Message ' + (model.name || model.id) + '... (Enter to send, Shift+Enter for new line)';
    } else {
      activeModelBadge.textContent = 'No model selected';
      textarea.placeholder = 'Select a model to start chatting...';
    }
  }

  function renderConversation() {
    messagesWrap.replaceChildren();

    if (messages.length === 0) {
      renderWelcomeState();
      return;
    }

    messages.forEach((msg, index) => {
      renderMessageRow(msg, index);
    });

    scrollToBottom(false);
  }

  function renderWelcomeState() {
    const welcome = el('div', undefined, messagesWrap, 'chat-welcome-box');

    const iconCircle = el('div', undefined, welcome, 'chat-welcome-icon');
    iconCircle.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

    el('h2', 'Welcome to Inference Chat', welcome, 'chat-welcome-title');
    el('p', 'Test and chat directly with your mapped models. Responses are streamed directly through uwu-x-proxy.', welcome, 'chat-welcome-sub');

    const cardsGrid = el('div', undefined, welcome, 'chat-starter-grid');
    const starters = [
      { icon: '💡', title: 'Explain a Concept', prompt: 'Explain quantum computing and superposition in simple, intuitive terms.' },
      { icon: '💻', title: 'Write Clean Code', prompt: 'Write an idiomatic TypeScript debounce function with TypeScript generics.' },
      { icon: '📝', title: 'Draft an Email', prompt: 'Draft a polite, professional email declining an invitation to speak at a conference.' },
      { icon: '⚡', title: 'Compare Technologies', prompt: 'Compare WebSockets vs Server-Sent Events (SSE): tradeoffs, latency, and ideal use cases.' }
    ];

    starters.forEach(item => {
      const cardBtn = el('button', undefined, cardsGrid, 'chat-starter-card');
      cardBtn.type = 'button';
      const cHeader = el('div', undefined, cardBtn, 'starter-header');
      el('span', item.icon, cHeader, 'starter-icon');
      el('strong', item.title, cHeader, 'starter-title');
      el('p', item.prompt, cardBtn, 'starter-prompt');

      cardBtn.onclick = () => {
        textarea.value = item.prompt;
        autoResize();
        textarea.focus();
      };
    });
  }

  function renderMessageRow(msg, index) {
    const isUser = msg.role === 'user';
    const row = el('div', undefined, messagesWrap, 'chat-row ' + (isUser ? 'user-row' : 'assistant-row'));
    row.dataset.index = index;

    const avatar = el('div', undefined, row, 'chat-avatar');
    if (isUser) {
      avatar.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
      avatar.title = 'You';
    } else {
      avatar.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><polyline points="12 22 12 15.5"/><polyline points="22 8.5 12 15.5 2 8.5"/></svg>';
      avatar.title = msg.model || selectedModelId || 'AI Assistant';
    }

    const bodyCard = el('div', undefined, row, 'chat-bubble ' + (isUser ? 'user-bubble' : 'assistant-bubble'));

    if (!isUser) {
      const bubbleHeader = el('div', undefined, bodyCard, 'chat-bubble-header');
      el('span', msg.model || selectedModelId || 'assistant', bubbleHeader, 'chat-model-tag');
      if (msg.timestamp) {
        const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        el('span', timeStr, bubbleHeader, 'chat-time-tag');
      }
    }

    if (!isUser && msg.thinking) {
      const thinkingDetails = el('details', undefined, bodyCard, 'chat-thinking-box');
      if (msg.loading) thinkingDetails.open = true;
      const summary = el('summary', undefined, thinkingDetails, 'chat-thinking-summary');
      summary.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg> <span>Thought Process</span>';
      const thinkingText = el('div', msg.thinking, thinkingDetails, 'chat-thinking-content');
      thinkingText.style.whiteSpace = 'pre-wrap';
    }

    const contentEl = el('div', undefined, bodyCard, 'chat-content-text');

    if (isUser) {
      contentEl.textContent = msg.content;
    } else {
      if (msg.content) {
        contentEl.innerHTML = renderMarkdown(msg.content);
      } else if (msg.loading) {
        const typingBox = el('div', undefined, contentEl, 'chat-typing-indicator');
        el('span', undefined, typingBox, 'typing-dot');
        el('span', undefined, typingBox, 'typing-dot');
        el('span', undefined, typingBox, 'typing-dot');
      }
    }

    if (msg.error) {
      const errBanner = el('div', undefined, bodyCard, 'chat-error-banner');
      errBanner.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> <span>' + escapeHtml(msg.error) + '</span>';
    }

    if (!isUser && msg.content && !msg.loading) {
      const footer = el('div', undefined, bodyCard, 'chat-bubble-footer');

      const copyBtn = el('button', undefined, footer, 'chat-copy-msg-btn');
      copyBtn.type = 'button';
      copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg> <span>Copy</span>';
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(msg.content);
          copyBtn.classList.add('copied');
          copyBtn.querySelector('span').textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.querySelector('span').textContent = 'Copy';
          }, 2000);
        } catch {}
      };

      if (msg.tokens) {
        el('span', msg.tokens + ' tokens', footer, 'chat-token-pill');
      }
      if (msg.latencyMs) {
        el('span', msg.latencyMs + ' ms', footer, 'chat-latency-pill');
      }
    }

    bodyCard.querySelectorAll('.chat-copy-code-btn').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const rawCode = decodeURIComponent(btn.dataset.code || '');
        try {
          await navigator.clipboard.writeText(rawCode);
          const orig = btn.innerHTML;
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.innerHTML = orig;
            btn.classList.remove('copied');
          }, 2000);
        } catch {}
      };
    });

    return row;
  }

  function updateLiveAssistantMessage(msg) {
    const rows = messagesWrap.querySelectorAll('.chat-row.assistant-row');
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return;

    if (msg.thinking) {
      let thinkingBox = lastRow.querySelector('.chat-thinking-box');
      if (!thinkingBox) {
        const bubble = lastRow.querySelector('.chat-bubble');
        thinkingBox = document.createElement('details');
        thinkingBox.className = 'chat-thinking-box';
        thinkingBox.open = true;
        const summary = document.createElement('summary');
        summary.className = 'chat-thinking-summary';
        summary.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg> <span>Thought Process</span>';
        thinkingBox.append(summary);
        const thinkingContent = document.createElement('div');
        thinkingContent.className = 'chat-thinking-content';
        thinkingContent.style.whiteSpace = 'pre-wrap';
        thinkingBox.append(thinkingContent);
        bubble.insertBefore(thinkingBox, bubble.querySelector('.chat-content-text'));
      }
      const tc = thinkingBox.querySelector('.chat-thinking-content');
      if (tc) tc.textContent = msg.thinking;
    }

    const contentEl = lastRow.querySelector('.chat-content-text');
    if (contentEl) {
      if (msg.content) {
        contentEl.innerHTML = renderMarkdown(msg.content);
        contentEl.querySelectorAll('.chat-copy-code-btn').forEach(btn => {
          btn.onclick = async (e) => {
            e.stopPropagation();
            const rawCode = decodeURIComponent(btn.dataset.code || '');
            try {
              await navigator.clipboard.writeText(rawCode);
              const orig = btn.innerHTML;
              btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
              setTimeout(() => { btn.innerHTML = orig; }, 2000);
            } catch {}
          };
        });
      }
    }

    scrollToBottom(true);
  }

  async function sendMessage() {
    const text = textarea.value.trim();
    if (!text || isGenerating) return;

    if (!selectedModelId) {
      alert('Please select a model from the top dropdown first.');
      return;
    }

    const userMsg = {
      role: 'user',
      content: text,
      timestamp: Date.now()
    };
    messages.push(userMsg);

    textarea.value = '';
    autoResize();

    const assistantMsg = {
      role: 'assistant',
      content: '',
      thinking: '',
      model: selectedModelId,
      loading: true,
      timestamp: Date.now()
    };
    messages.push(assistantMsg);

    renderConversation();
    persistMessages();

    isGenerating = true;
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'inline-flex';
    currentAbortController = new AbortController();

    const startTime = Date.now();

    const history = messages
      .slice(0, -1)
      .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'));

    const payload = {
      model: selectedModelId,
      messages: history.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: 4096
    };

    if (systemPrompt) {
      payload.system = systemPrompt;
    }

    if (selectedEffort && selectedEffort !== 'default') {
      payload.reasoning_effort = selectedEffort;
    }

    try {
      const response = await fetch('/admin/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: currentAbortController.signal
      });

      if (!response.ok) {
        let errDetail = 'HTTP ' + response.status;
        try {
          const errJson = await response.json();
          errDetail = errJson.error?.message || errJson.message || errDetail;
        } catch {}
        throw new Error(errDetail);
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || '';

          for (const frame of frames) {
            const lines = frame.split(/\r?\n/);
            for (const line of lines) {
              if (line.startsWith('data:')) {
                const dataStr = line.slice(5).trim();
                if (dataStr === '[DONE]') continue;
                try {
                  const ev = JSON.parse(dataStr);
                  if (ev.type === 'content_block_delta') {
                    if (ev.delta?.type === 'text_delta') {
                      assistantMsg.content += ev.delta.text || '';
                    } else if (ev.delta?.type === 'thinking_delta') {
                      assistantMsg.thinking += ev.delta.thinking || '';
                    }
                  } else if (ev.type === 'message_delta') {
                    if (ev.usage?.output_tokens) {
                      assistantMsg.tokens = ev.usage.output_tokens;
                    }
                  } else if (ev.type === 'error') {
                    assistantMsg.error = ev.error?.message || 'Upstream error during generation';
                  }
                } catch {}
              }
            }
          }

          updateLiveAssistantMessage(assistantMsg);
        }

        if (buffer.trim()) {
          const lines = buffer.split(/\r?\n/);
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const dataStr = line.slice(5).trim();
              if (dataStr && dataStr !== '[DONE]') {
                try {
                  const ev = JSON.parse(dataStr);
                  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                    assistantMsg.content += ev.delta.text || '';
                  }
                } catch {}
              }
            }
          }
        }
      } else {
        const data = await response.json();
        if (Array.isArray(data.content)) {
          assistantMsg.content = data.content.filter(c => c.type === 'text').map(c => c.text).join('') || '';
          const thinkPart = data.content.find(c => c.type === 'thinking');
          if (thinkPart) assistantMsg.thinking = thinkPart.thinking || '';
        } else if (typeof data.content === 'string') {
          assistantMsg.content = data.content;
        } else if (data.choices?.[0]?.message?.content) {
          assistantMsg.content = data.choices[0].message.content;
        }
        if (data.usage?.output_tokens || data.usage?.completion_tokens) {
          assistantMsg.tokens = data.usage.output_tokens || data.usage.completion_tokens;
        }
      }

      assistantMsg.latencyMs = Date.now() - startTime;
      assistantMsg.loading = false;
    } catch (e) {
      if (e.name === 'AbortError') {
        assistantMsg.loading = false;
        if (!assistantMsg.content) {
          assistantMsg.content = '(Generation stopped by user)';
        }
      } else {
        assistantMsg.loading = false;
        assistantMsg.error = e.message || 'Request failed';
      }
    } finally {
      isGenerating = false;
      currentAbortController = null;
      sendBtn.style.display = 'inline-flex';
      stopBtn.style.display = 'none';
      persistMessages();
      renderConversation();
      textarea.focus();
    }
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.onclick = sendMessage;

  stopBtn.onclick = () => {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  };

  clearBtn.onclick = () => {
    if (isGenerating && currentAbortController) {
      currentAbortController.abort();
    }
    messages = [];
    persistMessages();
    renderConversation();
    textarea.focus();
  };

  async function loadModels() {
    try {
      const [routes, models] = await Promise.all([
        api('routes').catch(() => []),
        api('models').catch(() => [])
      ]);

      const activeRoutes = (routes || []).filter(r => r.enabled !== false);
      const activeModels = (models || []).filter(m => m.enabled !== false);

      const list = [...activeRoutes];
      for (const m of activeModels) {
        if (!list.some(r => r.id === m.id)) {
          list.push(m);
        }
      }

      availableModels = list;
      modelSelect.replaceChildren();

      if (availableModels.length === 0) {
        const opt = el('option', 'No models mapped yet', modelSelect);
        opt.value = '';
        updateEffortOptions(null);
        updateActiveBadge();

        messagesWrap.replaceChildren();
        const emptyBox = el('div', undefined, messagesWrap, 'chat-welcome-box');
        el('h3', 'No Mapped Models Found', emptyBox);
        el('p', 'Auto Map default models to immediately connect Gemini, Claude, and GPT models.', emptyBox, 'muted');
        const autoMapBtn = el('button', '⚡ Auto Map Default Models', emptyBox, 'primary');
        autoMapBtn.style.marginTop = '16px';
        autoMapBtn.onclick = async () => {
          autoMapBtn.disabled = true;
          autoMapBtn.textContent = 'Mapping models...';
          try {
            await api('routes/auto-map', { method: 'POST' });
            await loadModels();
          } catch (err) {
            error(emptyBox, err);
            autoMapBtn.disabled = false;
            autoMapBtn.textContent = '⚡ Auto Map Default Models';
          }
        };
        return;
      }

      for (const m of availableModels) {
        const prov = m.provider ? (m.provider.includes('google') ? 'Google' : 'OpenAI') : (m.endpointId ? 'Endpoint' : '');
        const label = prov ? (m.name || m.id) + ' (' + prov + ')' : (m.name || m.id);
        const opt = el('option', label, modelSelect);
        opt.value = m.id;
      }

      if (selectedModelId && availableModels.some(m => m.id === selectedModelId)) {
        modelSelect.value = selectedModelId;
      } else {
        selectedModelId = availableModels[0].id;
        modelSelect.value = selectedModelId;
      }

      const activeModel = availableModels.find(m => m.id === selectedModelId);
      updateEffortOptions(activeModel);
      updateActiveBadge();
      renderConversation();
    } catch (e) {
      error(messagesWrap, e);
    }
  }

  modelSelect.onchange = () => {
    selectedModelId = modelSelect.value;
    try { sessionStorage.setItem(STORAGE_KEY_MODEL, selectedModelId); } catch {}
    const activeModel = availableModels.find(m => m.id === selectedModelId);
    updateEffortOptions(activeModel);
    updateActiveBadge();
  };

  effortSelect.onchange = () => {
    selectedEffort = effortSelect.value;
    try { sessionStorage.setItem(STORAGE_KEY_EFFORT, selectedEffort); } catch {}
  };

  loadModels();
}
