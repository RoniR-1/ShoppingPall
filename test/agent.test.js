import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeCart } from '../src/agent.js';

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
    { items: [{ productId: 'unselected', quantity: 1 }] }
  ];
  let searches = 0;
  await assert.rejects(recipeCart('soup', async () => ++searches === 1
    ? { products: [] }
    : { selection_id: 'matched', products: [{ id: '463838' }] },
  async () => replies.shift()), /unselected products/);
});
