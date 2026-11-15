function aiError(message, status, code) {
  return Object.assign(Error(message), { status, code });
}

export async function callGeminiJSON(systemPrompt, userPrompt, { env = process.env, fetchImpl = fetch } = {}) {
  const base = (env.LUNA_BASE_URL || '').trim().replace(/\/+$/, '');
  const rawKey = (env.LUNA_API_KEY || '').trim();
  const apiKey = rawKey.startsWith('Ab8RN6') ? `AQ.${rawKey}` : rawKey;
  if (!apiKey || !base) {
    throw aiError('Configure LUNA_API_KEY and LUNA_BASE_URL to use the agent', 503, 'AI_NOT_CONFIGURED');
  }

  const timeout = Number(env.LUNA_TIMEOUT_MS || 60000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw aiError('LUNA_TIMEOUT_MS must be a positive integer', 503, 'AI_NOT_CONFIGURED');
  }
  // Thinking models count hidden reasoning against max_tokens, so leave room beyond the short JSON answer.
  const maxTokens = Number(env.LUNA_MAX_TOKENS || 8192);
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw aiError('LUNA_MAX_TOKENS must be a positive integer', 503, 'AI_NOT_CONFIGURED');
  }

  let response;
  try {
    response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: env.LUNA_MODEL || 'gemini-2.5-flash',
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(timeout)
    });
  } catch {
    throw aiError('AI provider unavailable or timed out; retry the request', 502, 'AI_UNAVAILABLE');
  }

  let raw;
  try {
    raw = await response.text();
  } catch {
    if (response.status === 429) throw aiError('AI provider rate limited the request; retry later', 429, 'AI_RATE_LIMITED');
    throw aiError('AI provider response unavailable or timed out; retry the request', 502, 'AI_UNAVAILABLE');
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
    throw aiError(
      `AI provider request failed (${response.status}): ${detail}`,
      response.status === 429 ? 429 : 502,
      response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_ERROR'
    );
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
