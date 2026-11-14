import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeCart, ollamaJSON, rankCandidates } from '../src/agent.js';
import { z } from 'zod';

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

test('Ollama requests bounded structured output with thinking disabled', async () => {
  const schema = z.object({ ok: z.boolean() });
  const result = await ollamaJSON('test', schema, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.think, false);
    assert.equal(body.keep_alive, '15m');
    assert.equal(body.options.num_predict, 1024);
    assert.equal(body.format.properties.ok.type, 'boolean');
    return new Response(JSON.stringify({ message: { content: '{"ok":true}' } }));
  });
  assert.deepEqual(result, { ok: true });
});

test('Ollama timeouts identify the model and suggest a diagnostic', async () => {
  await assert.rejects(ollamaJSON('test', z.object({}), async () => {
    throw new DOMException('timed out', 'TimeoutError');
  }), /Ollama model .* timed out after .*ollama ps/);
});

test('Ollama output limit explains failure instead of parsing truncated JSON', async () => {
  await assert.rejects(ollamaJSON('test', z.object({}), async () =>
    new Response(JSON.stringify({ done_reason: 'length', message: { content: '{' } }))),
  /1024-token output limit/);
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

test('actual Ollama schema errors use the same readable validation message', async () => {
  await assert.rejects(ollamaJSON('test', z.object({ items: z.array(z.object({ quantity: z.number().max(1000000) })) }),
    async () => new Response(JSON.stringify({ message: { content: '{"items":[{"quantity":1000001}]}' } }))),
  /Invalid quantities for 1 item/);
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
