import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeCart, lunaJSON, rankCandidates } from '../src/agent.js';
import { z } from 'zod';
import { parseBudget, stripBudget, parseDeliveryDeadline, stripOrderConstraints, parseSustainability, parseOriginPreference, parseNutritionGoals, nutritionPer100 } from '../src/contracts.js';

test('recipe reuses planned synonyms without an extra model call', async () => {
  const replies = [
    { ingredients: [{ query: 'fish broth', alternatives: ['fish bouillon'] }] },
    { items: [{ productId: '463838', quantity: 1 }] }
  ];
  const messages = [];
  const cart = await recipeCart('salmon soup', async path => path.includes('fish%20bouillon')
    ? { selection_id: 'matched', products: [{ id: '463838' }] }
    : { products: [] }, async () => {
    assert.ok(replies.length, 'No extra model call should be needed');
    return replies.shift();
  }, message => messages.push(message));
  assert.equal(cart.items[0].productId, '463838');
  assert.equal(replies.length, 0);
  assert.ok(messages.some(message => message.includes('Selecting products and quantities completed')));
});

const lunaEnv = { LUNA_BASE_URL: 'https://luna.example/v1', LUNA_API_KEY: 'test-key', LUNA_MODEL: 'test-model' };
const lunaReply = value => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });

test('Luna requests bounded JSON and includes the validation schema', async () => {
  const schema = z.object({ ok: z.boolean() });
  const result = await lunaJSON('test', schema, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url, 'https://luna.example/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(body.model, 'test-model');
    assert.equal(body.max_tokens, 8192);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /"ok":\{"type":"boolean"/);
    return lunaReply({ ok: true });
  }, lunaEnv);
  assert.deepEqual(result, { ok: true });
});

test('Luna missing configuration and timeouts fail without a fallback', async () => {
  let calls = 0;
  await assert.rejects(lunaJSON('test', z.object({}), async () => { calls++; }, {}), /Configure LUNA_API_KEY and LUNA_BASE_URL/);
  assert.equal(calls, 0);
  await assert.rejects(lunaJSON('test', z.object({}), async () => {
    throw new DOMException('timed out', 'TimeoutError');
  }, lunaEnv), /unavailable or timed out/);
});

test('Luna rejects truncated output', async () => {
  await assert.rejects(lunaJSON('test', z.object({}), async () =>
    Response.json({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }), lunaEnv),
  /truncated/);
});

test('recipe retries an unmatched ingredient and uses only the successful selection', async () => {
  const queries = [];
  const replies = [
    { ingredients: [{ query: 'fish broth' }] },
    { queries: ['FISH BROTH', 'fish bouillon', 'kalaliemi'] },
    { items: [{ productId: '463838', quantity: 1 }] }
  ];
  const cart = await recipeCart('salmon soup', async path => {
    const query = new URL(path, 'http://localhost').searchParams.get('q');
    queries.push(query);
    return query === 'fish bouillon'
      ? { selection_id: 'matched', products: [{ id: '463838' }] }
      : { selection_id: 'empty', products: [] };
  }, async () => replies.shift());
  assert.deepEqual(queries, ['fish broth', 'fish bouillon']);
  assert.deepEqual(cart, { items: [{ productId: '463838', quantity: 1 }], selection_ids: ['matched'] });
  assert.equal(replies.length, 0);
});

test('recipe stops before cart construction when all alternatives have no results', async () => {
  let searches = 0;
  let modelCalls = 0;
  await assert.rejects(recipeCart('soup', async () => {
    searches++;
    return { products: [] };
  }, async () => {
    modelCalls++;
    if (modelCalls === 1) return { ingredients: [{ query: 'fish broth' }] };
    if (modelCalls === 2) return { queries: ['fish bouillon', 'kalaliemi', 'fish stock'] };
    assert.fail('Must not construct a cart with missing ingredients');
  }), /No catalog results for "fish broth" after trying alternative names/);
  assert.equal(searches, 4);
  assert.equal(modelCalls, 2);
});

test('retry products cannot bypass the selected product check', async () => {
  const replies = [
    { ingredients: [{ query: 'fish broth' }] },
    { queries: ['kalaliemi'] },
    { items: [{ productId: 'unselected', quantity: 1 }] },
    { items: [{ productId: 'unselected', quantity: 1 }] }
  ];
  let searches = 0;
  await assert.rejects(recipeCart('soup', async () => ++searches === 1
    ? { products: [] }
    : { selection_id: 'matched', products: [{ id: '463838' }] },
  async () => replies.shift()), /unselected products/);
});

test('duplicate ingredient queries merge alternatives and search only once', async () => {
  const replies = [
    { ingredients: [{ query: ' Fish   Broth ' }, { query: 'fish broth', alternatives: ['kalaliemi'] }] },
    { items: [{ productId: '463838', quantity: 2 }] }
  ];
  const queries = [];
  const cart = await recipeCart('soup', async path => {
    const query = new URL(path, 'http://localhost').searchParams.get('q');
    queries.push(query);
    return { selection_id: 'selection', products: query === 'kalaliemi' ? [{ id: '463838', allowed_lot_size: 1 }] : [] };
  }, async () => replies.shift());
  assert.deepEqual(queries, ['fish broth', 'kalaliemi']);
  assert.deepEqual(cart.selection_ids, ['selection']);
  assert.equal(replies.length, 0);
});

test('oversized model quantities get one correction before returning a cart', async () => {
  const replies = [
    { ingredients: [{ query: 'cream' }] },
    { items: [{ productId: 'cream', quantity: 12345678 }] },
    { items: [{ productId: 'cream', quantity: 2 }] }
  ];
  const prompts = [];
  const cart = await recipeCart('50 portions', async path => {
    assert.ok(path.startsWith('/catalog/search?'), 'Must not request quotes or submit orders');
    return { selection_id: 'selection', products: [{ id: 'cream', allowed_lot_size: 1 }] };
  }, async prompt => { prompts.push(prompt); return replies.shift(); });
  assert.equal(cart.items[0].quantity, 2);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2], /previous response was rejected.*1,000,000/);
});

test('repeated invalid quantities stop with a concise error and no further retries', async () => {
  let calls = 0;
  await assert.rejects(recipeCart('soup', async path => {
    assert.ok(path.startsWith('/catalog/search?'));
    return { selection_id: 'selection', products: [{ id: 'cream' }] };
  }, async () => ++calls === 1 ? { ingredients: [{ query: 'cream' }] }
    : { items: [{ productId: 'cream', quantity: 1e12 }] }), error => {
    assert.match(error.message, /failed after one correction attempt/);
    assert.match(error.message, /Invalid quantities for 1 item/);
    assert.match(error.message, /No quote or order was requested/);
    assert.doesNotMatch(error.message, /"origin"|"path"|"too_big"/);
    return true;
  });
  assert.equal(calls, 3);
});

test('invalid lot quantities are corrected without rounding silently', async () => {
  const replies = [
    { ingredients: [{ query: 'cream' }] },
    { items: [{ productId: 'cream', quantity: 1 }] },
    { items: [{ productId: 'cream', quantity: 6 }] }
  ];
  const cart = await recipeCart('soup', async () => ({ selection_id: 'selection',
    products: [{ id: 'cream', allowed_lot_size: 6 }] }), async () => replies.shift());
  assert.equal(cart.items[0].quantity, 6);
  assert.equal(replies.length, 0);
});

test('Luna schema errors use the same readable validation message', async () => {
  await assert.rejects(lunaJSON('test', z.object({ items: z.array(z.object({ quantity: z.number().max(1000000) })) }),
    async () => lunaReply({items:[{quantity:1000001}]}), lunaEnv), /Invalid quantities for 1 item/);
});

test('invalid ingredient plans fail with a readable stage before searching', async () => {
  await assert.rejects(recipeCart('soup', async () => assert.fail('Must not search invalid plans'),
    async () => ({ ingredients: [] })), /Planning ingredients: Invalid model response/);
});

test('rankCandidates orders by keyword match, allergens, price, human-approved history, and stock/delivery', () => {
  const ranked = rankCandidates([
    { id: 'slow-stock', match_rank: 3, allergen_safe: true, unit_price: 2.0, human_approved_count: 1, bought_count: 2, in_stock: true, available_date: '2026-11-18' },
    { id: 'fast-stock', match_rank: 3, allergen_safe: true, unit_price: 2.0, human_approved_count: 1, bought_count: 2, in_stock: true, available_date: '2026-11-16' },
    { id: 'human-fav', match_rank: 3, allergen_safe: true, unit_price: 2.0, human_approved_count: 3, bought_count: 3, in_stock: true, available_date: '2026-11-17' },
    { id: 'cheaper', match_rank: 3, allergen_safe: true, unit_price: 1.5, human_approved_count: 0, bought_count: 0, in_stock: true, available_date: '2026-11-18' },
    { id: 'allergen-bad', match_rank: 3, allergen_safe: false, unit_price: 0.5, human_approved_count: 9, bought_count: 9, in_stock: true, available_date: '2026-11-16' },
    { id: 'exact', match_rank: 4, allergen_safe: true, unit_price: 5.0, human_approved_count: 0, bought_count: 0, in_stock: false, available_date: null }
  ]);
  assert.deepEqual(ranked.map(p => p.id), ['exact', 'cheaper', 'human-fav', 'fast-stock', 'slow-stock', 'allergen-bad']);
});

test('recipeCart keeps word match first and prioritizes delivery by the requested date', async () => {
  const prompts = [];
  const replies = [
    { ingredients: [{ query: 'apple' }] },
    { items: [{ productId: 'exact-late', quantity: 6 }] },
    { items: [{ productId: 'exact-late', quantity: 5 }] }
  ];
  const cart = await recipeCart('I want apples with a total budget of €10.', async (path) => {
    if (path.startsWith('/catalog/search?')) return { selection_id: 'sel-1', products: [
      { id: 'exact-late', name: 'Apple', match_rank: 4, allergen_safe: true },
      { id: 'loose-early', name: 'Apple juice', match_rank: 3, allergen_safe: true }
    ] };
    if (path === '/api/price') return { products: [
      { productId: 'exact-late', error: false, priceWithTax: { value: 2 } },
      { productId: 'loose-early', error: false, priceWithTax: { value: 1 } }
    ] };
    if (path === '/api/availability') return { products: [
      { productId: 'exact-late', salesBlock: false, scheduleLines: [{ salesBlock: false, availableAmount: 4, availableDate: '2026-11-20' }] },
      { productId: 'loose-early', salesBlock: false, scheduleLines: [{ salesBlock: false, availableAmount: 4, availableDate: '2026-11-16' }] }
    ] };
    assert.fail(`Unexpected path ${path}`);
  }, async prompt => { prompts.push(prompt); return replies.shift(); }, () => {}, { requestedDate: '2026-11-17' });
  const prompt = prompts[1];
  assert.ok(prompt.indexOf('exact-late') < prompt.indexOf('loose-early'), 'Higher word match remains first despite missing the requested date');
  assert.match(prompt, /stated total budget is EUR 10/);
  assert.match(prompt, /default delivery date is 2026-11-17; between equally priced candidates, prefer those available by then/);
  assert.match(prompt, /"deliverable_by_date":false/);
  assert.match(prompt, /"deliverable_by_date":true/);
  assert.equal(cart.items[0].quantity, 5, 'Over-budget quantity should trigger correction to the EUR 10 limit');
  assert.match(prompts[2], /Cart total EUR 12\.00 exceeds the stated budget of EUR 10\.00/);
});

test('recipeCart sends an over-budget cart for required human approval when correction still exceeds the budget', async () => {
  const replies = [
    { ingredients: [{ query: 'eggs' }] },
    { items: [{ productId: 'eggs', quantity: 6 }] },
    { items: [{ productId: 'eggs', quantity: 6 }] }
  ];
  const cart = await recipeCart('10 eggs, total budget €10', async path => {
    if (path.startsWith('/catalog/search?')) return { selection_id: 'sel-1', products: [
      { id: 'eggs', name: 'Eggs', match_rank: 4, allergen_safe: true }
    ] };
    if (path === '/api/price') return { products: [
      { productId: 'eggs', error: false, priceWithTax: { value: 2 } }
    ] };
    if (path === '/api/availability') return { products: [
      { productId: 'eggs', salesBlock: false, scheduleLines: [{ salesBlock: false, availableAmount: 20, availableDate: '2026-11-16' }] }
    ] };
    assert.fail(`Unexpected path ${path}`);
  }, async () => replies.shift(), () => {}, { requestedDate: '2026-11-16' });
  assert.equal(cart.requiresApproval, true);
  assert.equal(cart.items[0].quantity, 6);
  assert.match(cart.approvalReason, /exceeds the stated budget of EUR 10\.00/);
});

test('parseBudget reads total budgets, ignores per-unit limits and handles thousands separators', () => {
  for (const [text, expected] of [
    ['I want apples with a total budget of €10.', 10], ['budget of 10€', 10], ['budget: 25 EUR', 25],
    ['€1.000,50 budget', 1000.5], ['budget €1,000', 1000], ['under 40 euros', 40], ['no more than EUR 12,5', 12.5],
    ['€10 budget: 10 eggs', 10], ['budget: 10 eggs', null], ['max €3 per kg of apples', null],
    ['within €20/kg', null], ['12 apples under 5 kg', null], ['2 kg apples', null]
  ]) assert.equal(parseBudget(text), expected, text);
  assert.equal(stripBudget('10 eggs, total budget €10'), '10 eggs');
  assert.equal(stripBudget('12 apples with a budget of €10'), '12 apples');
  assert.equal(stripBudget('2 kg apples'), '2 kg apples');
});

const budgetApi = (products, prices) => async path => {
  if (path.startsWith('/catalog/search?')) return { selection_id: 'sel-1', products };
  if (path === '/api/price') return { products: Object.entries(prices).map(([productId, value]) => ({ productId, error: false, priceWithTax: { value } })) };
  if (path === '/api/availability') return { products: products.map(p => ({ productId: p.id, salesBlock: false,
    scheduleLines: [{ salesBlock: false, availableAmount: 50, availableDate: '2026-11-16' }] })) };
  assert.fail(`Unexpected path ${path}`);
};

test('recipeCart with a budget never ranks allergen-unsafe products above safe ones', async () => {
  const prompts = [];
  const replies = [{ ingredients: [{ query: 'bread' }] }, { items: [{ productId: 'safe', quantity: 1 }] }];
  await recipeCart('bread, budget €10', budgetApi([
    { id: 'unsafe-cheap', name: 'Bread', match_rank: 4, allergen_safe: false },
    { id: 'safe', name: 'Bread', match_rank: 4, allergen_safe: true }
  ], { 'unsafe-cheap': 1, safe: 3 }), async prompt => { prompts.push(prompt); return replies.shift(); }, () => {}, { requestedDate: '2026-11-16' });
  assert.ok(prompts[1].indexOf('"safe"') < prompts[1].indexOf('"unsafe-cheap"'));
});

test('recipeCart sends the over-budget cart for approval when the correction is invalid', async () => {
  const replies = [
    { ingredients: [{ query: 'eggs' }] },
    { items: [{ productId: 'eggs', quantity: 6 }] },
    { items: [{ productId: 'not-a-candidate', quantity: 1 }] }
  ];
  const cart = await recipeCart('10 eggs, total budget €10', budgetApi([{ id: 'eggs', name: 'Eggs', match_rank: 4, allergen_safe: true }], { eggs: 2 }),
    async () => replies.shift(), () => {}, { requestedDate: '2026-11-16' });
  assert.equal(cart.requiresApproval, true);
  assert.equal(cart.budget, 10);
  assert.deepEqual(cart.items, [{ productId: 'eggs', quantity: 6 }]);
  assert.match(cart.approvalReason, /EUR 12\.00 exceeds the stated budget of EUR 10\.00/);
});

test('parseDeliveryDeadline turns a stated delivery window into a date and strips it from product lines', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  for (const [text, expected] of [
    ['10 eggs delivered in 3 days', '2026-11-17'], ['eggs, delivery within a week', '2026-11-21'],
    ['10 eggs to be delivered in two days', '2026-11-16'], ['12 apples by tomorrow', '2026-11-15'], ['2 kg apples', null]
  ]) assert.equal(parseDeliveryDeadline(text, now), expected, text);
  assert.equal(stripOrderConstraints('10 eggs, delivered in 3 days, budget €20'), '10 eggs');
});

test('rankCandidates keeps keyword match on top and ranks deliverability by an explicit deadline above price', () => {
  const candidates = [
    { id: 'weak-fast-cheap', match_rank: 2, allergen_safe: true, unit_price: 1, deliverable_by_date: true },
    { id: 'exact-late-cheap', match_rank: 4, allergen_safe: true, unit_price: 1, deliverable_by_date: false },
    { id: 'exact-fast-pricey', match_rank: 4, allergen_safe: true, unit_price: 5, deliverable_by_date: true },
    { id: 'exact-fast-unsafe', match_rank: 4, allergen_safe: false, unit_price: 0.5, deliverable_by_date: true }
  ];
  const ids = options => rankCandidates(candidates, options).map(p => p.id);
  assert.deepEqual(ids({ deliveryRequested: true }), ['exact-fast-pricey', 'exact-late-cheap', 'exact-fast-unsafe', 'weak-fast-cheap']);
  assert.deepEqual(ids({ deliveryRequested: true, budget: true }), ['exact-fast-pricey', 'exact-late-cheap', 'exact-fast-unsafe', 'weak-fast-cheap']);
  // Without an explicit window, a stated budget keeps price above the default delivery date.
  assert.deepEqual(ids({ budget: true }), ['exact-late-cheap', 'exact-fast-pricey', 'exact-fast-unsafe', 'weak-fast-cheap']);
});

test('recipeCart ranks by a "delivered in X days" request without overriding keyword match', async () => {
  const prompts = [];
  const replies = [{ ingredients: [{ query: 'apple' }] }, { items: [{ productId: 'exact-fast', quantity: 1 }] }];
  const bodies = [];
  const products = [
    { id: 'loose-fast', name: 'Apple juice', match_rank: 3, allergen_safe: true },
    { id: 'exact-late', name: 'Apple', match_rank: 4, allergen_safe: true },
    { id: 'exact-fast', name: 'Apple', match_rank: 4, allergen_safe: true }
  ];
  const dates = { 'loose-fast': '2026-11-15', 'exact-late': '2026-11-25', 'exact-fast': '2026-11-16' };
  const prices = { 'loose-fast': 1, 'exact-late': 2, 'exact-fast': 4 };
  await recipeCart('2 kg apples, budget €20, delivered in 3 days', async (path, body) => {
    if (path.startsWith('/catalog/search?')) return { selection_id: 'sel-1', products };
    bodies.push(body);
    if (path === '/api/price') return { products: products.map(p => ({ productId: p.id, error: false, priceWithTax: { value: prices[p.id] } })) };
    if (path === '/api/availability') return { products: products.map(p => ({ productId: p.id, salesBlock: false,
      scheduleLines: [{ salesBlock: false, availableAmount: 10, availableDate: dates[p.id] }] })) };
    assert.fail(`Unexpected path ${path}`);
  }, async prompt => { prompts.push(prompt); return replies.shift(); }, () => {}, { now: Date.parse('2026-11-14T12:00:00Z') });
  assert.equal(bodies[0].requestedDate, '2026-11-17', 'Stated window is used as the delivery date when none is given');
  const order = ['exact-fast', 'exact-late', 'loose-fast'].map(id => prompts[1].indexOf(`"${id}"`));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'match first, then deliverable before cheaper-but-late');
  assert.match(prompts[1], /wants delivery by 2026-11-17/);
});

test('parseSustainability detects sustainability wording without treating "green" products as a preference', () => {
  for (const [text, expected] of [
    ['10 eggs, sustainable please', true], ['10 eco-friendly eggs', true], ['12 apples with the lowest CO2', true],
    ['eggs with a low carbon footprint', true], ['2 kg green apples', false], ['2 kg apples', false]
  ]) assert.equal(parseSustainability(text), expected, text);
  assert.equal(stripOrderConstraints('10 eco-friendly eggs'), '10 eggs');
  assert.equal(stripOrderConstraints('10 eggs, 2 kg apples, make it sustainable, budget €20, delivered in 3 days'), '10 eggs, 2 kg apples');
  assert.equal(stripOrderConstraints('2 kg green apples'), '2 kg green apples');
});

test('rankCandidates ranks lowest CO2 under keyword match, allergens and deliverability, above price, only when requested', () => {
  const candidates = [
    { id: 'weak-green', match_rank: 2, allergen_safe: true, unit_price: 1, carbon_kg_co2_per_kg: 0.1, deliverable_by_date: true },
    { id: 'exact-dirty-cheap', match_rank: 4, allergen_safe: true, unit_price: 1, carbon_kg_co2_per_kg: 3, deliverable_by_date: true },
    { id: 'exact-green-pricey', match_rank: 4, allergen_safe: true, unit_price: 5, carbon_kg_co2_per_kg: 0.5, deliverable_by_date: true },
    { id: 'exact-unknown-co2', match_rank: 4, allergen_safe: true, unit_price: 0.5, carbon_kg_co2_per_kg: null, deliverable_by_date: true },
    { id: 'exact-greenest-late', match_rank: 4, allergen_safe: true, unit_price: 1, carbon_kg_co2_per_kg: 0.2, deliverable_by_date: false },
    { id: 'exact-green-unsafe', match_rank: 4, allergen_safe: false, unit_price: 1, carbon_kg_co2_per_kg: 0.01, deliverable_by_date: true }
  ];
  const ids = options => rankCandidates(candidates, options).map(p => p.id);
  assert.deepEqual(ids({ sustainability: true, deliveryRequested: true }),
    ['exact-green-pricey', 'exact-dirty-cheap', 'exact-unknown-co2', 'exact-greenest-late', 'exact-green-unsafe', 'weak-green']);
  assert.deepEqual(ids({ deliveryRequested: true }),
    ['exact-unknown-co2', 'exact-dirty-cheap', 'exact-green-pricey', 'exact-greenest-late', 'exact-green-unsafe', 'weak-green']);
});

test('recipeCart sends CO2 data and a sustainability constraint to the model only when requested', async () => {
  const run = async recipe => {
    const prompts = [];
    const replies = [{ ingredients: [{ query: 'apple' }] }, { items: [{ productId: 'green', quantity: 1 }] }];
    await recipeCart(recipe, async path => {
      if (path.startsWith('/catalog/search?')) return { selection_id: 'sel-1', products: [
        { id: 'dirty', name: 'Apple', match_rank: 4, allergen_safe: true, carbon_kg_co2_per_kg: 2.3 },
        { id: 'green', name: 'Apple', match_rank: 4, allergen_safe: true, carbon_kg_co2_per_kg: 0.4 }
      ] };
      assert.fail(`Unexpected path ${path}`);
    }, async prompt => { prompts.push(prompt); return replies.shift(); });
    return prompts[1];
  };
  const sustainable = await run('2 kg apples, sustainable please');
  assert.ok(sustainable.indexOf('"green"') < sustainable.indexOf('"dirty"'));
  assert.match(sustainable, /wants sustainable choices/);
  assert.match(sustainable, /"carbon_kg_co2_per_kg":0.4/);
  const plain = await run('2 kg apples');
  assert.doesNotMatch(plain, /carbon_kg_co2_per_kg/);
});

test('parseOriginPreference reads strict and preferred origins without touching product names', () => {
  for (const [text, expected] of [
    ['I want 50 apples sustainability, 10 euros budget, English only', { countries: ['gb'], strict: true }],
    ['2 kg apples, Finnish only', { countries: ['fi'], strict: true }],
    ['10 eggs, only from Finland', { countries: ['fi'], strict: true }],
    ['1 cheese, Finnish or Swedish only', { countries: ['fi', 'se'], strict: true }],
    ['10 eggs, must be from Finland', { countries: ['fi'], strict: true }],
    ['prefer Finnish, 2 kg potato', { countries: ['fi'], strict: false }],
    ['2 kg apples from Spain if possible', { countries: ['es'], strict: false }],
    ['10 eggs, Finnish origin', { countries: ['fi'], strict: false }],
    ['2 kg French fries', null], ['1 Greek yoghurt', null], ['answer in English only: 2 kg apples', null], ['10 eggs from us', null]
  ]) assert.deepEqual(parseOriginPreference(text), expected, text);
  assert.equal(stripOrderConstraints('I want 50 apples sustainability, 10 euros budget, English only'), 'I want 50 apples');
  assert.equal(stripOrderConstraints('2 kg French fries, Finnish only'), '2 kg French fries');
});

test('rankCandidates puts a requested origin right after keyword match and allergen safety', () => {
  const candidates = [
    { id: 'weak-fi', match_rank: 2, allergen_safe: true, unit_price: 1, country_of_origin: 'fi' },
    { id: 'exact-fr-cheap-green-fast', match_rank: 4, allergen_safe: true, unit_price: 1, carbon_kg_co2_per_kg: 0.1, deliverable_by_date: true, country_of_origin: 'fr' },
    { id: 'exact-fi-pricey-late', match_rank: 4, allergen_safe: true, unit_price: 5, carbon_kg_co2_per_kg: 2, deliverable_by_date: false, country_of_origin: 'FI' },
    { id: 'exact-fi-unsafe', match_rank: 4, allergen_safe: false, unit_price: 1, country_of_origin: 'fi' }
  ];
  const ids = options => rankCandidates(candidates, options).map(p => p.id);
  assert.deepEqual(ids({ origins: ['fi'], sustainability: true, deliveryRequested: true, budget: true }),
    ['exact-fi-pricey-late', 'exact-fr-cheap-green-fast', 'exact-fi-unsafe', 'weak-fi']);
  assert.deepEqual(ids({ sustainability: true, deliveryRequested: true, budget: true }),
    ['exact-fr-cheap-green-fast', 'exact-fi-pricey-late', 'exact-fi-unsafe', 'weak-fi']);
});

const originApi = async path => {
  if (path.startsWith('/catalog/search?')) return { selection_id: 'sel-1', products: [
    { id: 'fr-apple', name: 'Apple', match_rank: 4, allergen_safe: true, country_of_origin: 'fr' },
    { id: 'fi-apple', name: 'Apple', match_rank: 4, allergen_safe: true, country_of_origin: 'fi' }
  ] };
  assert.fail(`Unexpected path ${path}`);
};

test('recipeCart corrects a cart that breaks a strict origin requirement', async () => {
  const prompts = [];
  const replies = [{ ingredients: [{ query: 'apple' }] }, { items: [{ productId: 'fr-apple', quantity: 1 }] }, { items: [{ productId: 'fi-apple', quantity: 1 }] }];
  const cart = await recipeCart('2 kg apples, Finnish only', originApi, async prompt => { prompts.push(prompt); return replies.shift(); });
  assert.deepEqual(cart.items, [{ productId: 'fi-apple', quantity: 1 }]);
  assert.equal(cart.requiresApproval, undefined);
  assert.ok(prompts[1].indexOf('"fi-apple"') < prompts[1].indexOf('"fr-apple"'));
  assert.match(prompts[1], /accepts ONLY products whose country_of_origin is fi \(Finland\)/);
  assert.match(prompts[2], /fr-apple is from France, but the request allows only Finland/);
});

test('recipeCart sends a strict-origin cart for human approval when no matching origin is chosen', async () => {
  const replies = [{ ingredients: [{ query: 'apple' }] }, { items: [{ productId: 'fr-apple', quantity: 1 }] }, { items: [{ productId: 'fr-apple', quantity: 1 }] }];
  const cart = await recipeCart('2 kg apples, English only', originApi, async () => replies.shift());
  assert.equal(cart.requiresApproval, true);
  assert.match(cart.approvalReason, /^Origin requirement not met after correction: fr-apple is from France, but the request allows only the United Kingdom/);
});

test('recipeCart only ranks by a preferred origin and does not enforce it', async () => {
  const replies = [{ ingredients: [{ query: 'apple' }] }, { items: [{ productId: 'fr-apple', quantity: 1 }] }];
  const cart = await recipeCart('2 kg apples, prefer Finnish', originApi, async () => replies.shift());
  assert.deepEqual(cart.items, [{ productId: 'fr-apple', quantity: 1 }]);
  assert.equal(cart.requiresApproval, undefined);
});

test('parseNutritionGoals reads one goal per nutrient in the order mentioned and strips them from product lines', () => {
  for (const [text, expected] of [
    ['2 high protein yoghurt, low sugar', [['protein', 'max'], ['sugar', 'min']]],
    ['10 eggs, less salt and more fibre', [['salt', 'min'], ['fibre', 'max']]],
    ['1 milk, low in saturated fat, fewer calories', [['saturatedFat', 'min'], ['energy', 'min']]],
    ['2 lactose free milk', [['lactose', 'min']]], ['keto: 2 kg chicken', [['carbs', 'min']]],
    ['1 sugar-free gum', [['sugar', 'min']]], ['1 Greek yoghurt protein-rich', [['protein', 'max']]],
    ['1 sugar, 2 kg salt', []], ['1 kg brown sugar', []]
  ]) assert.deepEqual(parseNutritionGoals(text).map(g => [g.nutrient, g.direction]), expected, text);
  assert.equal(stripOrderConstraints('2 high protein yoghurt, low sugar, Finnish only, budget €20'), '2 yoghurt');
  assert.equal(stripOrderConstraints('1 sugar, 2 kg salt'), '1 sugar, 2 kg salt');
});

test('nutritionPer100 normalises nutrition values to per 100 g/ml and skips per-portion values', () => {
  assert.deepEqual(nutritionPer100([
    { id: 'PRO-', value: 3.7, unit: 'GRM', basisQuantity: 100, basisQuantityUnit: 'GRM' },
    { id: 'FAT', value: 10, unit: 'GRM', basisQuantity: 40, basisQuantityUnit: 'GRM' },
    { id: 'SALTEQ', value: 1, unit: 'GRM', basisQuantity: 1, basisQuantityUnit: 'PTN' },
    { id: 'ENER-E14', value: 496, unit: 'E14', basisQuantity: 100, basisQuantityUnit: 'MLT' }
  ]), { protein: 3.7, fat: 25, energy: 496 });
  assert.deepEqual(nutritionPer100(null), {});
});

test('rankCandidates gives each nutrition goal its own level, below keyword match, allergens, origin and delivery', () => {
  const candidates = [
    { id: 'weak-best-protein', match_rank: 2, allergen_safe: true, nutrition: { protein: 30, sugar: 0 } },
    { id: 'exact-p10-s9-cheap', match_rank: 4, allergen_safe: true, unit_price: 1, carbon_kg_co2_per_kg: 0.1, nutrition: { protein: 10, sugar: 9 } },
    { id: 'exact-p10-s2', match_rank: 4, allergen_safe: true, unit_price: 3, carbon_kg_co2_per_kg: 2, nutrition: { protein: 10.02, sugar: 2 } },
    { id: 'exact-p12-s15', match_rank: 4, allergen_safe: true, unit_price: 5, nutrition: { protein: 12, sugar: 15 } },
    { id: 'exact-unknown', match_rank: 4, allergen_safe: true, unit_price: 0.5, nutrition: {} },
    { id: 'exact-unsafe', match_rank: 4, allergen_safe: false, nutrition: { protein: 50, sugar: 0 } }
  ];
  const ids = nutrition => rankCandidates(candidates, { nutrition, sustainability: true }).map(p => p.id);
  // Protein first (10 and 10.02 tie at 0.1 g precision), then sugar decides, then CO2 and price.
  assert.deepEqual(ids([{ nutrient: 'protein', direction: 'max' }, { nutrient: 'sugar', direction: 'min' }]),
    ['exact-p12-s15', 'exact-p10-s2', 'exact-p10-s9-cheap', 'exact-unknown', 'exact-unsafe', 'weak-best-protein']);
  // Mentioning sugar first changes the priority.
  assert.deepEqual(ids([{ nutrient: 'sugar', direction: 'min' }, { nutrient: 'protein', direction: 'max' }]),
    ['exact-p10-s2', 'exact-p10-s9-cheap', 'exact-p12-s15', 'exact-unknown', 'exact-unsafe', 'weak-best-protein']);
});

test('recipeCart sends the requested nutrients to the model and ranks by them', async () => {
  const prompts = [];
  const replies = [{ ingredients: [{ query: 'yoghurt' }] }, { items: [{ productId: 'high', quantity: 1 }] }];
  await recipeCart('2 yoghurt, high protein', async path => {
    if (path.startsWith('/catalog/search?')) return { selection_id: 'sel-1', products: [
      { id: 'low', name: 'Yoghurt', match_rank: 4, allergen_safe: true, nutrition: { protein: 3, sugar: 4 } },
      { id: 'high', name: 'Yoghurt', match_rank: 4, allergen_safe: true, nutrition: { protein: 10, sugar: 4 } }
    ] };
    assert.fail(`Unexpected path ${path}`);
  }, async prompt => { prompts.push(prompt); return replies.shift(); });
  assert.ok(prompts[1].indexOf('"high"') < prompts[1].indexOf('"low"'));
  assert.match(prompts[1], /wants most protein/);
  assert.match(prompts[1], /"nutrition":\{"protein \(g\)":10\}/);
  assert.doesNotMatch(prompts[1], /sugar \(g\)/);
});

test('rankCandidates moves unrequested delivery and CO2 levels between price and the tie-breakers', () => {
  const candidates = [
    { id: 'cheap-late-dirty', match_rank: 4, allergen_safe: true, unit_price: 1, deliverable_by_date: false, carbon_kg_co2_per_kg: 9 },
    { id: 'pricey-fast-green', match_rank: 4, allergen_safe: true, unit_price: 5, deliverable_by_date: true, carbon_kg_co2_per_kg: 0.1 },
    { id: 'mid-late-green-favourite', match_rank: 4, allergen_safe: true, unit_price: 3, deliverable_by_date: false, carbon_kg_co2_per_kg: 0.1, human_approved_count: 9 },
    { id: 'mid-late-dirty', match_rank: 4, allergen_safe: true, unit_price: 3, deliverable_by_date: false, carbon_kg_co2_per_kg: 2 },
    { id: 'mid-fast-dirty', match_rank: 4, allergen_safe: true, unit_price: 3, deliverable_by_date: true, carbon_kg_co2_per_kg: 2 }
  ];
  const ids = options => rankCandidates(candidates, options).map(p => p.id);
  // Nothing requested: price, then default-date delivery, then CO2, then history.
  assert.deepEqual(ids({}), ['cheap-late-dirty', 'mid-fast-dirty', 'mid-late-green-favourite', 'mid-late-dirty', 'pricey-fast-green']);
  // Requested delivery and sustainability move above price.
  assert.deepEqual(ids({ deliveryRequested: true, sustainability: true }),
    ['pricey-fast-green', 'mid-fast-dirty', 'mid-late-green-favourite', 'mid-late-dirty', 'cheap-late-dirty']);
});

test('recipeCart enriches and sorts candidates with live price and availability when requestedDate is set', async () => {
  const prompts = [];
  const replies = [{ ingredients: [{ query: 'apple' }] }, { items: [{ productId: 'cheap-fast', quantity: 1 }] }];
  const cart = await recipeCart('2 kg apples', async (path, body) => {
    if (path.startsWith('/catalog/search?')) {
      return {
        selection_id: 'sel-1',
        products: [
          { id: 'expensive', name: 'Apple A', match_rank: 3, allergen_safe: true },
          { id: 'cheap-fast', name: 'Apple B', match_rank: 3, allergen_safe: true }
        ]
      };
    }
    if (path === '/api/price') {
      assert.deepEqual(body.selection_ids, ['sel-1']);
      return { products: [{ productId: 'expensive', error: false, priceWithTax: { value: 5.0 } }, { productId: 'cheap-fast', error: false, priceWithTax: { value: 2.0 } }] };
    }
    if (path === '/api/availability') {
      return {
        products: [
          { productId: 'expensive', salesBlock: false, scheduleLines: [{ salesBlock: false, availableAmount: 10, availableDate: '2026-11-16' }] },
          { productId: 'cheap-fast', salesBlock: false, scheduleLines: [{ salesBlock: false, availableAmount: 10, availableDate: '2026-11-16' }] }
        ]
      };
    }
    assert.fail(`Unexpected path ${path}`);
  }, async prompt => { prompts.push(prompt); return replies.shift(); }, () => {}, { requestedDate: '2026-11-16' });
  assert.equal(cart.items[0].productId, 'cheap-fast');
  const cheapIndex = prompts[1].indexOf('"cheap-fast"');
  const expensiveIndex = prompts[1].indexOf('"expensive"');
  assert.ok(cheapIndex > 0 && cheapIndex < expensiveIndex, 'Cheaper candidate should appear before expensive candidate');
});
test('catalog cannot enlarge the five-candidate window', async () => {
  let calls=0;
  await assert.rejects(recipeCart('soup', async () => ({selection_id:'selected',products:Array.from({length:6},(_,i)=>({id:String(i)}))}),
    async () => {calls++; return {ingredients:[{query:'soup'}]};}), /Invalid catalog search response/);
  assert.equal(calls,1);
});
test('empty Luna content returns an actionable error', async () => {
  await assert.rejects(lunaJSON('test', z.object({}), async () => Response.json({choices:[{message:{content:''}}]}), lunaEnv), /empty or invalid content/);
});
test('Luna HTTP errors, refusal and malformed responses stop inference', async () => {
  for (const [fetcher, pattern] of [
    [async()=>new Response('bad request',{status:400}), /failed \(400\)/],
    [async()=>new Response('unavailable',{status:503}), /failed \(503\)/],
    [async()=>{throw new TypeError('fetch failed');}, /unavailable or timed out/],
    [async()=>Response.json({choices:[{message:{content:'{"items":'}}]}), /rephrase the products and quantities.*no order was placed/]
  ]) await assert.rejects(lunaJSON('test',z.object({}),fetcher,lunaEnv),pattern);
});
for (const items of [
  [{productId:'cream',quantity:0}], [{productId:'cream',quantity:-1}],
  [{productId:'cream',quantity:1},{productId:'cream',quantity:1}],
  [{productId:'invented',quantity:1}]
]) test('invalid cart exhausts exactly one correction without quote or order: '+JSON.stringify(items), async () => {
  let calls=0;
  await assert.rejects(recipeCart('cream',async path => {
    assert.ok(path.startsWith('/catalog/search?'));
    return {selection_id:'s',products:[{id:'cream',allowed_lot_size:1}]};
  }, async () => ++calls === 1 ? {ingredients:[{query:'cream'}]} : {items}), /one correction attempt.*No quote or order was requested/);
  assert.equal(calls,3);
});

test('Luna malformed cart gets one correction and no quote is requested', async () => {
  let calls = 0;
  const model = (prompt, schema) => lunaJSON(prompt, schema, async () => {
    calls++;
    if (calls === 1) return lunaReply({ ingredients: [{ query: 'cream' }] });
    if (calls === 2) return Response.json({ choices: [{ message: { content: '{invalid' } }] });
    return lunaReply({ items: [{ productId: 'cream', quantity: 2 }] });
  }, lunaEnv);
  const cart = await recipeCart('cream', async path => {
    assert.ok(path.startsWith('/catalog/search?'));
    return { selection_id:'s', products:[{ id:'cream', allowed_lot_size:1 }] };
  }, model);
  assert.equal(calls, 3);
  assert.deepEqual(cart.items, [{ productId:'cream', quantity:2 }]);
});

test('Luna rate limit stops recipe without correction or quoting', async () => {
  let calls = 0;
  const model = (prompt, schema) => lunaJSON(prompt, schema, async () => {
    calls++;
    if (calls === 1) return lunaReply({ ingredients: [{ query:'cream' }] });
    return new Response('', { status:429 });
  }, lunaEnv);
  await assert.rejects(recipeCart('cream', async path => {
    assert.ok(path.startsWith('/catalog/search?'));
    return {selection_id:'s',products:[{id:'cream',allowed_lot_size:1}]};
  }, model), error => error.status === 429 && error.code === 'AI_RATE_LIMITED');
  assert.equal(calls, 2);
});

test('Luna response body timeout stops without cart correction or quoting', async () => {
  let calls = 0;
  const model = (prompt, schema) => lunaJSON(prompt, schema, async () => {
    calls++;
    if (calls === 1) return lunaReply({ ingredients: [{ query:'cream' }] });
    return { ok:true, status:200, text:async () => { throw new DOMException('timed out', 'TimeoutError'); } };
  }, lunaEnv);
  await assert.rejects(recipeCart('cream', async path => {
    assert.ok(path.startsWith('/catalog/search?'));
    return {selection_id:'s',products:[{id:'cream',allowed_lot_size:1}]};
  }, model), error => error.status === 502 && error.code === 'AI_UNAVAILABLE');
  assert.equal(calls, 2);
});

test('Luna preserves 429 if its error body cannot be read', async () => {
  await assert.rejects(lunaJSON('test', z.object({}), async () => ({
    ok:false, status:429, text:async () => { throw new Error('body unavailable'); }
  }), lunaEnv), error => error.status === 429 && error.code === 'AI_RATE_LIMITED');
});
