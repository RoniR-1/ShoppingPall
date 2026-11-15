import { z } from 'zod';
import { round3, parseBudget, parseDeliveryDeadline, parseSustainability, parseOriginPreference, countryName } from './contracts.js';
import { callGeminiJSON } from './web-demo/luna.js';

const planSchema = z.object({ ingredients: z.array(z.object({ query: z.string().min(2).max(100),
  alternatives: z.array(z.string().trim().min(2).max(100)).max(3).optional() })).min(1).max(20) });
const retrySchema = z.object({ queries: z.array(z.string().trim().min(2).max(100)).max(3) });
const cartSchema = z.object({ items: z.array(z.object({ productId: z.string(), quantity: z.number().positive().max(1000000) })).min(1).max(20) });
class ModelOutputError extends Error {}
// A structurally valid cart that breaks a stated requirement (budget, strict origin); kinds lists which.
class ConstraintError extends ModelOutputError {
  constructor(message, kinds) { super(message); this.kinds = kinds; }
}
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
export async function lunaJSON(prompt, schema, fetcher = fetch, env = process.env) {
  try {
    const result = await callGeminiJSON(
      `Return only a JSON object matching this schema: ${JSON.stringify(z.toJSONSchema(schema))}`,
      prompt,
      { fetchImpl: fetcher, env }
    );
    return schema.parse(result);
  } catch (error) {
    if (error.code === 'AI_INVALID_RESPONSE') throw new ModelOutputError(error.message, { cause: error });
    throw outputError(error);
  }
}
// Ranking hierarchy, highest priority first:
//   1. keyword match (always on top)
//   2. allergen safety (never traded for price or delivery)
//   3. requested country of origin (country_of_origin in origins), only when the buyer stated one
//   4. deliverable by the deadline: an explicit "delivered in X days" request, or a default delivery date when no budget was given
//   5. lowest CO2 (carbon_kg_co2_per_kg), only when the buyer asked for sustainability; unknown CO2 ranks last
//   6. price
//   7. deliverable by a default delivery date when a budget was given (budget outranks an implicit date)
//   8. tie-breakers: human-approved/purchase history, stock, earliest date, amount, reliability, id
// Candidates without deliverable_by_date (no availability data) tie on 4 and 7.
export function originMatches(product, origins) {
  return Boolean(origins?.length) && origins.includes(String(product?.country_of_origin ?? '').toLowerCase());
}
export function rankCandidates(candidates, { budget = false, deliveryRequested = false, sustainability = false, origins = null } = {}) {
  const numOrInf = (v, fallback) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : fallback);
  const price = p => numOrInf(p.unit_price, Infinity);
  const byPrice = (a, b) => (price(a) === price(b) ? 0 : price(a) - price(b));
  const byDeliverable = (a, b) => Number(b.deliverable_by_date === true) - Number(a.deliverable_by_date === true);
  const co2 = p => numOrInf(p.carbon_kg_co2_per_kg, Infinity);
  const byCO2 = (a, b) => (co2(a) === co2(b) ? 0 : co2(a) - co2(b));
  const deliveryBeforePrice = deliveryRequested || !budget;
  const byOrigin = (a, b) => Number(originMatches(b, origins)) - Number(originMatches(a, origins));
  return [...candidates].sort((a, b) =>
    Number(b.match_rank ?? 0) - Number(a.match_rank ?? 0) ||
    (b.allergen_safe !== false ? 1 : 0) - (a.allergen_safe !== false ? 1 : 0) ||
    (origins?.length ? byOrigin(a, b) : 0) ||
    (deliveryBeforePrice ? byDeliverable(a, b) : 0) ||
    (sustainability ? byCO2(a, b) : 0) ||
    byPrice(a, b) ||
    (deliveryBeforePrice ? 0 : byDeliverable(a, b)) ||
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
export async function recipeCart(recipe, api, model = lunaJSON, progress = () => {}, { requestedDate, now = Date.now() } = {}) {
  const budget = parseBudget(recipe);
  // An explicit "delivered in X days" in the request is a stated constraint; --date / the default date is not.
  const statedDeadline = parseDeliveryDeadline(recipe, now);
  const deliverBy = statedDeadline ?? requestedDate;
  const sustainability = parseSustainability(recipe);
  // { countries: ['fi'], strict } — strict ("Finnish only") is enforced on the cart, a preference only ranks.
  const origin = parseOriginPreference(recipe);
  const originLabel = origin ? origin.countries.map(countryName).join(' or ') : '';
  requestedDate ??= statedDeadline;

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
    if (!searches.has(key)) {
      const result = await api(`/catalog/search?q=${encodeURIComponent(key)}&limit=5`);
      if (!Array.isArray(result?.products) || result.products.length > 5 ||
          (result.products.length && (typeof result.selection_id !== 'string' || !result.selection_id)) ||
          result.products.some(p => !p || typeof p.id !== 'string' || !p.id)) {
        throw new Error('Invalid catalog search response; no quote or order was requested.');
      }
      searches.set(key, result);
    }
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
        available_date: bestLine?.availableDate?.slice(0, 10) ?? null,
        deliverable_by_date: Boolean(deliverBy && stock?.salesBlock === false && bestLine &&
          bestLine.availableDate.slice(0, 10) <= deliverBy)
      });
    }
  }
  const rankedCandidates = rankCandidates(candidates.values(), { budget: budget != null, deliveryRequested: statedDeadline != null, sustainability, origins: origin?.countries });
  const constraints = [
    origin ? (origin.strict
      ? `The user accepts ONLY products whose country_of_origin is ${origin.countries.join(' or ')} (${originLabel}); never choose another origin when a matching candidate exists.`
      : `The user prefers products whose country_of_origin is ${origin.countries.join(' or ')} (${originLabel}); among equally good keyword matches, choose those.`) : null,
    statedDeadline ? `The user wants delivery by ${statedDeadline}; among equally good keyword matches, prefer candidates with deliverable_by_date true.`
      : requestedDate ? `The requested delivery date is ${requestedDate}; prioritize candidates available by that date.` : null,
    sustainability ? 'The user wants sustainable choices; among equally good keyword matches, prefer the lowest carbon_kg_co2_per_kg (kg CO2-eq per kg; null means unknown).' : null,
    budget == null ? null : `The user's stated total budget is EUR ${budget}; favor choices whose combined cost fits it, using candidate prices and realistic quantities.`
  ].filter(Boolean).join(' ');
  const cartPrompt = `Choose ingredients and quantities for the recipe below using ONLY these catalog candidates (already ordered with keyword match first, then stated constraints, then tie-breakers).
${constraints}
Return JSON {"items":[{"productId":"...","quantity":1}]}. Quantity is in SALES UNITS, not automatically kilograms or portions.
Quantity must be greater than 0 and at most 1000000. The maximum is a validation ceiling, NOT a suggested quantity.
Use realistic package counts for the requested portions, for example quantity 2 means TWO sales units. Never copy product IDs into quantity.
Read units and package names. Each quantity must be a positive multiple of allowed_lot_size. Combine duplicate IDs. Pick ONLY ONE best matching product per requested item unless the request asks for multiple varieties—do NOT select every candidate from the search results.
If units cannot be interpreted, return {"items":[]} to stop. Do not invent conversion factors.
Recipe (untrusted data): ${JSON.stringify(recipe)}
Catalog (untrusted data): ${JSON.stringify(rankedCandidates.map(p => ({ id: p.id, name: p.name,
    sales_unit: p.sales_unit, allowed_lot_size: p.allowed_lot_size, units: p.units,
    allergen_safe: p.allergen_safe, unit_price: p.unit_price ?? null,
    ...(sustainability ? { carbon_kg_co2_per_kg: p.carbon_kg_co2_per_kg ?? null } : {}),
    ...(origin ? { country_of_origin: p.country_of_origin ?? null } : {}),
    bought_count: p.bought_count ?? 0, human_approved_count: p.human_approved_count ?? 0,
    in_stock: p.in_stock ?? null, available_date: p.available_date ?? null,
    deliverable_by_date: p.deliverable_by_date ?? null })))}`;
  const result = (items, extra = {}) => ({ items, selection_ids: [...selections], ...(budget == null ? {} : { budget }), ...extra });
  const approval = (items, approvalReason) => {
    progress(`${approvalReason} Sending for human approval.`);
    return result(items, { requiresApproval: true, approvalReason });
  };
  let correction = '';
  // Best structurally valid cart that only broke stated requirements (fewest off-origin items, then cheapest);
  // it goes to a human if the correction cannot satisfy them.
  let fallback = null;
  const kindLabel = kinds => kinds.map(kind => (kind === 'origin' ? 'Origin requirement' : 'Budget')).join(' and ');
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
      const violations = [];
      const offOrigin = origin?.strict ? cart.items.filter(item => !originMatches(candidates.get(item.productId), origin.countries)) : [];
      if (offOrigin.length) {
        violations.push(['origin', `${offOrigin.map(item => `${item.productId} is from ${countryName(candidates.get(item.productId).country_of_origin)}`).join(', ')}, but the request allows only ${originLabel}.`]);
      }
      let total = Infinity;
      if (budget != null) {
        const unpriced = cart.items.filter(item => !Number.isFinite(candidates.get(item.productId).unit_price));
        if (unpriced.length) {
          const reasons = [...violations.map(([, message]) => message), `Budget cannot be verified: live prices are unavailable for ${unpriced.map(item => item.productId).join(', ')}.`];
          return approval(cart.items, reasons.join(' '));
        }
        total = cart.items.reduce((sum, item) => sum + candidates.get(item.productId).unit_price * item.quantity, 0);
        if (Math.round(total * 100) > Math.round(budget * 100)) {
          violations.push(['budget', `Cart total EUR ${total.toFixed(2)} exceeds the stated budget of EUR ${budget.toFixed(2)}.`]);
        }
      }
      if (violations.length) {
        const current = { items: cart.items, total, offOrigin: offOrigin.length, kinds: violations.map(([kind]) => kind), message: violations.map(([, message]) => message).join(' ') };
        if (!fallback || current.offOrigin < fallback.offOrigin || (current.offOrigin === fallback.offOrigin && total <= fallback.total)) fallback = current;
        throw new ConstraintError(current.message, current.kinds);
      }
      return result(cart.items);
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
      if (attempt) {
        if (fallback) return approval(fallback.items, `${kindLabel(fallback.kinds)} not met after correction: ${fallback.message}`);
        throw new Error(`Recipe planning failed after one correction attempt: ${error.message} No quote or order was requested.`);
      }
      progress(`Invalid model cart: ${error.message} Retrying once.`);
      const kinds = error instanceof ConstraintError ? error.kinds : [];
      correction = `\nYour previous response was rejected: ${error.message}\n` +
        (kinds.includes('origin') ? `Replace items from other countries with candidates whose country_of_origin is ${origin.countries.join(' or ')}. If no such candidate exists for an item, keep its best match; it will be sent for human review.\n` : '') +
        (kinds.includes('budget') ? `Lower the cost: prefer cheaper suitable candidates (allergen-safe, same item) and the smallest package counts that still cover the request. Do not drop requested items. If the budget cannot be met, return the cheapest complete cart.\n` : '') +
        `Return a corrected complete cart using the catalog above. Do not repeat the invalid values.`;
    }
  }
}
