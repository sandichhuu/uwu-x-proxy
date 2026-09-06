const bad = message => Object.assign(new Error(message), { status: 400 });

export function getAccountRemainingQuota(account, upstreamId) {
  if (!account || !account.quota) return 50;
  const q = account.quota;

  if (account.provider === 'openai' || q.rate_limit) {
    if (q.rate_limit?.limit_reached === true) return 0;
    if (q.rate_limit?.primary_window?.used_percent !== undefined) {
      const used = Number(q.rate_limit.primary_window.used_percent);
      if (!Number.isNaN(used)) return Math.max(0, 100 - used);
    }
    if (q.remaining !== undefined) return Math.max(0, Number(q.remaining) || 0);
    if (q.percentage !== undefined) return Math.max(0, 100 - (Number(q.percentage) || 0));
    if (q.used_percent !== undefined) return Math.max(0, 100 - (Number(q.used_percent) || 0));
  }

  if (account.provider === 'google' || typeof q === 'object') {
    if (typeof q.remainingFraction === 'number') {
      return Math.round(q.remainingFraction * 100);
    }
    if (upstreamId && q[upstreamId]) {
      const frac = q[upstreamId].remainingFraction ?? (q[upstreamId].resetTime ? 0 : null);
      if (typeof frac === 'number') return Math.round(frac * 100);
    }
    const entries = Object.entries(q);
    if (entries.length > 0) {
      const claude = entries.find(([k]) => /claude/i.test(k));
      if (claude && claude[1]) {
        const frac = claude[1].remainingFraction ?? (claude[1].resetTime ? 0 : null);
        if (typeof frac === 'number') return Math.round(frac * 100);
      }
      const fractions = entries
        .map(([, info]) => info?.remainingFraction ?? (info?.resetTime ? 0 : null))
        .filter(f => typeof f === 'number');
      if (fractions.length > 0) return Math.round(Math.min(...fractions) * 100);
    }
  }

  return 50;
}

const ASTRA_EFFORT_MAP = {
  minimal: 'light',
  low: 'light',
  light: 'light',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra_high',
  extrahigh: 'extra_high',
  extra_high: 'extra_high',
  max: 'ultra',
  ultra: 'ultra'
};

export function resolveModel(store, publicId, effort) {
  if (typeof publicId !== 'string' || !publicId) throw bad('model is required');
  const model = store.list('models').find(x => x.id === publicId && x.enabled !== false);
  if (!model) throw Object.assign(new Error('Unknown model'), { status: 404 });
  const config = model.effort || { mode: 'unsupported' };
  let resolved = effort ?? config.default;
  let upstreamId = model.upstreamId;
  const isVariant = config.mode === 'variant';
  const isForward = config.mode === 'forward' || config.mode === 'passthrough';
  if (resolved !== undefined) {
    if (typeof resolved !== 'string' || !resolved || (!isVariant && !isForward)) throw bad('Unsupported reasoning effort');
    if (config.supported?.includes('light') && config.supported?.includes('ultra') && ASTRA_EFFORT_MAP[resolved.toLowerCase()]) {
      resolved = ASTRA_EFFORT_MAP[resolved.toLowerCase()];
    }
    const supportedList = config.supported?.length ? config.supported : (isVariant ? Object.keys(config.variants || model.variants || {}) : []);
    if (supportedList.length && !supportedList.includes(resolved)) throw bad(`Unsupported effort. Valid values: ${supportedList.join(', ')}`);
  }
  if (isVariant) {
    const variantMap = config.variants || model.variants || {};
    if (!resolved || !variantMap[resolved]) throw bad('An explicit discovered effort variant is required');
    upstreamId = variantMap[resolved];
  }
  // Collect eligible targets
  const targets = [];
  if (model.sources && model.sources.length > 0) {
    for (const s of model.sources) {
      if (s.type === 'endpoint' || s.endpointId) {
        const ep = store.list('endpoints').find(x => x.id === (s.endpointId || s.id) && x.enabled !== false);
        if (ep) targets.push({ type: 'endpoint', endpoint: ep, upstreamId: s.upstreamId || upstreamId });
      } else if (s.type === 'account' || s.provider) {
        const prov = (s.provider || '').startsWith('google') ? 'google' : 'openai';
        const accs = store.list('accounts').filter(x => x.provider === prov && x.enabled !== false && (!s.accountIds?.length || s.accountIds.includes(x.id)) && (!x.cooldownUntil || x.cooldownUntil <= Date.now()));
        for (const acc of accs) {
          targets.push({ type: 'account', account: acc, provider: prov, upstreamId: s.upstreamId || upstreamId });
        }
      }
    }
  } else if (model.provider === 'google' || model.provider === 'google-antigravity' || model.provider === 'openai' || model.provider === 'openai-codex') {
    const provider = model.provider.startsWith('google') ? 'google' : 'openai';
    const accounts = store.list('accounts').filter(x => x.provider === provider && x.enabled !== false && (!model.accountIds?.length || model.accountIds.includes(x.id)) && (!x.cooldownUntil || x.cooldownUntil <= Date.now()));
    for (const acc of accounts) {
      targets.push({ type: 'account', account: acc, provider, upstreamId });
    }
  } else {
    const epIds = model.endpointIds?.length ? model.endpointIds : (model.endpointId ? [model.endpointId] : []);
    for (const id of epIds) {
      const ep = store.list('endpoints').find(x => x.id === id && x.enabled !== false);
      if (ep) targets.push({ type: 'endpoint', endpoint: ep, upstreamId });
    }
  }

  if (!targets.length) {
    if (model.endpointId || model.endpointIds?.length) throw Object.assign(new Error('No eligible endpoint for model'), { status: 503 });
    throw Object.assign(new Error('No eligible account for model'), { status: 503 });
  }

  let chosenTarget;
  const strategy = model.strategy || model.routingStrategy || 'round-robin';
  if (strategy === 'smart') {
    const scored = targets.map(t => {
      let usage = 50;
      if (t.type === 'account') usage = getAccountRemainingQuota(t.account, t.upstreamId);
      return { target: t, usage };
    });
    scored.sort((a, b) => b.usage - a.usage);
    chosenTarget = scored[0].target;
  } else {
    const cursor = store._targetCursor = (store._targetCursor || 0) + 1;
    chosenTarget = targets[cursor % targets.length];
  }

  if (chosenTarget.type === 'account') {
    return { model, account: chosenTarget.account, provider: chosenTarget.provider, upstreamId: chosenTarget.upstreamId, effort: resolved };
  }
  return { model, endpoint: chosenTarget.endpoint, upstreamId: chosenTarget.upstreamId, effort: resolved };
}
