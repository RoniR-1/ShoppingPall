function aiError(message, status, code) {
  return Object.assign(Error(message), { status, code });
}

const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const providerStates = new WeakMap();

export function configuredLunaModels(env = process.env) {
  const configured = (env.LUNA_MODELS || '').trim();
  const legacy = (env.LUNA_MODEL || '').trim();
  const selected = configured || legacy;
  return selected
    ? [...new Set(selected.split(',').map(model => model.trim().replace(/^models\//, '')).filter(Boolean))]
    : [...DEFAULT_MODELS];
}

function positiveSetting(value, fallback, name) {
  const number = Number(value || fallback);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw aiError(`${name} must be a positive integer`, 503, 'AI_NOT_CONFIGURED');
  }
  return number;
}

export async function callGeminiJSON(systemPrompt, userPrompt, { env = process.env, fetchImpl = fetch } = {}) {
  const base = (env.LUNA_BASE_URL || '').trim().replace(/\/+$/, '');
  const rawKey = (env.LUNA_API_KEY || '').trim();
  const apiKey = rawKey.startsWith('Ab8RN6') ? `AQ.${rawKey}` : rawKey;
  if (!apiKey || !base) {
    throw aiError('Configure LUNA_API_KEY and LUNA_BASE_URL to use the agent', 503, 'AI_NOT_CONFIGURED');
  }
  const models = configuredLunaModels(env);
  if (!models.length) throw aiError('LUNA_MODELS must contain at least one model', 503, 'AI_NOT_CONFIGURED');
  const timeout = positiveSetting(env.LUNA_TIMEOUT_MS, 10000, 'LUNA_TIMEOUT_MS');
  const cooldown = positiveSetting(env.LUNA_COOLDOWN_MS, 60000, 'LUNA_COOLDOWN_MS');
  const maxTokens = positiveSetting(env.LUNA_MAX_TOKENS, 8192, 'LUNA_MAX_TOKENS');
  let states = providerStates.get(env);
  if (!states) providerStates.set(env, states = new Map());
  const config = JSON.stringify([base, apiKey, models]);
  if (!states.has(config)) states.set(config, new Map());
  const state = states.get(config);
  let lastError;
  for (const model of models) {
    let modelState = state.get(model);
    if (modelState && (modelState.until > Date.now() || modelState.probing)) {
      lastError = modelState.error;
      continue;
    }
    if (modelState) modelState.probing = true;
    try {
      const value = await requestModel({base, apiKey, model, timeout, maxTokens, systemPrompt, userPrompt, fetchImpl});
      state.delete(model);
      return value;
    } catch (error) {
      if (!error.retryable) {
        if (modelState) modelState.probing = false;
        throw error;
      }
      lastError = error;
      if (models.length > 1) state.set(model, {until: Date.now() + cooldown, probing: false, error});
    }
  }
  throw lastError || aiError('AI provider unavailable or timed out; retry the request', 502, 'AI_UNAVAILABLE');
}

async function requestModel({base, apiKey, model, timeout, maxTokens, systemPrompt, userPrompt, fetchImpl}) {
  const geminiNative = /generativelanguage\.googleapis\.com\/v1beta$/i.test(base);
  const nativeModel = model.replace(/^models\//, '');
  const url = geminiNative
    ? `${base}/models/${encodeURIComponent(nativeModel)}:generateContent?key=${encodeURIComponent(apiKey)}`
    : `${base}/chat/completions`;
  const headers = geminiNative
    ? { 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const body = geminiNative
    ? { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: 'user', parts: [{ text: userPrompt }] },], generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' } }
    : { model, temperature: 0, max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        response_format: { type: 'json_object' } };
  const controller = new AbortController();
  let timer;
  let response;
  let raw;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Error('timeout')); }, timeout);
    });
    await Promise.race([(async () => {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      raw = await response.text();
    })(), deadline]);
  } catch {
    if (response && !response.ok && response.status !== 429 && response.status < 500) {
      throw aiError(`AI provider request failed (${response.status}): Provider rejected request`, 502, 'AI_PROVIDER_ERROR');
    }
    const error = response?.status === 429
      ? aiError('AI provider rate limited the request; retry later', 429, 'AI_RATE_LIMITED')
      : aiError('AI provider unavailable or timed out; retry the request', 502, 'AI_UNAVAILABLE');
    error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    if (response.ok && (/\btext\/html\b/i.test(response.headers?.get('content-type') || '') || /^\s*<(?:!doctype\s+html|html)\b/i.test(raw))) {
      throw aiError('AI provider returned a web page instead of an API response. Check that LUNA_BASE_URL is the provider\'s OpenAI-compatible API base URL, not its website.', 502, 'AI_INVALID_RESPONSE');
    }
    if (response.ok) throw aiError('AI provider returned malformed JSON', 502, 'AI_INVALID_RESPONSE');
    payload = {};
  }
  if (Array.isArray(payload)) payload = payload[0];
  if (!payload || typeof payload !== 'object') {
    if (response.ok) throw aiError('AI provider returned invalid response', 502, 'AI_INVALID_RESPONSE');
    payload = {};
  }
  if (!response.ok) {
    const detail = String(payload.error?.message || 'Provider rejected request').replaceAll(apiKey, '[redacted]');
    const error = aiError(
      `AI provider request failed (${response.status}): ${detail}`,
      response.status === 429 ? 429 : 502,
      response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_ERROR'
    );
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }

  if (geminiNative) {
    const candidate = payload.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason === 'SAFETY') {
      throw aiError('The request could not be processed. Please rephrase the products and quantities; no order was placed.', 422, 'AI_REFUSAL');
    }
    if (finishReason === 'MAX_TOKENS') throw aiError('AI output was truncated; retry or simplify the request', 502, 'AI_TRUNCATED');
    const content = candidate?.content?.parts?.map(part => part.text || '').join('');
    if (typeof content !== 'string' || !content.trim()) throw aiError('AI provider returned empty or invalid content', 502, 'AI_INVALID_RESPONSE');
    try { return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { throw aiError('Could not interpret the request. Please rephrase the products and quantities and try again; no order was placed.', 502, 'AI_INVALID_RESPONSE'); }
  }
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
    throw aiError('The request could not be processed. Please rephrase the products and quantities; no order was placed.', 422, 'AI_REFUSAL');
  }
  if (choice?.finish_reason === 'length') {
    throw aiError('AI output was truncated; retry or simplify the request', 502, 'AI_TRUNCATED');
  }
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw aiError('AI provider returned empty or invalid content', 502, 'AI_INVALID_RESPONSE');
  }
  try {
    return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw aiError('Could not interpret the request. Please rephrase the products and quantities and try again; no order was placed.', 502, 'AI_INVALID_RESPONSE');
  }
}
