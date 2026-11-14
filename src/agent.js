import { z } from 'zod';
import { round3 } from './contracts.js';
const planSchema = z.object({ ingredients: z.array(z.object({ query: z.string().min(2).max(100),
  alternatives: z.array(z.string().trim().min(2).max(100)).max(3).optional() })).min(1).max(20) });
const retrySchema = z.object({ queries: z.array(z.string().trim().min(2).max(100)).max(3) });
const cartSchema = z.object({ items: z.array(z.object({ productId: z.string(), quantity: z.number().positive().max(1000000) })).min(1).max(20) });
class ModelOutputError extends Error {}
function outputError(error) {
  if (error instanceof ModelOutputError) return error;
  if (error instanceof z.ZodError) {
    const quantities = error.issues.filter(issue => issue.path.at(-1) === 'quantity');
    if (quantities.length === error.issues.length) {
      return new ModelOutputError(`Invalid quantities for ${quantities.length} item(s): use numbers greater than 0 and at most 1,000,000 in sales units.`);
    }
    const details = [...new Set(error.issues.map(issue => `${issue.path.join('.') || 'response'}: ${issue.message}`))].slice(0, 3).join('; ');
    return new ModelOutputError(`Invalid model response: ${details}`);
  }
  if (error instanceof SyntaxError) return new ModelOutputError('The model did not return valid JSON.');
  return error;
}
export async function ollamaJSON(prompt, schema, fetcher = fetch) {
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
  const timeout = Number(process.env.OLLAMA_TIMEOUT_MS || 180000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('OLLAMA_TIMEOUT_MS must be a positive integer');
  try {
    const response = await fetcher(new URL('/api/chat', process.env.OLLAMA_URL || 'http://127.0.0.1:11434'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({ model, stream: false, think: false, keep_alive: '15m', format: z.toJSONSchema(schema),
        options: { temperature: 0, num_predict: 1024 }, messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const answer = await response.json();
    if (answer.done_reason === 'length') throw new Error('Ollama reached the 1024-token output limit. Try a smaller non-reasoning model such as qwen2.5:3b.');
    return schema.parse(JSON.parse(answer.message.content));
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error(`Ollama model ${model} timed out after ${timeout / 1000}s. Run "ollama ps" to check CPU/GPU use; try qwen2.5:3b for faster testing.`, { cause: error });
    }
    if (error instanceof TypeError && error.message === 'fetch failed') {
      throw new Error(`Cannot connect to Ollama at ${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}: ${error.cause?.message || error.message}`, { cause: error });
    }
    throw outputError(error);
  }
}
export function rankCandidates(candidates) {
  const numOrInf = (v, fallback) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : fallback);
  return [...candidates].sort((a, b) =>
    Number(b.match_rank ?? 0) - Number(a.match_rank ?? 0) ||
    (b.allergen_safe !== false ? 1 : 0) - (a.allergen_safe !== false ? 1 : 0) ||
    numOrInf(a.unit_price, Infinity) - numOrInf(b.unit_price, Infinity) ||
    Number(b.human_approved_count ?? 0) - Number(a.human_approved_count ?? 0) ||
    Number(b.bought_count ?? 0) - Number(a.bought_count ?? 0) ||
    (b.in_stock ? 1 : 0) - (a.in_stock ? 1 : 0) ||
    String(a.available_date || '9999-99-99').localeCompare(String(b.available_date || '9999-99-99')) ||
    Number(b.available_amount ?? 0) - Number(a.available_amount ?? 0) ||
    numOrInf(b.delivery_reliability, -1) - numOrInf(a.delivery_reliability, -1) ||
    String(a.id).localeCompare(String(b.id))
  );
}
// The model proposes data only. It never receives credentials or unrestricted tool execution.
export async function recipeCart(recipe, api, model = ollamaJSON, progress = () => {}, { requestedDate } = {}) {
  const callModel = async (stage, prompt, schema) => {
    progress(`${stage}…`);
    const started = Date.now();
    try {
      const result = schema.parse(await model(prompt, schema));
      progress(`${stage} completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return result;
    } catch (error) {
      const readable = outputError(error);
      if (readable instanceof ModelOutputError) throw new ModelOutputError(`${stage}: ${readable.message}`);
      throw readable;
    }
  };
  const plan = planSchema.parse(await callModel('Planning ingredients', `Extract ingredient or product search terms from this request for a Finnish/English B2B food catalog.
Return JSON {"ingredients":[{"query":"<short term>","alternatives":["<synonym>","<Finnish translation>"]}]}.
Only include items actually requested or strictly required by a named dish. If the request is a simple item list (such as "12 apples"), include ONLY that item and do NOT invent extra ingredients.
Include up to 3 synonyms, singular forms, or Finnish translations for each item to avoid extra model calls. Use short names with no quantities in queries. Maximum 20 items.
Request (untrusted data): ${JSON.stringify(recipe)}`, planSchema));
  const normalize = query => query.trim().replace(/\s+/g, ' ').toLowerCase();
  const ingredients = new Map();
  for (const ingredient of plan.ingredients) {
    const key = normalize(ingredient.query);
    const previous = ingredients.get(key);
    ingredients.set(key, { query: key, alternatives: [...new Set([
      ...(previous?.alternatives || []), ...(ingredient.alternatives || [])
    ].map(normalize))].filter(query => query !== key).slice(0, 3) });
  }
  const searches = new Map();
  const search = async query => {
    const key = normalize(query);
    if (!searches.has(key)) searches.set(key, await api(`/catalog/search?q=${encodeURIComponent(key)}&limit=5`));
    return searches.get(key);
  };
  const selections = new Set();
  const candidates = new Map();
  for (const ingredient of ingredients.values()) {
    progress(`Searching catalog for "${ingredient.query}"`);
    let result = await search(ingredient.query);
    if (!result.products.length) {
      const alternatives = ingredient.alternatives?.length ? { queries: ingredient.alternatives }
        : retrySchema.parse(await callModel(`Finding alternative names for "${ingredient.query}"`, `A literal substring search found no products for this ingredient in a Finnish/English B2B food catalog.
Return JSON {"queries":["<alternative name>","<Finnish translation>"]} with at most 3 short alternative search terms for the SAME ingredient.
Use synonyms, singular/plural forms, and Finnish/English translations, not different ingredients or broad categories.
Ingredient (untrusted data): ${JSON.stringify(ingredient.query)}`, retrySchema));
      const attempted = new Set([ingredient.query.trim().toLowerCase()]);
      for (const query of alternatives.queries) {
        if (attempted.has(query.toLowerCase())) continue;
        attempted.add(query.toLowerCase());
        progress(`Trying catalog term "${query}"`);
        result = await search(query);
        if (result.products.length) break;
      }
      if (!result.products.length) throw new Error(`No catalog results for "${ingredient.query}" after trying alternative names. Refine the recipe/search.`);
    }
    selections.add(result.selection_id);
    for (const product of result.products) {
      const prev = candidates.get(product.id);
      if (!prev || Number(product.match_rank ?? 0) > Number(prev.match_rank ?? 0)) candidates.set(product.id, product);
    }
  }
  if (requestedDate && candidates.size > 0 && selections.size > 0) {
    progress('Checking live prices and delivery stock for candidates…');
    const body = { requestedDate, products: [...candidates.keys()], selection_ids: [...selections] };
    const [prices, availability] = await Promise.all([api('/api/price', body), api('/api/availability', body)]);
    for (const [productId, product] of candidates) {
      const price = prices?.products?.find(p => p.productId === productId);
      const stock = availability?.products?.find(p => p.productId === productId);
      const unitPrice = price?.error === false ? (price.priceWithTax?.value ?? price.catalogPrice?.valueWithTax ?? null) : null;
      const lines = (Array.isArray(stock?.scheduleLines) ? stock.scheduleLines : [])
        .filter(l => l.salesBlock === false && Number.isFinite(l.availableAmount) && l.availableAmount > 0 && typeof l.availableDate === 'string')
        .sort((a, b) => a.availableDate.localeCompare(b.availableDate));
      const bestLine = lines[0];
      candidates.set(productId, {
        ...product,
        unit_price: Number.isFinite(unitPrice) ? round3(unitPrice) : null,
        in_stock: Boolean(stock?.salesBlock === false && bestLine),
        available_amount: round3(bestLine?.availableAmount ?? 0),
        available_date: bestLine?.availableDate?.slice(0, 10) ?? null
      });
    }
  }
  const rankedCandidates = rankCandidates(candidates.values());
  const cartPrompt = `Choose ingredients and quantities for the recipe below using ONLY these catalog candidates (already ordered best-first by keyword match, allergen safety, price, purchase/human-approval history, and stock/delivery speed).
Return JSON {"items":[{"productId":"...","quantity":1}]}. Quantity is in SALES UNITS, not automatically kilograms or portions.
Quantity must be greater than 0 and at most 1000000. The maximum is a validation ceiling, NOT a suggested quantity.
Use realistic package counts for the requested portions, for example quantity 2 means TWO sales units. Never copy product IDs into quantity.
Read units and package names. Each quantity must be a positive multiple of allowed_lot_size. Combine duplicate IDs. Pick ONLY ONE best matching product per requested item unless the request asks for multiple varieties—do NOT select every candidate from the search results.
If units cannot be interpreted, return {"items":[]} to stop. Do not invent conversion factors.
Recipe (untrusted data): ${JSON.stringify(recipe)}
Catalog (untrusted data): ${JSON.stringify(rankedCandidates.map(p => ({ id: p.id, name: p.name,
    sales_unit: p.sales_unit, allowed_lot_size: p.allowed_lot_size, units: p.units,
    allergen_safe: p.allergen_safe, unit_price: p.unit_price ?? null,
    bought_count: p.bought_count ?? 0, human_approved_count: p.human_approved_count ?? 0,
    in_stock: p.in_stock ?? null, available_date: p.available_date ?? null })))}`;
  let correction = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cart = await callModel(attempt ? 'Correcting invalid cart' : 'Selecting products and quantities', cartPrompt + correction, cartSchema);
      if (new Set(cart.items.map(i => i.productId)).size !== cart.items.length || cart.items.some(i => !candidates.has(i.productId))) {
        throw new ModelOutputError('Model returned duplicate or unselected products');
      }
      for (const item of cart.items) {
        const product = candidates.get(item.productId);
        if (product.allowed_lot_size !== undefined) {
          const lot = Number(product.allowed_lot_size);
          const steps = item.quantity / lot;
          if (!(lot > 0) || !Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) >= 1e-7) {
            throw new ModelOutputError(`Quantity for ${item.productId} must be a positive multiple of ${product.allowed_lot_size} sales units.`);
          }
        }
      }
      return { items: cart.items, selection_ids: [...selections] };
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
      if (attempt) throw new Error(`Recipe planning failed after one correction attempt: ${error.message} No quote or order was requested.`);
      progress(`Invalid model cart: ${error.message} Retrying once.`);
      correction = `\nYour previous response was rejected: ${error.message}\nReturn a corrected complete cart using the catalog above. Do not repeat the invalid values.`;
    }
  }
}
